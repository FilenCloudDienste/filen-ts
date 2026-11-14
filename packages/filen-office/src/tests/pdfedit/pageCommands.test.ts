import { MessageChannel } from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import { savePortReader, type SavePortEnd } from "@filen/shared/savePort"
import { PDF_DESKTOP_MEMORY } from "../../core/pdfedit"
import type { PdfEngineClient } from "../../dom/pdfedit/client"
import { CROP_COMMANDS } from "../../dom/pdfedit/commands/crop"
import { changedPages } from "../../dom/pdfedit/commands/pages"
import type { PdfCommandContext } from "../../dom/pdfedit/commands/types"
import { PDF_EXTRACT_ENCRYPTION } from "../../dom/pdfedit/pages/extractRequest"
import type { PdfSaveExpectation } from "../../dom/pdfedit/protocol"
import { markArea, markText, pageRedactionMarks } from "../../dom/pdfedit/redact"
import { createSyncRangeBuffer, serveSyncRange, type SyncRangePort } from "../../dom/pdfedit/syncRange"
import { PDF_UNSIGNED } from "../../core/pdfedit/signaturePolicy"
import type { RedactionManifest, RedactionVerdict } from "../../core/pdfedit/redactVerify"
import { openPdf, pageText } from "../docxPdfFixtures"
import { budget } from "../timing"
import { spawnEngine, startEngine, stopEngines, syncPort } from "./harness"
import { makeMarginsPdf, makeOrganisedPdf, makeOtherPdf } from "./pageFixtures"

// The page and crop commands through a real engine: each a journal step with undo and redo, a second document held
// open to insert from, new files of pages held like a save's output, and the saved files reopened in MuPDF and pdf.js.

afterEach(stopEngines)

const TIMEOUT = budget(60_000)

// A channel the engine reads `bytes` through (its port is transferred with the request).
function serveBytes(bytes: Uint8Array): { readonly channel: { buffer: SharedArrayBuffer; port: SyncRangePort; length: number } } {
	const blockBytes = 64 * 1024
	const buffer = createSyncRangeBuffer(8, blockBytes)
	const channel = new MessageChannel()
	const lifetime = new AbortController()

	serveSyncRange(
		buffer,
		syncPort(channel.port2),
		{ length: bytes.length, read: (start, end) => Promise.resolve(bytes.slice(start, end)) },
		{ lifetime: lifetime.signal, readAhead: 2, onReaderClose: () => lifetime.abort() }
	)

	return { channel: { buffer, port: channel.port1 as unknown as SyncRangePort, length: bytes.length } }
}

async function texts(client: PdfEngineClient): Promise<string[]> {
	const { pageCount } = await client.call("state", {})
	const out: string[] = []

	for (let page = 0; page < pageCount; page++) {
		const text = await client.call("text", { page })

		out.push(text.lines.map(line => line.str).join(" "))
	}

	return out
}

// The held output streamed as an upload would read it.
async function upload(client: PdfEngineClient): Promise<Uint8Array> {
	const channel = new MessageChannel()
	const reader = savePortReader(channel.port2 as unknown as SavePortEnd)
	const written = client.call("writeOutput", { port: channel.port1 }, [channel.port1])
	const chunks: Uint8Array[] = []

	for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) chunks.push(chunk)

	reader.settled(true)
	expect((await written).uploaded).toBe(true)

	const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
	let at = 0

	for (const chunk of chunks) {
		bytes.set(chunk, at)
		at += chunk.length
	}

	return bytes
}

// The held output's redaction check, in a verifying engine as the page runs it.
async function verifyRedaction(client: PdfEngineClient, size: number, manifest: RedactionManifest): Promise<RedactionVerdict> {
	const buffer = createSyncRangeBuffer(8, 64 * 1024)
	const channel = new MessageChannel()

	await client.call("serveOutput", { buffer, port: channel.port1 as unknown as SyncRangePort }, [channel.port1])

	const verifier = spawnEngine({})

	await verifier.call("open", { channel: { buffer, port: channel.port2 as unknown as SyncRangePort, length: size }, role: "verify" }, [
		channel.port2
	])

	const verdict = await verifier.call("verifyRedaction", { manifest })

	verifier.terminate()

	return verdict
}

async function verify(client: PdfEngineClient, size: number, expected: PdfSaveExpectation, password?: string) {
	const buffer = createSyncRangeBuffer(8, 64 * 1024)
	const channel = new MessageChannel()

	await client.call("serveOutput", { buffer, port: channel.port1 as unknown as SyncRangePort }, [channel.port1])

	const verifier = spawnEngine({})
	const opened = await verifier.call(
		"open",
		{
			channel: { buffer, port: channel.port2 as unknown as SyncRangePort, length: size },
			role: "verify",
			...(password === undefined ? {} : { password })
		},
		[channel.port2]
	)

	expect(opened.status).toBe("open")

	const check = await verifier.call("checkSaved", expected)

	verifier.terminate()

	return check
}

// `removesContent`: whether the save says content was removed since the last one (the earlier-versions warning);
// `redacted`: the pages whose regions the save's redaction check proves gone (it passes).
async function save(
	client: PdfEngineClient,
	inputBytes: number,
	removesContent = false,
	redacted: readonly number[] = []
): Promise<Uint8Array> {
	const begun = await client.call("saveBegin", { inputBytes, memory: PDF_DESKTOP_MEMORY, invalidateConfirmed: true })

	if (begun.status !== "written") throw new Error("refused")

	expect(begun.removesContent).toBe(removesContent)
	expect([...new Set(begun.redaction?.regions.map(region => region.page) ?? [])]).toEqual(redacted)

	if (begun.redaction !== null) {
		expect(begun.redaction.regions.every(region => region.kind === "area")).toBe(true)
		expect(await verifyRedaction(client, begun.size, begun.redaction)).toEqual({ ok: true })
	}

	const bytes = await upload(client)

	await client.call("saveEnd", { outcome: "saved", next: "continue" })

	return bytes
}

async function pdfjsTexts(bytes: Uint8Array, password?: string): Promise<string[]> {
	const pdf = await openPdf(bytes, password)
	const out: string[] = []

	for (let page = 1; page <= pdf.numPages; page++) out.push(await pageText(pdf, page))

	await pdf.loadingTask.destroy()

	return out
}

function mupdfTexts(bytes: Uint8Array, password?: string): string[] {
	const doc = mupdf.Document.openDocument(bytes, "application/pdf")

	if (password !== undefined) doc.authenticatePassword(password)

	return Array.from({ length: doc.countPages() }, (_, index) => doc.loadPage(index).toStructuredText("").asText().trim())
}

function pdfPage(doc: mupdf.PDFDocument, index: number): mupdf.PDFPage {
	const page = doc.loadPage(index)

	if (!(page instanceof mupdf.PDFPage)) throw new Error("not a PDF page")

	return page
}

function pngBytes(width: number, height: number): Uint8Array {
	const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false)

	pixmap.clear(128)

	const png = pixmap.asPNG().slice()

	pixmap.destroy()

	return png
}

// An unsigned 3-page document: "Page N" at the top of each page, a rect lower down.
function plainPdf(): Uint8Array {
	const doc = new mupdf.PDFDocument()
	const font = doc.addSimpleFont(new mupdf.Font("Helvetica"))

	for (let index = 0; index < 3; index++) {
		doc.insertPage(
			-1,
			doc.addPage(
				[0, 0, 612, 792],
				0,
				doc.addObject({ Font: { F1: font } }),
				`BT /F1 24 Tf 72 720 Td (Page ${String(index + 1)}) Tj ET 0 0 1 rg 72 400 100 50 re f`
			)
		)
	}

	const bytes = doc.saveToBuffer("compress").asUint8Array().slice()

	doc.destroy()

	return bytes
}

describe("page commands", () => {
	it("reports every position a change moved", () => {
		expect(changedPages({ from: [0, 2, 1, 3], touched: [], tagged: false })).toEqual([1, 2])
		expect(changedPages({ from: [0, 1, -1, 2], touched: [2], tagged: false })).toEqual([2, 3])
		expect(changedPages({ from: [0, 1, 2], touched: [1], tagged: false })).toEqual([1])
	})

	it(
		"moves, rotates, duplicates, inserts and deletes pages as undoable steps, saved and reopened",
		async () => {
			const bytes = plainPdf()
			const engine = startEngine(bytes)

			await engine.open()

			const moved = await engine.client.call("dispatch", { command: "pages.move", args: { order: [2, 0, 1] } })

			expect(moved.pages).toEqual([0, 1, 2])
			expect(moved.state).toMatchObject({ undoLabel: "pages.move", dirty: true, changes: ["pages"] })
			expect(await texts(engine.client)).toEqual(["Page 3", "Page 1", "Page 2"])

			const rotated = await engine.client.call("dispatch", { command: "pages.rotate", args: { pages: [1], degrees: 90 } })

			expect(rotated.pages).toEqual([1])
			expect((await engine.client.call("pages", { from: 1, count: 1 }))[0]).toMatchObject({ width: 792, height: 612 })

			const duplicated = await engine.client.call("dispatch", { command: "pages.duplicate", args: { pages: [0] } })

			expect(duplicated.state.pageCount).toBe(4)
			expect(duplicated.pages).toEqual([1, 2, 3])

			const blank = await engine.client.call("dispatch", { command: "pages.insertBlank", args: { at: 4, count: 1 } })

			expect(blank.state.pageCount).toBe(5)
			expect(blank.pages).toEqual([4])

			const image = await engine.client.call("dispatch", { command: "pages.insertImage", args: { at: 0, bytes: pngBytes(40, 20) } })

			expect(image.state.pageCount).toBe(6)
			// A landscape picture turns its page landscape.
			expect((await engine.client.call("pages", { from: 0, count: 1 }))[0]).toMatchObject({ width: 792, height: 612 })

			const deleted = await engine.client.call("dispatch", { command: "pages.delete", args: { pages: [0, 5] } })

			expect(deleted.state).toMatchObject({ pageCount: 4 })
			expect(await texts(engine.client)).toEqual(["Page 3", "Page 3", "Page 1", "Page 2"])

			// Every page cannot go; a bad picture is refused; nothing is left behind by either.
			await expect(engine.client.call("dispatch", { command: "pages.delete", args: { pages: [0, 1, 2, 3] } })).rejects.toMatchObject({
				failure: "badRequest",
				message: "lastPage"
			})
			await expect(
				engine.client.call("dispatch", { command: "pages.insertImage", args: { at: 0, bytes: new Uint8Array([1, 2, 3]) } })
			).rejects.toMatchObject({ failure: "badRequest" })
			await expect(
				engine.client.call("dispatch", { command: "pages.rotate", args: { pages: [9], degrees: 90 } })
			).rejects.toMatchObject({
				failure: "badRequest"
			})
			expect((await engine.client.call("state", {})).undoLabel).toBe("pages.delete")

			// Undo of the delete brings the pages back; redo deletes them again.
			const undone = await engine.client.call("undo", {})

			expect(undone.state).toMatchObject({ pageCount: 6 })

			const redone = await engine.client.call("redo", {})

			expect(redone.state).toMatchObject({ pageCount: 4 })

			const saved = await save(engine.client, bytes.length, true)

			expect(mupdfTexts(saved)).toEqual(["Page 3", "Page 3", "Page 1", "Page 2"])
			expect(await pdfjsTexts(saved)).toEqual(["Page 3", "Page 3", "Page 1", "Page 2"])

			const reopened = mupdf.Document.openDocument(saved, "application/pdf").asPDF()

			expect(reopened?.countVersions()).toBe(1)
			expect(reopened?.findPage(2).get("Rotate").asNumber()).toBe(90)

			// Past the save: the document as opened, the earlier steps run again.
			for (let step = 0; step < 6; step++) await engine.client.call("undo", {})

			expect(await texts(engine.client)).toEqual(["Page 1", "Page 2", "Page 3"])

			for (let step = 0; step < 6; step++) await engine.client.call("redo", {})

			expect(await texts(engine.client)).toEqual(["Page 3", "Page 3", "Page 1", "Page 2"])
		},
		TIMEOUT
	)

	it(
		"inserts pages of a second document, asking for its password, and keeps it for steps run again",
		async () => {
			const bytes = plainPdf()
			const engine = startEngine(bytes)

			await engine.open()

			const locked = makeOrganisedPdf({ userPassword: "pässword" })
			const asked = serveBytes(locked)

			expect(await engine.client.call("attachSource", { channel: asked.channel }, [asked.channel.port])).toEqual({
				status: "password"
			})

			const wrong = serveBytes(locked)

			expect(await engine.client.call("attachSource", { channel: wrong.channel, password: "nope" }, [wrong.channel.port])).toEqual({
				status: "password"
			})

			const right = serveBytes(locked)
			const attached = await engine.client.call("attachSource", { channel: right.channel, password: "pässword" }, [
				right.channel.port
			])

			if (attached.status !== "open") throw new Error("not open")

			expect(attached.pageCount).toBe(6)

			const other = serveBytes(makeOtherPdf())
			const second = await engine.client.call("attachSource", { channel: other.channel }, [other.channel.port])

			if (second.status !== "open") throw new Error("not open")

			const inserted = await engine.client.call("dispatch", {
				command: "pages.insertFrom",
				args: { at: 1, source: second.source, pages: [0, 2] }
			})

			expect(inserted.pages).toEqual([1, 2, 3, 4])
			expect(await texts(engine.client)).toEqual(["Page 1", "Other 1", "Other 3", "Page 2", "Page 3"])

			await engine.client.call("dispatch", { command: "pages.insertFrom", args: { at: 5, source: attached.source, pages: [1] } })

			expect((await texts(engine.client))[5]).toBe("Page 2")

			// An unopened source is refused; a source no step uses can be let go.
			await expect(
				engine.client.call("dispatch", { command: "pages.insertFrom", args: { at: 0, source: 99, pages: [0] } })
			).rejects.toMatchObject({ failure: "badRequest" })

			const notPdf = serveBytes(new TextEncoder().encode("not a pdf at all"))

			await expect(engine.client.call("attachSource", { channel: notPdf.channel }, [notPdf.channel.port])).rejects.toMatchObject({
				failure: "notPdf"
			})

			const saved = await save(engine.client, bytes.length)
			const savedTexts = ["Page 1", "Other 1", "Other 3", "Page 2", "Page 3", "Page 2"]

			expect(await pdfjsTexts(saved)).toEqual(savedTexts)

			// Scripts of inserted pages are dropped.
			expect(new TextDecoder("latin1").decode(saved)).not.toContain("app.alert")

			// Undo past the save rebuilds from the file as opened and inserts from the held sources again.
			await engine.client.call("undo", {})
			await engine.client.call("undo", {})
			expect(await texts(engine.client)).toEqual(["Page 1", "Page 2", "Page 3"])
			await engine.client.call("redo", {})
			await engine.client.call("redo", {})
			expect(await texts(engine.client)).toEqual(savedTexts)
		},
		TIMEOUT
	)

	it(
		"checks a redaction where its page shows after a later rotation and crop",
		async () => {
			const bytes = plainPdf()
			const engine = startEngine(bytes)

			await engine.open()
			// An area clear of the blue rectangle, which the turned and cropped page shows where the area was before.
			await engine.client.call("dispatch", { command: "redact.markArea", args: { page: 0, rect: [300, 40, 600, 100] } })
			await engine.client.call("dispatch", {
				command: "redact.apply",
				args: { page: 0, removeAnnotations: true, terms: [], sanitize: false }
			})
			await engine.client.call("dispatch", { command: "pages.rotate", args: { pages: [0], degrees: 90 } })
			await engine.client.call("dispatch", {
				command: "crop.set",
				args: { pages: [0], margins: { left: 20, top: 30, right: 40, bottom: 50 } }
			})

			await save(engine.client, bytes.length, true, [0])
		},
		TIMEOUT
	)

	it(
		"crops, fits to content, and removes what lies outside a crop",
		async () => {
			const bytes = plainPdf()
			const engine = startEngine(bytes)

			await engine.open()

			// The top 150 pt hold "Page N".
			const margins = { left: 36, top: 150, right: 36, bottom: 36 }
			const cropped = await engine.client.call("dispatch", { command: "crop.set", args: { pages: [0], margins } })

			expect(cropped.pages).toEqual([0])
			expect((await engine.client.call("pages", { from: 0, count: 1 }))[0]).toMatchObject({ width: 540, height: 606 })

			const fitted = await engine.client.call("dispatch", { command: "crop.toContent", args: { pages: [2], padding: 0 } })

			expect(fitted.pages).toEqual([2])

			const removed = await engine.client.call("dispatch", { command: "crop.removeOutside", args: { pages: [1], margins } })

			expect(removed.pages).toEqual([1])
			expect(removed.state).toMatchObject({ changes: ["pages", "content"] })

			await expect(
				engine.client.call("dispatch", { command: "crop.set", args: { pages: [0], margins: { ...margins, left: -1 } } })
			).rejects.toMatchObject({ failure: "badRequest" })

			const saved = await save(engine.client, bytes.length, true, [1])
			const doc = mupdf.Document.openDocument(saved, "application/pdf").asPDF()

			if (doc === null) throw new Error("not a PDF")

			// Cropping alone hides: page 1's text is still in the file. The removing crop deleted page 2's.
			for (const index of [0, 1]) doc.findPage(index).delete("CropBox")

			expect(doc.loadPage(0).toStructuredText("").asText()).toContain("Page 1")
			expect(doc.loadPage(1).toStructuredText("").asText()).not.toContain("Page 2")
			expect(new TextDecoder("latin1").decode(doc.saveToBuffer("decompress").asUint8Array())).not.toContain("(Page 2)")
			// pdf.js reads only what the crop boxes show.
			expect(await pdfjsTexts(saved)).toEqual(["", "", "Page 3"])

			const third = doc.loadPage(2).getBounds()

			// Fitted to the blue rect (72-172 × 342-392 from the top) and the text above it.
			expect(third[2] - third[0]).toBeLessThan(200)
			doc.destroy()
		},
		TIMEOUT
	)

	it("keeps the user's pending redaction marks when it removes what lies outside a crop", () => {
		const doc = mupdf.Document.openDocument(makeMarginsPdf(), "application/pdf").asPDF()

		if (doc === null) throw new Error("not a PDF")

		doc.enableJournal()

		const pages = new Map<number, mupdf.PDFPage>()
		const context: PdfCommandContext = {
			mupdf,
			document: doc,
			signatures: PDF_UNSIGNED,
			page: index => {
				const page = pages.get(index) ?? pdfPage(doc, index)

				pages.set(index, page)

				return page
			},
			pageOf: () => undefined,
			now: () => new Date()
		}
		let page = pdfPage(doc, 0)

		// One area mark inside the crop and one text mark over its edge.
		markArea(page, [250, 350, 300, 400])
		markText(page, [[190, 290, 260, 290, 190, 310, 260, 310]])
		page.destroy()

		const command = CROP_COMMANDS["crop.removeOutside"]
		const args = command.parse({ pages: [0], margins: { left: 150, top: 250, right: 150, bottom: 250 } })

		if (args === null) throw new Error("refused")

		doc.beginOperation("crop.removeOutside")
		expect(command.run(context, args)).toEqual([0])
		doc.endOperation()

		page = pdfPage(doc, 0)

		const marks = pageRedactionMarks(page, 0)

		expect(marks.map(mark => mark.kind).sort()).toEqual(["area", "text"])
		expect(page.getBounds()).toEqual([0, 0, 295, 342])
		page.destroy()

		// One undo step reverts it all.
		doc.undo()
		page = pdfPage(doc, 0)
		expect(page.getBounds()).toEqual([0, 0, 595, 842])
		expect(pageRedactionMarks(page, 0)).toHaveLength(2)
		doc.destroy()
	})

	it(
		"makes new files of pages, encrypted like the document unless its owner says, without changing it",
		async () => {
			const locked = makeOrganisedPdf({ userPassword: "pässword" })
			const engine = startEngine(locked)

			// A signed document: its pages cannot be organised, yet new files can be made of them.
			await engine.open("pässword")

			const before = await engine.client.call("state", {})
			const begun = await engine.client.call("extractBegin", {
				pages: [0, 2],
				protect: true,
				inputBytes: locked.length,
				memory: PDF_DESKTOP_MEMORY
			})

			if (begun.status !== "written") throw new Error("refused")

			expect(begun).toMatchObject({ pageCount: 2, encryption: PDF_EXTRACT_ENCRYPTION })
			expect(
				await verify(engine.client, begun.size, { pageCount: 2, versions: 1, encryption: begun.encryption }, "pässword")
			).toEqual({ ok: true })

			const encrypted = await upload(engine.client)
			const ended = await engine.client.call("saveEnd", { outcome: "copied", next: "continue" })

			expect(before.tools.pages).toBe("signed")
			expect(ended.state).toMatchObject({ dirty: false, canUndo: false, pageCount: 6 })
			expect(await pdfjsTexts(encrypted, "pässword")).toEqual(["Page 1", "Page 3"])

			// Opened with the user password, leaving the protection off is not this session's to choose.
			const kept = await engine.client.call("extractBegin", {
				pages: [1],
				protect: false,
				inputBytes: locked.length,
				memory: PDF_DESKTOP_MEMORY
			})

			if (kept.status !== "written") throw new Error("refused")

			expect(kept.encryption).toBe(PDF_EXTRACT_ENCRYPTION)
			await engine.client.call("saveEnd", { outcome: "failed", next: "continue" })

			// Opened with the owner password, it is.
			const owned = startEngine(locked)

			await owned.open("owner-pässword")

			const open = await owned.client.call("extractBegin", {
				pages: [1],
				protect: false,
				inputBytes: locked.length,
				memory: PDF_DESKTOP_MEMORY
			})

			if (open.status !== "written") throw new Error("refused")

			expect(open.encryption).toBe("None")
			expect(await verify(owned.client, open.size, { pageCount: 1, versions: 1, encryption: "None" })).toEqual({ ok: true })

			const plain = await upload(owned.client)

			await owned.client.call("saveEnd", { outcome: "copied", next: "continue" })
			expect(mupdf.Document.openDocument(plain, "application/pdf").needsPassword()).toBe(false)
			expect(await pdfjsTexts(plain)).toEqual(["Page 2"])

			// A document without a password makes files without one, whatever is asked.
			const unlocked = startEngine(plainPdf())

			await unlocked.open()
			await unlocked.client.call("dispatch", { command: "pages.rotate", args: { pages: [0], degrees: 90 } })

			const free = await unlocked.client.call("extractBegin", {
				pages: [0],
				protect: true,
				inputBytes: 1,
				memory: PDF_DESKTOP_MEMORY
			})

			expect(free).toMatchObject({ status: "written", encryption: "None" })

			// The rotation made in the editor is in the new file.
			const rotated = await upload(unlocked.client)

			expect(mupdf.Document.openDocument(rotated, "application/pdf").asPDF()?.findPage(0).get("Rotate").asNumber()).toBe(90)

			// One at a time: a held file refuses another and a save.
			await expect(
				unlocked.client.call("extractBegin", { pages: [0], protect: true, inputBytes: 1, memory: PDF_DESKTOP_MEMORY })
			).rejects.toMatchObject({ failure: "badRequest" })
			expect((await unlocked.client.call("saveEnd", { outcome: "failed", next: "continue" })).state).toMatchObject({
				dirty: true,
				undoLabel: "pages.rotate"
			})
			await expect(
				unlocked.client.call("extractBegin", { pages: [7], protect: true, inputBytes: 1, memory: PDF_DESKTOP_MEMORY })
			).rejects.toMatchObject({ failure: "badRequest" })
		},
		TIMEOUT
	)
})

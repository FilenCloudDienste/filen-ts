import { MessageChannel } from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { savePortReader, type SavePortEnd } from "@filen/shared/savePort"
import { PDF_DESKTOP_MEMORY } from "../../core/pdfedit"
import { buildPdfCms, type PdfSigningIdentity } from "../../core/pdfsign"
import { cmsCapacity } from "../../core/pdfsign/cmsBuild"
import { matchPdfFont } from "../../core/pdfedit/fontMatch"
import { PdfEngineError, type PdfEngineClient } from "../../dom/pdfedit/client"
import { TEXT_EDIT_UNSAFE, type PdfSignFieldArgs } from "../../dom/pdfedit/commands/index"
import type { PdfSignPort } from "../../dom/pdfedit/protocol"
import { newTextFrame } from "../../dom/pdfedit/textEdit/target"
import { pdfSignatureFields } from "../../dom/pdf/signatureFields"
import { makeFormPdf, makePdf } from "./fixtures"
import { startEngine, stopEngines } from "./harness"
import { scannedPdf, textPage } from "./ocrFixtures"
import { LATIN_CONTENT, LINE, makeDocument, save, SECOND } from "./textEditFixtures"
import { loadIdentity, signingSubtle, verifySigned } from "../pdfSignCreateFixtures"
import { budget } from "../timing"

// The tools' engine requests and commands end to end in an engine worker with the real MuPDF: text edited and added,
// recognised text laid over a page, a certificate signature placed and signed by a signing save, and the editor
// checking the file's signatures.

afterEach(stopEngines)

const TIMEOUT = budget(60_000)
// Helvetica's first line, display space (y down, A4).
const LINE_POINT: readonly [number, number] = [100, 842 - 722 - 4]

async function pageText(bytes: Uint8Array, password?: string): Promise<string> {
	const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, ...(password === undefined ? {} : { password }) })
	const document = await task.promise
	const content = await (await document.getPage(1)).getTextContent()

	await task.destroy()

	return content.items.map(item => ("str" in item ? item.str : "")).join(" ")
}

function mupdfFinds(bytes: Uint8Array, word: string): boolean {
	const document = new mupdf.PDFDocument(bytes.slice())
	const page = document.loadPage(0)
	const found = page.search(word, "").length > 0

	page.destroy()
	document.destroy()

	return found
}

async function failureOf(call: Promise<unknown>): Promise<PdfEngineError> {
	try {
		await call
	} catch (error) {
		if (error instanceof PdfEngineError) return error

		throw error
	}

	throw new Error("the call did not fail")
}

// The held output streamed over a save port, read here as an upload would.
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

// A plain save to the end, kept as a new version. `removesContent`: what the save says of content removed since the
// last one (the earlier-versions warning).
async function saveVersion(client: PdfEngineClient, size: number, removesContent = false): Promise<Uint8Array> {
	const begun = await client.call("saveBegin", { inputBytes: size, memory: PDF_DESKTOP_MEMORY, invalidateConfirmed: false })

	expect(begun).toMatchObject({ status: "written", removesContent })

	const bytes = await upload(client)

	await client.call("saveEnd", { outcome: "saved", next: "continue" })

	return bytes
}

describe("editing text in the engine", () => {
	it(
		"replaces a word, undoes and redoes it, and saves it where pdf.js reads it",
		async () => {
			const bytes = save(makeDocument({ pages: [{ content: LATIN_CONTENT }] }))
			const engine = startEngine(bytes)

			await engine.open()

			const hit = await engine.client.call("textHit", { page: 0, point: LINE_POINT, unit: "line" })

			if (hit.kind !== "target") throw new Error("no text under the point")

			expect(hit.target.text).toBe(LINE)

			const start = hit.target.text.indexOf("brave")
			const chars = hit.target.chars.filter((_, index) => {
				const offset = hit.target.offsets[index] ?? -1

				return offset >= start && offset < start + 5
			})
			const overlay = await engine.client.call("textPrepare", { source: hit.target, text: "Hello bold new world", style: {} })

			expect(overlay).toBeInstanceOf(Uint8Array)

			// The whole line replaced (its glyphs), then a word removed.
			let result = await engine.client.call("dispatch", {
				command: "textEdit.replace",
				args: { page: 0, chars: hit.target.chars, overlay }
			})

			expect(result.pages).toEqual([0])
			expect(result.state).toMatchObject({ dirty: true, canUndo: true, undoLabel: "textEdit.replace" })

			let text = (await engine.client.call("text", { page: 0 })).lines.map(line => line.str).join("\n")

			expect(text).toContain("Hello bold new world")
			expect(text).not.toContain("brave")
			expect(text).toContain(SECOND)

			result = await engine.client.call("undo", {})
			text = (await engine.client.call("text", { page: 0 })).lines.map(line => line.str).join("\n")
			expect(text).toContain(LINE)
			expect(result.state.canRedo).toBe(true)

			await engine.client.call("redo", {})
			text = (await engine.client.call("text", { page: 0 })).lines.map(line => line.str).join("\n")
			expect(text).toContain("Hello bold new world")

			const saved = await saveVersion(engine.client, bytes.length, true)
			const read = await pageText(saved)

			expect(read).toContain("Hello bold new world")
			expect(read).toContain(SECOND)
			expect(read).not.toContain("brave")
			expect(chars.map(char => char.c).join("")).toBe("brave")
		},
		TIMEOUT
	)

	it(
		"refuses a replacement that would take a neighbour with it, leaving nothing to undo",
		async () => {
			const bytes = save(makeDocument({ pages: [{ content: "BT /F1 12 Tf 72 722 Td [(A) 580 (B) ( tail)] TJ ET" }] }))
			const engine = startEngine(bytes)

			await engine.open()

			const hit = await engine.client.call("textHit", { page: 0, point: [80, 842 - 722 - 4] })

			if (hit.kind !== "target") throw new Error("no text under the point")

			const a = hit.target.chars.filter(char => char.c === "A")
			const failure = await failureOf(
				engine.client.call("dispatch", { command: "textEdit.replace", args: { page: 0, chars: a, overlay: null } })
			)

			expect(failure.failure).toBe("notAllowed")
			expect(failure.message).toBe(TEXT_EDIT_UNSAFE)
			expect(await engine.client.call("state", {})).toMatchObject({ dirty: false, canUndo: false })
		},
		TIMEOUT
	)

	it(
		"adds text where there was none and refuses text drawn as shapes",
		async () => {
			const content = `${LATIN_CONTENT} 0 g 72 400 m 80 430 l 88 400 l h f 90 400 m 98 430 l 106 400 l h f`
			const bytes = save(makeDocument({ pages: [{ content }] }))
			const engine = startEngine(bytes)

			await engine.open()

			expect(await engine.client.call("textHit", { page: 0, point: [80, 842 - 410] })).toEqual({
				kind: "refused",
				reason: "cantEdit"
			})
			expect(await engine.client.call("textHit", { page: 0, point: [300, 600] })).toEqual({ kind: "none" })

			const overlay = await engine.client.call("textPrepare", {
				source: {
					frame: newTextFrame([300, 600], 14),
					size: 14,
					color: 0x112233,
					font: matchPdfFont({ name: "", bold: false, italic: false, serif: false, mono: false }),
					pageWidth: 595,
					pageHeight: 842
				},
				text: "Added note",
				style: {}
			})

			if (overlay === null) throw new Error("no overlay")

			await engine.client.call("dispatch", { command: "textEdit.add", args: { page: 0, overlay } })

			const saved = await saveVersion(engine.client, bytes.length)

			expect(await pageText(saved)).toContain("Added note")
			expect(mupdfFinds(saved, "Added note")).toBe(true)
		},
		TIMEOUT
	)

	it(
		"refuses malformed text commands",
		async () => {
			const engine = startEngine(save(makeDocument({ pages: [{ content: LATIN_CONTENT }] })))

			await engine.open()

			for (const args of [
				{ page: 0, chars: [], overlay: null },
				{ page: 0, chars: [{ c: "A", x: 1, y: 2, quad: [1, 2, 3] }], overlay: null },
				{ page: 0, chars: [{ c: "A", x: 1, y: 2, quad: [1, 2, 3, 4, 5, 6, 7, 8] }], overlay: "pdf" }
			]) {
				expect((await failureOf(engine.client.call("dispatch", { command: "textEdit.replace", args }))).failure).toBe("badRequest")
			}

			expect(
				(
					await failureOf(
						engine.client.call("dispatch", { command: "textEdit.add", args: { page: 9, overlay: new Uint8Array(4) } })
					)
				).failure
			).toBe("badRequest")
		},
		TIMEOUT
	)
})

describe("recognised text in the engine", () => {
	it(
		"finds the scanned pages, renders one for the recogniser and lays text over it as one step",
		async () => {
			const scan = scannedPdf({ lines: ["Searchable words here"], dpi: 150 })
			const merged = new mupdf.PDFDocument(scan.slice())

			// Page 2 is text: never a candidate.
			merged.graftPage(-1, textPage(["Plain text page"]), 0)

			const bytes = merged.saveToBuffer("compress").asUint8Array().slice()

			merged.destroy()

			const engine = startEngine(bytes)

			await engine.open()

			expect(await engine.client.call("ocrScan", {})).toEqual({ scanned: [0] })

			const rendered = await engine.client.call("ocrRender", { page: 0 })

			expect(rendered.pixels.length).toBeGreaterThanOrEqual(rendered.stride * rendered.height)
			expect(rendered.dpi).toBeGreaterThanOrEqual(150)
			await engine.client.call("ocrFlush", {})

			// A recogniser's page stands in: a text page of the page's size laid over it unscaled.
			const overlay = textPage(["Recognised overlay"]).saveToBuffer("").asUint8Array().slice()
			const result = await engine.client.call("dispatch", {
				command: "ocr.applyPage",
				args: { page: 0, pdf: overlay, matrix: [1, 0, 0, 1, 0, 0] }
			})

			expect(result.pages).toEqual([0])
			expect(result.state.changes).toContain("content")
			expect((await engine.client.call("text", { page: 0 })).lines.map(line => line.str).join(" ")).toContain("Recognised overlay")

			await engine.client.call("undo", {})
			expect((await engine.client.call("text", { page: 0 })).lines.map(line => line.str).join(" ")).not.toContain("Recognised")
			await engine.client.call("redo", {})

			const saved = await saveVersion(engine.client, bytes.length)

			expect(await pageText(saved)).toContain("Recognised overlay")
			expect(mupdfFinds(saved, "Recognised")).toBe(true)
			expect(
				(
					await failureOf(
						engine.client.call("dispatch", {
							command: "ocr.applyPage",
							args: { page: 0, pdf: overlay, matrix: [0, 0, 0, 0, 0, 0] }
						})
					)
				).failure
			).toBe("badRequest")
		},
		TIMEOUT
	)
})

// Answers the engine's digests with the CMS, as the page relays them to the signer worker.
function signerPort(identity: PdfSigningIdentity): PdfSignPort {
	const channel = new MessageChannel()

	channel.port2.on("message", (message: { digest: Uint8Array }) => {
		void buildPdfCms(identity, message.digest, signingSubtle).then(
			cms => {
				channel.port2.postMessage({ cms })
			},
			(error: unknown) => {
				channel.port2.postMessage({ error: String(error) })
			}
		)
	})

	return channel.port1 as unknown as PdfSignPort
}

function fieldArgs(identity: PdfSigningIdentity, page: number, rect: readonly [number, number, number, number]): PdfSignFieldArgs {
	return {
		placement: { kind: "rect", page, rect: [...rect] },
		visual: null,
		lines: ["Signed by Fixture", "2026-11-14"],
		name: "Fixture Signer",
		reason: "Approval",
		location: null,
		time: Date.UTC(2026, 10, 14, 12),
		certify: null,
		capacity: cmsCapacity(identity)
	}
}

async function signSave(client: PdfEngineClient, identity: PdfSigningIdentity, size: number) {
	const signer = signerPort(identity)
	const begun = await client.call("signBegin", { inputBytes: size, memory: PDF_DESKTOP_MEMORY, digest: identity.scheme.digest, signer }, [
		signer
	])

	if (begun.status !== "written") throw new Error("not signed")

	const bytes = await upload(client)

	expect(bytes.length).toBe(begun.size)

	return { begun, bytes }
}

describe("signing with a certificate in the engine", () => {
	it.each(["rsa2048", "p256", "legacy-3des"])(
		"signs a placed signature as the save's last step (%s), and the editor then checks it unchanged",
		async name => {
			const identity = await loadIdentity(name)
			const bytes = makePdf({ pages: 1 })
			const engine = startEngine(bytes)

			await engine.open()
			await engine.client.call("dispatch", { command: "sign.addField", args: fieldArgs(identity, 0, [320, 100, 520, 160]) })

			// A plain save never writes the unsigned placeholder.
			expect(
				(
					await failureOf(
						engine.client.call("saveBegin", {
							inputBytes: bytes.length,
							memory: PDF_DESKTOP_MEMORY,
							invalidateConfirmed: false
						})
					)
				).failure
			).toBe("badRequest")

			const { begun, bytes: signed } = await signSave(engine.client, identity, bytes.length)

			expect(begun.versions).toBe(2)

			const report = await verifySigned(signed)

			expect(report.signatures.map(signature => signature.state)).toEqual(["unchanged"])

			const ended = await engine.client.call("saveEnd", { outcome: "saved", next: "adopt" })

			expect(ended.history).toBe("reset")
			expect(ended.state.signatures.fields).toEqual([begun.field])
			expect(ended.state.dirty).toBe(false)

			// The editor checks the file it now holds, with pdf.js's view of its fields.
			const checked = await engine.client.call("verifySignatures", {
				fields: pdfSignatureFields([{ fieldName: begun.field, byteRange: begun.byteRange }])
			})

			expect(checked.signatures.map(signature => signature.state)).toEqual(["unchanged"])
		},
		TIMEOUT
	)

	it(
		"signs a second time, keeping the first signature as changed with allowed changes",
		async () => {
			const identity = await loadIdentity("rsa2048")
			const bytes = makePdf({ pages: 1 })
			const engine = startEngine(bytes)

			await engine.open()
			await engine.client.call("dispatch", { command: "sign.addField", args: fieldArgs(identity, 0, [320, 100, 520, 160]) })

			const first = await signSave(engine.client, identity, bytes.length)

			await engine.client.call("saveEnd", { outcome: "saved", next: "adopt" })
			await engine.client.call("dispatch", { command: "sign.addField", args: fieldArgs(identity, 0, [320, 200, 520, 260]) })

			const second = await signSave(engine.client, identity, first.bytes.length)

			expect(second.bytes.subarray(0, first.bytes.length)).toEqual(first.bytes)

			const report = await verifySigned(second.bytes)

			expect(report.signatures.map(signature => signature.state)).toEqual(["changed", "unchanged"])
			expect(report.signatures[0]?.changes?.allowed).toBe(true)
		},
		TIMEOUT
	)

	it(
		"rewrites an unsigned document's other changes into the signed file, and drops a signature it did not keep",
		async () => {
			const identity = await loadIdentity("p256")
			const bytes = makeFormPdf()
			const engine = startEngine(bytes)

			await engine.open()

			const widgets = await engine.client.call("widgets", { pages: [0] })
			const name = widgets[0]?.widgets.find(widget => widget.field === "name")

			if (name === undefined) throw new Error("no field")

			await engine.client.call("dispatch", {
				command: "forms.setField",
				args: { page: 0, widget: name.id, value: { kind: "text", text: "Ada" } }
			})
			await engine.client.call("dispatch", { command: "sign.addField", args: fieldArgs(identity, 0, [320, 100, 520, 160]) })

			// Not kept: the upload failed. The signature goes, the field's value stays.
			await signSave(engine.client, identity, bytes.length)
			await engine.client.call("saveEnd", { outcome: "failed", next: "continue" })

			const discarded = await engine.client.call("signDiscard", {})

			expect(discarded.state).toMatchObject({ dirty: true, canRedo: false, undoLabel: "forms.setField" })

			// Placed again and kept: one file with the rewrite and the signature's revision.
			await engine.client.call("dispatch", { command: "sign.addField", args: fieldArgs(identity, 0, [320, 100, 520, 160]) })

			const { begun, bytes: signed } = await signSave(engine.client, identity, bytes.length)

			expect(begun.versions).toBe(2)
			expect((await verifySigned(signed)).signatures.map(signature => signature.state)).toEqual(["unchanged"])

			const values = await pdfjsValues(signed)

			expect(values["name"]).toBe("Ada")
		},
		TIMEOUT
	)

	it(
		"refuses to sign over new protection or a redaction not saved yet, which a plain Save writes and checks",
		async () => {
			const identity = await loadIdentity("p256")

			for (const pending of ["protection", "redaction"] as const) {
				const bytes = makePdf({ pages: 2 })
				const engine = startEngine(bytes)

				await engine.open()

				if (pending === "protection") {
					await engine.client.call("securitySet", { choice: { kind: "open", password: "secret" } })
				} else {
					await engine.client.call("dispatch", { command: "redact.markArea", args: { page: 1, rect: [60, 60, 500, 140] } })
					const applied = await engine.client.call("dispatch", {
						command: "redact.apply",
						args: { page: 1, removeAnnotations: false, terms: [], sanitize: false }
					})

					expect(applied.state.redacting).toBe(true)
				}

				await engine.client.call("dispatch", { command: "sign.addField", args: fieldArgs(identity, 0, [320, 100, 520, 160]) })

				const signer = signerPort(identity)
				const refusal = await failureOf(
					engine.client.call(
						"signBegin",
						{ inputBytes: bytes.length, memory: PDF_DESKTOP_MEMORY, digest: identity.scheme.digest, signer },
						[signer]
					)
				)

				expect(refusal).toMatchObject({ failure: "notAllowed", message: "saveFirst" })
			}
		},
		TIMEOUT
	)

	it(
		"signs on what the last save wrote, not on the file the document went on reading after it",
		async () => {
			const identity = await loadIdentity("p256")
			const bytes = makePdf({ pages: 2 })
			const engine = startEngine(bytes)

			await engine.open()
			await engine.client.call("dispatch", { command: "pages.delete", args: { pages: [1] } })

			// A rewrite kept as a version, the document going on on the file it opened (its history kept).
			const saved = await saveVersion(engine.client, bytes.length, true)

			await engine.client.call("dispatch", { command: "sign.addField", args: fieldArgs(identity, 0, [320, 100, 520, 160]) })

			const { bytes: signed } = await signSave(engine.client, identity, saved.length)

			expect((await verifySigned(signed)).signatures.map(signature => signature.state)).toEqual(["unchanged"])

			// The revision the signature was appended to is the saved rewrite (one page), never the opened file.
			const text = new TextDecoder("latin1").decode(signed)
			const firstEnd = text.indexOf("%%EOF") + "%%EOF".length
			const first = new mupdf.PDFDocument(signed.slice(0, firstEnd))

			expect(first.countPages()).toBe(1)
			expect(new mupdf.PDFDocument(signed.slice()).countPages()).toBe(1)
			first.destroy()
		},
		TIMEOUT
	)
})

async function pdfjsValues(bytes: Uint8Array): Promise<Record<string, unknown>> {
	const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 })
	const document = await task.promise
	const annotations = (await (await document.getPage(1)).getAnnotations()) as { fieldName?: string; fieldValue?: unknown }[]
	const values: Record<string, unknown> = {}

	for (const annotation of annotations) if (annotation.fieldName !== undefined) values[annotation.fieldName] = annotation.fieldValue

	await task.destroy()

	return values
}

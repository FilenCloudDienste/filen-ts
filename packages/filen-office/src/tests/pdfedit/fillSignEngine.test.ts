import { readFileSync } from "node:fs"
import { MessageChannel } from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { savePortReader, type SavePortEnd } from "@filen/shared/savePort"
import { PDF_DESKTOP_MEMORY, type PdfWidgetSummary } from "../../core/pdfedit"
import { normalizeStrokes } from "../../core/pdfedit/visualSignature"
import { pdfSignatureFields, type PdfSignatureFieldHint } from "../../dom/pdf"
import type { PdfEngineClient } from "../../dom/pdfedit/client"
import { startEngine, stopEngines } from "./harness"
import { budget } from "../timing"

// Forms and Fill & Sign as the editor runs them: the commands (one journal step each, undo and redo), the widgets'
// tab order, the required-fields check before a save, XFA removal, and the saved file read back by MuPDF and pdf.js.
// Fixtures: src/tests/fixtures/pdfforms (src/scripts/pdfFormFixtures.ts).

afterEach(stopEngines)

const TIMEOUT = budget(30_000)
const FIXTURES = new URL("../fixtures/pdfforms/", import.meta.url)

function fixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(new URL(name, FIXTURES)))
}

async function widgets(client: PdfEngineClient, page = 0): Promise<PdfWidgetSummary[]> {
	return (await client.call("widgets", { pages: [page] })).flatMap(entry => entry.widgets)
}

async function widget(client: PdfEngineClient, field: string, page = 0): Promise<PdfWidgetSummary> {
	const found = (await widgets(client, page)).find(entry => entry.field === field)

	if (found === undefined) throw new Error(`no widget ${field}`)

	return found
}

// The document as a save writes it (a copy: the session goes on).
async function saved(client: PdfEngineClient, inputBytes: number): Promise<Uint8Array> {
	const begun = await client.call("saveBegin", { inputBytes, memory: PDF_DESKTOP_MEMORY, invalidateConfirmed: false })

	if (begun.status !== "written") throw new Error("refused")

	const bytes = await upload(client)

	await client.call("saveEnd", { outcome: "copied", next: "continue" })

	return bytes
}

// The held output, streamed as an upload reads it.
async function upload(client: PdfEngineClient): Promise<Uint8Array> {
	const channel = new MessageChannel()
	const reader = savePortReader(channel.port2 as unknown as SavePortEnd)
	const written = client.call("writeOutput", { port: channel.port1 }, [channel.port1])
	const chunks: Uint8Array[] = []

	for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) chunks.push(chunk)

	reader.settled(true)
	await written

	const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
	let at = 0

	for (const chunk of chunks) {
		bytes.set(chunk, at)
		at += chunk.length
	}

	return bytes
}

// The signatures pdf.js reads, the hints the engine's check cross-checks.
async function pdfjsHints(bytes: Uint8Array): Promise<PdfSignatureFieldHint[] | null> {
	const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 })
	const hints = pdfSignatureFields(await (await task.promise).getSignatures())

	await task.destroy()

	return hints
}

async function pdfjsAnnotations(bytes: Uint8Array): Promise<Record<string, unknown>[][]> {
	const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 })
	const pdf = await task.promise
	const pages: Record<string, unknown>[][] = []

	for (let index = 1; index <= pdf.numPages; index++)
		pages.push((await (await pdf.getPage(index)).getAnnotations()) as Record<string, unknown>[])

	await task.destroy()

	return pages
}

function pngSignature(): Uint8Array {
	const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 90, 30], false)

	pixmap.clear(40)

	const png = pixmap.asPNG().slice()

	pixmap.destroy()

	return png
}

describe("form commands", () => {
	it(
		"fills every kind of field as one step each, refuses password and read-only fields, and saves",
		async () => {
			const source = fixture("acroform.pdf")
			const engine = startEngine(source)

			await engine.open()

			const set = async (field: string, value: unknown, page = 0) =>
				engine.client.call("dispatch", {
					command: "forms.setField",
					args: { page, widget: (await widget(engine.client, field, page)).id, value }
				})

			await set("name", { kind: "text", text: "Jane Doe" })
			await set("code", { kind: "text", text: "AB12CD99" })
			await set("agree", { kind: "checkbox", checked: true })
			await set("country", { kind: "choice", values: ["France"] })
			await set("city", { kind: "text", text: "Hamburg" })

			const toppings = await set("toppings", { kind: "choice", values: ["Olives", "Cheese"] })

			expect(toppings.widgets[0]?.widgets.find(entry => entry.field === "toppings")?.selected).toEqual(["Cheese", "Olives"])

			// The radio group's other button is on page 1: both pages change.
			const radio = await set("choice", { kind: "radio" }, 1)

			expect(radio.pages).toEqual([0, 1])
			expect((await widget(engine.client, "choice", 0)).value).toBe("B")

			await expect(set("password", { kind: "text", text: "s3cret" })).rejects.toMatchObject({ failure: "notAllowed" })
			await expect(set("readonly", { kind: "text", text: "x" })).rejects.toMatchObject({ failure: "notAllowed" })
			await expect(set("country", { kind: "choice", values: ["Spain"] })).rejects.toMatchObject({ failure: "badRequest" })
			await expect(set("agree", { kind: "nonsense" })).rejects.toMatchObject({ failure: "badRequest" })

			const state = await engine.client.call("state", {})

			expect(state).toMatchObject({ undoLabel: "forms.setField", changes: ["formFill"] })

			await engine.client.call("undo", {})
			expect((await widget(engine.client, "choice", 0)).value).toBe("Off")
			await engine.client.call("redo", {})
			expect((await widget(engine.client, "choice", 0)).value).toBe("B")

			const bytes = await saved(engine.client, source.length)
			const values = new Map(
				(await pdfjsAnnotations(bytes)).flat().map(annotation => [String(annotation["fieldName"]), annotation["fieldValue"]])
			)

			expect(values.get("name")).toBe("Jane Doe")
			expect(values.get("code")).toBe("AB12CD")
			expect(values.get("agree")).toBe("Yes")
			expect(values.get("country")).toEqual(["France"])
			expect(values.get("city")).toEqual(["Hamburg"])
			expect(values.get("toppings")).toEqual(["Cheese", "Olives"])
			// Never written.
			expect(values.get("password")).toBe("")
		},
		TIMEOUT
	)

	it(
		"reports the required fields still empty and clears the form",
		async () => {
			const engine = startEngine(fixture("acroform.pdf"))

			await engine.open()

			const required = await widget(engine.client, "required")

			expect(await engine.client.call("requiredFields", {})).toEqual({ count: 1, first: { page: 0, widget: required.id } })

			await engine.client.call("dispatch", {
				command: "forms.setField",
				args: { page: 0, widget: required.id, value: { kind: "text", text: "done" } }
			})
			expect(await engine.client.call("requiredFields", {})).toEqual({ count: 0, first: null })

			const reset = await engine.client.call("dispatch", { command: "forms.reset", args: {} })

			expect(reset.pages).toEqual([0, 1])
			expect((await widget(engine.client, "required")).value).toBe("")
			expect((await engine.client.call("requiredFields", {})).count).toBe(1)
		},
		TIMEOUT
	)

	it(
		"removes a hybrid form's XFA as an undoable step",
		async () => {
			const source = fixture("hybrid-xfa.pdf")
			const engine = startEngine(source)

			await engine.open()
			expect((await engine.client.call("state", {})).form.xfa).toBe("hybrid")

			await engine.client.call("dispatch", { command: "forms.removeXfa", args: {} })
			// Counted as a content change: a signed document's save would invalidate its signatures.
			expect(await engine.client.call("state", {})).toMatchObject({ form: { xfa: "none" }, changes: ["content"] })

			await engine.client.call("undo", {})
			expect((await engine.client.call("state", {})).form.xfa).toBe("hybrid")

			await engine.client.call("redo", {})

			const reopened = new mupdf.PDFDocument(await saved(engine.client, source.length))

			expect(reopened.getTrailer().get("Root", "AcroForm", "XFA").isNull()).toBe(true)
			reopened.destroy()
		},
		TIMEOUT
	)

	it(
		"counts removing a signed form's XFA as invalidating its signatures, and goes on with the file that rewrote them",
		async () => {
			// A signed form given an XFA packet afterwards (a hybrid form the signer signed).
			const signed = new mupdf.PDFDocument(readFileSync(new URL("../fixtures/pdfsign/approval-rsa.pdf", import.meta.url)))

			signed.getTrailer().get("Root", "AcroForm").put("XFA", signed.newString("<xdp:xdp/>"))

			const source = signed.saveToBuffer("incremental").asUint8Array().slice()

			signed.destroy()

			const engine = startEngine(source)

			await engine.open()
			expect(await engine.client.call("state", {})).toMatchObject({ tools: { formFill: null }, form: { xfa: "hybrid" } })

			await engine.client.call("dispatch", { command: "forms.removeXfa", args: {} })

			const begun = await engine.client.call("saveBegin", {
				inputBytes: source.length,
				memory: PDF_DESKTOP_MEMORY,
				invalidateConfirmed: false
			})

			expect(begun).toMatchObject({ status: "refused", reason: "invalidatesSignatures", plan: { mode: "full" } })

			// Confirmed: the rewrite becomes the file, and the engine goes on with it, so its signature check reads the
			// written file, never the signed one it opened.
			const before = await engine.client.call("verifySignatures", { fields: await pdfjsHints(source) })

			expect(before.signatures[0]?.state).not.toBe("invalid")

			const confirmed = await engine.client.call("saveBegin", {
				inputBytes: source.length,
				memory: PDF_DESKTOP_MEMORY,
				invalidateConfirmed: true
			})

			expect(confirmed).toMatchObject({ status: "written", plan: { mode: "full", invalidates: ["Signature1"] } })
			const written = await upload(engine.client)

			const ended = await engine.client.call("saveEnd", { outcome: "saved", next: "continue" })

			expect(ended).toMatchObject({ history: "reset", state: { dirty: false, form: { xfa: "none" } } })

			const after = await engine.client.call("verifySignatures", { fields: await pdfjsHints(written) })

			expect(after.signatures[0]?.state).toBe("invalid")

			// The file it now reads is its own: the hints for it are the engine's reading, as pdf.js would read the same
			// bytes, and the check against them is the verdict; the opened file's hints no longer describe it.
			expect(ended.state.ownFile).toBe(true)

			const own = await engine.client.call("signatureHints", {})

			expect(own).toEqual(await pdfjsHints(written))
			expect((await engine.client.call("verifySignatures", { fields: own })).signatures[0]?.state).toBe("invalid")
			expect((await engine.client.call("verifySignatures", { fields: await pdfjsHints(source) })).signatures[0]).toMatchObject({
				unverifiableReason: "parserMismatch"
			})
		},
		TIMEOUT
	)

	it(
		"orders a page's widgets by its structure tree when /Tabs is /S",
		async () => {
			const document = new mupdf.PDFDocument(fixture("acroform.pdf"))
			const page = document.findPage(0)
			const annots = page.get("Annots")
			const widgetsInOrder: mupdf.PDFObject[] = []

			for (let index = 0; index < annots.length; index++) widgetsInOrder.push(annots.get(index))

			// The structure reaches the page's widgets in reverse order.
			const kids = document.newArray()

			for (const annotation of [...widgetsInOrder].reverse()) {
				const objr = document.newDictionary()

				objr.put("Type", document.newName("OBJR"))
				objr.put("Obj", annotation)
				kids.push(objr)
			}

			const element = document.addObject(document.newDictionary())

			element.put("S", document.newName("Form"))
			element.put("K", kids)

			const root = document.addObject(document.newDictionary())

			root.put("Type", document.newName("StructTreeRoot"))
			root.put("K", element)
			document.getTrailer().get("Root").put("StructTreeRoot", root)
			page.put("Tabs", document.newName("S"))

			const bytes = document.saveToBuffer("garbage=no").asUint8Array().slice()
			const annotationOrder = widgetsInOrder.map(annotation => annotation.asIndirect())

			document.destroy()

			const engine = startEngine(bytes)

			await engine.open()

			const ordered = await widgets(engine.client)

			expect(ordered.map(entry => entry.id)).toEqual(annotationOrder.filter(id => ordered.some(entry => entry.id === id)).reverse())

			// Page 1 has no /Tabs: annotation order.
			const second = await widgets(engine.client, 1)

			expect(second.map(entry => entry.field)).toEqual(["choice", "page2"])
		},
		TIMEOUT
	)
})

describe("Fill & Sign commands", () => {
	it(
		"places text, marks, a drawn and an image signature as steps; undo and redo; saved for MuPDF and pdf.js",
		async () => {
			const source = fixture("acroform.pdf")
			const engine = startEngine(source)

			await engine.open()

			const strokes = normalizeStrokes([
				[0, 0, 30, 40, 60, 0],
				[10, 20, 50, 20]
			])

			if (strokes === null) throw new Error("no strokes")

			const place = (command: string, args: Record<string, unknown>) =>
				engine.client.call("dispatch", { command, args: { page: 1, author: "Jane Doe", ...args } })

			const text = await place("fillSign.text", {
				box: [300, 100, 500, 130],
				text: "Signed in Berlin",
				font: "sans",
				size: 14,
				color: [0, 0, 0]
			})

			expect(text.pages).toEqual([1])
			expect(text.state).toMatchObject({ undoLabel: "fillSign.text", changes: ["annotate"] })

			await place("fillSign.mark", { box: [100, 200, 120, 220], mark: "check", color: [0, 0, 0] })
			await place("fillSign.mark", { box: [130, 200, 150, 220], mark: "cross", color: [0, 0, 0] })
			await place("fillSign.mark", { box: [160, 205, 170, 215], mark: "dot", color: [0, 0, 0] })
			await place("fillSign.signature", { box: [100, 300, 400, 400], role: "signature", signature: strokes })

			const image = await place("fillSign.signature", {
				box: [100, 450, 220, 490],
				role: "initials",
				signature: { kind: "image", png: pngSignature(), width: 90, height: 30 }
			})

			expect(image.state.changes).toEqual(expect.arrayContaining(["annotate", "sign"]))

			// Refused: a box off the page, a picture that is not a PNG, an unknown mark.
			await expect(place("fillSign.mark", { box: [5000, 5000, 5020, 5020], mark: "check", color: [0, 0, 0] })).rejects.toMatchObject({
				failure: "badRequest"
			})
			await expect(
				place("fillSign.signature", {
					box: [100, 450, 220, 490],
					role: "signature",
					signature: { kind: "image", png: new Uint8Array([1, 2, 3]), width: 1, height: 1 }
				})
			).rejects.toMatchObject({ failure: "badRequest" })
			await expect(place("fillSign.mark", { box: [10, 10, 30, 30], mark: "star", color: [0, 0, 0] })).rejects.toMatchObject({
				failure: "badRequest"
			})

			await engine.client.call("undo", {})

			const afterUndo = new mupdf.PDFDocument(await saved(engine.client, source.length))

			expect(
				afterUndo
					.loadPage(1)
					.getAnnotations()
					.map(annotation => annotation.getType())
			).toEqual(["FreeText", "Ink", "Ink", "Circle", "Ink"])
			afterUndo.destroy()

			await engine.client.call("redo", {})

			const bytes = await saved(engine.client, source.length)
			const reopened = new mupdf.PDFDocument(bytes)
			const annotations = reopened.loadPage(1).getAnnotations()

			expect(annotations.map(annotation => annotation.getType())).toEqual(["FreeText", "Ink", "Ink", "Circle", "Ink", "Stamp"])
			expect(annotations.every(annotation => annotation.getAuthor() === "Jane Doe")).toBe(true)
			expect(annotations[4]?.getSubject()).toBe("Signature")
			expect(annotations[5]?.getSubject()).toBe("Initials")
			reopened.destroy()

			const theirs = (await pdfjsAnnotations(bytes))[1]?.map(annotation => annotation["subtype"]) ?? []

			expect(theirs).toEqual(expect.arrayContaining(["FreeText", "Ink", "Circle", "Stamp"]))
		},
		TIMEOUT
	)
})

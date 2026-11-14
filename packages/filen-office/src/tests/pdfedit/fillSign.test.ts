import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import {
	addFillMark,
	addFillText,
	hasFormScripts,
	missingRequiredFields,
	PdfFieldError,
	pdfFormScripts,
	pdfXfaKind,
	placeVisualSignature,
	readPageFields,
	removeXfa,
	resetForm,
	setFieldValue,
	type PdfFieldValue,
	type PdfFormField
} from "../../dom/pdfedit/fillSign"
import { normalizeStrokes, type PdfPageRect, type PdfSignatureImage } from "../../core/pdfedit/visualSignature"

// Fill & Sign over real MuPDF: every widget type set, saved, reopened in MuPDF and in pdf.js (another parser), and
// signatures / marks surviving a save. Fixtures: src/tests/fixtures/pdfforms (src/scripts/pdfFormFixtures.ts).

const FIXTURES = new URL("../fixtures/pdfforms/", import.meta.url)
const open: mupdf.PDFDocument[] = []

function load(name: string): mupdf.PDFDocument {
	const document = new mupdf.PDFDocument(readFileSync(new URL(name, FIXTURES)))

	document.disableJS()
	open.push(document)

	return document
}

function reopen(document: mupdf.PDFDocument): { document: mupdf.PDFDocument; bytes: Uint8Array } {
	const bytes = document.saveToBuffer("garbage=compact,compress").asUint8Array().slice()
	const again = new mupdf.PDFDocument(bytes)

	open.push(again)

	return { document: again, bytes }
}

afterEach(() => {
	for (const document of open.splice(0)) document.destroy()
})

function fields(document: mupdf.PDFDocument): PdfFormField[] {
	const all: PdfFormField[] = []

	for (let index = 0; index < document.countPages(); index++) all.push(...readPageFields(document.loadPage(index), index))

	return all
}

function field(document: mupdf.PDFDocument, name: string, page?: number): PdfFormField {
	const found = fields(document).find(item => item.name === name && (page === undefined || item.page === page))

	if (found === undefined) throw new Error(`no field ${name}`)

	return found
}

function set(document: mupdf.PDFDocument, name: string, value: PdfFieldValue, page?: number): number[] {
	const target = field(document, name, page)

	return setFieldValue(document, document.loadPage(target.page), target.page, target.widget, value)
}

interface PdfjsField {
	readonly value: unknown
	readonly page: number
	readonly annotation: Record<string, unknown>
}

async function pdfjsFields(bytes: Uint8Array): Promise<Map<string, PdfjsField[]>> {
	const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 })
	const pdf = await task.promise
	const result = new Map<string, PdfjsField[]>()

	for (let index = 1; index <= pdf.numPages; index++) {
		const page = await pdf.getPage(index)

		for (const annotation of (await page.getAnnotations()) as Record<string, unknown>[]) {
			const key = typeof annotation["fieldName"] === "string" ? annotation["fieldName"] : `#${String(annotation["subtype"])}`
			const list = result.get(key) ?? []

			list.push({ value: annotation["fieldValue"], page: index - 1, annotation })
			result.set(key, list)
		}
	}

	await task.destroy()

	return result
}

describe("form fields", () => {
	it("reads every widget type with its flags, label and options", () => {
		const document = load("acroform.pdf")
		const byName = new Map(fields(document).map(item => [`${item.name}@${String(item.page)}`, item]))

		expect(byName.get("name@0")).toMatchObject({ kind: "text", label: "Full name", value: "", readOnly: false })
		expect(byName.get("notes@0")).toMatchObject({ kind: "text", multiline: true })
		expect(byName.get("code@0")).toMatchObject({ kind: "text", comb: true, maxLength: 6 })
		expect(byName.get("zip@0")).toMatchObject({ kind: "text", maxLength: 5 })
		expect(byName.get("password@0")).toMatchObject({ kind: "text", password: true, label: "Password" })
		expect(byName.get("readonly@0")).toMatchObject({ readOnly: true, value: "fixed" })
		expect(byName.get("required@0")).toMatchObject({ required: true })
		expect(byName.get("agree@0")).toMatchObject({ kind: "checkbox", value: "Off", onState: "Yes" })
		expect(byName.get("choice@0")).toMatchObject({ kind: "radio", onState: "A" })
		expect(byName.get("choice@1")).toMatchObject({ kind: "radio", onState: "B" })
		expect(byName.get("country@0")).toMatchObject({ kind: "combo", editable: false })
		expect(byName.get("country@0")?.options.map(option => option.value)).toEqual(["Germany", "France", "Italy"])
		expect(byName.get("city@0")).toMatchObject({ kind: "combo", editable: true })
		expect(byName.get("colour@0")).toMatchObject({ kind: "list", multiSelect: false })
		expect(byName.get("toppings@0")).toMatchObject({ kind: "list", multiSelect: true })
		expect(byName.get("reset@0")).toMatchObject({ kind: "button" })
		expect(byName.get("signature@0")).toMatchObject({ kind: "signature" })
		expect(byName.get("page2@1")).toMatchObject({ kind: "text", label: "Second page" })
	})

	it("sets every field type; MuPDF and pdf.js read the values back after a save", async () => {
		const document = load("acroform.pdf")

		set(document, "name", { kind: "text", text: "Jane Doe" })
		set(document, "notes", { kind: "text", text: "line one\r\nline two" })
		set(document, "code", { kind: "text", text: "AB12CD99" })
		set(document, "zip", { kind: "text", text: "12345678" })
		set(document, "password", { kind: "text", text: "s3cret" })
		set(document, "required", { kind: "text", text: "single\nline" })
		set(document, "agree", { kind: "checkbox", checked: true })
		set(document, "country", { kind: "choice", values: ["France"] })
		set(document, "city", { kind: "text", text: "Hamburg" })
		set(document, "colour", { kind: "choice", values: ["Blue"] })
		set(document, "toppings", { kind: "choice", values: ["Olives", "Cheese"] })
		set(document, "page2", { kind: "text", text: "Zoë – ✓" })

		const pages = set(document, "choice", { kind: "radio" }, 1)

		// The group spans both pages: both are re-rendered.
		expect(pages.sort()).toEqual([0, 1])

		const saved = reopen(document)
		const after = saved.document

		expect(field(after, "name").value).toBe("Jane Doe")
		expect(field(after, "notes").value).toBe("line one\nline two")
		// Comb and max length clip to the field's length; a single-line field keeps its first line.
		expect(field(after, "code").value).toBe("AB12CD")
		expect(field(after, "zip").value).toBe("12345")
		expect(field(after, "required").value).toBe("single")
		expect(field(after, "password").value).toBe("s3cret")

		// A password field's appearance shows bullets, never the text (rendered, extracted, printed).
		const shown = (name: string): string =>
			after
				.loadPage(0)
				.getWidgets()
				.find(widget => widget.getName() === name)
				?.toDisplayList()
				.toStructuredText("")
				.asText() ?? ""

		expect(shown("name")).toContain("Jane Doe")
		expect(shown("password")).toContain("•".repeat(6))
		expect(shown("password")).not.toContain("s3cret")
		expect(field(after, "agree").value).toBe("Yes")
		expect(field(after, "choice", 0).value).toBe("B")
		expect(field(after, "country").selected).toEqual(["France"])
		expect(field(after, "city").value).toBe("Hamburg")
		expect(field(after, "colour").selected).toEqual(["Blue"])
		expect(field(after, "toppings").selected).toEqual(["Cheese", "Olives"])
		expect(field(after, "page2").value).toBe("Zoë – ✓")

		const theirs = await pdfjsFields(saved.bytes)
		const value = (name: string): unknown => theirs.get(name)?.[0]?.value

		expect(value("name")).toBe("Jane Doe")
		expect(value("notes")).toBe("line one\nline two")
		expect(value("code")).toBe("AB12CD")
		expect(value("zip")).toBe("12345")
		expect(value("password")).toBe("s3cret")
		expect(value("agree")).toBe("Yes")
		expect(theirs.get("choice")?.map(item => item.value)).toEqual(["B", "B"])
		expect(theirs.get("choice")?.map(item => item.annotation["buttonValue"])).toEqual(["A", "B"])
		expect(value("country")).toEqual(["France"])
		expect(value("city")).toEqual(["Hamburg"])
		expect(value("colour")).toEqual(["Blue"])
		expect(value("toppings")).toEqual(["Cheese", "Olives"])
		expect(value("page2")).toBe("Zoë – ✓")
	})

	it("switches a cross-page radio group back and unchecks a check box", () => {
		const document = load("acroform.pdf")

		set(document, "choice", { kind: "radio" }, 1)
		set(document, "choice", { kind: "radio" }, 0)
		set(document, "agree", { kind: "checkbox", checked: true })
		set(document, "agree", { kind: "checkbox", checked: false })

		const after = reopen(document).document

		expect(field(after, "choice", 1).value).toBe("A")
		expect(
			after
				.loadPage(1)
				.getWidgets()
				.find(widget => widget.getName() === "choice")
				?.getObject()
				.get("AS")
				.asName()
		).toBe("Off")
		expect(field(after, "agree").value).toBe("Off")
	})

	it("refuses read-only fields, wrong kinds and values that are not options; changes nothing", () => {
		const document = load("acroform.pdf")
		const refusal = (name: string, value: PdfFieldValue): unknown => {
			try {
				set(document, name, value)
			} catch (error) {
				return error instanceof PdfFieldError ? error.reason : error
			}

			return null
		}

		expect(refusal("readonly", { kind: "text", text: "changed" })).toBe("readOnly")
		expect(refusal("agree", { kind: "text", text: "x" })).toBe("wrongKind")
		expect(refusal("country", { kind: "choice", values: ["Spain"] })).toBe("notAnOption")
		expect(refusal("colour", { kind: "choice", values: ["Purple"] })).toBe("notAnOption")
		expect(refusal("country", { kind: "text", text: "Spain" })).toBe("wrongKind")
		expect(field(document, "readonly").value).toBe("fixed")
		expect(field(document, "country").selected).toEqual([])
	})

	it("clears the form and lists the empty required fields", () => {
		const document = load("acroform.pdf")

		expect(missingRequiredFields(document).map(item => item.name)).toEqual(["required"])

		set(document, "required", { kind: "text", text: "done" })
		set(document, "name", { kind: "text", text: "Jane" })
		set(document, "toppings", { kind: "choice", values: ["Ham", "Pepper"] })
		set(document, "choice", { kind: "radio" }, 1)

		expect(missingRequiredFields(document)).toEqual([])
		expect(resetForm(document)).toEqual([0, 1])

		const after = reopen(document).document

		expect(field(after, "name").value).toBe("")
		expect(field(after, "required").value).toBe("")
		expect(field(after, "toppings").selected).toEqual([])
		expect(field(after, "choice", 1).value).toBe("Off")
		expect(
			after
				.loadPage(1)
				.getWidgets()
				.find(widget => widget.getName() === "choice")
				?.getObject()
				.get("AS")
				.asName()
		).toBe("Off")
		expect(missingRequiredFields(after).map(item => item.name)).toEqual(["required"])
	})
})

describe("XFA and scripts", () => {
	it("tells hybrid from XFA-only forms", () => {
		expect(pdfXfaKind(load("acroform.pdf"))).toBe("none")
		expect(pdfXfaKind(load("hybrid-xfa.pdf"))).toBe("hybrid")
		expect(pdfXfaKind(load("xfa-only.pdf"))).toBe("xfaOnly")
	})

	it("removes the XFA packet of a hybrid form and keeps the AcroForm entries", async () => {
		const document = load("hybrid-xfa.pdf")

		set(document, "name", { kind: "text", text: "From AcroForm" })

		expect(removeXfa(document)).toBe(true)
		expect(removeXfa(document)).toBe(false)

		const saved = reopen(document)

		expect(pdfXfaKind(saved.document)).toBe("none")
		expect(field(saved.document, "name").value).toBe("From AcroForm")
		expect((await pdfjsFields(saved.bytes)).get("name")?.[0]?.value).toBe("From AcroForm")
	})

	it("detects calculate, format and validate scripts", () => {
		expect(pdfFormScripts(load("calculated.pdf"))).toEqual({ calculate: true, format: true, validate: true, keystroke: false })
		expect(hasFormScripts(load("calculated.pdf"))).toBe(true)
		expect(hasFormScripts(load("acroform.pdf"))).toBe(false)
	})
})

// Fraction of non-white pixels of `box` on a page rendered at 72 dpi.
function inkIn(document: mupdf.PDFDocument, pageIndex: number, box: PdfPageRect): number {
	const page = document.loadPage(pageIndex)
	const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true)
	const pixels = pixmap.getPixels()
	const width = pixmap.getWidth()
	let inked = 0
	let total = 0

	for (let y = Math.ceil(box[1]); y < Math.floor(box[3]); y++) {
		for (let x = Math.ceil(box[0]); x < Math.floor(box[2]); x++) {
			const at = (y * width + x) * 3

			total++

			if ((pixels[at] ?? 255) < 200 || (pixels[at + 1] ?? 255) < 200 || (pixels[at + 2] ?? 255) < 200) inked++
		}
	}

	pixmap.destroy()

	return total === 0 ? 0 : inked / total
}

function pngSignature(): PdfSignatureImage {
	const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 120, 40], false)

	pixmap.clear(255)

	const pixels = pixmap.getPixels()

	// A dark bar across the middle.
	for (let y = 15; y < 25; y++) for (let x = 5; x < 115; x++) pixels.set([20, 20, 60], (y * 120 + x) * 3)

	const png = pixmap.asPNG().slice()

	pixmap.destroy()

	return { kind: "image", png, width: 120, height: 40 }
}

describe("Fill & Sign annotations", () => {
	const meta = { author: "Jane Doe", date: new Date("2026-01-02T03:04:05Z") }

	it("places text, marks, an image signature and drawn initials that survive a save", async () => {
		const document = load("acroform.pdf")
		const page = document.loadPage(1)
		const strokes = normalizeStrokes([
			[0, 0, 30, 40, 60, 0],
			[10, 20, 50, 20]
		])

		if (strokes === null) throw new Error("no strokes")

		const textBox: PdfPageRect = [300, 100, 500, 130]
		const checkBox: PdfPageRect = [100, 200, 120, 220]
		const crossBox: PdfPageRect = [130, 200, 150, 220]
		const dotBox: PdfPageRect = [160, 205, 170, 215]
		const signatureBox: PdfPageRect = [100, 300, 400, 400]
		const initialsBox: PdfPageRect = [100, 450, 160, 490]

		addFillText(page, { ...meta, box: textBox, text: "Signed in Berlin", font: "sans", size: 14, color: [0, 0, 0] })
		addFillMark(page, { ...meta, box: checkBox, mark: "check", color: [0, 0, 0] })
		addFillMark(page, { ...meta, box: crossBox, mark: "cross", color: [0, 0, 0] })
		addFillMark(page, { ...meta, box: dotBox, mark: "dot", color: [0, 0, 0] })
		placeVisualSignature(mupdf, page, pngSignature(), { ...meta, box: signatureBox, role: "signature" })
		placeVisualSignature(mupdf, page, strokes, { ...meta, box: initialsBox, role: "initials" })

		const saved = reopen(document)
		const annotations = saved.document.loadPage(1).getAnnotations()
		const byType = annotations.map(annotation => annotation.getType())

		expect(byType).toEqual(["FreeText", "Ink", "Ink", "Circle", "Stamp", "Ink"])
		expect(annotations.every(annotation => annotation.getAuthor() === "Jane Doe")).toBe(true)
		expect(annotations[0]?.getContents()).toBe("Signed in Berlin")
		expect(annotations[4]?.getSubject()).toBe("Signature")
		expect(annotations[5]?.getSubject()).toBe("Initials")
		expect(annotations[4]?.getCreationDate().toISOString()).toBe("2026-01-02T03:04:05.000Z")

		// The stamp keeps the image's 3:1 aspect, centred in the box.
		const stampRect = annotations[4]?.getRect() ?? [0, 0, 0, 0]

		expect((stampRect[2] - stampRect[0]) / (stampRect[3] - stampRect[1])).toBeCloseTo(3, 1)

		for (const box of [textBox, checkBox, crossBox, dotBox, signatureBox, initialsBox]) {
			expect(inkIn(saved.document, 1, box)).toBeGreaterThan(0.01)
		}

		const theirs = await pdfjsFields(saved.bytes)

		for (const subtype of ["FreeText", "Ink", "Circle", "Stamp"]) {
			const found = theirs.get(`#${subtype}`) ?? []

			expect(found.length).toBeGreaterThan(0)
			expect(found.every(item => item.page === 1)).toBe(true)
		}

		expect(theirs.get("#Ink")?.length).toBe(3)
	})

	it("signs over a signature field's box without touching the field", () => {
		const document = load("acroform.pdf")
		const target = field(document, "signature")

		placeVisualSignature(mupdf, document.loadPage(0), pngSignature(), { ...meta, box: target.rect, role: "signature" })

		const after = reopen(document).document

		expect(field(after, "signature").value).toBe("")
		expect(inkIn(after, 0, target.rect)).toBeGreaterThan(0.01)
	})
})

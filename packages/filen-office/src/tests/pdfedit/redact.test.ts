import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import * as mupdf from "mupdf"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import {
	hiddenTerms,
	REDACTION_SAVE_OPTIONS,
	type RedactionManifest,
	type RedactionRegion,
	type RedactionTerm,
	type RedactionVerdict
} from "../../core/pdfedit/redactVerify"
import {
	applyAllRedactions,
	applyPageRedactions,
	drawPendingRedactions,
	findRedactions,
	listRedactionMarks,
	markArea,
	markFindings,
	markPage,
	markText,
	removeRedactionMark,
	sanitizeForRedaction,
	scrubTermsForRedaction,
	verifyRedactedPdf
} from "../../dom/pdfedit/redact"
import { markedSections } from "../../dom/pdfedit/redact/content"
import { makeFormPdf, makePdf } from "./fixtures"
import { page as toPage, SECRET, SPEC, type PdfBox } from "./redactFixtureSpec"

const SECRET_TERM: RedactionTerm = { text: SECRET, matchCase: false, wholeWord: false }

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../fixtures/pdfredact/${name}.pdf`, import.meta.url)))
const open = (bytes: Uint8Array): mupdf.PDFDocument => new mupdf.PDFDocument(bytes)
const save = (document: mupdf.PDFDocument, options = REDACTION_SAVE_OPTIONS): Uint8Array =>
	document.saveToBuffer(options).asUint8Array().slice()

function verify(bytes: Uint8Array, manifest: RedactionManifest): RedactionVerdict {
	const document = open(bytes)
	const verdict = verifyRedactedPdf(mupdf, document, manifest)

	document.destroy()

	return verdict
}

interface Redaction {
	readonly areas?: readonly PdfBox[]
	readonly terms?: readonly RedactionTerm[]
	readonly sanitize?: boolean
	readonly removeAnnotations?: boolean
}

// The whole flow as the editor runs it: marks, find, apply, scrub, sanitize, full rewrite.
function redact(name: string | Uint8Array, options: Redaction): { readonly bytes: Uint8Array; readonly manifest: RedactionManifest } {
	const document = open(typeof name === "string" ? fixture(name) : name)
	const terms = options.terms ?? []
	const first = document.loadPage(0)

	for (const area of options.areas ?? []) markArea(first, toPage(area))

	first.destroy()
	markFindings(document, findRedactions(document, { terms, presets: [] }))

	const applied = applyAllRedactions(mupdf, document, { removeAnnotations: options.removeAnnotations ?? true })

	scrubTermsForRedaction(document, terms)

	if (options.sanitize ?? true) sanitizeForRedaction(document)

	const bytes = save(document)

	document.destroy()

	return {
		bytes,
		manifest: {
			regions: applied.regions,
			terms,
			hidden: hiddenTerms(applied.hidden),
			sanitized: options.sanitize ?? true,
			annotationsRemoved: options.removeAnnotations ?? true
		}
	}
}

async function pdfjsText(bytes: Uint8Array): Promise<string> {
	const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 })
	const document = await task.promise
	let text = ""

	for (let index = 1; index <= document.numPages; index++) {
		const page = await document.getPage(index)
		const content = await page.getTextContent()

		text += content.items.map(item => ("str" in item ? item.str : "")).join("")

		for (const annotation of await page.getAnnotations()) text += JSON.stringify(annotation)
	}

	text += JSON.stringify(await document.getMetadata())
	text += JSON.stringify(await document.getOutline())
	text += JSON.stringify(await document.getAttachments())
	await task.destroy()

	return text
}

const area = (page: number, box: PdfBox): RedactionRegion => ({ page, kind: "area", rect: toPage(box) })

describe("redaction marks", () => {
	it("marks text, areas and pages as Redact annotations and removes them", () => {
		const document = open(fixture("text"))
		const page = document.loadPage(0)
		const [finding] = findRedactions(document, { terms: [SECRET_TERM], presets: [] })

		if (finding === undefined) throw new Error("no finding")

		const text = markText(page, finding.quads)
		const box = markArea(page, toPage(SPEC.text.lineArea))
		const whole = markPage(page)
		const marks = listRedactionMarks(document)

		expect(marks.map(mark => [mark.id, mark.kind])).toEqual([
			[text, "text"],
			[box, "area"],
			[whole, "page"]
		])
		expect(removeRedactionMark(page, box)).toBe(true)
		expect(removeRedactionMark(page, box)).toBe(false)
		expect(listRedactionMarks(document).map(mark => mark.id)).toEqual([text, whole])
	})

	it("finds terms with case and whole-word options, and the presets", () => {
		const document = open(fixture("text"))
		const found = (term: RedactionTerm) =>
			findRedactions(document, { terms: [term], presets: [] }).map(finding => [finding.page, finding.text])

		expect(found(SECRET_TERM)).toEqual([
			[0, "Secret"],
			[1, "Secret"]
		])
		expect(found({ text: "secret", matchCase: true, wholeWord: false })).toEqual([])
		expect(found({ text: "Secre", matchCase: false, wholeWord: true })).toEqual([])
		expect(found({ text: "Secre", matchCase: false, wholeWord: false })).toHaveLength(2)
		expect(findRedactions(document, { terms: [], presets: ["emails", "phoneNumbers"] }).map(finding => finding.text)).toEqual([
			"bob@example.com",
			"+1 (555) 010-7788"
		])
	})

	it("fills pending marks when printing without changing the document", () => {
		const document = open(fixture("text"))
		const page = document.loadPage(0)
		const rect = toPage(SPEC.text.lineArea)

		markArea(page, rect)

		// Without object streams: each save would write its own anew (at new numbers), whatever changed.
		const plain = "garbage=yes,compress"
		const before = save(document, plain)
		const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 612, 792], false)

		pixmap.clear(255)

		const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap)

		page.run(device, mupdf.Matrix.identity)
		expect(drawPendingRedactions(mupdf, page, device, mupdf.Matrix.identity)).toBe(1)
		device.close()

		const x = Math.round((rect[0] + rect[2]) / 2) + 10
		const y = Math.round(rect[1]) + 5
		const at = y * pixmap.getStride() + x * 3

		expect([...pixmap.getPixels().slice(at, at + 3)]).toEqual([0, 0, 0])
		expect(save(document, plain)).toEqual(before)
	})
})

describe("applying redactions", () => {
	it("removes text, images under marks and drawings an area touches, and passes the check in MuPDF and pdf.js", async () => {
		const { bytes, manifest } = redact("text", { areas: [SPEC.text.lineArea, SPEC.text.apexArea], terms: [SECRET_TERM] })

		expect(verify(bytes, manifest)).toEqual({ ok: true })

		const text = await pdfjsText(bytes)

		expect(text).not.toContain(SECRET)
		expect(text).toContain("Agent name")

		// The line and the triangle were touched: both gone; the black boxes are the only drawings left.
		const document = open(bytes)
		const content = document.loadPage(0).getObject().get("Contents").readStream().asString()

		expect(content).not.toMatch(/\bS\b/)
		expect(content.match(/\bf\b/g)?.length).toBe(3)
	})

	it.each([
		["form", { areas: [SPEC.form.area], terms: [SECRET_TERM] }],
		["invisible", { areas: [SPEC.invisible.area], terms: [SECRET_TERM] }],
		["ocr", { areas: [SPEC.ocr.area], terms: [SECRET_TERM] }],
		["clipped", { areas: [SPEC.clipped.area], terms: [SECRET_TERM] }],
		["layer", { terms: [SECRET_TERM] }],
		["tagged", { areas: [SPEC.tagged.area], terms: [SECRET_TERM] }],
		["annotations", { areas: [SPEC.annotations.area], terms: [SECRET_TERM] }],
		["metadata", { terms: [SECRET_TERM] }],
		["images", { areas: SPEC.images.areas }],
		["vector", { areas: SPEC.vector.areas }],
		["revision", { terms: [{ text: "Original", matchCase: true, wholeWord: true }] }]
	] as const)("redacts %s correctly", async (name, options) => {
		const { bytes, manifest } = redact(name, options)

		expect(verify(bytes, manifest)).toEqual({ ok: true })

		if (manifest.terms.length > 0) expect(await pdfjsText(bytes)).not.toMatch(new RegExp(manifest.terms[0]?.text ?? "", "i"))
	})

	it("reads no form for the drawing of marked content where there is none, and still reads it inside a section", () => {
		const document = new mupdf.PDFDocument()
		const form = document.addStream("0 0 10 10 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10] })
		const resources = document.addObject({ XObject: { Fm0: form }, Properties: {} })
		const untagged = Array.from({ length: 40 }, () => "q /Fm0 Do Q").join(" ")

		document.insertPage(-1, document.addPage([0, 0, 200, 200], 0, resources, untagged))
		document.insertPage(-1, document.addPage([0, 0, 200, 200], 0, resources, "/P <</MCID 0>> BDC /Fm0 Do EMC /Fm0 Do"))

		const reads = vi.spyOn(mupdf.PDFObject.prototype, "readStream")

		try {
			// The page's content only.
			expect(markedSections(document.findPage(0)).sections).toEqual([])
			expect(reads).toHaveBeenCalledTimes(1)
			reads.mockClear()
			expect(markedSections(document.findPage(1)).sections).toEqual([{ open: 0, mcid: 0, signature: "F(P)" }])
			expect(reads).toHaveBeenCalledTimes(2)
		} finally {
			reads.mockRestore()
			document.destroy()
		}
	})

	it("keeps the second page's shared form intact while redacting the first", () => {
		const { bytes } = redact("form", { areas: [SPEC.form.area] })
		const document = open(bytes)

		expect(document.loadPage(0).toStructuredText("").asText()).not.toContain("Formula")
		expect(document.loadPage(1).toStructuredText("").asText()).toContain("Secret Formula")
	})

	it("strips the text alternatives of redacted tagged content and keeps the others", () => {
		const { bytes } = redact("tagged", { areas: [SPEC.tagged.area] })
		const document = open(bytes)
		const parents = document.getTrailer().get("Root", "StructTreeRoot", "ParentTree", "Nums").get(1)

		expect(parents.get(0).get("ActualText").isNull()).toBe(true)
		expect(parents.get(0).get("Alt").isNull()).toBe(true)
		expect(parents.get(1).get("Alt").asString()).toBe("Kept alt")
		expect(document.loadPage(0).getObject().get("Contents").readStream().asString()).not.toContain("ActualText")
	})

	it("strips the text alternatives of every ancestor of redacted tagged content, and the verifier checks the tags", () => {
		const { bytes, manifest } = redact("tagged-parent", { areas: [SPEC.taggedParent.area] })
		const document = open(bytes)
		const [one, two] = [0, 1].map(index => document.getTrailer().get("Root", "StructTreeRoot", "ParentTree", "Nums").get(1).get(index))
		const section = one?.get("P")
		const documentElement = section?.get("P")

		expect(manifest.hidden).toEqual([
			{ text: "Hidden", matchCase: true, wholeWord: true },
			{ text: "words", matchCase: true, wholeWord: true }
		])
		expect(section?.get("ActualText").isNull()).toBe(true)
		expect(documentElement?.get("Alt").isNull()).toBe(true)
		expect(two?.get("Alt").asString()).toBe("Kept alt")
		expect(document.loadPage(0).toStructuredText("").asText()).toContain("Kept words")
		expect(verify(bytes, manifest)).toEqual({ ok: true })
	})

	it("removes links and form fields over a mark with their values, and keeps comments when asked", () => {
		const keep = redact("annotations", { areas: [SPEC.annotations.area], removeAnnotations: false, sanitize: false })
		const document = open(keep.bytes)
		const page = document.loadPage(0)

		expect(page.getLinks()).toHaveLength(0)
		expect(page.getWidgets()).toHaveLength(0)
		// Both notes stay (MuPDF never lists popups); a free text box over a mark is always redacted by MuPDF.
		expect(page.getAnnotations().map(annotation => annotation.getType())).toEqual(["Text", "Text"])
		expect(document.getTrailer().get("Root", "AcroForm", "Fields").length).toBe(0)

		const removed = open(redact("annotations", { areas: [SPEC.annotations.area], sanitize: false }).bytes)

		expect(
			removed
				.loadPage(0)
				.getAnnotations()
				.map(annotation => annotation.getType())
		).toEqual(["Text"])
	})

	it("sanitizes metadata, attachments, scripts, page pieces and hidden layers", () => {
		const { bytes } = redact("metadata", {})
		const document = open(bytes)
		const root = document.getTrailer().get("Root")

		expect(document.getTrailer().get("Info").isNull()).toBe(true)
		expect(root.get("Metadata").isNull()).toBe(true)
		expect(root.get("OpenAction").isNull()).toBe(true)
		expect(root.get("Names", "EmbeddedFiles").isNull()).toBe(true)
		expect(document.loadPage(0).getObject().get("PieceInfo").isNull()).toBe(true)
		expect(document.loadPage(0).getObject().get("Metadata").isNull()).toBe(true)
		expect(verify(bytes, { regions: [], terms: [], sanitized: true, annotationsRemoved: true })).toEqual({ ok: true })

		const layer = open(redact("layer", {}).bytes)

		expect(layer.loadPage(0).getObject().get("Contents").readStream().asString()).not.toContain("Layer)")
		expect(layer.loadPage(0).getObject().get("Contents").readStream().asString()).toContain("Shown layer")
	})

	it("keeps resources named like the keys sanitize drops, and still drops those keys where they are the format's", () => {
		// Resources named /AA (a font, in an indirect map) and /AF (an image, in a direct one), on a page with a real
		// /AA action and a catalog with a /Metadata stream.
		const make = (): Uint8Array => {
			const document = new mupdf.PDFDocument()
			const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false)

			pixmap.clear(0)

			const image = document.addImage(new mupdf.Image(pixmap))
			const fonts = document.addObject({ AA: document.addSimpleFont(new mupdf.Font("Helvetica")) })
			const resources = document.addObject({ Font: fonts, XObject: { AF: image } })
			const page = document.addPage(
				[0, 0, 300, 300],
				0,
				resources,
				"BT /AA 12 Tf 20 250 Td (Kept words) Tj ET q 50 0 0 50 100 100 cm /AF Do Q"
			)

			page.put("AA", document.addObject({ O: { S: "JavaScript", JS: "app.alert(1)" } }))
			document.insertPage(-1, page)
			document
				.getTrailer()
				.get("Root")
				.put("Metadata", document.addStream("<x:xmpmeta/>", { Type: "Metadata", Subtype: "XML" }))
			pixmap.destroy()

			return save(document)
		}
		const { bytes, manifest } = redact(make(), {})
		const document = open(bytes)
		const page = document.loadPage(0)
		const resources = page.getObject().get("Resources")

		expect(verify(bytes, manifest)).toEqual({ ok: true })
		expect(resources.get("Font", "AA").isNull()).toBe(false)
		expect(resources.get("XObject", "AF").isNull()).toBe(false)
		expect(page.toStructuredText("").asText()).toContain("Kept words")
		expect(page.toStructuredText("preserve-images").asJSON()).toContain('"type":"image"')
		expect(page.getObject().get("AA").isNull()).toBe(true)
		expect(document.getTrailer().get("Root", "Metadata").isNull()).toBe(true)
		page.destroy()
		document.destroy()

		// Left in place, the real ones fail the check.
		const unsanitized = redact(make(), { sanitize: false })

		expect(verify(unsanitized.bytes, { ...unsanitized.manifest, sanitized: true })).toEqual({
			ok: false,
			failure: { code: "metadata", what: "xmp" }
		})
	})

	it("applies text and area marks of one page with their own drawing rules", () => {
		const document = open(fixture("text"))
		const page = document.loadPage(0)
		const [finding] = findRedactions(document, { terms: [SECRET_TERM], presets: [] })

		if (finding === undefined) throw new Error("no finding")

		markText(page, finding.quads)
		markArea(page, toPage(SPEC.text.apexArea))

		const applied = applyPageRedactions(mupdf, document, 0, { removeAnnotations: true })

		expect(applied.pages).toEqual([0])
		expect(applied.regions.map(region => region.kind)).toEqual(["text", "area"])

		const content = document.loadPage(0).getObject().get("Contents").readStream().asString()

		// The line under no mark stays; the triangle the area touched goes.
		expect(content).toMatch(/\bS\b/)
		expect(verify(save(document), { regions: applied.regions, terms: [], sanitized: false, annotationsRemoved: true })).toEqual({
			ok: true
		})
	})
})

describe("encrypted files", () => {
	it("redacts and verifies an AES-256 file saved with its encryption kept, a short term not matching binary data", () => {
		const document = open(makePdf({ pages: 3, imageBytes: 30_000, userPassword: "pw", ownerPassword: "owner" }))

		document.authenticatePassword("owner")

		const term: RedactionTerm = { text: "Pa", matchCase: false, wholeWord: false }

		markFindings(document, findRedactions(document, { terms: [term], presets: [] }))

		const applied = applyAllRedactions(mupdf, document, { removeAnnotations: true })

		scrubTermsForRedaction(document, [term])
		sanitizeForRedaction(document)

		const bytes = save(document, `${REDACTION_SAVE_OPTIONS},encrypt=keep`)
		const check = open(bytes)

		expect(check.needsPassword()).toBe(true)
		expect(check.authenticatePassword("pw")).toBeGreaterThan(0)
		// The page tree, page boxes and the text outside the marks survive the scrub ("Pa" is in /Parent, /Pages, /Page).
		expect(check.countPages()).toBe(3)

		for (let index = 0; index < 3; index++) {
			const page = check.loadPage(index)

			expect(page.getBounds()).toEqual([0, 0, 595, 842])
			expect(page.toStructuredText("").asText()).toContain(`ge ${String(index + 1)}`)
			page.destroy()
		}

		expect(
			verifyRedactedPdf(mupdf, check, { regions: applied.regions, terms: [term], sanitized: true, annotationsRemoved: true })
		).toEqual({
			ok: true
		})
		expect(applied.regions).toHaveLength(3)
	})
})

describe("scrubbing terms outside the pages", () => {
	const term = (text: string): RedactionTerm => ({ text, matchCase: false, wholeWord: false })
	const shape = (bytes: Uint8Array) => {
		const document = open(bytes)
		const pages = Array.from({ length: document.countPages() }, (_, index) => {
			const page = document.loadPage(index)
			const out = { bounds: page.getBounds(), widgets: page.getWidgets().length, links: page.getLinks().length }

			page.destroy()

			return out
		})

		document.destroy()

		return pages
	}

	it.each(["Page", "Parent", "Type", "Font", "Contents", "age", "Kids", "Annot"])(
		"keeps the document whole when the term is %s, a name the format uses",
		text => {
			for (const source of [fixture("annotations"), fixture("tagged"), makeFormPdf()]) {
				const before = shape(source)
				const { bytes, manifest } = redact(source, { terms: [term(text)], sanitize: false, removeAnnotations: false })
				const after = shape(bytes)

				expect(after.map(page => page.bounds)).toEqual(before.map(page => page.bounds))
				expect(after.length).toBeGreaterThan(0)
				expect(verify(bytes, manifest)).toEqual({ ok: true })
			}
		}
	)

	it("keeps the form's fields and the text outside the marks", () => {
		const { bytes, manifest } = redact(makeFormPdf(), { terms: [term("Parent"), term("Type")], sanitize: false })
		const document = open(bytes)
		const page = document.loadPage(0)

		expect(verify(bytes, manifest)).toEqual({ ok: true })
		expect(page.getWidgets().map(widget => widget.getName())).toEqual(["name", "agree", "fixed", "colour", "choice"])
		expect(page.toStructuredText("").asText()).toContain("Form page 1")
		expect(document.getTrailer().get("Root", "AcroForm", "Fields").length).toBe(5)
	})

	it("cuts a term from a custom document information entry, its key and its value", () => {
		const document = open(makePdf({ pages: 1 }))

		document.setMetaData("info:Title", "Report")

		const custom = document.getTrailer().get("Info")

		custom.put("SecretOwner", document.newString("Secret agency"))
		custom.put("Plain", document.newName("SecretName"))
		scrubTermsForRedaction(document, [SECRET_TERM])

		const bytes = save(document)
		const saved = open(bytes)
		const info = saved.getTrailer().get("Info")

		expect(info.get("Owner").asString()).toBe(" agency")
		expect(info.get("SecretOwner").isNull()).toBe(true)
		expect(info.get("Plain").asName()).toBe("Name")
		expect(info.get("Title").asString()).toBe("Report")
		expect(verify(bytes, { regions: [], terms: [SECRET_TERM], sanitized: false, annotationsRemoved: true })).toEqual({ ok: true })
	})

	it("keeps both entries when two keys cut to the same name", () => {
		const document = open(makePdf({ pages: 1 }))

		document.setMetaData("info:Title", "Report")

		const custom = document.getTrailer().get("Info")

		custom.put("SecretX", document.newString("one"))
		custom.put("XSecret", document.newString("two"))
		custom.put("Y", document.newString("three"))
		custom.put("SecretY", document.newString("four"))
		scrubTermsForRedaction(document, [SECRET_TERM])

		const saved = open(save(document))
		const info = saved.getTrailer().get("Info")
		const entries: Record<string, string> = {}

		info.forEach((value, key) => {
			entries[String(key)] = value.asString()
		})

		expect(Object.values(entries).sort()).toEqual(["Report", "four", "one", "three", "two"])
		expect(entries["Y"]).toBe("three")
		expect(Object.keys(entries).some(key => key.includes(SECRET))).toBe(false)
	})

	it("cuts custom tags and role map keys, and leaves the standard ones", () => {
		const document = open(fixture("tagged"))
		const tree = document.getTrailer().get("Root", "StructTreeRoot")
		const first = tree.get("ParentTree", "Nums").get(1).get(0)

		const terms = [term("Secret"), term("Docu")]

		first.put("S", document.newName("SecretPara"))
		tree.put("RoleMap", { SecretPara: document.newName("P") })
		markFindings(document, findRedactions(document, { terms, presets: [] }))

		const applied = applyAllRedactions(mupdf, document, { removeAnnotations: true })

		scrubTermsForRedaction(document, terms)

		const bytes = save(document)
		const file = open(bytes)
		const saved = file.getTrailer().get("Root", "StructTreeRoot")

		expect(saved.get("ParentTree", "Nums").get(1).get(0).get("S").asName()).toBe("Para")
		expect(saved.get("RoleMap", "Para").asName()).toBe("P")
		expect(saved.get("K", "S").asName()).toBe("Document")
		expect(verify(bytes, { regions: applied.regions, terms, sanitized: false, annotationsRemoved: true })).toEqual({ ok: true })
	})

	it("clears a button whose appearance state holds the term", () => {
		const document = open(makeFormPdf())

		scrubTermsForRedaction(document, [term("Yes")])

		const bytes = save(document)
		const saved = open(bytes)
		const agree = saved.findPage(0).get("Annots").get(1)

		expect(agree.get("AP").isNull()).toBe(true)
		expect(agree.get("AS").asName()).toBe("Off")
		expect(verify(bytes, { regions: [], terms: [term("Yes")], sanitized: false, annotationsRemoved: true })).toEqual({ ok: true })
		// The verifier reads the states: the unscrubbed form fails.
		expect(verify(makeFormPdf(), { regions: [], terms: [term("Yes")], sanitized: false, annotationsRemoved: true })).toEqual({
			ok: false,
			failure: { code: "term", term: "Yes", place: "field" }
		})
	})

	it.each(["Off", "of"])("leaves every button's off state alone when the term is %s", text => {
		const terms = [term(text)]
		const buttons = (document: mupdf.PDFDocument): string[][] =>
			document
				.loadPage(0)
				.getWidgets()
				.concat(document.loadPage(1).getWidgets())
				.map(widget => widget.getObject())
				.filter(widget => widget.get("FT").asName() === "Btn" || widget.get("Parent", "FT").asName() === "Btn")
				.map(widget => {
					const states: string[] = []

					widget.get("AP", "N").forEach((_, key) => states.push(String(key)))

					return [
						widget.get("AS").asName(),
						(widget.get("V").isNull() ? widget.get("Parent", "V") : widget.get("V")).asName(),
						...states
					]
				})
		const before = buttons(open(makeFormPdf()))
		const document = open(makeFormPdf())

		scrubTermsForRedaction(document, terms)

		const bytes = save(document)

		expect(before).toHaveLength(3)
		expect(buttons(open(bytes))).toEqual(before)
		expect(verify(bytes, { regions: [], terms, sanitized: false, annotationsRemoved: true })).toEqual({ ok: true })
		expect(verify(makeFormPdf(), { regions: [], terms, sanitized: false, annotationsRemoved: true })).toEqual({ ok: true })
	})

	it("removes every annotation over the marks with its replies in one pass", () => {
		const document = open(makePdf({ pages: 1 }))
		const page = document.loadPage(0)
		const note = (y: number, reply?: mupdf.PDFAnnotation): mupdf.PDFAnnotation => {
			const annotation = page.createAnnotation("Text")

			annotation.setRect([100, y, 120, y + 20])

			if (reply !== undefined) annotation.getObject().put("IRT", reply.getObject())

			return annotation
		}

		for (const y of [100, 200, 300]) note(y + 10, note(y))

		markArea(page, [50, 50, 400, 400])
		page.destroy()
		applyAllRedactions(mupdf, document, { removeAnnotations: true })

		const saved = open(save(document))

		expect(
			saved
				.loadPage(0)
				.getAnnotations()
				.map(annotation => annotation.getType())
		).toEqual([])
	})
})

describe("the verifier catches incomplete redactions", () => {
	it("fails a file without pages, or without a page a mark was on", () => {
		const empty = new mupdf.PDFDocument()

		expect(verify(save(empty), { regions: [], terms: [], sanitized: false, annotationsRemoved: true })).toEqual({
			ok: false,
			failure: { code: "unreadable", page: 1 }
		})
		expect(
			verify(makePdf({ pages: 1 }), { regions: [area(2, [0, 0, 10, 10])], terms: [], sanitized: false, annotationsRemoved: true })
		).toEqual({ ok: false, failure: { code: "unreadable", page: 3 } })
	})

	// A "redaction" that only paints black boxes over the areas.
	function boxesOnly(name: string, areas: readonly PdfBox[]): Uint8Array {
		const document = open(fixture(name))
		const page = document.loadPage(0).getObject()
		const boxes = areas
			.map(box => `${String(box[0])} ${String(box[1])} ${String(box[2] - box[0])} ${String(box[3] - box[1])} re f`)
			.join(" ")
		const contents = page.get("Contents")
		const original = contents.isArray() ? contents.get(0).readStream().asString() : contents.readStream().asString()

		page.put("Contents", document.addStream(`${original}\nq 0 g ${boxes} Q`, {}))

		return save(document)
	}

	it("catches hidden (render mode 3) text left under a box", () => {
		const bytes = boxesOnly("invisible", [SPEC.invisible.area])

		expect(verify(bytes, { regions: [area(0, SPEC.invisible.area)], terms: [], sanitized: false, annotationsRemoved: true })).toEqual({
			ok: false,
			failure: { code: "text", page: 1 }
		})
	})

	it("catches text in a Form XObject left under a box", () => {
		const bytes = boxesOnly("form", [SPEC.form.area])

		expect(verify(bytes, { regions: [area(0, SPEC.form.area)], terms: [], sanitized: false, annotationsRemoved: true })).toEqual({
			ok: false,
			failure: { code: "text", page: 1 }
		})
	})

	it("catches text in a hidden layer and a hidden membership", () => {
		const { off, membership } = SPEC.layer
		const offBox: PdfBox = [off.x - 2, off.y - 4, off.x + 150, off.y + 16]
		const memberBox: PdfBox = [membership.x - 2, membership.y - 4, membership.x + 200, membership.y + 16]

		expect(
			verify(boxesOnly("layer", [offBox]), { regions: [area(0, offBox)], terms: [], sanitized: false, annotationsRemoved: true })
		).toEqual({
			ok: false,
			failure: { code: "text", page: 1 }
		})
		expect(
			verify(boxesOnly("layer", [memberBox]), {
				regions: [area(0, memberBox)],
				terms: [],
				sanitized: false,
				annotationsRemoved: true
			})
		).toEqual({ ok: false, failure: { code: "text", page: 1 } })
	})

	it("catches a metadata copy when sanitize was claimed", () => {
		const { bytes } = redact("metadata", { sanitize: false })

		expect(verify(bytes, { regions: [], terms: [], sanitized: true, annotationsRemoved: true })).toMatchObject({
			ok: false,
			failure: { code: "metadata" }
		})
		expect(verify(bytes, { regions: [], terms: [SECRET_TERM], sanitized: false, annotationsRemoved: true })).toEqual({
			ok: false,
			failure: { code: "term", term: SECRET, place: "metadata" }
		})
	})

	it("catches a term left in an annotation's contents", () => {
		const document = open(fixture("annotations"))

		markFindings(document, findRedactions(document, { terms: [SECRET_TERM], presets: [] }))

		const applied = applyAllRedactions(mupdf, document, { removeAnnotations: true })

		expect(
			verify(save(document), { regions: applied.regions, terms: [SECRET_TERM], sanitized: false, annotationsRemoved: true })
		).toEqual({
			ok: false,
			failure: { code: "term", term: SECRET, place: "annotation" }
		})
	})

	it("catches one surviving pixel", () => {
		const { bytes, manifest } = redact("images", { areas: SPEC.images.areas })
		const document = open(bytes)
		const image = document.loadPage(0).getObject().get("Resources", "XObject", "Im1")
		const pixels = image.readStream().asUint8Array().slice()
		// Column 4, row 6 of the 16 × 16 RGB image lies under the first area.
		const at = (6 * 16 + 4) * 3

		expect([...pixels.slice(at, at + 3)]).toEqual([255, 255, 255])
		pixels.set([30, 60, 90], at)
		image.writeStream(pixels)

		expect(verify(save(document), manifest)).toEqual({ ok: false, failure: { code: "image", page: 1 } })
	})

	it("catches a surviving path segment under an area mark", () => {
		const document = open(fixture("text"))
		const page = document.loadPage(0)
		const rect = toPage(SPEC.text.lineArea)

		// A text mark over the line: drawings are only removed when fully covered, so the line survives.
		markText(page, [[rect[0], rect[1], rect[2], rect[1], rect[0], rect[3], rect[2], rect[3]]])
		applyAllRedactions(mupdf, document, { removeAnnotations: true })

		expect(
			verify(save(document), { regions: [area(0, SPEC.text.lineArea)], terms: [], sanitized: false, annotationsRemoved: true })
		).toEqual({
			ok: false,
			failure: { code: "drawing", page: 1 }
		})
	})

	it("catches a shading left under an area mark", () => {
		const shading = SPEC.vector.areas[1]

		if (shading === undefined) throw new Error("no area")

		expect(
			verify(boxesOnly("vector", [shading]), { regions: [area(0, shading)], terms: [], sanitized: false, annotationsRemoved: true })
		).toEqual({
			ok: false,
			failure: { code: "drawing", page: 1 }
		})
	})

	it("catches an earlier revision", () => {
		const document = open(fixture("text"))

		markArea(document.loadPage(0), toPage(SPEC.text.lineArea))

		const applied = applyAllRedactions(mupdf, document, { removeAnnotations: true })

		expect(
			verify(save(document, "incremental"), { regions: applied.regions, terms: [], sanitized: false, annotationsRemoved: true })
		).toEqual({
			ok: false,
			failure: { code: "revisions", count: 2 }
		})
	})

	it("catches a stencil and a soft mask left under a box", () => {
		const [rgb, stencil] = SPEC.images.areas

		if (rgb === undefined || stencil === undefined) throw new Error("no areas")

		expect(
			verify(boxesOnly("images", [stencil]), { regions: [area(0, stencil)], terms: [], sanitized: false, annotationsRemoved: true })
		).toEqual({
			ok: false,
			failure: { code: "image", page: 1 }
		})
		expect(
			verify(boxesOnly("images", [rgb]), { regions: [area(0, rgb)], terms: [], sanitized: false, annotationsRemoved: true })
		).toEqual({
			ok: false,
			failure: { code: "image", page: 1 }
		})
	})

	it("catches a covered word an ancestor's text alternative still spells out", () => {
		// The tagged file as it was: its section and document elements describe the words under the area.
		const bytes = save(open(fixture("tagged-parent")))

		expect(
			verify(bytes, {
				regions: [],
				terms: [],
				hidden: hiddenTerms(["Hidden"]),
				sanitized: false,
				annotationsRemoved: true
			})
		).toEqual({ ok: false, failure: { code: "term", term: "Hidden", place: "tags" } })
	})

	it("catches a term in the text alternative of a tagged page's marked content", () => {
		const bytes = save(open(fixture("tagged")))

		expect(
			verify(bytes, {
				regions: [],
				terms: [{ text: "Secret Actual", matchCase: true, wholeWord: false }],
				sanitized: false,
				annotationsRemoved: true
			})
		).toEqual({ ok: false, failure: { code: "term", term: "Secret Actual", place: "page", page: 1 } })
	})

	it("catches a term only in a string of the page's content that no text extraction returns", () => {
		const document = new mupdf.PDFDocument()
		const font = document.addSimpleFont(new mupdf.Font("Helvetica"))
		// "Secret Lang", hex: no reading of the raw stream spells it, and no extraction returns a /Lang.
		const hex = [..."Secret Lang"].map(char => char.charCodeAt(0).toString(16)).join("")
		const content = `/Span << /MCID 0 /Lang <${hex}> >> BDC BT /F1 18 Tf 72 600 Td (Kept words) Tj ET EMC`

		document.insertPage(-1, document.addPage([0, 0, 612, 792], 0, document.addObject({ Font: { F1: font } }), content))

		const bytes = save(document)

		document.destroy()
		expect(
			verify(bytes, {
				regions: [],
				terms: [{ text: "Secret Lang", matchCase: true, wholeWord: false }],
				sanitized: false,
				annotationsRemoved: true
			})
		).toEqual({ ok: false, failure: { code: "term", term: "Secret Lang", place: "page", page: 1 } })
	})
})

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
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
import { makePdf } from "./fixtures"
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
function redact(name: string, options: Redaction): { readonly bytes: Uint8Array; readonly manifest: RedactionManifest } {
	const document = open(fixture(name))
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
		expect(
			verifyRedactedPdf(mupdf, check, { regions: applied.regions, terms: [term], sanitized: true, annotationsRemoved: true })
		).toEqual({
			ok: true
		})
		expect(applied.regions).toHaveLength(3)
	})
})

describe("the verifier catches incomplete redactions", () => {
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

	it("catches a term only in an earlier revision's leftovers and in page content strings", () => {
		const document = open(fixture("tagged"))
		const bytes = save(document)

		expect(
			verify(bytes, {
				regions: [],
				terms: [{ text: "Secret Actual", matchCase: true, wholeWord: false }],
				sanitized: false,
				annotationsRemoved: true
			})
		).toMatchObject({
			ok: false,
			failure: { code: "term" }
		})
	})
})

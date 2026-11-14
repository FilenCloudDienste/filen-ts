import { describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import {
	deletePages,
	duplicatePages,
	extractDocument,
	extractSaveOptions,
	insertBlankPages,
	insertImagePage,
	insertPagesFrom,
	isTaggedPdf,
	PageOpError,
	reorderPages,
	rotatePages,
	topLevelBookmarkPages,
	type PageOpResult
} from "../../dom/pdfedit/pages"
import { destPageNum, namedDests, pageIndexByNum, targetDest } from "../../dom/pdfedit/pages/objects"
import { moveBeforeOrder } from "../../core/pdfedit/pageOrder"
import { openPdf, pageText } from "../docxPdfFixtures"
import { makeOrganisedPdf, makeOtherPdf } from "./pageFixtures"

// Page organisation on a live journaled MuPDF document: every operation, its undo, and the saved file reopened in
// MuPDF and pdf.js.

function open(bytes: Uint8Array, password?: string): mupdf.PDFDocument {
	const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()

	if (doc === null) throw new Error("not a PDF")
	if (password !== undefined) doc.authenticatePassword(password)

	doc.enableJournal()

	return doc
}

function op<T>(doc: mupdf.PDFDocument, label: string, run: () => T): T {
	doc.beginOperation(label)

	try {
		const result = run()

		doc.endOperation()

		return result
	} catch (error) {
		doc.abandonOperation()
		throw error
	}
}

const UNENCRYPTED = { garbage: "compact", compress: "yes", objstms: "yes", encrypt: "none" }

function save(
	doc: mupdf.PDFDocument,
	options: string | Readonly<Record<string, string | number>> = "garbage=compact,compress"
): Uint8Array {
	return doc.saveToBuffer(options).asUint8Array().slice()
}

function texts(doc: mupdf.Document): string[] {
	return Array.from({ length: doc.countPages() }, (_, index) => {
		const text = doc.loadPage(index).toStructuredText("").asText().trim()

		return text.split("\n")[0] ?? ""
	})
}

function labels(doc: mupdf.Document): string[] {
	return Array.from({ length: doc.countPages() }, (_, index) => doc.loadPage(index).getLabel())
}

function root(doc: mupdf.PDFDocument): mupdf.PDFObject {
	return doc.getTrailer().get("Root")
}

// Fully qualified field names of the form, depth first.
function fieldNames(doc: mupdf.PDFDocument): string[] {
	const out: string[] = []
	const walk = (field: mupdf.PDFObject, prefix: string): void => {
		const name = field.get("T")
		const full = name.isNull() ? prefix : prefix === "" ? name.asString() : `${prefix}.${name.asString()}`
		const kids = field.get("Kids")
		let terminal = true

		if (!kids.isNull()) {
			kids.forEach(kid => {
				if (!kid.get("T").isNull()) {
					terminal = false
					walk(kid, full)
				}
			})
		}

		if (terminal) out.push(full)
	}
	const fields = root(doc).get("AcroForm")

	if (fields.isNull()) return out

	fields.get("Fields").forEach(field => {
		walk(field, "")
	})

	return out
}

function outlineTitles(doc: mupdf.Document): string[] {
	const out: string[] = []
	const walk = (items: readonly { title?: string | undefined; page?: number; down?: unknown[] }[], depth: number): void => {
		for (const item of items) {
			out.push(`${"-".repeat(depth)}${item.title ?? ""}@${item.page === undefined ? "none" : String(item.page + 1)}`)

			if (Array.isArray(item.down)) walk(item.down as typeof items, depth + 1)
		}
	}

	walk(doc.loadOutline() ?? [], 0)

	return out
}

// Page number (1-based) or URI of each link annotation. Named destinations are resolved through both the /Dests
// dictionary and the /Names tree (MuPDF's resolveLink misses names-tree strings in GoTo actions).
function linkTargets(doc: mupdf.PDFDocument, page: number): (number | string)[] {
	const named = namedDests(doc)
	const pages = pageIndexByNum(doc)
	const out: (number | string)[] = []

	doc.findPage(page)
		.get("Annots")
		.forEach(annot => {
			if (annot.get("Subtype").asName() !== "Link") return

			const uri = annot.get("A").isNull() ? null : annot.get("A").get("URI")

			if (uri !== null && !uri.isNull()) {
				out.push(uri.asString())

				return
			}

			const target = targetDest(annot)
			const num = target === null ? null : destPageNum(target, named)

			out.push(num === null ? -1 : (pages.get(num) ?? -2) + 1)
		})

	return out
}

async function pdfjsTexts(bytes: Uint8Array, password?: string): Promise<string[]> {
	const pdf = await openPdf(bytes, password)
	const out: string[] = []

	for (let page = 1; page <= pdf.numPages; page++) out.push(await pageText(pdf, page))

	await pdf.loadingTask.destroy()

	return out
}

// Raw bytes with no object streams and no compression, to look for what the file must not contain.
function rawText(doc: mupdf.PDFDocument): string {
	return new TextDecoder("latin1").decode(save(doc, "garbage=compact,decompress"))
}

function expectFrom(result: PageOpResult, from: number[]): void {
	expect([...result.from]).toEqual(from)
}

describe("reorder", () => {
	it("moves pages with their links, outline, fields and tags; labels stay with positions; undo restores", async () => {
		const doc = open(makeOrganisedPdf())
		const order = moveBeforeOrder(6, [4, 5], 1)

		expect(order).toEqual([0, 4, 5, 1, 2, 3])

		const result = op(doc, "Move pages", () => reorderPages(doc, order))

		expectFrom(result, order)
		expect(result.tagged).toBe(true)
		expect(texts(doc)).toEqual(["Page 1", "Page 5", "Page 6", "Page 2", "Page 3", "Page 4"])
		expect(labels(doc)).toEqual(["i", "ii", "1", "2", "3", "4"])
		// Page 1's links still go to "Page 3", "Page 4", "Page 5", now at positions 5, 6, 2.
		expect(linkTargets(doc, 0)).toEqual([5, 6, 2, "https://example.com/"])
		expect(outlineTitles(doc)).toEqual([
			"Chapter 1@1",
			"Chapter 2@4",
			"-Section 2.1@5",
			"Chapter 3@5",
			"Chapter 4@6",
			"Chapter 5@2",
			"Chapter 6@3"
		])
		expect(fieldNames(doc)).toEqual(["name", "city", "choice", "approval"])
		expect(isTaggedPdf(doc)).toBe(true)

		// (Undo first: MuPDF's journal no longer reverts operations made before a save.)
		doc.undo()
		expect(texts(doc)).toEqual(["Page 1", "Page 2", "Page 3", "Page 4", "Page 5", "Page 6"])
		expect(labels(doc)).toEqual(["i", "ii", "1", "2", "3", "4"])
		doc.redo()
		expect(texts(doc)[1]).toBe("Page 5")

		const bytes = save(doc)

		expect(await pdfjsTexts(bytes)).toEqual(["Page 1", "Page 5", "Page 6", "Page 2", "Page 3", "Page 4"])
		expect(texts(open(bytes))).toEqual(["Page 1", "Page 5", "Page 6", "Page 2", "Page 3", "Page 4"])
	})

	it("refuses an order that is not a permutation", () => {
		const doc = open(makeOrganisedPdf())

		expect(() => reorderPages(doc, [0, 0, 1, 2, 3, 4])).toThrow(PageOpError)
		expect(() => reorderPages(doc, [0, 1])).toThrow(PageOpError)
	})
})

describe("rotate", () => {
	it("adds to the current rotation, including an inherited one, and undoes", () => {
		const doc = open(makeOrganisedPdf())

		doc.beginOperation("setup")
		root(doc).get("Pages").put("Rotate", 90)
		doc.findPage(0).delete("Rotate")
		doc.findPage(2).delete("Rotate")
		doc.endOperation()

		const result = op(doc, "Rotate", () => rotatePages(doc, [0, 2], 90))

		expect([...result.touched]).toEqual([0, 2])
		expect(doc.findPage(0).get("Rotate").asNumber()).toBe(180)
		expect(doc.findPage(2).get("Rotate").asNumber()).toBe(180)

		op(doc, "Rotate back", () => rotatePages(doc, [0], -270))
		expect(doc.findPage(0).get("Rotate").asNumber()).toBe(270)
		doc.undo()
		doc.undo()
		expect(doc.findPage(0).getInheritable("Rotate").asNumber()).toBe(90)
	})
})

describe("delete", () => {
	it("removes the pages and everything pointing at them; undo brings all of it back", async () => {
		const doc = open(makeOrganisedPdf())
		const result = op(doc, "Delete pages", () => deletePages(doc, [2, 3]))

		expectFrom(result, [0, 1, 4, 5])
		expect(texts(doc)).toEqual(["Page 1", "Page 2", "Page 5", "Page 6"])
		// Chapter 2 keeps its place and destination; its section (page 3) is gone; chapters 3 and 4 too.
		expect(outlineTitles(doc)).toEqual(["Chapter 1@1", "Chapter 2@2", "Chapter 5@3", "Chapter 6@4"])
		expect(root(doc).get("Outlines").get("Count").asNumber()).toBe(4)
		// Links to pages 3 and 4 dropped; the named one to page 5 stays.
		expect(linkTargets(doc, 0)).toEqual([3, "https://example.com/"])
		expect(root(doc).get("Dests").get("toFour").isNull()).toBe(true)
		expect(root(doc).get("OpenAction").isNull()).toBe(true)
		// "city" (page 3) and the signature (page 4) leave the form; the radio keeps its page-2 widget.
		expect(fieldNames(doc)).toEqual(["name", "choice"])
		expect(root(doc).get("AcroForm").get("Fields").get(1).get("Kids").length).toBe(1)
		// Structure elements and ParentTree entries of pages 3 and 4 dropped.
		expect(root(doc).get("StructTreeRoot").get("K").length).toBe(4)
		expect(root(doc).get("StructTreeRoot").get("ParentTree").get("Nums").length).toBe(8)
		expect(labels(doc)).toEqual(["i", "ii", "1", "2"])
		expect(result.tagged).toBe(true)

		doc.undo()
		expect(texts(doc)).toEqual(["Page 1", "Page 2", "Page 3", "Page 4", "Page 5", "Page 6"])
		expect(fieldNames(doc)).toEqual(["name", "city", "choice", "approval"])
		expect(outlineTitles(doc)).toHaveLength(7)
		expect(linkTargets(doc, 0)).toEqual([3, 4, 5, "https://example.com/"])
		expect(root(doc).get("StructTreeRoot").get("K").length).toBe(6)
		doc.redo()

		const bytes = save(doc)
		const reopened = open(bytes)

		expect(reopened.countPages()).toBe(4)
		expect(await pdfjsTexts(bytes)).toEqual(["Page 1", "Page 2", "Page 5", "Page 6"])
		// The deleted pages' content is not in the saved file.
		expect(rawText(reopened)).not.toContain("Page 3")
	})

	it("never deletes every page", () => {
		const doc = open(makeOrganisedPdf())

		expect(() => op(doc, "Delete", () => deletePages(doc, [0, 1, 2, 3, 4, 5]))).toThrow(PageOpError)
		expect(doc.countPages()).toBe(6)
	})
})

describe("duplicate", () => {
	it("puts each copy after its original; copied widgets join their fields", async () => {
		const doc = open(makeOrganisedPdf())
		const result = op(doc, "Duplicate", () => duplicatePages(doc, [0, 1]))

		expectFrom(result, [0, -1, 1, -1, 2, 3, 4, 5])
		expect([...result.touched]).toEqual([1, 3])
		expect(texts(doc).slice(0, 4)).toEqual(["Page 1", "Page 1", "Page 2", "Page 2"])
		// "name" was a merged field/widget: now a field with two widgets; "choice" gained a third.
		const fields = root(doc).get("AcroForm").get("Fields")

		expect(fields.get(0).get("Kids").length).toBe(2)
		expect(fields.get(0).get("T").asString()).toBe("name")
		expect(fields.get(2).get("Kids").length).toBe(3)
		expect(doc.loadPage(1).getWidgets()).toHaveLength(1)
		expect(doc.findPage(1).get("StructParents").isNull()).toBe(true)

		const bytes = save(doc)
		const pdf = await openPdf(bytes)
		const objects = await pdf.getFieldObjects()

		expect(objects?.get("name")?.filter(field => "page" in field && field.page !== -1)).toHaveLength(2)
		expect(await pdfjsTexts(bytes)).toHaveLength(8)
		await pdf.loadingTask.destroy()
	})
})

describe("insert", () => {
	it("inserts blank pages sized like the page before them", () => {
		const doc = open(makeOrganisedPdf())
		const result = op(doc, "Insert blank", () => insertBlankPages(doc, 1, 2))

		expectFrom(result, [0, -1, -1, 1, 2, 3, 4, 5])
		expect(doc.loadPage(1).getBounds()).toEqual([0, 0, 595, 842])
		expect(doc.countPages()).toBe(8)
	})

	it("inserts an image as a page fitted to its neighbour's size, turned to the image's orientation", () => {
		const doc = open(makeOrganisedPdf())
		const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 400, 200], false)

		pixmap.clear(128)

		const png = pixmap.asPNG().slice()
		const result = op(doc, "Insert image", () => insertImagePage(mupdf, doc, png, 1))

		expectFrom(result, [0, -1, 1, 2, 3, 4, 5])

		const [, , width, height] = doc.loadPage(1).getBounds()

		expect(width).toBe(842)
		expect(height).toBe(595)
		expect(() => insertImagePage(mupdf, doc, new Uint8Array([1, 2, 3]), 0)).toThrow(PageOpError)
	})

	it("inserts pages of another document without its scripts, keeping links between inserted pages", async () => {
		const doc = open(makeOrganisedPdf())
		const other = open(makeOtherPdf())
		const result = op(doc, "Insert from file", () => insertPagesFrom(doc, other, [0, 1], 1))

		expectFrom(result, [0, -1, -1, 1, 2, 3, 4, 5])
		expect(texts(doc).slice(0, 4)).toEqual(["Page 1", "Other 1", "Other 2", "Page 2"])
		// The link to "Other 3" (not inserted) is dropped; the one to "Other 2" goes to its copy.
		expect(linkTargets(doc, 1)).toEqual([3])
		// The inserted "name" is renamed beside this document's own.
		expect(fieldNames(doc)).toContain("name_2")
		expect(doc.findPage(1).get("AA").isNull()).toBe(true)

		doc.undo()
		expect(doc.countPages()).toBe(6)
		expect(fieldNames(doc)).not.toContain("name_2")
		doc.redo()

		const raw = rawText(doc)

		expect(raw).not.toContain("app.alert(3)")
		expect(raw).not.toContain("event.rc")
		expect(raw).not.toContain("Other 3")
		expect((await pdfjsTexts(save(doc))).slice(0, 4)).toEqual(["Page 1", "Other 1", "Other 2", "Page 2"])
	})
})

describe("extract", () => {
	it("makes a new document of the pages with their fields, outline and links; signatures drawn, not carried", async () => {
		const source = open(makeOrganisedPdf())
		const extracted = extractDocument(mupdf, source, [1, 2, 3])
		const doc = extracted.document

		expect(extracted.flattenedSignatures).toBe(1)
		expect(extracted.droppedTags).toBe(true)
		expect(texts(doc)).toEqual(["Page 2", "Page 3", "Page 4"])
		expect(fieldNames(doc)).toEqual(["choice", "city"])
		expect(root(doc).get("AcroForm").get("SigFlags").isNull()).toBe(true)
		expect(outlineTitles(doc)).toEqual(["Chapter 2@1", "-Section 2.1@2", "Chapter 3@2", "Chapter 4@3"])

		const raw = rawText(doc)

		// The signature's appearance is page content now; no signature dictionary travels; nothing of pages 1, 5, 6.
		expect(raw).toContain("FlSig1 Do")
		expect(raw).not.toContain("/Sig")
		expect(raw).not.toContain("Page 1)")
		expect(raw).not.toContain("Page 5")
		expect(raw).not.toContain("example.com")

		const saved = extractSaveOptions(source, null)

		expect(saved).toEqual({ ok: true, options: UNENCRYPTED, encrypted: false })

		const bytes = save(doc, saved.ok ? saved.options : "")
		const unlocked = mupdf.Document.openDocument(bytes, "application/pdf")

		expect(unlocked.needsPassword()).toBe(false)
		expect(unlocked.getMetaData("encryption")).toBe("None")
		const pdf = await openPdf(bytes)
		const objects = await pdf.getFieldObjects()

		expect([...(objects?.keys() ?? [])].sort()).toEqual(["choice", "city"])
		expect(await pdfjsTexts(bytes)).toEqual(["Page 2", "Page 3", "Page 4"])
		await pdf.loadingTask.destroy()

		// The source is untouched.
		expect(source.countPages()).toBe(6)
		expect(source.canUndo()).toBe(false)
		doc.destroy()
	})

	it("carries the source's encryption as AES-256 with its permissions, and can leave it off", async () => {
		const source = open(makeOrganisedPdf({ userPassword: "pässword" }), "pässword")
		const extracted = extractDocument(mupdf, source, [1])
		const saved = extractSaveOptions(source, { user: "pässword" })

		if (!saved.ok) throw new Error("refused")

		expect(saved.encrypted).toBe(true)

		const bytes = save(extracted.document, saved.options)
		const reopened = mupdf.Document.openDocument(bytes, "application/pdf")

		expect(reopened.needsPassword()).toBe(true)
		expect(reopened.authenticatePassword("pässword")).toBeGreaterThan(0)
		expect(await pdfjsTexts(bytes, "pässword")).toEqual(["Page 2"])
		expect(extractSaveOptions(source, { user: "pässword" }, false)).toEqual({ ok: true, options: UNENCRYPTED, encrypted: false })

		// A separator in a password is a password character, never another option.
		const comma = extractSaveOptions(source, { user: "a,encrypt=none" })

		if (!comma.ok) throw new Error("refused")

		const commaDoc = mupdf.Document.openDocument(save(extracted.document, comma.options), "application/pdf")

		expect(commaDoc.needsPassword()).toBe(true)
		expect(commaDoc.authenticatePassword("a,encrypt=none")).toBeGreaterThan(0)
		// A control character cannot pass the option parser unchanged: such a password cannot be carried.
		expect(extractSaveOptions(source, { user: "a\u0007b" })).toEqual({ ok: false, reason: "unsupportedPassword" })
		expect(extractSaveOptions(source, { user: "a\tb" })).toEqual({ ok: false, reason: "unsupportedPassword" })
		extracted.document.destroy()
	})

	it.each(["a,encrypt=none", 'x","encrypt":"none', 'o\\"wn,er=1}{', "🔑,=密码"])(
		"carries a password with separators %j intact, never as options",
		async password => {
			const source = open(makeOrganisedPdf({ userPassword: "pässword" }), "pässword")
			const extracted = extractDocument(mupdf, source, [0])
			const saved = extractSaveOptions(source, { user: password, owner: `${password}!` })

			if (!saved.ok) throw new Error("refused")

			const bytes = save(extracted.document, saved.options)
			const reopened = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()

			expect(reopened?.getMetaData("encryption")).toBe("Standard V5 R6 256-bit AES")
			expect(reopened?.needsPassword()).toBe(true)
			expect(reopened?.authenticatePassword(password)).toBe(2)
			expect(reopened?.authenticatePassword(`${password}!`)).toBe(4)
			expect(await pdfjsTexts(bytes, password)).toEqual(["Page 1"])
			extracted.document.destroy()
		}
	)

	it("lists the top-level bookmarks' pages for a split", () => {
		expect(topLevelBookmarkPages(open(makeOrganisedPdf()))).toEqual([0, 1, 2, 3, 4, 5])
	})
})

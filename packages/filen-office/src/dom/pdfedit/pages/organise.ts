import type { Image, PDFDocument, PDFObject } from "mupdf"
import { deleteOrder, isIdentityOrder, isPermutation, selectionPages } from "../../../core/pdfedit/pageOrder"
import type { MupdfModule } from "../protocol"
import { copyPages } from "./copy"
import { at, catalog, deref, ensureArray, items, MAX_DEPTH, nameOf, numOf, pageAnnots, ref, shallowCopy } from "./objects"
import { collectRemoved, pruneReferences } from "./references"

// Page organisation on a live (journaled) document. Each function is one journal operation's worth of change: the
// caller wraps it in beginOperation/endOperation (abandonOperation when it throws) and reads the result to update its
// page list. Nothing here calls rearrangePages: it rewrites the catalog outside the journal (see references.ts).

export interface PageOpResult {
	// Per page of the result, the 0-based page it was before the operation, or -1 for a new page: the session keeps its
	// page ids and thumbnails across the change.
	readonly from: readonly number[]
	// Pages of the result (0-based) whose appearance changed.
	readonly touched: readonly number[]
	// The document carries accessibility tags (/MarkInfo /Marked and a structure tree): the "tags may be incomplete"
	// notice is due after deletes, inserts and duplicates.
	readonly tagged: boolean
}

export type PageOpRefusal = "lastPage" | "badOrder" | "badPages" | "badImage"

export class PageOpError extends Error {
	readonly reason: PageOpRefusal

	constructor(reason: PageOpRefusal) {
		super(`page operation refused: ${reason}`)
		this.name = "PageOpError"
		this.reason = reason
	}
}

// True for a tagged PDF: /MarkInfo /Marked true and a /StructTreeRoot.
export function isTaggedPdf(doc: PDFDocument): boolean {
	const root = catalog(doc)
	const marked = at(root, "MarkInfo", "Marked")

	return marked.isBoolean() && marked.asBoolean() && at(root, "StructTreeRoot").isDictionary()
}

function identityFrom(count: number): number[] {
	return Array.from({ length: count }, (_, index) => index)
}

// The /PageLabels number tree as key/label pairs, so a reorder (whose deletes and inserts shift MuPDF's label ranges)
// can put the ranges back where they were: labels belong to positions, not to pages.
function readLabels(doc: PDFDocument): PDFObject[] | null {
	const tree = at(catalog(doc), "PageLabels")

	if (!tree.isDictionary()) return null

	const pairs: PDFObject[] = []
	const walk = (node: PDFObject, depth: number): void => {
		if (depth > MAX_DEPTH) return

		for (const kid of items(ref(node, "Kids"))) walk(deref(kid), depth + 1)

		const nums = items(ref(node, "Nums"))

		for (const entry of nums) pairs.push(entry)
	}

	walk(tree, 0)

	return pairs
}

function writeLabels(doc: PDFDocument, pairs: readonly PDFObject[] | null): void {
	const root = catalog(doc)

	if (pairs === null) {
		root.delete("PageLabels")

		return
	}

	const nums = doc.newArray()

	for (const entry of pairs) nums.push(entry)

	const tree = doc.newDictionary()

	tree.put("Nums", nums)
	root.put("PageLabels", tree)
}

// Reorders the pages: `order` lists every old page index once, in the new order. Page objects move, so links,
// outlines, fields and tags (all pointing at page objects) follow their pages; page labels stay with positions.
export function reorderPages(doc: PDFDocument, order: readonly number[]): PageOpResult {
	const count = doc.countPages()

	if (!isPermutation(order, count)) throw new PageOpError("badOrder")

	const tagged = isTaggedPdf(doc)

	if (isIdentityOrder(order)) return { from: identityFrom(count), touched: [], tagged }

	const labels = readLabels(doc)
	const objects = identityFrom(count).map(index => doc.findPage(index))
	// The page objects' numbers in their current order, updated with every move.
	const current = objects.map(object => numOf(object) ?? -1)

	order.forEach((wanted, index) => {
		const want = numOf(objects[wanted] ?? doc.findPage(wanted)) ?? -1
		const from = current.indexOf(want, index)
		const object = objects[wanted]

		if (from === index || from < 0 || object === undefined) return

		doc.deletePage(from)
		doc.insertPage(index, object)
		current.splice(from, 1)
		current.splice(index, 0, want)
	})

	writeLabels(doc, labels)

	return { from: [...order], touched: [], tagged }
}

// Rotates pages by a multiple of 90 degrees (positive: clockwise), on top of their current (possibly inherited)
// /Rotate.
export function rotatePages(doc: PDFDocument, pages: Iterable<number>, degrees: number): PageOpResult {
	const count = doc.countPages()
	const touched = selectionPages(count, pages)

	if (degrees % 90 !== 0) throw new PageOpError("badPages")

	for (const index of touched) {
		const page = deref(doc.findPage(index))
		const inherited = deref(page.getInheritable("Rotate"))
		const current = inherited.isNumber() ? inherited.asNumber() : 0
		const next = (((Math.round(current / 90) * 90 + degrees) % 360) + 360) % 360

		page.put("Rotate", next)
	}

	return { from: identityFrom(count), touched, tagged: isTaggedPdf(doc) }
}

// Deletes pages, then everything that pointed at them (references.ts). At least one page must stay.
export function deletePages(doc: PDFDocument, pages: Iterable<number>): PageOpResult {
	const count = doc.countPages()
	const doomed = selectionPages(count, pages)

	if (doomed.length === 0) return { from: identityFrom(count), touched: [], tagged: isTaggedPdf(doc) }
	if (doomed.length >= count) throw new PageOpError("lastPage")

	const removed = collectRemoved(doc, doomed)

	for (let index = doomed.length - 1; index >= 0; index--) doc.deletePage(doomed[index] ?? 0)

	pruneReferences(doc, removed)

	return { from: deleteOrder(count, doomed), touched: [], tagged: isTaggedPdf(doc) }
}

// Field keys moved from a merged field/widget into a new field when the widget gets a sibling.
const FIELD_KEYS = ["FT", "T", "TU", "TM", "Ff", "V", "DV", "Opt", "TI", "I", "MaxLen", "DA", "Q", "DS", "RV", "Lock", "SV"]
const PAGE_COPY_SKIP = new Set(["Annots", "StructParents", "Parent", "B"])
const ANNOT_COPY_SKIP = new Set(["P", "Popup", "IRT", "Parent", "StructParent"])

// The field a widget copy joins: its own /Parent, or (a merged field and widget) a new field the original's field
// keys move into, put where the original stood.
function widgetField(doc: PDFDocument, widget: PDFObject): PDFObject {
	const dict = deref(widget)
	const parent = ref(dict, "Parent")

	if (!parent.isNull()) return parent

	const field = doc.addObject(doc.newDictionary())

	for (const key of FIELD_KEYS) {
		const value = ref(dict, key)

		if (!value.isNull()) {
			field.put(key, value)
			dict.delete(key)
		}
	}

	const kids = doc.newArray()

	kids.push(widget)
	field.put("Kids", kids)
	dict.put("Parent", field)

	const fields = at(catalog(doc), "AcroForm", "Fields")
	const num = numOf(widget)

	if (fields.isArray() && num !== null) {
		for (let index = 0; index < fields.length; index++) {
			if (numOf(fields.get(index)) === num) fields.put(index, field)
		}
	}

	return field
}

// A copy of a page as a new page object: content and resources shared, annotations copied (form widgets join their
// field, so the copy shows and edits the same value), tags left out.
function copyPageObject(doc: PDFDocument, page: PDFObject): PDFObject {
	const copy = doc.addObject(shallowCopy(doc, page, PAGE_COPY_SKIP))
	const annots = doc.newArray()
	const copies = new Map<number, PDFObject>()
	const pairs: { readonly source: PDFObject; readonly copy: PDFObject }[] = []

	for (const annot of pageAnnots(page)) {
		const source = deref(annot)

		if (!source.isDictionary()) continue

		// A merged field/widget first gives its field keys to a new field, so the copy is a plain widget.
		const field = nameOf(ref(source, "Subtype")) === "Widget" ? widgetField(doc, annot) : null
		const made = doc.addObject(shallowCopy(doc, source, ANNOT_COPY_SKIP))

		made.put("P", copy)

		if (field !== null) {
			made.put("Parent", field)
			ensureArray(doc, deref(field), "Kids").push(made)
		}

		const num = numOf(annot)

		if (num !== null) copies.set(num, made)

		pairs.push({ source, copy: made })
		annots.push(made)
	}

	for (const { source, copy: made } of pairs) {
		for (const key of ["Popup", "IRT"] as const) {
			const linked = numOf(ref(source, key))
			const target = linked === null ? undefined : copies.get(linked)

			if (target !== undefined) made.put(key, target)
		}

		if (nameOf(ref(source, "Subtype")) === "Popup") {
			const owner = numOf(ref(source, "Parent"))
			const target = owner === null ? undefined : copies.get(owner)

			if (target !== undefined) made.put("Parent", target)
		}
	}

	if (annots.length > 0) copy.put("Annots", annots)

	return copy
}

// Duplicates pages: each copy right after its original.
export function duplicatePages(doc: PDFDocument, pages: Iterable<number>): PageOpResult {
	const count = doc.countPages()
	const sources = selectionPages(count, pages)
	const from: number[] = []
	const touched: number[] = []

	for (let index = sources.length - 1; index >= 0; index--) {
		const page = sources[index] ?? 0

		doc.insertPage(page + 1, copyPageObject(doc, doc.findPage(page)))
	}

	const duplicated = new Set(sources)
	let added = 0

	for (let page = 0; page < count; page++) {
		from.push(page)

		if (duplicated.has(page)) {
			added++
			from.push(-1)
			touched.push(page + added)
		}
	}

	return { from, touched, tagged: isTaggedPdf(doc) }
}

// The size (points, as shown) of the page a new page joins: the one before `at`, or the first page.
function neighbourSize(doc: PDFDocument, at_: number): readonly [number, number] {
	const count = doc.countPages()

	if (count === 0) return [595.28, 841.89]

	const [x0, y0, x1, y1] = doc.loadPage(Math.max(0, Math.min(count - 1, at_ - 1))).getBounds()

	return [Math.max(1, x1 - x0), Math.max(1, y1 - y0)]
}

function insertedResult(doc: PDFDocument, count: number, at_: number, added: number): PageOpResult {
	const from = identityFrom(count)
	const touched = Array.from({ length: added }, (_, offset) => at_ + offset)

	from.splice(at_, 0, ...touched.map(() => -1))

	return { from, touched, tagged: isTaggedPdf(doc) }
}

// Inserts `count` blank pages before page `at` (0..pages), sized like the page before them (the first page at 0).
export function insertBlankPages(doc: PDFDocument, at_: number, count = 1): PageOpResult {
	const pages = doc.countPages()
	const start = Math.max(0, Math.min(pages, Math.trunc(at_)))
	const [width, height] = neighbourSize(doc, start)

	for (let offset = 0; offset < count; offset++) {
		doc.insertPage(start + offset, doc.addPage([0, 0, width, height], 0, doc.newDictionary(), ""))
	}

	return insertedResult(doc, pages, start, count)
}

// Inserts an image (bytes MuPDF can decode: JPEG, PNG, GIF, BMP, TIFF, JPEG 2000, JBIG2, PNM) as a new page before page
// `at`: the page is sized like its neighbour, turned to the image's orientation, the image fitted and centred.
export function insertImagePage(mupdf: MupdfModule, doc: PDFDocument, bytes: Uint8Array, at_: number): PageOpResult {
	const pages = doc.countPages()
	const start = Math.max(0, Math.min(pages, Math.trunc(at_)))
	let image: Image

	try {
		image = new mupdf.Image(bytes)
	} catch {
		throw new PageOpError("badImage")
	}

	const imageWidth = image.getWidth()
	const imageHeight = image.getHeight()

	if (imageWidth <= 0 || imageHeight <= 0) throw new PageOpError("badImage")

	const [neighbourWidth, neighbourHeight] = neighbourSize(doc, start)
	const landscape = imageWidth > imageHeight
	const width = landscape === neighbourWidth > neighbourHeight ? neighbourWidth : neighbourHeight
	const height = width === neighbourWidth ? neighbourHeight : neighbourWidth
	const scale = Math.min(width / imageWidth, height / imageHeight)
	const drawWidth = imageWidth * scale
	const drawHeight = imageHeight * scale
	const x = (width - drawWidth) / 2
	const y = (height - drawHeight) / 2
	const resources = doc.newDictionary()
	const xobjects = doc.newDictionary()

	xobjects.put("Im1", doc.addImage(image))
	resources.put("XObject", xobjects)

	const content = `q ${drawWidth.toFixed(4)} 0 0 ${drawHeight.toFixed(4)} ${x.toFixed(4)} ${y.toFixed(4)} cm /Im1 Do Q`

	doc.insertPage(start, doc.addPage([0, 0, width, height], 0, resources, content))
	image.destroy()

	return insertedResult(doc, pages, start, 1)
}

// Inserts pages of a second open document before page `at` through one graft map. Scripts and additional actions of
// the inserted pages are dropped, signed signature fields are drawn into their pages, form fields join this
// document's form (renamed when a name is taken), and the inserted pages are untagged.
export function insertPagesFrom(doc: PDFDocument, source: PDFDocument, pages: readonly number[], at_: number): PageOpResult {
	const count = doc.countPages()
	const sourceCount = source.countPages()

	if (pages.length === 0 || pages.some(page => !Number.isInteger(page) || page < 0 || page >= sourceCount)) {
		throw new PageOpError("badPages")
	}

	const start = Math.max(0, Math.min(count, Math.trunc(at_)))

	copyPages(doc, source, pages, start, { scripts: "strip" })

	return insertedResult(doc, count, start, pages.length)
}

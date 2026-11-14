import type { PDFDocument, PDFObject } from "mupdf"

// Object access shared by the page operations. MuPDF's null object has no document, so every read of a value that may
// be missing goes through these instead of PDFObject.get.

// Bounds on walks over document-supplied structures (outline, field and structure trees, name trees): a malformed or
// hostile file can loop or nest without end.
export const MAX_DEPTH = 64
export const MAX_NODES = 1_000_000

export function deref(object: PDFObject): PDFObject {
	return object.isNull() ? object : object.resolve()
}

// The value at a key or index path, unresolved (to read its object number).
export function ref(object: PDFObject, ...path: (string | number)[]): PDFObject {
	return object.isNull() ? object : object.get(...path)
}

export function at(object: PDFObject, ...path: (string | number)[]): PDFObject {
	return deref(ref(object, ...path))
}

export function nameOf(object: PDFObject): string | null {
	const resolved = deref(object)

	return resolved.isName() ? resolved.asName() : null
}

export function numOf(object: PDFObject): number | null {
	return object.isIndirect() ? object.asIndirect() : null
}

export function isTrue(object: PDFObject): boolean {
	const resolved = deref(object)

	return resolved.isBoolean() && resolved.asBoolean()
}

export function catalog(doc: PDFDocument): PDFObject {
	return at(doc.getTrailer(), "Root")
}

// The array at `key` of `dict` (made, as a direct array, when missing or not an array).
export function ensureArray(doc: PDFDocument, dict: PDFObject, key: string): PDFObject {
	const existing = at(dict, key)

	if (existing.isArray()) return existing

	const array = doc.newArray()

	dict.put(key, array)

	return array
}

export function ensureDict(doc: PDFDocument, dict: PDFObject, key: string): PDFObject {
	const existing = at(dict, key)

	if (existing.isDictionary()) return existing

	const made = doc.newDictionary()

	dict.put(key, made)

	return made
}

// The entries of an array, unresolved.
export function items(array: PDFObject): PDFObject[] {
	const resolved = deref(array)
	const out: PDFObject[] = []

	if (!resolved.isArray()) return out

	for (let index = 0; index < resolved.length; index++) out.push(resolved.get(index))

	return out
}

// A new direct dictionary in `doc` holding `dict`'s entries except `skip` (values shared, not copied): a sibling
// that can be changed at its top level without touching the original.
export function shallowCopy(doc: PDFDocument, dict: PDFObject, skip: ReadonlySet<string> = new Set()): PDFObject {
	const copy = doc.newDictionary()
	const resolved = deref(dict)

	if (!resolved.isDictionary()) return copy

	resolved.forEach((value, key) => {
		if (typeof key === "string" && !skip.has(key)) copy.put(key, value)
	})

	return copy
}

// The object numbers of the page objects in page order.
export function pageNums(doc: PDFDocument): number[] {
	const count = doc.countPages()
	const out: number[] = []

	for (let index = 0; index < count; index++) out.push(numOf(doc.findPage(index)) ?? -1)

	return out
}

// Page index by page object number.
export function pageIndexByNum(doc: PDFDocument): Map<number, number> {
	const map = new Map<number, number>()

	pageNums(doc).forEach((num, index) => {
		if (num >= 0) map.set(num, index)
	})

	return map
}

// The annotation objects of a page (unresolved references, or direct dictionaries).
export function pageAnnots(page: PDFObject): PDFObject[] {
	return items(ref(page, "Annots"))
}

// A destination's explicit form: a name or string resolved through the document's named destinations, a {D: …}
// dictionary unwrapped. Null when it cannot be resolved.
export interface NamedDests {
	readonly lookup: (key: string) => PDFObject | null
}

export function namedDests(doc: PDFDocument): NamedDests {
	let tree: Record<string, PDFObject> | null = null
	const old = at(catalog(doc), "Dests")

	return {
		lookup: key => {
			if (old.isDictionary()) {
				const found = at(old, key)

				if (!found.isNull()) return found
			}

			tree ??= doc.loadNameTree("Dests")

			return tree[key] ?? null
		}
	}
}

export function explicitDest(dest: PDFObject, named: NamedDests): PDFObject | null {
	let value = deref(dest)

	for (let hops = 0; hops < 4; hops++) {
		if (value.isArray()) return value
		if (value.isDictionary()) {
			value = at(value, "D")
			continue
		}

		const key = value.isName() ? value.asName() : value.isString() ? value.asString() : null

		if (key === null) return null

		const found = named.lookup(key)

		if (found === null) return null

		value = deref(found)
	}

	return null
}

// The page object number a destination points at inside this document, or null (external, missing, malformed).
export function destPageNum(dest: PDFObject, named: NamedDests): number | null {
	const explicit = explicitDest(dest, named)

	return explicit === null ? null : numOf(ref(explicit, 0))
}

// The destination an outline item, link or OpenAction goes to inside this document: its /Dest, or a GoTo action's /D.
// Null when it has none (a URI, a script, another file).
export function targetDest(holder: PDFObject): PDFObject | null {
	const resolved = deref(holder)

	if (resolved.isArray()) return resolved

	const dest = ref(resolved, "Dest")

	if (!dest.isNull()) return dest

	const action = at(resolved, "A")

	if (action.isDictionary() && nameOf(ref(action, "S")) === "GoTo") {
		const goTo = ref(action, "D")

		return goTo.isNull() ? null : goTo
	}

	// An OpenAction may be the action itself.
	if (nameOf(ref(resolved, "S")) === "GoTo") {
		const goTo = ref(resolved, "D")

		return goTo.isNull() ? null : goTo
	}

	return null
}

// Appends drawing to a page's content: the existing content wrapped in q/Q (so a CTM it leaves behind does not move
// what follows), then `content`, with `resources` merged into the page's XObject resources.
export function appendPageContent(doc: PDFDocument, page: PDFObject, content: string, xobjects: ReadonlyMap<string, PDFObject>): void {
	const resolved = deref(page)
	const resources = at(resolved, "Resources")
	let own = resources

	if (!own.isDictionary()) {
		own = doc.newDictionary()
		resolved.put("Resources", own)
	} else if (ref(resolved, "Resources").isIndirect()) {
		// Resources shared with other pages: this page gets its own copy before an entry is added.
		own = shallowCopy(doc, resources)
		resolved.put("Resources", own)
	}

	const existing = at(own, "XObject")
	const xobject = existing.isDictionary() ? shallowCopy(doc, existing) : doc.newDictionary()

	for (const [key, value] of xobjects) xobject.put(key, value)

	own.put("XObject", xobject)

	const contents = doc.newArray()

	contents.push(doc.addStream("q\n", {}))

	const old = ref(resolved, "Contents")
	const oldResolved = deref(old)

	if (oldResolved.isArray()) for (const part of items(oldResolved)) contents.push(part)
	else if (!old.isNull()) contents.push(old)

	contents.push(doc.addStream(`\nQ\n${content}`, {}))
	resolved.put("Contents", contents)
}

// An XObject resource name not yet used on the page.
export function freeXObjectName(page: PDFObject, prefix: string, taken: Set<string>): string {
	const existing = at(page, "Resources", "XObject")

	for (let index = 1; ; index++) {
		const candidate = `${prefix}${String(index)}`

		if (!taken.has(candidate) && (!existing.isDictionary() || at(existing, candidate).isNull())) {
			taken.add(candidate)

			return candidate
		}
	}
}

export type PdfMatrix = readonly [number, number, number, number, number, number]

// The matrix that draws an annotation's appearance stream (BBox through its /Matrix) into the annotation's Rect, as
// a viewer places it (PDF 32000-1 12.5.5).
export function appearanceMatrix(bbox: readonly number[], matrix: PdfMatrix, rect: readonly number[]): PdfMatrix | null {
	const [bx0 = 0, by0 = 0, bx1 = 0, by1 = 0] = bbox
	const corners = [
		[bx0, by0],
		[bx1, by0],
		[bx0, by1],
		[bx1, by1]
	].map(([x = 0, y = 0]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]] as const)
	const xs = corners.map(corner => corner[0])
	const ys = corners.map(corner => corner[1])
	const tx0 = Math.min(...xs)
	const ty0 = Math.min(...ys)
	const width = Math.max(...xs) - tx0
	const height = Math.max(...ys) - ty0
	const [rx0 = 0, ry0 = 0, rx1 = 0, ry1 = 0] = rect
	const left = Math.min(rx0, rx1)
	const bottom = Math.min(ry0, ry1)

	if (width <= 0 || height <= 0) return null

	const sx = Math.abs(rx1 - rx0) / width
	const sy = Math.abs(ry1 - ry0) / height

	// The placement only: `Do` applies the form's own /Matrix before it.
	return [sx, 0, 0, sy, left - tx0 * sx, bottom - ty0 * sy]
}

export function numbers(object: PDFObject): number[] | null {
	const resolved = deref(object)

	if (!resolved.isArray()) return null

	const out: number[] = []

	for (let index = 0; index < resolved.length; index++) {
		const item = at(resolved, index)

		if (!item.isNumber()) return null

		out.push(item.asNumber())
	}

	return out
}

export function formatNumber(value: number): string {
	const rounded = Math.round(value * 10_000) / 10_000

	return Object.is(rounded, -0) ? "0" : String(rounded)
}

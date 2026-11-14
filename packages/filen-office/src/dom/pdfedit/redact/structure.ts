import type * as Mupdf from "mupdf"

// The tagged-PDF side of a redaction: struct elements whose content was redacted lose their text alternatives
// (ActualText, Alt, E), which would otherwise still spell out what the page no longer draws.

const ALTERNATIVES = ["ActualText", "Alt", "E"]
const MAX_TREE_DEPTH = 32

// The value under `key` in a number tree, or null.
export function numberTreeGet(node: Mupdf.PDFObject, key: number, depth = 0): Mupdf.PDFObject | null {
	if (!node.isDictionary() || depth > MAX_TREE_DEPTH) return null

	const nums = node.get("Nums")

	if (nums.isArray()) {
		for (let index = 0; index + 1 < nums.length; index += 2) {
			if (nums.get(index).asNumber() === key) return nums.get(index + 1)
		}
	}

	const kids = node.get("Kids")

	if (!kids.isArray()) return null

	for (let index = 0; index < kids.length; index++) {
		const kid = kids.get(index)
		const limits = kid.get("Limits")

		if (limits.isArray() && (key < limits.get(0).asNumber() || key > limits.get(1).asNumber())) continue

		const found = numberTreeGet(kid, key, depth + 1)

		if (found !== null) return found
	}

	return null
}

function parentTree(document: Mupdf.PDFDocument): Mupdf.PDFObject | null {
	const tree = document.getTrailer().get("Root", "StructTreeRoot", "ParentTree")

	return tree.isDictionary() ? tree : null
}

function strip(element: Mupdf.PDFObject): boolean {
	let changed = false

	if (!element.isDictionary()) return false

	for (const key of ALTERNATIVES) {
		if (!element.get(key).isNull()) {
			element.delete(key)
			changed = true
		}
	}

	return changed
}

// Strips the text alternatives of the struct elements owning the given MCIDs of a page (or of every MCID on it).
// Returns whether anything changed.
export function stripPageStructText(document: Mupdf.PDFDocument, page: Mupdf.PDFObject, mcids: ReadonlySet<number> | "all"): boolean {
	const tree = parentTree(document)
	const key = page.get("StructParents")

	if (tree === null || !key.isNumber()) return false

	const entry = numberTreeGet(tree, key.asNumber())

	if (entry === null) return false
	if (!entry.isArray()) return strip(entry)

	let changed = false

	for (let index = 0; index < entry.length; index++) {
		if (mcids === "all" || mcids.has(index)) changed = strip(entry.get(index)) || changed
	}

	return changed
}

// Strips the text alternatives of the struct element of an object with a StructParent key (an annotation).
export function stripObjectStructText(document: Mupdf.PDFDocument, object: Mupdf.PDFObject): boolean {
	const tree = parentTree(document)
	const key = object.get("StructParent")

	if (tree === null || !key.isNumber()) return false

	const entry = numberTreeGet(tree, key.asNumber())

	return entry !== null && strip(entry)
}

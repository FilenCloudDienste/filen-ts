import type * as Mupdf from "mupdf"
import { graftOverlay } from "../overlay"
import type { MupdfModule } from "../protocol"
import { allChars, charKey, readStext, type PdfQuad, type StextChar } from "./stext"
import type { TextEditChar, TextEditTarget } from "./target"

// Replacing text, as ONE journal operation the caller opens before and ends (or abandons) after:
// 1. every other pending Redact annotation on the page is detached (deleted, re-created after step 3 with its own
//    entries), so applying redactions touches only ours;
// 2. our Redact annotation covers the target's glyphs, each quad shrunk (15 % of its height off top and bottom; at
//    the ends of a run, the edge moved to the middle of the gap to the neighbouring glyph), applied with text removal
//    only (no box, images and drawings untouched);
// 3. the page's text before and after must differ by exactly the target's glyphs: if any other glyph went, or a
//    target glyph stayed, the result is "unsafe" and the caller abandons the operation (nothing is re-created);
// 4. the new text, laid out beforehand into a one-page overlay PDF (core/pdfedit/textLayout.ts), is grafted over the
//    page (overlay.ts).
// Structure (tagged PDF) is not updated: `tagged` says the document has tags, for the notice.
//
// The page's PDFPage wrappers held elsewhere keep a stale annotation list after this (MuPDF deletes the applied
// Redact annotation underneath them): reload the page.

export type TextEditResult =
	| { readonly status: "applied"; readonly pages: readonly number[]; readonly tagged: boolean }
	// Abandon the journal operation and say the change was not applied (the "unsafe" notice).
	| { readonly status: "unsafe" }

// Of the glyph's height, taken off its top and its bottom.
const VERTICAL_INSET = 0.15
// Two readings of a glyph's pen position closer than this (points) are the same glyph.
const SAME_POSITION = 0.02

interface DetachedRedact {
	readonly entries: readonly (readonly [string, Mupdf.PDFObject])[]
	readonly popup: Mupdf.Rect | null
	readonly open: boolean
}

export function applyTextEdit(
	mupdf: MupdfModule,
	document: Mupdf.PDFDocument,
	pageIndex: number,
	// Only its glyphs are needed (what a logged step keeps).
	target: Pick<TextEditTarget, "chars">,
	overlay: Uint8Array | null
): TextEditResult {
	const page = document.loadPage(pageIndex)

	try {
		const before = allChars(readStext(page))
		const selected = locate(before, target.chars)

		if (selected === null) return { status: "unsafe" }

		const detached = detachRedactions(page)
		const redact = page.createAnnotation("Redact")

		redact.setQuadPoints(shrunkQuads(before, selected).map(quad => [...quad]))
		page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE)

		if (!removedExactly(before, selected, allChars(readStext(page)))) return { status: "unsafe" }

		reattachRedactions(page, detached)

		if (overlay !== null) graftOverlay(mupdf, document, pageIndex, overlay)

		return { status: "applied", pages: [pageIndex], tagged: isTagged(document) }
	} finally {
		page.destroy()
	}
}

// "Add text": the overlay grafted as it is, nothing removed.
export function applyAddText(
	mupdf: MupdfModule,
	document: Mupdf.PDFDocument,
	pageIndex: number,
	overlay: Uint8Array
): { readonly pages: readonly number[]; readonly tagged: boolean } {
	graftOverlay(mupdf, document, pageIndex, overlay)

	return { pages: [pageIndex], tagged: isTagged(document) }
}

// A document with a structure tree or marked as tagged.
export function isTagged(document: Mupdf.PDFDocument): boolean {
	const root = document.getTrailer().get("Root")

	if (!root.isDictionary()) return false

	const markInfo = root.get("MarkInfo")

	return !root.get("StructTreeRoot").isNull() || (markInfo.isDictionary() && markInfo.get("Marked").valueOf() === true)
}

// Indices into `chars` of the target's glyphs; null when one is not on the page (any more).
function locate(chars: readonly StextChar[], wanted: readonly TextEditChar[]): Set<number> | null {
	const byKey = new Map<string, number[]>()

	chars.forEach((char, index) => {
		const key = charKey(char)
		const list = byKey.get(key)

		if (list === undefined) byKey.set(key, [index])
		else list.push(index)
	})

	const selected = new Set<number>()

	for (const char of wanted) {
		const index = byKey.get(charKey(char))?.find(candidate => !selected.has(candidate)) ?? nearby(chars, char, selected)

		if (index === undefined) return null

		selected.add(index)
	}

	return selected
}

// Rounding can put the same pen position on either side of a 1/100 pt boundary.
function nearby(chars: readonly StextChar[], wanted: TextEditChar, taken: ReadonlySet<number>): number | undefined {
	const index = chars.findIndex(
		(char, at) =>
			!taken.has(at) &&
			char.c === wanted.c &&
			Math.abs(char.x - wanted.x) <= SAME_POSITION &&
			Math.abs(char.y - wanted.y) <= SAME_POSITION
	)

	return index === -1 ? undefined : index
}

function shrunkQuads(chars: readonly StextChar[], selected: ReadonlySet<number>): PdfQuad[] {
	const quads: PdfQuad[] = []

	chars.forEach((char, index) => {
		if (!selected.has(index)) return

		const q = char.quad
		// Upper and lower edges moved towards each other.
		const insetX = (q[4] - q[0]) * VERTICAL_INSET
		const insetY = (q[5] - q[1]) * VERTICAL_INSET
		let ul: [number, number] = [q[0] + insetX, q[1] + insetY]
		let ur: [number, number] = [q[2] + insetX, q[3] + insetY]
		let ll: [number, number] = [q[4] - insetX, q[5] - insetY]
		let lr: [number, number] = [q[6] - insetX, q[7] - insetY]
		const previous = chars[index - 1]
		const next = chars[index + 1]

		// At a run's start and end, the edge sits halfway between this glyph and its unselected neighbour on the line.
		if (previous !== undefined && !selected.has(index - 1) && sameLine(previous, char)) {
			ul = midpoint(ul, [previous.quad[2] + insetX, previous.quad[3] + insetY])
			ll = midpoint(ll, [previous.quad[6] - insetX, previous.quad[7] - insetY])
		}

		if (next !== undefined && !selected.has(index + 1) && sameLine(char, next)) {
			ur = midpoint(ur, [next.quad[0] + insetX, next.quad[1] + insetY])
			lr = midpoint(lr, [next.quad[4] - insetX, next.quad[5] - insetY])
		}

		quads.push([ul[0], ul[1], ur[0], ur[1], ll[0], ll[1], lr[0], lr[1]])
	})

	return quads
}

function midpoint(a: readonly [number, number], b: readonly [number, number]): [number, number] {
	return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}

// Neighbours in the page's text that share a baseline (consecutive in MuPDF's order, so on one line).
function sameLine(a: StextChar, b: StextChar): boolean {
	return Math.abs(a.y - b.y) < Math.max(a.size, b.size) * 0.5 && Math.abs(a.x - b.x) < Math.max(a.size, b.size) * 4
}

function removedExactly(before: readonly StextChar[], selected: ReadonlySet<number>, after: readonly StextChar[]): boolean {
	const remaining = new Map<string, number>()

	for (const char of after) {
		const key = charKey(char)

		remaining.set(key, (remaining.get(key) ?? 0) + 1)
	}

	const expected = new Map<string, number>()

	before.forEach((char, index) => {
		if (selected.has(index)) return

		const key = charKey(char)

		expected.set(key, (expected.get(key) ?? 0) + 1)
	})

	if (after.length !== before.length - selected.size) return false

	for (const [key, count] of expected) if (remaining.get(key) !== count) return false

	return true
}

function detachRedactions(page: Mupdf.PDFPage): DetachedRedact[] {
	const detached: DetachedRedact[] = []

	for (const annotation of [...page.getAnnotations()]) {
		if (annotation.getType() !== "Redact") continue

		const entries: [string, Mupdf.PDFObject][] = []

		annotation.getObject().forEach((value, key) => {
			if (typeof key === "string" && key !== "P" && key !== "Popup") entries.push([key, value])
		})

		const popup = annotation.getObject().get("Popup")

		detached.push({
			entries,
			popup: popup.isNull() ? null : annotation.getPopup(),
			open: popup.isNull() ? false : annotation.getIsOpen()
		})
		page.deleteAnnotation(annotation)
	}

	return detached
}

function reattachRedactions(page: Mupdf.PDFPage, detached: readonly DetachedRedact[]): void {
	for (const redact of detached) {
		const annotation = page.createAnnotation("Redact")
		const object = annotation.getObject()

		for (const [key, value] of redact.entries) object.put(key, value)

		if (redact.popup !== null) {
			annotation.setPopup(redact.popup)
			annotation.setIsOpen(redact.open)
		}
	}
}

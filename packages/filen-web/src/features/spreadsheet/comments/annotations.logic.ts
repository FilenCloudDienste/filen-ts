import { CellFlag, quotedSheetName, rangeName, type SheetQueryResult, type SheetSummary } from "@filen/office/core/sheet"
import type { GridRect } from "@filen/office/react/sheet"
import { isSafeAbsoluteHref } from "@/lib/safeUrl"

// Notes, threaded comments and hyperlinks in the sheet view: what a cell has, where a link goes and where a card goes
// beside its cell.

export type SheetNote = NonNullable<SheetQueryResult<"note.get">>
export type SheetThread = NonNullable<SheetQueryResult<"thread.get">>
export type SheetLink = NonNullable<SheetQueryResult<"link.get">>

export type AnnotationKind = "note" | "thread" | "link"

// What a cell's flags say it has; a comment hides its cell's note (its placeholder), as in Excel.
export function annotationOf(flags: number): AnnotationKind | null {
	if ((flags & CellFlag.THREADED_COMMENT) !== 0) return "thread"
	if ((flags & CellFlag.NOTE) !== 0) return "note"
	if ((flags & CellFlag.HYPERLINK) !== 0) return "link"

	return null
}

// What a new note's text starts with, as Excel starts it: the author's name and a colon, on a line of its own.
export function noteStart(author: string | null): string {
	return author === null || author === "" ? "" : `${author}:\n`
}

// A place in the workbook as Excel names it ("Sheet2!B3:C4").
export function placeName(sheets: readonly SheetSummary[], place: NonNullable<SheetLink["place"]>): string {
	const sheet = sheets.find(candidate => candidate.id === place.sheet)
	const reference = rangeName(place.range)

	return sheet === undefined ? reference : `${quotedSheetName(sheet.name)}!${reference}`
}

export type LinkAction =
	| { readonly kind: "open"; readonly href: string }
	| { readonly kind: "go"; readonly place: NonNullable<SheetLink["place"]> }
	// The target is not a web, mail or phone address the shared link policy allows, or names nothing here.
	| { readonly kind: "blocked" }
	| { readonly kind: "nowhere" }
	// A HYPERLINK formula whose target is only known once calculated.
	| { readonly kind: "unknown" }

// What following a link does. External targets go through the shared link policy (isSafeAbsoluteHref); the
// untrusted-domain confirmation comes after, when it opens.
export function linkAction(link: SheetLink | null): LinkAction {
	if (link === null) return { kind: "unknown" }
	if (link.place !== null) return { kind: "go", place: link.place }
	if (link.location !== null) return { kind: "nowhere" }
	if (link.url === null) return { kind: "unknown" }

	return isSafeAbsoluteHref(link.url) ? { kind: "open", href: link.url.trim() } : { kind: "blocked" }
}

// The primary modifier of a click that follows a link: Command on a Mac, Ctrl elsewhere.
export function followsLink(event: { readonly ctrlKey: boolean; readonly metaKey: boolean }, mac: boolean): boolean {
	return mac ? event.metaKey : event.ctrlKey
}

// Space between a card and its cell, and from the grid's edges (CSS px).
export const CARD_GAP = 6

// Where a card of `width` by `height` goes beside its cell's box (as shown) inside `bounds`: past the cell's trailing
// edge (its right; its left in a right-to-left sheet), on the other side when it does not fit there, its top at the
// cell's top, kept inside the bounds.
export function cardPlace(
	cell: GridRect,
	width: number,
	height: number,
	bounds: { readonly width: number; readonly height: number },
	rightToLeft: boolean
): { readonly left: number; readonly top: number } {
	const after = cell.x + cell.width + CARD_GAP
	const before = cell.x - CARD_GAP - width
	const fitsAfter = after + width <= bounds.width - CARD_GAP
	const fitsBefore = before >= CARD_GAP
	let left = rightToLeft ? (fitsBefore || !fitsAfter ? before : after) : fitsAfter || !fitsBefore ? after : before

	left = Math.max(CARD_GAP, Math.min(left, bounds.width - CARD_GAP - width))

	const top = Math.max(CARD_GAP, Math.min(cell.y, bounds.height - CARD_GAP - height))

	return { left, top }
}

// The link dialog's fields, checked: what link.set takes, or the field that is wrong.
export interface LinkForm {
	readonly kind: "web" | "place"
	readonly address: string
	readonly sheet: string
	readonly reference: string
	readonly text: string
	readonly tooltip: string
}

export type LinkFormResult =
	| { readonly ok: true; readonly target: { readonly url: string } | { readonly location: string } }
	| { readonly ok: false; readonly field: "address" | "reference" }

const REFERENCE = /^\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?$/
const NAME = /^[A-Za-z_\\][\w.\\?]*$/

// A web address without its scheme ("filen.io") is taken as https, as Excel takes one; a bare email address as mailto.
export function linkTarget(form: LinkForm): LinkFormResult {
	if (form.kind === "place") {
		const reference = form.reference.trim()

		if (!REFERENCE.test(reference) && !NAME.test(reference)) return { ok: false, field: "reference" }

		const sheet = form.sheet.trim()

		return {
			ok: true,
			target: { location: sheet === "" || !REFERENCE.test(reference) ? reference : `${quotedSheetName(sheet)}!${reference}` }
		}
	}

	let address = form.address.trim()

	if (/^[^\s@:/]+@[^\s@:/]+\.[^\s@:/]+$/.test(address)) address = `mailto:${address}`
	else if (!/^[a-z][a-z0-9+.-]*:/i.test(address) && /^[^\s/]+\.[^\s/]+/.test(address)) address = `https://${address}`

	return isSafeAbsoluteHref(address) ? { ok: true, target: { url: address } } : { ok: false, field: "address" }
}

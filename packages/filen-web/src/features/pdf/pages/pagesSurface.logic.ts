import { loadPdfOutline, resolveDestination, type PdfDocument } from "@filen/office/dom/pdf"
import type { CropMargins, CropRect } from "@filen/office/core/pdfedit/crop"

// Plain helpers of the page surfaces: where the top-level bookmarks start (Split by bookmarks), the browser's file
// picker opened from a click, and the crop drawn on a turned view as the page's own margins.

// The 0-based first page of each top-level bookmark, in order, without repeats (bookmarks going nowhere skipped).
export async function bookmarkStarts(document: PdfDocument): Promise<number[]> {
	const outline = await loadPdfOutline(document).catch(() => [])
	const pages: number[] = []

	for (const item of outline) {
		if (item.depth !== 0 || item.dest === null) continue

		const target = await resolveDestination(document, item.dest)

		if (target !== null && !pages.includes(target.page - 1)) pages.push(target.page - 1)
	}

	return pages
}

// Opens the browser's file picker (from a click, which lets it open) and hands on the file chosen.
export function pickFile(accept: string, onPick: (file: File) => void): void {
	const input = document.createElement("input")

	input.type = "file"
	input.accept = accept
	input.addEventListener(
		"change",
		() => {
			const file = input.files?.[0]

			if (file !== undefined) onPick(file)
		},
		{ once: true }
	)
	input.click()
}

// Whether page `index` (0-based) shows in the pages' scroller at all.
export function pageShown(scroller: HTMLElement | null, index: number): boolean {
	const page = scroller?.querySelector(`[data-page="${String(index + 1)}"]`)

	if (scroller === null || page === null || page === undefined) return false

	const box = page.getBoundingClientRect()
	const view = scroller.getBoundingClientRect()

	return box.bottom > view.top && box.top < view.bottom
}

// The margins a crop drawn on the page as the view shows it (turned by `viewRotation` on top of the page's own
// rotation) takes off the page as it shows without the view's turn: a quarter turn clockwise brings the page's top edge
// to the right, and so on.
export function unrotateMargins(margins: CropMargins, viewRotation: number): CropMargins {
	const turn = (((Math.round(viewRotation / 90) * 90) % 360) + 360) % 360
	const { left, top, right, bottom } = margins

	switch (turn) {
		case 90:
			return { top: right, right: bottom, bottom: left, left: top }
		case 180:
			return { top: bottom, right: left, bottom: top, left: right }
		case 270:
			return { top: left, left: bottom, bottom: right, right: top }
		default:
			return margins
	}
}

// The margins `rect` leaves of `bounds`, rounded to a hundredth of a point and never negative.
export function cropMargins(bounds: CropRect, rect: CropRect): CropMargins {
	const round = (value: number): number => Math.max(0, Math.round(value * 100) / 100)

	return {
		left: round(rect[0] - bounds[0]),
		top: round(rect[1] - bounds[1]),
		right: round(bounds[2] - rect[2]),
		bottom: round(bounds[3] - rect[3])
	}
}

export function hasMargins(margins: CropMargins): boolean {
	return margins.left > 0 || margins.top > 0 || margins.right > 0 || margins.bottom > 0
}

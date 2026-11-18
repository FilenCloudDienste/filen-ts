import { accessOfFlags, ENTRY_ACCESS } from "@/lib/sdk/archiveListing"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import { compareNames } from "@/features/archive/lib/naturalCompare"
import { canOpenEntry } from "@/features/archive/lib/entryAccess.logic"
import { extensionOf } from "@/features/drive/lib/preview.logic"
import { IMAGE_FORMATS } from "@/features/preview/lib/imageFormat"

// A comic book's pages and how they are laid out: which entries are pages, in what order, and which pages a view
// shows together.

export type ComicLayout = "single" | "spread"
export type ComicDirection = "ltr" | "rtl"

// An entry's path from the archive's root.
function pathOf(store: EntryStore, slot: number): string {
	const dir = store.dirPath(store.parent(slot))

	return dir === "" ? store.name(slot) : `${dir}/${store.name(slot)}`
}

// The page images, as entry slots in reading order: every file an image viewer opens by its name (W2's format table),
// macOS metadata and anything the SDK skips left out (canOpenEntry), sorted by the natural order of the whole path, so
// p2 comes before p10 and a chapter directory's pages stay together.
export function comicPages(store: EntryStore): number[] {
	const pages: { slot: number; path: string }[] = []

	for (let slot = 0; slot < store.entryCount; slot++) {
		if (IMAGE_FORMATS.has(extensionOf(store.name(slot))) && canOpenEntry(store, slot)) {
			pages.push({ slot, path: pathOf(store, slot) })
		}
	}

	pages.sort((a, b) => compareNames(a.path, b.path))

	return pages.map(page => page.slot)
}

// The largest solid block a page lies in, in archive bytes; 0 when no page is in one. Above SOLID_BLOCK_READ_MAX_BYTES
// the comic is extracted to read (E3).
export function largestSolidBlock(store: EntryStore, pages: readonly number[]): number {
	let largest = 0

	for (const slot of pages) {
		if (accessOfFlags(store.flags(slot)) === ENTRY_ACCESS.solidBlock) {
			largest = Math.max(largest, store.solidBlock(slot))
		}
	}

	return largest
}

// The views a reader steps through, each the page positions it shows (positions into comicPages' list). Single: one
// page each. Spread: the cover alone, then pairs; a landscape page (a two-page scan) stands alone and the pairing
// starts over after it; a last page without a partner stands alone.
export function comicViews(count: number, layout: ComicLayout, landscape: ReadonlySet<number>): number[][] {
	const views: number[][] = []

	if (layout === "single") {
		for (let page = 0; page < count; page++) {
			views.push([page])
		}

		return views
	}

	let page = 0

	if (count > 0) {
		views.push([0])
		page = 1
	}

	while (page < count) {
		const next = page + 1

		if (landscape.has(page) || next >= count || landscape.has(next)) {
			views.push([page])
			page += 1
		} else {
			views.push([page, next])
			page += 2
		}
	}

	return views
}

// The view holding `page`: where a jump by the scrubber lands. -1 for no page.
export function viewOf(views: readonly (readonly number[])[], page: number): number {
	return views.findIndex(view => view.includes(page))
}

// A view's pages left to right on screen: right to left puts the earlier page on the right.
export function onScreen(view: readonly number[], direction: ComicDirection): readonly number[] {
	return direction === "rtl" ? [...view].reverse() : view
}

// The counter's pages, 1-based: "7" or "6–7".
export function viewLabel(view: readonly number[]): string {
	const first = view[0]
	const last = view.at(-1)

	if (first === undefined || last === undefined) {
		return ""
	}

	return first === last ? String(first + 1) : `${String(first + 1)}–${String(last + 1)}`
}

import { accessOfFlags, ENTRY_ACCESS } from "@/lib/sdk/archiveListing"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import { compareNames } from "@/features/archive/lib/naturalCompare"
import { canOpenEntry, canReadEntry } from "@/features/archive/lib/entryAccess.logic"
import { extensionOf } from "@/features/drive/lib/preview.logic"
import { IMAGE_FORMATS } from "@/features/preview/lib/imageFormat"
import { sniffImage } from "@/features/preview/lib/imageSniff/sniffImage"

// A comic book's pages and how they are laid out: which entries are pages, in what order, and which pages a view
// shows together.

export type ComicLayout = "single" | "spread"
export type ComicDirection = "ltr" | "rtl"

// An entry's path from the archive's root, by segment.
function segmentsOf(store: EntryStore, slot: number): string[] {
	const dir = store.dirPath(store.parent(slot))

	return dir === "" ? [store.name(slot)] : [...dir.split("/"), store.name(slot)]
}

// Natural order segment by segment, so a directory's pages stay together and sort as its name does: "ch1/…" before
// "ch1.5/…", "a/…" before "a b/…".
function comparePaths(a: readonly string[], b: readonly string[]): number {
	const shared = Math.min(a.length, b.length)

	for (let i = 0; i < shared; i++) {
		const order = compareNames(a[i] ?? "", b[i] ?? "")

		if (order !== 0) {
			return order
		}
	}

	return a.length - b.length
}

// The page images, as entry slots in reading order: every file an image viewer opens by its name (W2's format table)
// that the SDK reads alone, macOS metadata and anything the SDK skips left out (canReadEntry), sorted by the natural
// order of the path, segment by segment, so p2 comes before p10 and a chapter directory's pages stay together. A page
// too large to show keeps its place (pageOpens), so the numbering stays the book's.
export function comicPages(store: EntryStore): number[] {
	const pages: { slot: number; path: string[] }[] = []

	for (let slot = 0; slot < store.entryCount; slot++) {
		if (IMAGE_FORMATS.has(extensionOf(store.name(slot))) && canReadEntry(store, slot)) {
			pages.push({ slot, path: segmentsOf(store, slot) })
		}
	}

	pages.sort((a, b) => comparePaths(a.path, b.path))

	return pages.map(page => page.slot)
}

// Whether a page is shown: one above the image cap of its kind shows a placeholder in its place.
export function pageOpens(store: EntryStore, slot: number): boolean {
	return canOpenEntry(store, slot)
}

// Where every header the sniff reads sits.
const PAGE_HEAD_BYTES = 64 * 1024

// Whether a page's image is wider than tall (a two-page scan), from its header (W2's sniff, upright), before it is
// decoded; null when the header names no size.
export function landscapeOf(bytes: Uint8Array): boolean | null {
	const info = sniffImage(bytes.subarray(0, PAGE_HEAD_BYTES), bytes.length)

	return info === null ? null : info.width > info.height
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

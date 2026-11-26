import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { hasTwoSlides } from "@/features/preview/lib/slideshow.logic"
import { CATEGORY_POLICY, needsContentSniff, previewType } from "@/features/drive/lib/preview.logic"
import { anonPreviewability } from "@/features/publicLinks/lib/download.logic"
import { entryKey, type BrowseEntry } from "@/features/publicLinks/lib/browse.logic"
import { deviceProfile, type DeviceProfile } from "@/lib/deviceProfile"
import { clampListboxIndex } from "@/features/drive/lib/listbox"

// The pager over a directory link's opened file: the level's files in the browser's own sort and filter, stepped
// through in place of the list.

export type FileEntry = Extract<BrowseEntry, { kind: "file" }>

// Whether a file is one the pager steps onto: its category pages, and its hero shows a preview, or, on a link that
// downloads, a card that offers its download in place of one (an archive, a file above the preview's cap).
function pages(item: DriveItem, downloadable: boolean, profile: DeviceProfile): boolean {
	if (needsContentSniff(item) === null && !CATEGORY_POLICY[previewType(item)].pager) {
		return false
	}

	switch (anonPreviewability(item, profile)) {
		case "previewable":
		case "comic":
			return true
		case "archive":
		case "too-large":
			return downloadable
		case "unpreviewable":
			return false
	}
}

// The file entries a public preview pages over, in `visible`'s order, by the content verdicts recorded so far. The list
// is held from the file's opening: a verdict that lands later (a probe) changes what the hero shows for that file, not
// whether the pager holds it.
export function pagerEntries(visible: readonly BrowseEntry[], downloadable: boolean): FileEntry[] {
	const profile = deviceProfile()

	return visible.filter((entry): entry is FileEntry => entry.kind === "file" && pages(entry.item, downloadable, profile))
}

// The entry `delta` steps from `uuid`'s, clamped to the ends (a slideshow wraps by its own steps); null when the list
// does not hold `uuid`.
export function stepEntry<T extends BrowseEntry>(entries: readonly T[], uuid: string, delta: number): T | null {
	const index = entries.findIndex(entry => entryKey(entry) === uuid)

	if (index === -1) {
		return null
	}

	return entries[clampListboxIndex(index + delta, entries.length)] ?? null
}

// A slideshow's subdirectories' list as entries: its files narrowed, each standing in for its own listing file.
export function treeEntries(items: readonly DriveItem[]): FileEntry[] {
	const entries: FileEntry[] = []

	for (const item of items) {
		const base = asDirectoryOrFile(item)

		if (base.type === "file") {
			entries.push({ kind: "file", item, file: base.data })
		}
	}

	return entries
}

// The pager's list as held while a file is open: its entries and their items, built once, so the slideshow over the
// items sees one list until it is replaced; `twoSlides` is whether a slideshow is offered over it.
export interface BrowsePagerList {
	readonly entries: readonly FileEntry[]
	readonly items: readonly DriveItem[]
	readonly twoSlides: boolean
}

export function browsePagerList(entries: readonly FileEntry[]): BrowsePagerList {
	const items = entries.map(entry => entry.item)

	return { entries, items, twoSlides: hasTwoSlides(items) }
}

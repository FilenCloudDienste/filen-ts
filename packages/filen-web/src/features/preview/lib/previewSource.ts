import { driveItemName } from "@filen/shared"
import { type DriveItem } from "@/features/drive/lib/item"
import { clampListboxIndex } from "@/features/drive/lib/listbox"

// What a single pager slot in the preview overlay renders: a normalized drive item. Chat and note
// attachments that link a real file reach the overlay as a fabricated drive item of this same shape.
export interface PreviewSource {
	item: DriveItem
}

// Wraps a frozen drive-item snapshot (the previewable-sibling list) into PreviewSource[] — the one
// mechanical adapter every openPreview caller uses. A pure per-item wrap over the same item objects.
export function drivePreviewSources(items: DriveItem[]): PreviewSource[] {
	return items.map(item => ({ item }))
}

// Identity of a source, used both as the pager's stepping key and the body's remount key: the item uuid
// (the SAME key the DriveItem[] flow used, so uuid-rotation reconcile and error-boundary remounts are
// unchanged).
export function previewSourceKey(source: PreviewSource): string {
	return source.item.data.uuid
}

// Human-facing name for the header/alt text — the drive item's decrypted name (uuid fallback).
export function previewSourceName(source: PreviewSource): string {
	return driveItemName(source.item)
}

// Steps one slot (no wrap) from whichever source currently carries `currentKey` — a key lookup rather
// than a plain index+delta so a caller holding only the current slot's identity still steps correctly
// if positions shifted. Mirrors stepPreviewIndex (the DriveItem[] equivalent) over the source key
// instead of the raw uuid. An unresolvable key steps from the start of the list.
export function stepPreviewSourceIndex(currentKey: string, sources: PreviewSource[], delta: 1 | -1): number {
	const currentIndex = sources.findIndex(source => previewSourceKey(source) === currentKey)

	return clampListboxIndex((currentIndex === -1 ? 0 : currentIndex) + delta, sources.length)
}

import { type DriveItem } from "@/features/drive/lib/item"
import { clampListboxIndex } from "@/features/drive/lib/listbox"

// What a single pager slot in the preview overlay renders. Two arms, mirroring the mobile app's own
// preview seam: a normalized drive item (the only arm every current caller emits), and a bare
// external url (the SEAM for future chat/note attachments whose content isn't a browsable drive item
// — those load natively from the url, with no service-worker range route or byte-buffering). A chat
// attachment that IS linkable to a real file becomes a synthetic drive arm upstream; only genuinely
// unlinked content ever falls to the external arm.
export type PreviewSource =
	| {
			type: "drive"
			item: DriveItem
	  }
	| {
			type: "external"
			url: string
			name: string
	  }

// Wraps a frozen drive-item snapshot (the previewable-sibling list) into the drive arm — the one
// mechanical adapter every current openPreview caller uses so the overlay only ever sees
// PreviewSource[]. Behaviorally a pure per-item tag; the drive path downstream stays identical to the
// prior DriveItem[] flow.
export function drivePreviewSources(items: DriveItem[]): PreviewSource[] {
	return items.map(item => ({ type: "drive", item }))
}

// Identity of a source, used both as the pager's stepping key and the body's remount key. Drive: the
// item uuid (the SAME key the DriveItem[] flow used, so uuid-rotation reconcile and error-boundary
// remounts are unchanged). External: the url, which is its only stable handle.
export function previewSourceKey(source: PreviewSource): string {
	return source.type === "drive" ? source.item.data.uuid : source.url
}

// Human-facing name for the header/alt text — the drive item's decrypted name (uuid fallback) or the
// external source's own name.
export function previewSourceName(source: PreviewSource): string {
	return source.type === "drive" ? (source.item.data.decryptedMeta?.name ?? source.item.data.uuid) : source.name
}

// Steps one slot (no wrap) from whichever source currently carries `currentKey` — a key lookup rather
// than a plain index+delta so a caller holding only the current slot's identity still steps correctly
// if positions shifted. Mirrors stepPreviewIndex (the DriveItem[] equivalent) over the source key
// instead of the raw uuid. An unresolvable key steps from the start of the list.
export function stepPreviewSourceIndex(currentKey: string, sources: PreviewSource[], delta: 1 | -1): number {
	const currentIndex = sources.findIndex(source => previewSourceKey(source) === currentKey)

	return clampListboxIndex((currentIndex === -1 ? 0 : currentIndex) + delta, sources.length)
}

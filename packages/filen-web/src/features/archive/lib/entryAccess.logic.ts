import { accessOfFlags, ENTRY_ACCESS, ENTRY_FLAG, ENTRY_KIND } from "@/lib/sdk/archiveListing"
import { bufferedSizeCap, fileTypeExtension, previewCategoryForExtension, type PreviewCategory } from "@/features/drive/lib/preview.logic"
import type { EntryStore } from "@/features/archive/lib/entryStore"

// What the browser can do with one listed entry on its own: open it in a viewer, or save it. The SDK reads
// a zip's or 7z's file alone; a tar's member or a single compressed file only front to back, so never.

// The categories the preview loads whole into memory. Media streams, and a RAW or a nested archive needs
// a file of the drive: those entries only download.
const ENTRY_PREVIEW_CATEGORIES: ReadonlySet<PreviewCategory> = new Set<PreviewCategory>([
	"text",
	"code",
	"markdown",
	"pdf",
	"docx",
	"spreadsheet",
	"image"
])

// The SDK reads it alone: a file an extraction creates, of a zip or a 7z.
export function canReadEntry(store: EntryStore, slot: number): boolean {
	if (store.kind(slot) !== ENTRY_KIND.file || store.skip(slot) !== 0 || store.size(slot) < 0) {
		return false
	}

	const access = accessOfFlags(store.flags(slot))

	return access === ENTRY_ACCESS.direct || access === ENTRY_ACCESS.solidBlock
}

// The viewer category its name reads as, or null for one the entry preview does not show.
export function entryPreviewCategory(name: string): PreviewCategory | null {
	const category = previewCategoryForExtension(fileTypeExtension(name, null))

	return category !== null && ENTRY_PREVIEW_CATEGORIES.has(category) ? category : null
}

export function canOpenEntry(store: EntryStore, slot: number): boolean {
	if (!canReadEntry(store, slot)) {
		return false
	}

	const category = entryPreviewCategory(store.name(slot))
	const cap = category === null ? null : bufferedSizeCap(category)

	return cap !== null && store.size(slot) <= Number(cap)
}

export function isEncryptedEntry(store: EntryStore, slot: number): boolean {
	return (store.flags(slot) & ENTRY_FLAG.encrypted) !== 0
}

export interface EntryCost {
	// Decoded and thrown away before the entry's first byte.
	skippedBytes: number
	// Archive bytes fetched to reach the entry's end, an estimate.
	estimatedBytes: number
}

// What a solid 7z entry costs beyond itself; null for any other entry.
export function entryCost(store: EntryStore, slot: number): EntryCost | null {
	if (accessOfFlags(store.flags(slot)) !== ENTRY_ACCESS.solidBlock) {
		return null
	}

	return { skippedBytes: store.solidSkipped(slot), estimatedBytes: store.solidEstimated(slot) }
}

// A solid block's first file costs nothing beyond itself; any later one is confirmed first.
export function needsCostConfirm(store: EntryStore, slot: number): boolean {
	return (entryCost(store, slot)?.skippedBytes ?? 0) > 0
}

// Exactly the skip the listing stated, the cost the user accepted: the SDK refuses a larger one before
// fetching any of the block. Never null, which would allow any skip.
export function maxSolidSkipFor(store: EntryStore, slot: number): number {
	return entryCost(store, slot)?.skippedBytes ?? 0
}

// The preview cache's key for an entry, and the uuid its stand-in item carries.
export function entryKey(archiveUuid: string, index: number): string {
	return `${archiveUuid}#${String(index)}`
}

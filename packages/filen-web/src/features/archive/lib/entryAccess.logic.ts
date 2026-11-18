import {
	accessOfFlags,
	ENTRY_ACCESS,
	ENTRY_FLAG,
	ENTRY_KIND,
	READ_AHEAD_MAX_BYTES,
	READ_AHEAD_MAX_ENTRIES,
	type EntryReadPlan
} from "@/lib/sdk/archiveListing"
import {
	bufferedSizeCap,
	CATEGORY_POLICY,
	contentSniffFor,
	entryAdmits,
	opensAsLargeText,
	originServesRanges,
	fileTypeExtension,
	previewCategoryForExtension,
	previewType,
	sniffAdmitsFor,
	type PreviewCategory,
	type SniffSubject
} from "@/features/drive/lib/preview.logic"
import { gateRunsSniffer, SNIFFERS } from "@/features/preview/lib/contentSniff.logic"
import { deviceProfile } from "@/lib/deviceProfile"
import type { DriveItem } from "@/features/drive/lib/item"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import type { ByteOrigin } from "@/lib/sdk/byteOrigin"

// What the browser can do with one listed entry on its own: open it in a viewer, or save it. The SDK reads
// a zip's, 7z's or RAR's file and a compressed tar's member alone; a bare tar's member or a single compressed file
// only front to back, so never.

// The SDK reads it alone: a file an extraction creates, directly or from a solid block.
export function canReadEntry(store: EntryStore, slot: number): boolean {
	if (store.kind(slot) !== ENTRY_KIND.file || store.skip(slot) !== 0 || store.size(slot) < 0) {
		return false
	}

	const access = accessOfFlags(store.flags(slot))

	return access === ENTRY_ACCESS.direct || access === ENTRY_ACCESS.solidBlock
}

// The viewer category its name reads as, or null for one the entry preview does not show (CATEGORY_POLICY's `entry`:
// media streams, and a RAW or a nested archive needs a file of the drive, so those entries only download).
export function entryPreviewCategory(name: string): PreviewCategory | null {
	const category = previewCategoryForExtension(fileTypeExtension(name, null))

	return category !== null && CATEGORY_POLICY[category].entry !== "none" ? category : null
}

function entrySubject(store: EntryStore, slot: number): SniffSubject {
	return { name: store.name(slot), mime: null, size: BigInt(Math.max(0, store.size(slot))), verdict: null }
}

// Whether the entry's viewer is picked by a content read run before it opens (ContentSniffGate), not by its name. A
// viewer-mode read runs in the viewer its name picks.
export function entryAwaitsSniff(store: EntryStore, slot: number): boolean {
	const id = contentSniffFor(entrySubject(store, slot))

	return id !== null && gateRunsSniffer(SNIFFERS[id], "entry")
}

// The viewer a file held inside another (an archive's entry, an attachment) whose content read has run opens in, by its
// verdict; null when that kind does not open there. Text above its cap opens as large text where `origin` serves ranges.
export function sniffedEntryCategory(item: DriveItem, origin: ByteOrigin): PreviewCategory | null {
	const category = previewType(item)
	const profile = deviceProfile()
	const cap = CATEGORY_POLICY[category].entry === "none" ? null : bufferedSizeCap(category, profile)

	if (cap === null) {
		return null
	}

	return item.data.size <= cap || (opensAsLargeText(category, item.data.size, profile) && originServesRanges(origin)) ? category : null
}

export function canOpenEntry(store: EntryStore, slot: number): boolean {
	if (!canReadEntry(store, slot)) {
		return false
	}

	// Opens if some kind its read may find opens as an entry.
	if (entryAwaitsSniff(store, slot)) {
		return sniffAdmitsFor(entrySubject(store, slot), deviceProfile(), "entry")
	}

	const category = entryPreviewCategory(store.name(slot))

	return category !== null && entryAdmits(category, BigInt(store.size(slot)), deviceProfile())
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

// What a solid block's entry costs beyond itself (a solid 7z's or RAR's file, a compressed tar's member); null for
// any other entry. A compressed tar's estimatedBytes is approximate: up to one compressed block of its codec and a
// fetch's 1 MiB rounding off.
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

// Index steps a window looks past the entry for the files after it (directories and left-out entries between them).
const WINDOW_SCAN = 256

// How the entry is read whole: alone, or, a solid block's, in one pass with the files its block stores right after
// it, up to the read-ahead a reader keeps (READ_AHEAD_MAX_ENTRIES files, READ_AHEAD_MAX_BYTES), so reading them in
// turn decodes the block once per window rather than once per file. The pass may throw away what its last file's
// listed skip says, no more: within one block that is all it decodes before that file.
export function entryReadPlan(store: EntryStore, slot: number): EntryReadPlan {
	const index = store.index(slot)
	const maxSolidSkip = maxSolidSkipFor(store, slot)
	const window = [{ index, size: store.size(slot) }]
	let windowSkip = maxSolidSkip

	if (accessOfFlags(store.flags(slot)) !== ENTRY_ACCESS.solidBlock) {
		return { maxSolidSkip, window, windowSkip }
	}

	let bytes = 0

	for (let next = index + 1; next <= index + WINDOW_SCAN && window.length <= READ_AHEAD_MAX_ENTRIES; next++) {
		const at = store.slotOfIndex(next)

		if (at === -1 || store.kind(at) !== ENTRY_KIND.file) {
			continue
		}

		// Another block (its skip starts over), or an entry read some other way: the window ends.
		if (!canReadEntry(store, at) || accessOfFlags(store.flags(at)) !== ENTRY_ACCESS.solidBlock || store.solidSkipped(at) < windowSkip) {
			break
		}

		const size = store.size(at)

		if (bytes + size > READ_AHEAD_MAX_BYTES) {
			break
		}

		bytes += size
		windowSkip = store.solidSkipped(at)
		window.push({ index: next, size })
	}

	return { maxSolidSkip, window, windowSkip }
}

// The preview cache's key for an entry, and the uuid its stand-in item carries.
export function entryKey(archiveUuid: string, index: number): string {
	return `${archiveUuid}#${String(index)}`
}

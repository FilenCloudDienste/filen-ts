import {
	accessOfFlags,
	ENTRY_ACCESS,
	ENTRY_FLAG,
	ENTRY_KIND,
	READ_AHEAD_MAX_ENTRIES,
	archiveRetainedBudget,
	readAheadBudget,
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
	// Archive bytes fetched to reach the end of what the read brings (the entry, and the files read ahead with it), an
	// estimate.
	estimatedBytes: number
}

// Above this much of the archive in one solid block, a file deep in it decodes most of the block: it is extracted to
// read (owner decision E3; measured, never lowered without the owner). Accepting a cost never covers one.
export const SOLID_BLOCK_READ_MAX_BYTES = 512 * 1024 * 1024

// The entry lies in a solid block too large to read alone (SOLID_BLOCK_READ_MAX_BYTES).
export function extractsToRead(store: EntryStore, slot: number): boolean {
	return accessOfFlags(store.flags(slot)) === ENTRY_ACCESS.solidBlock && store.solidBlock(slot) > SOLID_BLOCK_READ_MAX_BYTES
}

// What reading a solid block's entry costs beyond itself (a solid 7z's or RAR's file, a compressed tar's member), with
// the files `plan` reads ahead with it; null for any other entry. A compressed tar's estimate is approximate: up to one
// compressed block of its codec and a fetch's 1 MiB rounding off.
export function entryCost(store: EntryStore, slot: number, plan?: EntryReadPlan): EntryCost | null {
	if (accessOfFlags(store.flags(slot)) !== ENTRY_ACCESS.solidBlock) {
		return null
	}

	const last = plan?.window.at(-1)
	const lastSlot = last === undefined ? -1 : store.slotOfIndex(last.index)

	return {
		skippedBytes: store.solidSkipped(slot),
		estimatedBytes: Math.max(store.solidEstimated(slot), lastSlot === -1 ? 0 : store.solidEstimated(lastSlot))
	}
}

// A solid block's first file costs nothing beyond itself, and before a cost was accepted reads nothing ahead; any
// later one is confirmed first.
export function needsCostConfirm(store: EntryStore, slot: number): boolean {
	return store.solidSkipped(slot) > 0 && accessOfFlags(store.flags(slot)) === ENTRY_ACCESS.solidBlock
}

// Exactly the skip the listing stated, the cost the user accepted: the SDK refuses a larger one before
// fetching any of the block. Never null, which would allow any skip.
export function maxSolidSkipFor(store: EntryStore, slot: number): number {
	return entryCost(store, slot)?.skippedBytes ?? 0
}

// Index steps a window looks past the entry for the files after it (directories between them).
const WINDOW_SCAN = 256

// The bytes a window may read ahead on this device: half the retained budget the client was built with.
export function deviceReadAheadBytes(): number {
	return readAheadBudget(archiveRetainedBudget(deviceProfile().mobile))
}

// The entry read alone.
export function lonePlan(index: number, size: number, maxSolidSkip: number): EntryReadPlan {
	return { maxSolidSkip, window: [{ index, size }], windowSkip: maxSolidSkip }
}

// How the entry is read whole: alone, or, once the session accepted a solid cost (`readAhead`), a solid block's entry
// in one pass with the files its block stores right after it, up to READ_AHEAD_MAX_ENTRIES files and `aheadBytes`, so
// reading them in turn decodes the block once per window rather than once per file. The pass may throw away the
// entry's own skip and what lies between the window's files, no more. A slot no longer in the store (a relist) reads
// alone.
export function entryReadPlan(
	store: EntryStore,
	slot: number,
	readAhead: boolean,
	aheadBytes: number = deviceReadAheadBytes()
): EntryReadPlan {
	const index = store.index(slot)
	const maxSolidSkip = maxSolidSkipFor(store, slot)
	const plan = lonePlan(index, store.size(slot), maxSolidSkip)

	if (!readAhead || accessOfFlags(store.flags(slot)) !== ENTRY_ACCESS.solidBlock) {
		return plan
	}

	const window = [...plan.window]
	const block = store.solidBlock(slot)
	let windowSkip = maxSolidSkip
	// Where the window's last file ends in the block's decoded output.
	let end = store.solidSkipped(slot) + store.size(slot)
	let bytes = 0

	for (let next = index + 1; next <= index + WINDOW_SCAN && window.length <= READ_AHEAD_MAX_ENTRIES; next++) {
		const at = store.slotOfIndex(next)

		if (at === -1 || store.kind(at) !== ENTRY_KIND.file) {
			continue
		}

		const skipped = store.solidSkipped(at)

		// Another block (its skip starts over, at 0 for its first file), or an entry read some other way: the window ends.
		if (
			!canReadEntry(store, at) ||
			accessOfFlags(store.flags(at)) !== ENTRY_ACCESS.solidBlock ||
			store.solidBlock(at) !== block ||
			skipped === 0 ||
			skipped < end
		) {
			break
		}

		const size = store.size(at)

		if (bytes + size > aheadBytes) {
			break
		}

		bytes += size
		// What lies between the last file and this one (entries the listing left out) is decoded and thrown away.
		windowSkip += skipped - end
		end = skipped + size
		window.push({ index: next, size })
	}

	return { maxSolidSkip, window, windowSkip }
}

// The plan for the archive's entry `index` from its listing (entryReadPlan); read alone when the store no longer lists
// it (a relist replaced it).
export function entryPlanOf(store: EntryStore, index: number, size: number, maxSolidSkip: number, readAhead: boolean): EntryReadPlan {
	const slot = store.slotOfIndex(index)

	return slot === -1 ? lonePlan(index, size, maxSolidSkip) : entryReadPlan(store, slot, readAhead)
}

// The preview cache's key for an entry, and the uuid its stand-in item carries.
export function entryKey(archiveUuid: string, index: number): string {
	return `${archiveUuid}#${String(index)}`
}

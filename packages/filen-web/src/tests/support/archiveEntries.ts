import type { ArchiveEntry, ArchiveEntryKind, ListedSkipReason } from "@filen/sdk-rs"
import { createListBatcher } from "@/workers/archiveListPacker"
import { createEntryStore, type EntryStore } from "@/features/archive/lib/entryStore"
import type { PackedEntryBatch } from "@/lib/sdk/archiveListing"

export const TEST_ARCHIVE = "archive-0000-0000-0000-000000000000"

export interface EntrySpec {
	// A trailing "/" makes a directory; undefined a pathless entry.
	path: string | undefined
	index?: number
	stored?: string
	kind?: ArchiveEntryKind
	size?: number
	modified?: number
	skip?: ListedSkipReason["type"]
}

// An SDK entry as a listing reports it, from a path shorthand.
export function archiveEntry(spec: EntrySpec | string, fallbackIndex = 0): ArchiveEntry {
	const { path, index = fallbackIndex, stored, kind, size, modified, skip } = typeof spec === "string" ? { path: spec } : spec
	const isDir = kind?.type === "dir" || (kind === undefined && path?.endsWith("/") === true)

	return {
		id: { archive: TEST_ARCHIVE, index },
		storedPath: stored ?? path ?? `stored-${String(index)}`,
		storedPathTruncated: false,
		path: path === undefined ? undefined : { path, rewritten: false, misleading: false },
		kind: kind ?? (isDir ? { type: "dir" } : { type: "file" }),
		size: isDir ? undefined : BigInt(size ?? 1),
		...(modified !== undefined ? { modified: BigInt(modified) } : {}),
		encrypted: false,
		method: undefined,
		skip: skip === undefined ? undefined : { type: skip },
		macMetadata: false,
		access: undefined
	}
}

export function packEntries(specs: readonly (EntrySpec | string)[], flushAt?: number): PackedEntryBatch[] {
	const batches: PackedEntryBatch[] = []
	const batcher = createListBatcher(batch => {
		batches.push(batch)
	}, flushAt)

	batcher.push(specs.map((spec, i) => archiveEntry(spec, i)))
	batcher.flush()

	return batches
}

export function storeOf(specs: readonly (EntrySpec | string)[], flushAt?: number): EntryStore {
	const store = createEntryStore()

	for (const batch of packEntries(specs, flushAt)) {
		store.append(batch)
	}

	return store
}

import type { ArchiveEntryKind, ListedSkipReason } from "@filen/sdk-rs"

// A listing's entries as the worker posts them: one struct-of-arrays per batch instead of an object
// graph per entry, so 250k entries clone and settle on the page as a few dozen typed arrays. Imported by
// the worker and the page alike, so nothing here may touch the DOM.

export const ENTRY_KIND = { file: 0, dir: 1, symlink: 2, hardlink: 3, device: 4, other: 5 } as const satisfies Record<
	ArchiveEntryKind["type"],
	number
>

export type EntryKindCode = (typeof ENTRY_KIND)[keyof typeof ENTRY_KIND]

// A skip's code is its position plus one; 0 is no skip.
export const SKIP_REASONS = [
	"symlink",
	"hardlink",
	"device",
	"sparse",
	"unsupportedType",
	"pathTooLong",
	"pathTooDeep",
	"unsafePath",
	"overlappingData",
	"unsupportedMethod",
	"antiItem",
	"macMetadata"
] as const satisfies readonly ListedSkipReason["type"][]

export type SkipReason = (typeof SKIP_REASONS)[number]

export const ENTRY_FLAG = { encrypted: 1, macMetadata: 2, rewritten: 4, misleading: 8, pathless: 16, storedTruncated: 32 } as const

// A character the SDK flags a path as misleading for (filen-sdk-rs fs/archive/entry_path.rs, is_suspicious):
// a control (C0, DEL, C1) or a format character behind bidi overrides and invisible joins.
export const MISLEADING_CHARACTER =
	/[\p{Cc}\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\u{E0001}\u{E0020}-\u{E007F}]/u

export function skipCode(reason: ListedSkipReason["type"]): number {
	return SKIP_REASONS.indexOf(reason) + 1
}

export function skipReasonOf(code: number): SkipReason | null {
	return SKIP_REASONS[code - 1] ?? null
}

export interface PackedEntryLink {
	// Position in the batch.
	i: number
	target: string
	// The target's ArchiveEntryId.index; -1 for a symlink or a hard link without one.
	targetIndex: number
}

export interface PackedStoredPath {
	i: number
	storedPath: string
}

export interface PackedEntryBatch {
	// ArchiveEntryId.archive, the same for every entry.
	archive: string
	count: number
	index: Uint32Array
	kind: Uint8Array
	skip: Uint8Array
	flags: Uint8Array
	// -1 when the archive states none (directories).
	size: Float64Array
	// NaN when absent.
	modified: Float64Array
	// The last segment of the extracted path; the whole stored path for a pathless entry.
	name: string[]
	// Into `parents`.
	parent: Uint32Array
	// This batch's distinct parent paths, "" the root (where pathless entries go too).
	parents: string[]
	// Symlinks and hard links only.
	links: PackedEntryLink[]
	// Only entries whose name is not their stored path: rewritten, pathless or truncated.
	stored: PackedStoredPath[]
}

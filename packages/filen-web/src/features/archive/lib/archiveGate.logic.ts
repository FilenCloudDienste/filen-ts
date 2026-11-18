import type { ArchiveFormat } from "@filen/sdk-rs"

// Whether opening an archive lists it at once or waits behind the gate. A zip's or 7z's listing reads only
// its index; a tar's or a single compressed file's downloads the whole file, and a RAR's reads the header before
// each member, which in an archive of small members (a comic's pages) is every chunk of it, so only a small one of
// those lists at once. An unknown format (null) is gated: its bytes may well be a tar. A zip-based package (`zipByName`, an .apk) is a
// zip the SDK's name table does not list, unless the SDK detected another format: that format's gate applies.
export type ArchiveGate = "list" | "gate"

export const UNGATED_MAX_BYTES = 8 * 1024 * 1024

// Flicking through a directory of archives starts no listing for those only passed by.
export const AUTO_LIST_DELAY_MS = 150

// The formats whose entries are all known from an index read up front: a zip's central directory, a 7z's header, a
// RAR's member table. An extract of one checks its selection against it first, so a chosen directory brings
// everything below it wherever it is stored.
export function isIndexedFormat(type: ArchiveFormat["type"] | null): boolean {
	return type === "zip" || type === "sevenZ" || type === "rar"
}

// The indexed formats whose index lies in one place, so listing reads only it. A RAR's member table is its headers,
// one before each member: listing walks them all, which in an archive of small members (a comic's pages) reads every
// chunk. So a RAR is gated and shows a byte bar as a tar does (owner decision: keep the 8 MiB RAR gate, deviating
// from W6 §3.11).
export function listsFromIndex(type: ArchiveFormat["type"] | null): boolean {
	return isIndexedFormat(type) && type !== "rar"
}

export function gateFor(format: ArchiveFormat | null, size: number, zipByName: boolean): ArchiveGate {
	if ((zipByName && format === null) || listsFromIndex(format?.type ?? null)) {
		return "list"
	}

	return size <= UNGATED_MAX_BYTES ? "list" : "gate"
}

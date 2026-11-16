import type { ArchiveFormat } from "@filen/sdk-rs"

// Whether opening an archive lists it at once or waits behind the gate. A zip's or 7z's listing reads only
// its index; a tar's or a single compressed file's downloads the whole file, so only a small one lists at
// once. An unknown format (null) is gated: its bytes may well be a tar. A zip-based package (`zipByName`, an .apk) is a
// zip the SDK's name table does not list.
export type ArchiveGate = "list" | "gate"

export const UNGATED_MAX_BYTES = 8 * 1024 * 1024

// Flicking through a directory of archives starts no listing for those only passed by.
export const AUTO_LIST_DELAY_MS = 150

export function gateFor(format: ArchiveFormat | null, size: number, zipByName: boolean): ArchiveGate {
	if (zipByName || format?.type === "zip" || format?.type === "sevenZ") {
		return "list"
	}

	return size <= UNGATED_MAX_BYTES ? "list" : "gate"
}

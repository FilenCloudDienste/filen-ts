import type { FileVerdict, SniffId } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import { previewType } from "@/features/drive/lib/preview.logic"

export interface SniffedOpen {
	// Runs the content read and resolves with its verdict; rejects when the bytes could not be read.
	read(sniff: SniffId): Promise<FileVerdict>
	record(verdict: FileVerdict): void
	// The persistent player, for what turned out to be audio.
	handOff(): void
	// The preview overlay, for anything else, and for a file whose read failed (its own gate reads again, with Retry).
	openPreview(): void
	onReadFailed(error: unknown): void
}

// Opens a drive file that is audio only by its extension's usual meaning (a `.mod` a camcorder wrote as an MPEG program
// stream) as what its head says it is.
export async function openSniffedAudio(item: DriveItem, sniff: SniffId, open: SniffedOpen): Promise<void> {
	let verdict: FileVerdict | null = null

	try {
		verdict = await open.read(sniff)
		open.record(verdict)
	} catch (error) {
		open.onReadFailed(error)
	}

	if (verdict !== null && previewType(item, verdict) === "audio") {
		open.handOff()
	} else {
		open.openPreview()
	}
}

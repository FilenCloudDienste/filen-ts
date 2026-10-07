import { BLOCK_BYTES } from "@/lib/media/blockSource"

export interface ByteRange {
	start: number
	end: number
	// `bytes=N-`: the client asked for everything from N on, so a shorter answer is still a valid one.
	openEnded: boolean
}

// Parse a single-range `bytes=` header against the known total; null = unsatisfiable/absent.
export function parseRange(header: string, total: number): ByteRange | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
	if (match === null) {
		return null
	}
	const startStr = match[1] ?? ""
	const endStr = match[2] ?? ""
	if (startStr === "" && endStr === "") {
		return null
	}
	let start: number
	let end: number
	if (startStr === "") {
		const suffix = Number(endStr)
		if (suffix <= 0) {
			return null
		}
		start = Math.max(0, total - suffix)
		end = total - 1
	} else {
		start = Number(startStr)
		end = endStr === "" ? total - 1 : Number(endStr)
	}
	if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= total) {
		return null
	}
	return { start, end, openEnded: startStr !== "" && endStr === "" }
}

// How much of an open-ended range a media preview gets per request. A media element reading `bytes=N-`
// asks again from where a short 206 stopped, so a seek or a closed preview cancels at most one piece of
// download and decrypt instead of the rest of the file (which Firefox also logs as a failed interception),
// and each piece is a fresh fetch event, which keeps Firefox from terminating the worker mid-playback.
export const PREVIEW_PIECE_BYTES = 4 * BLOCK_BYTES

// The inclusive last byte of the piece starting at `start`. Pieces end on an SDK chunk boundary, so the
// next one starts on one and never downloads a chunk the previous piece already decrypted.
export function previewPieceEnd(start: number, end: number): number {
	return Math.min(end, Math.floor(start / BLOCK_BYTES) * BLOCK_BYTES + PREVIEW_PIECE_BYTES - 1)
}

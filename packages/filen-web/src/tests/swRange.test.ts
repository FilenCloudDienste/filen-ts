import { describe, expect, it } from "vitest"
import { BLOCK_BYTES } from "@/lib/media/blockSource"
import { parseRange, previewPieceEnd, PREVIEW_PIECE_BYTES } from "@/sw/range"

describe("parseRange", () => {
	it("marks only a start-only range as open-ended", () => {
		expect(parseRange("bytes=100-", 1000)).toEqual({ start: 100, end: 999, openEnded: true })
		expect(parseRange("bytes=100-199", 1000)).toEqual({ start: 100, end: 199, openEnded: false })
		expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999, openEnded: false })
	})

	it("rejects an unsatisfiable or malformed range", () => {
		expect(parseRange("bytes=-", 1000)).toBeNull()
		expect(parseRange("bytes=1000-", 1000)).toBeNull()
		expect(parseRange("bytes=5-2", 1000)).toBeNull()
		expect(parseRange("items=0-1", 1000)).toBeNull()
	})
})

describe("previewPieceEnd", () => {
	const total = 20 * BLOCK_BYTES

	it("ends a piece on an SDK chunk boundary, so the next one starts on one", () => {
		expect(previewPieceEnd(0, total - 1)).toBe(PREVIEW_PIECE_BYTES - 1)
		expect(previewPieceEnd(PREVIEW_PIECE_BYTES, total - 1)).toBe(2 * PREVIEW_PIECE_BYTES - 1)
		// A seek lands mid-chunk: the piece still ends on the boundary, a little short.
		expect(previewPieceEnd(BLOCK_BYTES + 5, total - 1)).toBe(BLOCK_BYTES + PREVIEW_PIECE_BYTES - 1)
	})

	it("never runs past what was asked for", () => {
		expect(previewPieceEnd(total - 10, total - 1)).toBe(total - 1)
	})
})

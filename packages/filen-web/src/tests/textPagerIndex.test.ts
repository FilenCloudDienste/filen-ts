import { describe, expect, it } from "vitest"
import { BLOCK_BYTES } from "@filen/shared/videos"
import { CHECKPOINT_LINES, LineIndex, MAX_CHECKPOINTS } from "@/features/preview/lib/textPager/index.logic"
import { pagerEncoding, type PagerSource } from "@/features/preview/lib/textPager/rows.logic"

// Lines "0\n", "1\n", … : line n (1-based) holds the number n - 1.
function numberedLines(count: number): Uint8Array {
	return new TextEncoder().encode(Array.from({ length: count }, (_, index) => `${String(index)}\n`).join(""))
}

// Counts the bytes read, to bound what a lookup costs.
function counted(bytes: Uint8Array): { source: PagerSource; read: () => number } {
	let read = 0

	return {
		source: {
			size: bytes.length,
			read: (start, end) => {
				read += end - start

				return bytes.subarray(start, end)
			}
		},
		read: () => read
	}
}

function feedAll(index: LineIndex, bytes: Uint8Array, piece: number): void {
	for (let at = 0; at < bytes.length; at += piece) index.feed(bytes.subarray(at, Math.min(bytes.length, at + piece)), at)
}

describe("textPager line index", () => {
	it("counts lines from fed bytes and finds any counted line's start and number", async () => {
		const bytes = numberedLines(20_000)
		const encoding = pagerEncoding("utf-8", bytes)
		const index = new LineIndex(encoding, bytes.length)
		const { source } = counted(bytes)

		feedAll(index, bytes, 4093)
		expect(index.complete).toBe(true)
		// 20 000 breaks and the empty line after the last.
		expect(index.lines).toBe(20_001)
		expect(index.checkpoints).toBe(1 + Math.floor(20_000 / CHECKPOINT_LINES))

		for (const line of [1, 2, 4096, 4097, 12_345, 20_000]) {
			const start = await index.lineStart(source, line)

			expect(start).not.toBeNull()
			expect(new TextDecoder().decode(bytes.subarray(start ?? 0, (start ?? 0) + 6)).split("\n")[0]).toBe(String(line - 1))
			expect(await index.lineAt(source, start ?? 0)).toBe(line)
		}
	})

	it("knows only the counted prefix, and ignores bytes that leave a gap", async () => {
		const bytes = numberedLines(1000)
		const index = new LineIndex(pagerEncoding("utf-8", bytes), bytes.length)
		const { source } = counted(bytes)

		index.feed(bytes.subarray(0, 100), 0)
		index.feed(bytes.subarray(200, 300), 200)
		expect(index.frontier).toBe(100)
		expect(index.complete).toBe(false)
		expect(await index.lineStart(source, 900)).toBeNull()
		index.feed(bytes.subarray(50, 300), 50)
		expect(index.frontier).toBe(300)
	})

	it("checkpoints a line with no break at least every block, so a lookup reads at most one", async () => {
		const bytes = new Uint8Array(5 * BLOCK_BYTES).fill(0x61)

		bytes[4 * BLOCK_BYTES + 10] = 0x0a

		const index = new LineIndex(pagerEncoding("utf-8", bytes.subarray(0, 0)), bytes.length)
		const { source, read } = counted(bytes)

		feedAll(index, bytes, 2 * BLOCK_BYTES)
		expect(await index.lineAt(source, 4 * BLOCK_BYTES + 100)).toBe(2)
		expect(read()).toBeLessThanOrEqual(BLOCK_BYTES)
		expect(await index.lineStart(source, 2)).toBe(4 * BLOCK_BYTES + 11)
		expect(read()).toBeLessThanOrEqual(2 * BLOCK_BYTES)
	})

	it("thins its checkpoints instead of growing past the cap, and still answers", async () => {
		const bytes = numberedLines(5000)
		const index = new LineIndex(pagerEncoding("utf-8", bytes), bytes.length, { lines: 16, bytes: BLOCK_BYTES, max: 8 })
		const { source } = counted(bytes)

		feedAll(index, bytes, 1000)
		expect(index.checkpoints).toBeLessThanOrEqual(8)
		expect(await index.lineStart(source, 4321)).toBe(new TextDecoder().decode(bytes).indexOf("\n4320\n") + 1)
		expect(await index.lineAt(source, bytes.length - 1)).toBe(5000)
		expect(MAX_CHECKPOINTS * 16).toBe(1024 * 1024)
	})

	it("counts UTF-16 breaks only at unit boundaries", () => {
		const text = "aਊ\nb\n"
		const bytes = new Uint8Array(2 + text.length * 2)
		const view = new DataView(bytes.buffer)

		view.setUint16(0, 0xfeff, true)

		for (let at = 0; at < text.length; at++) view.setUint16(2 + at * 2, text.charCodeAt(at), true)

		const index = new LineIndex(pagerEncoding("utf-16le", bytes), bytes.length)

		// Fed in pieces that end on unit boundaries, as a scan's block-aligned stretches do.
		feedAll(index, bytes, 4)
		expect(index.lines).toBe(3)
	})
})

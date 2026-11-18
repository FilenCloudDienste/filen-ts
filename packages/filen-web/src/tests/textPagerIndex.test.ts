import { describe, expect, it } from "vitest"
import { BLOCK_BYTES } from "@filen/shared/videos"
import {
	CHECKPOINT_LINES,
	countLines,
	LineIndex,
	MAX_CHECKPOINTS,
	readStretches,
	SCAN_BYTES
} from "@/features/preview/lib/textPager/index.logic"
import { pagerEncoding, type PagerEncoding, type PagerSource } from "@/features/preview/lib/textPager/rows.logic"

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

		// Fed in odd pieces: a unit cut at a piece's end is counted with the next piece.
		feedAll(index, bytes, 3)
		expect(index.frontier).toBe(bytes.length)
		expect(index.lines).toBe(3)
	})

	// A UTF-8 file with its mark, reopened as UTF-16: its mark is text, so units stay aligned with the stretches.
	it.each(["utf-16le", "utf-16be"])("counts a UTF-8-BOM file read as %s to its end, stretch by stretch", async label => {
		const size = 2 * SCAN_BYTES + 7
		const bytes = new Uint8Array(size).fill(0x41)

		bytes.set([0xef, 0xbb, 0xbf])

		for (let at = 1000; at < size - 2; at += 1000) bytes.set(label === "utf-16le" ? [0x0a, 0] : [0, 0x0a], at)

		const encoding = pagerEncoding(label, bytes.subarray(0, 4096))
		const index = new LineIndex(encoding, size)
		const reads: [number, number][] = []

		expect(encoding.start).toBe(0)
		await countLines(
			index,
			{
				size,
				scan: (start, end) => {
					reads.push([start, end])

					return Promise.resolve(bytes.slice(start, end))
				}
			},
			() => false,
			new AbortController().signal,
			() => undefined
		)
		expect(reads).toEqual([
			[0, SCAN_BYTES],
			[SCAN_BYTES, 2 * SCAN_BYTES],
			[2 * SCAN_BYTES, size]
		])
		expect(index.complete).toBe(true)
		expect(index.lines).toBe(Math.floor((size - 3 - 1000) / 1000) + 2)
	})

	it("finds breaks that straddle a block in an encoding whose units do not line up with blocks", async () => {
		// An odd text start: a UTF-16 unit then spans every block boundary.
		const encoding: PagerEncoding = { label: "utf-16le", kind: "utf16", unit: 2, littleEndian: true, start: 1, newline: 0x0a }
		const bytes = new Uint8Array(2 * BLOCK_BYTES + 1).fill(0x41)

		bytes.set([0x0a, 0], BLOCK_BYTES - 1)

		const index = new LineIndex(encoding, bytes.length)
		const { source } = counted(bytes)

		index.feed(bytes.subarray(0, BLOCK_BYTES), 0)
		index.feed(bytes.subarray(BLOCK_BYTES), BLOCK_BYTES)
		expect(index.lines).toBe(2)
		expect(await index.lineAt(source, 2 * BLOCK_BYTES - 1)).toBe(2)
		expect(await index.lineStart(source, 2)).toBe(BLOCK_BYTES + 1)
	})

	it("keeps one stretch read in flight ahead, and calls it off when the reader stops early", async () => {
		const size = 4 * SCAN_BYTES
		const started: number[] = []
		const aborted: number[] = []
		const pending = new Map<number, () => void>()
		const source = {
			size,
			scan: (start: number, end: number, signal: AbortSignal) => {
				started.push(start)
				signal.addEventListener("abort", () => {
					aborted.push(start)
				})

				return new Promise<Uint8Array>(resolve => {
					pending.set(start, () => {
						resolve(new Uint8Array(end - start))
					})
				})
			}
		}
		const stretches = readStretches(source, 0, new AbortController().signal)
		const first = stretches.next()

		// Asked for one, both the first and the next are in flight.
		expect(started).toEqual([0, SCAN_BYTES])
		pending.get(0)?.()
		expect((await first).value?.base).toBe(0)

		const second = stretches.next()

		expect(started).toEqual([0, SCAN_BYTES, 2 * SCAN_BYTES])
		pending.get(SCAN_BYTES)?.()
		await second
		await stretches.return(undefined)
		expect(aborted).toContain(2 * SCAN_BYTES)
	})
})

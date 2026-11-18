import { describe, expect, it } from "vitest"
import { BLOCK_BYTES } from "@filen/shared/videos"
import { BlockCache } from "@/lib/media/blockCache"
import { visibleRows, wholeRows } from "@/features/preview/lib/textPager/viewport.logic"
import {
	boundaryAt,
	LINE_SEARCH_BYTES,
	locateRow,
	pagerEncoding,
	ROW_MAX_UNITS,
	rowsAround,
	rowsBefore,
	rowsFrom,
	type PagerEncoding,
	type PagerRow,
	type PagerSource
} from "@/features/preview/lib/textPager/rows.logic"

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

function utf16(text: string, littleEndian: boolean, bom: boolean): Uint8Array {
	const out = new Uint8Array((bom ? 2 : 0) + text.length * 2)
	const view = new DataView(out.buffer)

	if (bom) view.setUint16(0, 0xfeff, littleEndian)

	for (let index = 0; index < text.length; index++) view.setUint16((bom ? 2 : 0) + index * 2, text.charCodeAt(index), littleEndian)

	return out
}

function utf32le(text: string): Uint8Array {
	const points: number[] = []

	for (const char of text) points.push(char.codePointAt(0) ?? 0)

	const out = new Uint8Array(4 + points.length * 4)
	const view = new DataView(out.buffer)

	view.setUint32(0, 0xfeff, true)
	points.forEach((point, index) => {
		view.setUint32(4 + index * 4, point, true)
	})

	return out
}

function memory(bytes: Uint8Array): PagerSource {
	return { size: bytes.length, read: (start, end) => bytes.subarray(start, end) }
}

// A file of `size` bytes, each from `byteAt`, read through a block cache with no read-ahead: its stats count the 1 MiB
// blocks every step downloads.
function virtual(size: number, byteAt: (offset: number) => number): { source: PagerSource; cache: BlockCache } {
	const cache = new BlockCache(
		size,
		(start, end) => {
			const out = new Uint8Array(end - start)

			for (let index = 0; index < out.length; index++) out[index] = byteAt(start + index)

			return Promise.resolve(out)
		},
		{ capacity: 8, readAhead: 0 }
	)

	return { source: { size, read: (start, end) => cache.read(start, end) }, cache }
}

async function allRows(source: PagerSource, encoding: PagerEncoding): Promise<PagerRow[]> {
	return await rowsFrom(source, encoding, encoding.start, false, Number.POSITIVE_INFINITY, source.size)
}

describe("textPager rows", () => {
	it("reads the encoding's unit, its mark and its line break", () => {
		expect(pagerEncoding("utf-8", utf8("﻿a\nb"))).toMatchObject({ kind: "utf8", unit: 1, start: 3, newline: 0x0a })
		expect(pagerEncoding("utf-16be", utf16("a\nb", false, true))).toMatchObject({
			kind: "utf16",
			unit: 2,
			start: 2,
			littleEndian: false
		})
		expect(pagerEncoding("utf-32le", utf32le("a"))).toMatchObject({ kind: "utf32", unit: 4, start: 4 })
		expect(pagerEncoding("shift_jis", utf8("a\r\nb"))).toMatchObject({ kind: "multi", newline: 0x0a })
		expect(pagerEncoding("windows-1252", utf8("a\rb\rc"))).toMatchObject({ kind: "single", newline: 0x0d })
		// A mark of another encoding: skipped by a one-byte reading, text to a UTF-16 one (whose units stay aligned).
		expect(pagerEncoding("windows-1252", utf8("\ufeffa")).start).toBe(3)
		expect(pagerEncoding("utf-16le", utf8("\ufeffa")).start).toBe(0)
		expect(pagerEncoding("utf-16be", utf32le("a")).start).toBe(0)
	})

	it("lays out lines without their breaks, CRLF's CR dropped", async () => {
		const bytes = utf8("one\r\ntwo\n\nlast")
		const encoding = pagerEncoding("utf-8", bytes)
		const rows = await allRows(memory(bytes), encoding)

		expect(rows.map(row => row.text)).toEqual(["one", "two", "", "last"])
		expect(rows.map(row => [row.start, row.end, row.breaks, row.continuation])).toEqual([
			[0, 5, true, false],
			[5, 9, true, false],
			[9, 10, true, false],
			[10, 14, false, false]
		])
	})

	it("cuts a 9000-unit line into rows of at most 4096 units, then continuation rows", async () => {
		const bytes = utf8(`${"x".repeat(9000)}\nnext`)
		const encoding = pagerEncoding("utf-8", bytes)
		const rows = await allRows(memory(bytes), encoding)

		expect(rows.map(row => row.text.length)).toEqual([ROW_MAX_UNITS, ROW_MAX_UNITS, 9000 - 2 * ROW_MAX_UNITS, 4])
		expect(rows.map(row => row.continuation)).toEqual([false, true, true, false])
	})

	it("never cuts a UTF-8 sequence, a UTF-16 surrogate pair or a legacy double-byte character", async () => {
		const line = "é€😀".repeat(1500)
		const cases: [Uint8Array, string][] = [
			[utf8(line), "utf-8"],
			[utf16(line, true, true), "utf-16le"],
			[utf16(line, false, true), "utf-16be"],
			[utf32le(line), "utf-32le"]
		]

		for (const [bytes, label] of cases) {
			const encoding = pagerEncoding(label, bytes)
			const rows = await allRows(memory(bytes), encoding)

			expect(rows.length).toBeGreaterThan(1)
			expect(rows.every(row => row.text.length <= ROW_MAX_UNITS && !row.text.includes("�"))).toBe(true)
			expect(rows.map(row => row.text).join("")).toBe(line)
		}

		// Shift JIS "あ" is 0x82 0xA0: 3001 of them on one line.
		const sjis = new Uint8Array(6002).map((_, index) => (index % 2 === 0 ? 0x82 : 0xa0))
		const rows = await allRows(memory(sjis), pagerEncoding("shift_jis", sjis))

		expect(rows.map(row => row.text).join("")).toBe("あ".repeat(3001))
	})

	it("reads UTF-16 and UTF-32 breaks only at unit boundaries", async () => {
		// U+0A0A holds 0x0A in both bytes, never a break.
		const bytes = utf16("aਊb\nc", true, true)
		const rows = await allRows(memory(bytes), pagerEncoding("utf-16le", bytes))

		expect(rows.map(row => row.text)).toEqual(["aਊb", "c"])

		const wide = utf32le("x\ny")

		expect((await allRows(memory(wide), pagerEncoding("utf-32le", wide))).map(row => row.text)).toEqual(["x", "y"])
	})

	it("decodes a character split across two blocks of the cache", async () => {
		const prefix = BLOCK_BYTES - 1
		const euro = utf8("€")
		const { source } = virtual(BLOCK_BYTES + 8, offset => (offset < prefix ? 0x0a : (euro[offset - prefix] ?? 0x61)))
		const encoding = pagerEncoding("utf-8", new Uint8Array(0))
		const located = await locateRow(source, encoding, prefix + 1)
		const [row] = await rowsFrom(source, encoding, located.start, located.continuation, 1, source.size)

		expect(row?.start).toBe(prefix)
		expect(row?.text.startsWith("€")).toBe(true)
	})

	it("lays a line out from its start when that is near, and its rows match a forward layout", async () => {
		const bytes = utf8(`head\n${"y".repeat(10_000)}\ntail\n`)
		const encoding = pagerEncoding("utf-8", bytes)
		const source = memory(bytes)
		const forward = await allRows(source, encoding)

		expect(await locateRow(source, encoding, 5 + 5000)).toEqual({ start: 5 + ROW_MAX_UNITS, continuation: true })
		expect(await rowsBefore(source, encoding, bytes.length, forward.length)).toEqual(forward)
		expect(await rowsBefore(source, encoding, forward[3]?.start ?? 0, 2)).toEqual(forward.slice(1, 3))
	})

	it("reads one block per jump into a 500 MB file with no line break", async () => {
		const size = 500 * 1024 * 1024
		const { source, cache } = virtual(size, () => 0x61)
		const encoding = pagerEncoding("utf-8", new Uint8Array(0))

		for (const block of [3, 250, 477]) {
			const before = cache.stats.blockReads
			const at = block * BLOCK_BYTES + BLOCK_BYTES / 2
			const located = await locateRow(source, encoding, at)
			const rows = await rowsFrom(source, encoding, located.start, located.continuation, 40, size)

			expect(located).toEqual({ start: at, continuation: true })
			expect(rows).toHaveLength(40)
			expect(rows.every(row => row.continuation && row.text.length === ROW_MAX_UNITS)).toBe(true)
			expect(cache.stats.blockReads - before).toBe(1)
		}
	})

	it("scrolls back through a 64 MiB line with no break reading only around the rows", async () => {
		const size = 64 * 1024 * 1024
		const { source, cache } = virtual(size, offset => 0x61 + (offset % 26))
		const encoding = pagerEncoding("utf-8", new Uint8Array(0))
		const at = 40 * BLOCK_BYTES + 12_345
		const located = await locateRow(source, encoding, at)
		const before = cache.stats.blockReads
		const rows = await rowsBefore(source, encoding, located.start, 30)

		expect(rows).toHaveLength(30)
		expect(rows.at(-1)?.end).toBe(located.start)
		expect(rows.every((row, index) => index === 0 || row.start === rows[index - 1]?.end)).toBe(true)
		// 30 rows of 4 KiB sit within LINE_SEARCH_BYTES * 2 of the anchor: the block before it at most.
		expect(30 * ROW_MAX_UNITS).toBeLessThan(LINE_SEARCH_BYTES * 2)
		expect(cache.stats.blockReads - before).toBeLessThanOrEqual(1)

		const end = await locateRow(source, encoding, size)

		expect(end.start).toBeGreaterThan(size - ROW_MAX_UNITS - 1)
	})

	it("reads the last block for End, the one before only when the last row starts there, and nothing once cached", async () => {
		// The viewer's view at 13 px text in a 720 px window, and its worker's cache (8 blocks, a read-ahead of 2).
		const view = { rowHeight: 20, height: 640 }
		const after = 2 * visibleRows(view)
		const before = wholeRows(view) - 1

		for (const [size, blocks] of [
			[40 * BLOCK_BYTES, 1],
			[40 * BLOCK_BYTES + 1000, 2]
		] as const) {
			const requests: number[] = []
			const cache = new BlockCache(
				size,
				(start, end) => {
					// Every block a range spans: one request each, as the SDK reads them.
					for (let block = start / BLOCK_BYTES; block * BLOCK_BYTES < end; block++) requests.push(block)

					return Promise.resolve(new Uint8Array(end - start).map((_, index) => 0x61 + ((start + index) % 26)))
				},
				{ capacity: 8, readAhead: 2 }
			)
			const source: PagerSource = { size, read: (start, end) => cache.read(start, end) }
			const encoding = pagerEncoding("utf-8", await cache.read(0, BLOCK_BYTES))

			await rowsAround(source, encoding, 0, 0, after)

			const opened = requests.length
			const end = await rowsAround(source, encoding, size, before, after)

			expect(end.rows.at(-1)?.end).toBe(size)
			expect(end.rows.length).toBeGreaterThan(before)
			expect(requests.slice(opened).sort()).toEqual(blocks === 1 ? [39] : [39, 40])

			await rowsAround(source, encoding, size, before, after)

			expect(requests.length - opened).toBe(blocks)
		}
	})

	it("anchors a multi-byte legacy jump after a byte no character continues", async () => {
		// Fifty 0x82 0xA0 pairs, then a space, over and over.
		const bytes = new Uint8Array(300_000).map((_, index) => (index % 101 === 100 ? 0x20 : (index % 101) % 2 === 0 ? 0x82 : 0xa0))
		const encoding = pagerEncoding("shift_jis", bytes.subarray(0, 0))
		const source = memory(bytes)

		// Spaces sit at 101k + 100.
		expect(await boundaryAt(source, encoding, 150_051)).toBe(150_086)
		expect(await boundaryAt(source, encoding, 150_086)).toBe(150_086)

		const located = await locateRow(source, encoding, 200_051)
		const [row] = await rowsFrom(source, encoding, located.start, located.continuation, 1, source.size)

		expect(located.continuation).toBe(true)
		expect(row?.text.includes("�")).toBe(false)
	})
})

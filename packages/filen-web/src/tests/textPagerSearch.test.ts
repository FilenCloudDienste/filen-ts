import { describe, expect, it, vi } from "vitest"
import { LineIndex, SCAN_BYTES } from "@/features/preview/lib/textPager/index.logic"
import { pagerEncoding } from "@/features/preview/lib/textPager/rows.logic"
import { MATCH_CAP, MatchList, searchText, type PagerScanSource, type SearchEnd } from "@/features/preview/lib/textPager/search.logic"

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

interface Scanned {
	readonly source: PagerScanSource
	// Every read's length, in order.
	readonly reads: number[]
}

function scanned(bytes: Uint8Array, afterRead?: (count: number) => void): Scanned {
	const reads: number[] = []

	return {
		reads,
		source: {
			size: bytes.length,
			scan: (start, end) => {
				reads.push(end - start)
				afterRead?.(reads.length)

				return Promise.resolve(bytes.slice(start, end))
			}
		}
	}
}

async function search(
	bytes: Uint8Array,
	query: string,
	options?: { label?: string; caseSensitive?: boolean; signal?: AbortSignal; source?: PagerScanSource }
): Promise<{ end: SearchEnd; matches: MatchList }> {
	const matches = new MatchList()
	const end = await searchText({
		source: options?.source ?? scanned(bytes).source,
		encoding: pagerEncoding(options?.label ?? "utf-8", bytes.subarray(0, 4096)),
		query,
		caseSensitive: options?.caseSensitive ?? true,
		matches,
		signal: options?.signal ?? new AbortController().signal
	})

	return { end, matches }
}

function all(matches: MatchList): { offset: number; line: number }[] {
	return Array.from({ length: matches.count }, (_, index) => matches.at(index) ?? { offset: -1, line: -1 })
}

describe("textPager search", () => {
	it("finds matches with their byte offsets and line numbers, case-insensitively when asked", async () => {
		const bytes = utf8("añb Needle\n€€ needle x\n\nNEEDLE")
		const { end, matches } = await search(bytes, "needle", { caseSensitive: false })

		expect(end).toBe("done")
		expect(all(matches)).toEqual([
			{ offset: 5, line: 1 },
			{ offset: bytes.indexOf(0x6e, 13), line: 2 },
			{ offset: bytes.length - 6, line: 4 }
		])
		expect((await search(bytes, "needle")).matches.count).toBe(1)
	})

	it("keeps UTF-8 offsets exact past malformed bytes", async () => {
		const bytes = new Uint8Array([0xe2, 0x82, 0x41, 0xf0, 0x9f, 0x98, 0x80, 0xc0, 0x80, ...utf8("key")])
		const { matches } = await search(bytes, "key")

		expect(all(matches)).toEqual([{ offset: 9, line: 1 }])
	})

	it("finds a match across a stretch's end in a line with no break, keeping only the query's length back", async () => {
		const size = 2 * SCAN_BYTES + 100
		const bytes = new Uint8Array(size).fill(0x61)
		const at = SCAN_BYTES - 3

		bytes.set(utf8("needle"), at)
		bytes.set(utf8("€needle"), 2 * SCAN_BYTES - 2)

		const { source, reads } = scanned(bytes)
		const { matches } = await search(bytes, "needle", { source })

		expect(all(matches)).toEqual([
			{ offset: at, line: 1 },
			{ offset: 2 * SCAN_BYTES + 1, line: 1 }
		])
		// Block-aligned stretches, each read once.
		expect(reads).toEqual([SCAN_BYTES, SCAN_BYTES, 100])
	})

	it("finds a match on a line cut by a stretch's end, and counts each break once", async () => {
		const lines = Array.from({ length: 300_000 }, (_, index) => `line ${String(index)}`)
		const bytes = utf8(lines.join("\n"))
		const { matches } = await search(bytes, "line 123456")

		expect(all(matches)).toEqual([{ offset: utf8(lines.slice(0, 123_456).join("\n")).length + 1, line: 123_457 }])
		expect(bytes.length).toBeGreaterThan(SCAN_BYTES)

		const last = await search(bytes, "line 299999")

		expect(last.matches.at(0)?.line).toBe(300_000)
	})

	it("searches UTF-16 with exact offsets", async () => {
		const text = "x\nfind 😀 find"
		const bytes = new Uint8Array(2 + text.length * 2)
		const view = new DataView(bytes.buffer)

		view.setUint16(0, 0xfeff, false)

		for (let at = 0; at < text.length; at++) view.setUint16(2 + at * 2, text.charCodeAt(at), false)

		const { matches } = await search(bytes, "find", { label: "utf-16be" })

		expect(all(matches)).toEqual([
			{ offset: 2 + 2 * 2, line: 2 },
			{ offset: 2 + 2 * text.lastIndexOf("find"), line: 2 }
		])
	})

	it("stops at the match cap", async () => {
		const bytes = utf8("ab ".repeat(MATCH_CAP + 5))
		const { end, matches } = await search(bytes, "ab")

		expect(end).toBe("capped")
		expect(matches.count).toBe(MATCH_CAP)
		expect(matches.capped).toBe(true)
	})

	it("stops when cancelled between stretches", async () => {
		const bytes = new Uint8Array(3 * SCAN_BYTES).fill(0x61)
		const abort = new AbortController()
		const { source, reads } = scanned(bytes, () => {
			abort.abort()
		})
		const { end } = await search(bytes, "zz", { source, signal: abort.signal })

		expect(end).toBe("stopped")
		expect(reads).toHaveLength(1)
	})

	it("hands every stretch to the line index in order", async () => {
		const bytes = utf8("a\n".repeat(SCAN_BYTES))
		const encoding = pagerEncoding("utf-8", bytes.subarray(0, 16))
		const index = new LineIndex(encoding, bytes.length)

		await searchText({
			source: scanned(bytes).source,
			encoding,
			query: "nothing",
			caseSensitive: true,
			matches: new MatchList(),
			signal: new AbortController().signal,
			onBytes: (piece, base) => {
				index.feed(piece, base)
			}
		})
		expect(index.complete).toBe(true)
		expect(index.lines).toBe(SCAN_BYTES + 1)
	})

	it("finds the first match at or after an offset", () => {
		const matches = new MatchList()

		for (const offset of [10, 20, 30]) matches.push(offset, 1)

		expect([0, 10, 11, 30, 31].map(offset => matches.firstFrom(offset))).toEqual([0, 0, 1, 2, -1])
	})

	it("keeps counting lines past the first stretch for a UTF-8-BOM file read as UTF-16", async () => {
		const size = 2 * SCAN_BYTES + 6
		const bytes = new Uint8Array(size)

		bytes.set([0xef, 0xbb, 0xbf])

		for (let at = 4; at < size; at += 2) bytes.set(at % 400 === 0 ? [0x0a, 0] : [0x41, 0], at)

		bytes.set([0x7a, 0, 0x7a, 0], size - 6)

		const encoding = pagerEncoding("utf-16le", bytes.subarray(0, 4096))
		const index = new LineIndex(encoding, size)
		const matches = new MatchList()

		await searchText({
			source: scanned(bytes).source,
			encoding,
			query: "zz",
			caseSensitive: true,
			matches,
			signal: new AbortController().signal,
			onBytes: (piece, base) => {
				index.feed(piece, base)
			}
		})
		expect(index.complete).toBe(true)
		expect(matches.at(0)).toEqual({ offset: size - 6, line: index.lines })
	})

	// HKSCS pointers decode to two code points (0x88 0x62) or past the Basic Multilingual Plane; GB18030's four-byte
	// sequences from 0x90 too. Units are counted by decoding, so offsets stay exact whatever the decoder gives.
	it("keeps Big5 offsets exact past a pointer that decodes to two code points", async () => {
		// Node's decoder gives 0x88 0x62 a private-use character; WHATWG's (Firefox, Chromium) gives U+00CA U+0304.
		const Native = globalThis.TextDecoder

		vi.stubGlobal(
			"TextDecoder",
			class extends Native {
				public override decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string {
					return super.decode(input, options).replaceAll("\uf325", "\u00ca\u0304")
				}
			}
		)

		const head = new Uint8Array(6000).map((_, index) => (index % 2 === 0 ? 0x88 : 0x62))
		const bytes = new Uint8Array([...head, ...utf8(" key")])
		const { matches } = await search(bytes, "key", { label: "big5" })

		expect(all(matches).map(match => match.offset)).toEqual([head.length + 1])
	})

	it.each([
		["big5", [0xa4, 0xa4]],
		["gb18030", [0x94, 0x39, 0xfc, 0x36]]
	] as const)("keeps %s offsets exact past %j", async (label, char) => {
		const head = new Uint8Array(char.length * 3000).map((_, index) => char[index % char.length] ?? 0)
		const bytes = new Uint8Array([...head, ...utf8(" key "), ...head, ...utf8("key")])
		const { matches } = await search(bytes, "key", { label })

		expect(all(matches).map(match => match.offset)).toEqual([head.length + 1, bytes.length - 3])
	})
})

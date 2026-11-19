import { describe, expect, it, vi } from "vitest"
import { detectDelimiter, parseCsv, writeCsv } from "../core/sheet/csv/csvParse"
import { parseCsvFile, serializeCsv } from "../core/sheet/csv/csvView"
import {
	decodeUtf16,
	decodeUtf16Fallback,
	decodeUtf8Fallback,
	decodeUtf8Strict,
	decodeWindows1252,
	detectBom,
	encodeUtf16,
	encodeWindows1252
} from "../core/sheet/csv/encoding"

// RFC 4180 section 2, and the files that break it.
describe("parseCsv", () => {
	it("reads records and fields (RFC 4180 2.1-2.4)", () => {
		expect(parseCsv("aaa,bbb,ccc\r\nzzz,yyy,xxx\r\n", ",")).toEqual([
			["aaa", "bbb", "ccc"],
			["zzz", "yyy", "xxx"]
		])
		expect(parseCsv("aaa,bbb,ccc\r\nzzz,yyy,xxx", ",")).toEqual([
			["aaa", "bbb", "ccc"],
			["zzz", "yyy", "xxx"]
		])
		expect(parseCsv(" a , b ", ",")).toEqual([[" a ", " b "]])
	})

	it("reads quoted fields with separators, line ends and doubled quotes (2.5-2.7)", () => {
		expect(parseCsv('"aaa","b\r\nbb","c,cc"\r\n', ",")).toEqual([["aaa", "b\r\nbb", "c,cc"]])
		expect(parseCsv('"aaa","b""bb","ccc"', ",")).toEqual([["aaa", 'b"bb', "ccc"]])
		expect(parseCsv('"",""\n""', ",")).toEqual([["", ""], [""]])
	})

	it("ends records at LF and CR alone as well as CRLF", () => {
		expect(parseCsv("a,b\r1,2\n3,4\r\n5,6", ",")).toEqual([
			["a", "b"],
			["1", "2"],
			["3", "4"],
			["5", "6"]
		])
	})

	it("keeps empty lines and fields, and adds no record for the final line end", () => {
		expect(parseCsv("a\n\nb\n\n", ",")).toEqual([["a"], [""], ["b"], [""]])
		expect(parseCsv("a,b,\n,\n", ",")).toEqual([
			["a", "b", ""],
			["", ""]
		])
		expect(parseCsv("a,", ",")).toEqual([["a", ""]])
		expect(parseCsv("", ",")).toEqual([])
	})

	it("reads stray quotes as text", () => {
		// A quote inside a field that does not open with one is text; so is what follows a closing quote.
		expect(parseCsv('ab"c,d"e"f\n', ",")).toEqual([['ab"c', 'd"e"f']])
		expect(parseCsv('"x"y,z\n', ",")).toEqual([["xy", "z"]])
		expect(parseCsv(' "q" ,r', ",")).toEqual([[' "q" ', "r"]])
	})

	it("lets a quote never closed run to the end of the text", () => {
		expect(parseCsv('a,"open\nrest,of\nfile', ",")).toEqual([["a", "open\nrest,of\nfile"]])
		expect(parseCsv('"', ",")).toEqual([[""]])
		expect(parseCsv('"a""', ",")).toEqual([['a"']])
	})

	it("reads other separators", () => {
		expect(parseCsv('a\t"x\ty"\t"l1\nl2"\n', "\t")).toEqual([["a", "x\ty", "l1\nl2"]])
		expect(parseCsv("a;b,c|d", ";")).toEqual([["a", "b,c|d"]])
	})
})

describe("detectDelimiter", () => {
	it("takes the separator found the same number of times on the most lines", () => {
		expect(detectDelimiter("a,b,c\n1,2,3\n")).toBe(",")
		expect(detectDelimiter("a;b;c\n1;2,5;3\n4;5;6\n")).toBe(";")
		expect(detectDelimiter("a\tb\n1\t2\n")).toBe("\t")
		expect(detectDelimiter("a|b|c\n1|2|3")).toBe("|")
		expect(detectDelimiter("plain\ntext\n")).toBe(",")
	})

	it("counts nothing inside quotes, a doubled quote and a quoted line end included", () => {
		expect(detectDelimiter('"x""y,z";w\n"p""q,r";s\n')).toBe(";")
		expect(detectDelimiter('"a\nb;c",d\n"e;f",g\n')).toBe(",")
	})
})

describe("writeCsv", () => {
	it("quotes only what needs it, and ends no line after the last record", () => {
		expect(writeCsv([["a", "b,c", 'say "hi"', "l1\nl2", "cr\r"], [], [""]], ",", "\r\n")).toBe(
			'a,"b,c","say ""hi""","l1\nl2","cr\r"\r\n\r\n'
		)
		expect(writeCsv([["a;b", "c,d"]], ";", "\n")).toBe('"a;b";c,d')
	})

	it("reads back what it writes", () => {
		const rows = [["", '"', "a\r\nb", ",", " x "], ["only"]]

		expect(parseCsv(writeCsv(rows, ",", "\n"), ",")).toEqual(rows)
	})
})

function bytes(...values: number[]): Uint8Array {
	return Uint8Array.from(values)
}

// A fixed pseudo-random byte stream, so a failure repeats.
function random(seed: number): () => number {
	let state = seed

	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff

		return state >> 16
	}
}

function samples(count: number, seed: number, bias: readonly number[]): Uint8Array[] {
	const next = random(seed)
	const out: Uint8Array[] = []

	for (let i = 0; i < count; i++) {
		const length = next() % 24
		const sample = new Uint8Array(length)

		for (let j = 0; j < length; j++) {
			sample[j] = next() % 3 === 0 ? (bias[next() % bias.length] ?? 0) : next() & 0xff
		}

		out.push(sample)
	}

	return out
}

// Lead and continuation bytes, the surrogate and overlong boundaries, BOM bytes.
const UTF8_BIAS = [0x41, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc2, 0xdf, 0xe0, 0xed, 0xef, 0xbb, 0xf0, 0xf4, 0xf5, 0xff]
const UTF16_BIAS = [0x00, 0x41, 0xd8, 0xdb, 0xdc, 0xdf, 0xfe, 0xff]

function nativeUtf8(input: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(input)
	} catch {
		return null
	}
}

describe("text decoding without TextDecoder", () => {
	it("decodes UTF-8 as the platform's fatal decoder does", () => {
		const fixed = [
			bytes(),
			bytes(0xef, 0xbb, 0xbf, 0x61),
			bytes(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf),
			bytes(0x61, 0xef, 0xbb, 0xbf),
			bytes(0xc3, 0xa9),
			bytes(0xf0, 0x9f, 0x98, 0x80),
			bytes(0xc0, 0xaf),
			bytes(0xe0, 0x80, 0x80),
			bytes(0xed, 0xa0, 0x80),
			bytes(0xf4, 0x90, 0x80, 0x80),
			bytes(0xe2, 0x82),
			bytes(0x80)
		]

		for (const input of [...fixed, ...samples(4000, 7, UTF8_BIAS)]) {
			expect(decodeUtf8Fallback(input)).toBe(nativeUtf8(input))
			expect(decodeUtf8Strict(input)).toBe(nativeUtf8(input))
		}
	})

	it("decodes long text in chunks", () => {
		const text = "é€😀a".repeat(20_000)

		expect(decodeUtf8Fallback(new TextEncoder().encode(text))).toBe(text)
		expect(decodeUtf16Fallback(encodeUtf16(text, true), true)).toBe(text)
	})

	it("decodes UTF-16 in both orders as the platform's decoder does", () => {
		const fixed = [
			bytes(),
			bytes(0x41),
			bytes(0xff, 0xfe, 0x41, 0x00),
			bytes(0x00, 0xd8, 0x41, 0x00),
			bytes(0x00, 0xdc),
			bytes(0x00, 0xd8),
			bytes(0x00, 0xd8, 0x00, 0xd8, 0x00, 0xdc),
			bytes(0x3d, 0xd8, 0x00, 0xde, 0x41)
		]

		for (const input of [...fixed, ...samples(4000, 11, UTF16_BIAS)]) {
			for (const littleEndian of [true, false]) {
				const native = new TextDecoder(littleEndian ? "utf-16le" : "utf-16be").decode(input)

				expect(decodeUtf16Fallback(input, littleEndian)).toBe(native)
				expect(decodeUtf16(input, littleEndian)).toBe(native)
			}
		}
	})
})

// https://encoding.spec.whatwg.org/index-windows-1252.txt, 0x80-0x9F (every other byte is its own code point).
const INDEX_80_9F = [
	0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018,
	0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178
]
const UNDEFINED_1252 = [0x81, 0x8d, 0x8f, 0x90, 0x9d]

describe("windows-1252", () => {
	const all = Uint8Array.from({ length: 256 }, (_, byte) => byte)
	const expected = String.fromCharCode(
		...Array.from(all, byte => (byte >= 0x80 && byte <= 0x9f ? (INDEX_80_9F[byte - 0x80] ?? byte) : byte))
	)

	it("decodes every byte by the standard's index", () => {
		expect(decodeWindows1252(all)).toBe(expected)
		expect(decodeWindows1252(new Uint8Array(20_000).fill(0x80))).toBe("€".repeat(20_000))
	})

	it("encodes every defined byte back, and refuses what it cannot hold", () => {
		const defined = all.filter(byte => !UNDEFINED_1252.includes(byte))

		expect(encodeWindows1252(decodeWindows1252(defined))).toEqual(defined)

		for (const byte of UNDEFINED_1252) {
			expect(encodeWindows1252(String.fromCharCode(byte))).toBeNull()
		}

		expect(encodeWindows1252("\u0080")).toBeNull()
		expect(encodeWindows1252("Ā")).toBeNull()
		expect(encodeWindows1252("😀")).toBeNull()
	})
})

describe("detectBom", () => {
	it("names UTF-8 and both UTF-16 marks", () => {
		expect(detectBom(bytes(0xef, 0xbb, 0xbf))).toEqual({ encoding: "utf-8", length: 3 })
		expect(detectBom(bytes(0xff, 0xfe, 0x41))).toEqual({ encoding: "utf-16le", length: 2 })
		expect(detectBom(bytes(0xfe, 0xff))).toEqual({ encoding: "utf-16be", length: 2 })
		expect(detectBom(bytes(0xef, 0xbb))).toBeNull()
		expect(detectBom(bytes())).toBeNull()
	})
})

describe("parseCsvFile without TextDecoder", () => {
	it("reads every encoding as it does with one (as under Hermes)", () => {
		const files = [
			bytes(0xef, 0xbb, 0xbf, 0x61, 0x2c, 0xc3, 0xa9, 0x0a),
			bytes(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61),
			bytes(0xff, 0xfe, 0x61, 0x00, 0x3b, 0x00, 0x00, 0xd8, 0x0a, 0x00, 0x41),
			bytes(0xfe, 0xff, 0x00, 0x61, 0x00, 0x09, 0x20, 0xac),
			bytes(0x63, 0x61, 0x66, 0xe9, 0x2c, 0x80, 0x0d, 0x0a, 0x93, 0x94),
			bytes(0xc4, 0xe3, 0xba, 0xc3, 0x2c, 0x61),
			bytes(0x61, 0x2c, 0xed, 0xa0, 0x80)
		]
		const native = files.map(file => parseCsvFile(file, false))

		vi.stubGlobal("TextDecoder", undefined)

		expect(files.map(file => parseCsvFile(file, false))).toEqual(native)
	})
})

describe("CSV files read and written back", () => {
	const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
	const utf16 = (text: string, littleEndian: boolean): number[] =>
		text.split("").flatMap(char => {
			const code = char.charCodeAt(0)

			return littleEndian ? [code & 0xff, code >> 8] : [code >> 8, code & 0xff]
		})

	it("knows whether the text ends in a line end", () => {
		expect(["", "a", "a,b\n", "a,b\r", "a,b\r\n", "a\nb"].map(text => parseCsvFile(utf8(text), false).format.trailingNewline)).toEqual([
			false,
			false,
			true,
			true,
			true,
			false
		])
	})

	it("writes UTF-8 with a BOM and both UTF-16 orders back byte for byte", () => {
		const files = [
			bytes(0xef, 0xbb, 0xbf, ...utf8("a,\u00e9\u20ac\ud83d\ude00\r\nb,c\r\n")),
			bytes(0xff, 0xfe, ...utf16("a;\u00e9\u20ac\nb;c\n", true)),
			bytes(0xfe, 0xff, ...utf16("a\t\u00e9\rb\tc", false)),
			bytes(0xef, 0xbb, 0xbf)
		]

		for (const file of files) {
			const { rows, format } = parseCsvFile(file, false)

			expect([...serializeCsv(rows, format)]).toEqual([...file])
		}
	})
})

import { describe, expect, it } from "vitest"
import { decodeSubtitleBytes, legacyEncodingForLanguage, SUBTITLE_ENCODINGS } from "@filen/shared/textEncoding"

const enc = new TextEncoder()

function bytesOf(values: number[]): Uint8Array {
	return Uint8Array.from(values)
}

describe("decodeSubtitleBytes", () => {
	it("decodes UTF-8 and strips the BOM", () => {
		const plain = decodeSubtitleBytes(enc.encode("héllo ✓"))
		const bom = decodeSubtitleBytes(Uint8Array.from([0xef, 0xbb, 0xbf, ...enc.encode("héllo")]))

		expect(plain).toEqual({ text: "héllo ✓", encoding: "utf-8", bom: false, confident: true, writable: "yes", lossy: false })
		expect(bom?.text).toBe("héllo")
		expect(bom?.encoding).toBe("utf-8")
	})

	it("decodes UTF-16 with BOM in both byte orders", () => {
		const le = Uint8Array.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])
		const be = Uint8Array.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69])

		expect(decodeSubtitleBytes(le)).toMatchObject({ text: "hi", encoding: "utf-16le" })
		expect(decodeSubtitleBytes(be)).toMatchObject({ text: "hi", encoding: "utf-16be" })
	})

	it("sniffs BOM-less UTF-16", () => {
		const text = "1\n00:00:01,000 --> 00:00:02,000\nHello there\n"
		const le = new Uint8Array(text.length * 2)

		for (let i = 0; i < text.length; i++) {
			le[i * 2] = text.charCodeAt(i)
		}

		expect(decodeSubtitleBytes(le)).toMatchObject({ text, encoding: "utf-16le" })
	})

	it("falls back to a legacy codepage chosen by the language hint", () => {
		const cyrillic = bytesOf([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])

		expect(decodeSubtitleBytes(cyrillic, { languageHint: "rus" })).toEqual({
			text: "Привет",
			encoding: "windows-1251",
			bom: false,
			confident: false,
			writable: "yes",
			lossy: false
		})
		expect(decodeSubtitleBytes(bytesOf([0xe9]), { languageHint: null })).toMatchObject({ text: "é", encoding: "windows-1252" })
		expect(decodeSubtitleBytes(bytesOf([0x82, 0xb1, 0x82, 0xf1]), { languageHint: "ja" })).toMatchObject({
			text: "こん",
			encoding: "shift_jis"
		})
		expect(decodeSubtitleBytes(bytesOf([0xc7, 0xd1, 0xb1, 0xdb]), { languageHint: "kor" })).toMatchObject({
			text: "한글",
			encoding: "euc-kr"
		})
		expect(decodeSubtitleBytes(bytesOf([0xc4, 0xe3, 0xba, 0xc3]), { languageHint: "zh-CN" })).toMatchObject({
			text: "你好",
			encoding: "gb18030"
		})
		expect(decodeSubtitleBytes(bytesOf([0xa7, 0x41, 0xa6, 0x6e]), { languageHint: "zh-TW" })).toMatchObject({
			text: "你好",
			encoding: "big5"
		})
	})

	it("lets a manual encoding override detection", () => {
		const bytes = enc.encode("Привет")

		expect(decodeSubtitleBytes(bytes, { encoding: "windows-1252" })?.encoding).toBe("windows-1252")
		expect(decodeSubtitleBytes(bytesOf([0xcf, 0xf0]), { encoding: "windows-1251" })).toMatchObject({ text: "Пр", confident: false })
	})

	it("ignores unknown override labels", () => {
		expect(decodeSubtitleBytes(enc.encode("ok"), { encoding: "definitely-not" })).toMatchObject({ text: "ok", encoding: "utf-8" })
	})

	it("refuses inputs over 8 MiB", () => {
		expect(decodeSubtitleBytes(new Uint8Array(8 * 1024 * 1024 + 1))).toBeNull()
	})

	it("handles empty input", () => {
		expect(decodeSubtitleBytes(new Uint8Array(0))).toMatchObject({ text: "" })
	})

	it("only offers encodings the runtime can decode", () => {
		for (const { label } of SUBTITLE_ENCODINGS) {
			expect(() => new TextDecoder(label)).not.toThrow()
		}
	})
})

describe("legacyEncodingForLanguage", () => {
	it.each([
		["ru", "windows-1251"],
		["el", "windows-1253"],
		["tr", "windows-1254"],
		["heb", "windows-1255"],
		["ar", "windows-1256"],
		["lt", "windows-1257"],
		["pl", "windows-1250"],
		["vi", "windows-1258"],
		["th", "windows-874"],
		["zh-Hant", "big5"],
		["zht", "big5"],
		["zh-HK", "big5"],
		["chi", "gb18030"],
		["ja", "shift_jis"],
		["ko", "euc-kr"],
		["fr", "windows-1252"],
		["xx", "windows-1252"],
		[null, "windows-1252"]
	])("%s -> %s", (hint, expected) => {
		expect(legacyEncodingForLanguage(hint)).toBe(expected)
	})
})

describe("legacy hints and malformed UTF-16", () => {
	it.each([
		["Traditional Chinese", "big5"],
		["Chinese (Traditional)", "big5"],
		["zh-Hant", "big5"],
		["zh-TW", "big5"],
		["zh-HK", "big5"],
		["Chinese Simplified", "gb18030"],
		["sr-Latn", "windows-1250"],
		["sr-Cyrl", "windows-1251"],
		["scc", "windows-1251"]
	])("%s -> %s", (hint, expected) => {
		expect(legacyEncodingForLanguage(hint)).toBe(expected)
	})

	it("does not report confident UTF-8 for NUL-interleaved text behind a UTF-16 sniff", () => {
		// ASCII-looking UTF-16LE with a lone high surrogate: strict UTF-16 fails.
		const units = [..."1\n00:00:01,000 --> 00:00:02,000\nHello there\n"].map(c => c.charCodeAt(0))

		units.push(0xd800)

		const bytes = new Uint8Array(units.length * 2)

		units.forEach((u, i) => {
			bytes[i * 2] = u & 0xff
			bytes[i * 2 + 1] = u >> 8
		})

		const decoded = decodeSubtitleBytes(bytes)

		expect(decoded?.encoding).toBe("utf-16le")
		expect(decoded?.confident).toBe(false)
		expect(decoded?.text.includes("\u0000")).toBe(false)
		expect(decoded?.text.startsWith("1\n00:00:01,000")).toBe(true)
	})

	it("drops a UTF-8 BOM in front of a legacy payload", () => {
		// cp1250 "ž" (0x9E) is not UTF-8, so the BOM'd bytes fall back to the language's codepage.
		const body = [..."{1}{25}"].map(c => c.charCodeAt(0))
		const decoded = decodeSubtitleBytes(Uint8Array.from([0xef, 0xbb, 0xbf, ...body, 0x9e]), { languageHint: "cs" })

		expect(decoded).toMatchObject({ text: "{1}{25}ž", encoding: "windows-1250", bom: true, confident: false })
	})

	it("drops a UTF-8 BOM in front of a payload forced to a legacy codepage", () => {
		const body = [..."{1}{25}Ahoj"].map(c => c.charCodeAt(0))
		const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...body, 0x9e])

		expect(decodeSubtitleBytes(bytes, { encoding: "windows-1250" })).toMatchObject({
			text: "{1}{25}Ahojž",
			encoding: "windows-1250",
			confident: false,
			// The UTF-8 mark is not written back by a windows-1250 encoder.
			writable: "convert"
		})
		expect(decodeSubtitleBytes(Uint8Array.from([0xef, 0xbb, 0xbf, ...body]), { encoding: "UTF-8" })?.text).toBe("{1}{25}Ahoj")
	})

	it("flags a malformed BOM'd UTF-16 payload as not confident", () => {
		const decoded = decodeSubtitleBytes(Uint8Array.from([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00]))

		expect(decoded?.encoding).toBe("utf-16le")
		expect(decoded?.confident).toBe(false)
	})
})

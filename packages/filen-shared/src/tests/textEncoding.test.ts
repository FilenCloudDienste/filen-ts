import { describe, expect, it } from "vitest"
import { decodeTextBytes, editableAsIs, looksLikeText, needsLegacyGuess, TEXT_ENCODINGS } from "@filen/shared/textEncoding"

const enc = new TextEncoder()

function utf16(text: string, littleEndian: boolean, bom: boolean): Uint8Array {
	const out = new Uint8Array((bom ? 2 : 0) + text.length * 2)
	const view = new DataView(out.buffer)
	let offset = 0

	if (bom) {
		view.setUint16(0, 0xfeff, littleEndian)
		offset = 2
	}

	for (let i = 0; i < text.length; i++) {
		view.setUint16(offset + i * 2, text.charCodeAt(i), littleEndian)
	}

	return out
}

function utf32(points: number[], littleEndian: boolean): Uint8Array {
	const out = new Uint8Array(4 + points.length * 4)
	const view = new DataView(out.buffer)

	view.setUint32(0, 0xfeff, littleEndian)
	points.forEach((point, i) => {
		view.setUint32(4 + i * 4, point, littleEndian)
	})

	return out
}

// 64 little-endian units, high bytes zero: the UTF-16 sniff fires, but the units are no text.
function alternatingZeros(edit: (units: Uint16Array) => void): Uint8Array {
	const units = Uint16Array.from({ length: 64 }, (_, i) => 0x41 + (i % 20))

	edit(units)

	return new Uint8Array(units.buffer)
}

// A lone high surrogate: no strict UTF-16 decode.
const UNPAIRED_SURROGATE = alternatingZeros(units => {
	units[10] = 0xd800
})
// Three NUL units (both bytes zero, under the sniff's 5% bound): a strict decode, but no text holds NUL.
const NUL_UNITS = alternatingZeros(units => {
	units[0] = 0
	units[25] = 0
	units[50] = 0
})

describe("decodeTextBytes", () => {
	it("decodes strict UTF-8 as writable, with or without a BOM", () => {
		expect(decodeTextBytes(enc.encode("héllo ✓"))).toEqual({
			text: "héllo ✓",
			encoding: "utf-8",
			bom: false,
			confident: true,
			writable: "yes",
			lossy: false
		})
		expect(decodeTextBytes(Uint8Array.of(0xef, 0xbb, 0xbf, ...enc.encode("hi")))).toMatchObject({
			text: "hi",
			encoding: "utf-8",
			bom: true,
			writable: "yes"
		})
	})

	it("keeps a second U+FEFF after the mark as text", () => {
		expect(decodeTextBytes(Uint8Array.of(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61)).text).toBe("﻿a")
	})

	it("decodes UTF-16 with a BOM and by the sniff", () => {
		expect(decodeTextBytes(utf16("hi", true, true))).toMatchObject({ text: "hi", encoding: "utf-16le", bom: true, writable: "yes" })
		expect(decodeTextBytes(utf16("hi", false, true))).toMatchObject({ text: "hi", encoding: "utf-16be", bom: true, writable: "yes" })

		const text = "plain ascii text that is long enough\n"

		expect(decodeTextBytes(utf16(text, true, false))).toMatchObject({ text, encoding: "utf-16le", bom: false, confident: true })
	})

	it("never reads sniffed UTF-16 that fails a strict decode, or holds NUL, as confident or editable", () => {
		for (const bytes of [UNPAIRED_SURROGATE, NUL_UNITS]) {
			expect(decodeTextBytes(bytes)).toMatchObject({ encoding: "utf-16le", confident: false, writable: "convert", lossy: true })
		}
	})

	it("marks malformed UTF-16 as convert", () => {
		expect(decodeTextBytes(Uint8Array.of(0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00))).toMatchObject({
			encoding: "utf-16le",
			confident: false,
			writable: "convert",
			lossy: true
		})
	})

	it("decodes UTF-32 behind its BOM, which starts like UTF-16 LE's", () => {
		expect(decodeTextBytes(utf32([0x68, 0x1f600], true))).toMatchObject({
			text: "h😀",
			encoding: "utf-32le",
			bom: true,
			writable: "yes",
			lossy: false
		})
		expect(decodeTextBytes(utf32([0x68, 0x69], false))).toMatchObject({ text: "hi", encoding: "utf-32be" })
		expect(decodeTextBytes(utf32([0x110000], true))).toMatchObject({ text: "�", writable: "convert", lossy: true })
	})

	it("does not fail a prefix cut inside a multi-byte sequence", () => {
		const block = 1 << 20
		const bytes = new Uint8Array(block + 2)

		bytes.fill(0x61)
		// "€" (E2 82 AC) straddles the end of a 1 MiB block.
		bytes.set([0xe2, 0x82, 0xac], block - 1)

		const prefix = bytes.subarray(0, block)

		expect(decodeTextBytes(prefix, { prefix: true })).toMatchObject({ encoding: "utf-8", confident: true, writable: "yes", lossy: false })
		expect(decodeTextBytes(prefix, { prefix: true }).text.length).toBe(block - 1)
		expect(needsLegacyGuess(prefix, { prefix: true })).toBe(false)
		// Without `prefix` the cut sequence is not UTF-8.
		expect(decodeTextBytes(prefix).encoding).toBe("windows-1252")
	})

	it("reads UTF-8 with a few stray bytes as lossy UTF-8, never writable", () => {
		const body = enc.encode("Grüße aus Köln, schöne Grüße. ".repeat(4))
		const bytes = Uint8Array.of(...body, 0xff, ...body)

		expect(decodeTextBytes(bytes)).toMatchObject({ encoding: "utf-8", confident: false, writable: "convert", lossy: true })
		expect(needsLegacyGuess(bytes)).toBe(false)
	})

	it("falls back to the guess, the language's codepage, then windows-1252", () => {
		const cyrillic = Uint8Array.of(0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2)

		expect(decodeTextBytes(cyrillic, { guess: "windows-1251" })).toMatchObject({ text: "Привет", encoding: "windows-1251" })
		expect(decodeTextBytes(cyrillic, { languageHint: "ru" })).toMatchObject({
			text: "Привет",
			encoding: "windows-1251",
			confident: false,
			writable: "yes",
			lossy: false
		})
		expect(decodeTextBytes(Uint8Array.of(0x61, 0xe9))).toMatchObject({ text: "aé", encoding: "windows-1252", writable: "yes" })
		expect(needsLegacyGuess(cyrillic)).toBe(true)
	})

	it("never marks a multi-byte legacy decode or a codepage hole writable", () => {
		expect(decodeTextBytes(Uint8Array.of(0x82, 0xb1, 0x82, 0xf1), { languageHint: "ja" })).toMatchObject({
			text: "こん",
			encoding: "shift_jis",
			writable: "convert",
			lossy: false
		})
		// 0xD2 is a hole in windows-1253.
		expect(decodeTextBytes(Uint8Array.of(0x61, 0xd2), { languageHint: "el" })).toMatchObject({
			encoding: "windows-1253",
			writable: "convert",
			lossy: true
		})
	})

	it("honours a forced label, convert when it produced U+FFFD", () => {
		expect(decodeTextBytes(enc.encode("ok"), { encoding: "UTF-8" })).toMatchObject({ encoding: "utf-8", writable: "yes", confident: false })
		expect(decodeTextBytes(Uint8Array.of(0x61, 0xff), { encoding: "utf-8" })).toMatchObject({
			text: "a�",
			encoding: "utf-8",
			writable: "convert",
			lossy: true
		})
		expect(decodeTextBytes(enc.encode("ok"), { encoding: "not-an-encoding" })).toMatchObject({ encoding: "utf-8", confident: true })
	})

	it("handles empty input", () => {
		expect(decodeTextBytes(new Uint8Array(0))).toMatchObject({ text: "", encoding: "utf-8", writable: "yes" })
	})

	it("only lists encodings the runtime can decode", () => {
		for (const { label } of TEXT_ENCODINGS) {
			expect(new TextDecoder(label).encoding).toBe(label)
		}
	})
})

describe("looksLikeText", () => {
	it("treats a NUL near the start as binary", () => {
		expect(looksLikeText(enc.encode("plain text\n"))).toBe(true)
		expect(looksLikeText(Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x00))).toBe(false)

		const late = new Uint8Array(9000).fill(0x61)

		late[8500] = 0

		expect(looksLikeText(late)).toBe(true)
	})

	it("accepts UTF-16 and UTF-32, whose zeros are Unicode", () => {
		expect(looksLikeText(utf16("hi", true, true))).toBe(true)
		expect(looksLikeText(utf16("plain ascii text that is long enough", false, false))).toBe(true)
		expect(looksLikeText(utf32([0x68, 0x69], true))).toBe(true)
		expect(looksLikeText(utf32([0x68, 0x69], false))).toBe(true)
	})

	it("keeps a binary with alternating zeros binary unless it decodes strictly as UTF-16 text", () => {
		expect(looksLikeText(UNPAIRED_SURROGATE)).toBe(false)
		expect(looksLikeText(NUL_UNITS)).toBe(false)
		expect(looksLikeText(alternatingZeros(() => undefined))).toBe(true)
	})
})

describe("editableAsIs", () => {
	it("is true only for strict UTF-8, with or without a BOM", () => {
		expect(editableAsIs(decodeTextBytes(enc.encode("ok")))).toBe(true)
		expect(editableAsIs(decodeTextBytes(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61)))).toBe(true)
		expect(editableAsIs(decodeTextBytes(utf16("hi", true, true)))).toBe(false)
		expect(editableAsIs(decodeTextBytes(utf32([0x68], true)))).toBe(false)
		expect(editableAsIs(decodeTextBytes(Uint8Array.of(0x61, 0xe9)))).toBe(false)
		expect(editableAsIs(decodeTextBytes(Uint8Array.of(0xcf, 0xf0), { languageHint: "ru" }))).toBe(false)
		expect(editableAsIs(decodeTextBytes(Uint8Array.of(0x61, 0xff), { encoding: "utf-8" }))).toBe(false)
	})
})

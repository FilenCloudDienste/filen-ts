import { describe, expect, it, vi } from "vitest"
import { contentStrings, parseContent, sectionEnd, spliceContent, writeOperation } from "../core/pdfedit/contentStream"
import {
	coveredWords,
	decodeXmlText,
	foldCase,
	hiddenTerms,
	forEachCoveredPixel,
	glyphCore,
	matchedTerm,
	matchPreset,
	matchTerm,
	pdfTextString,
	quadOverlapsRect,
	segmentCrossesRect,
	streamReadings,
	utf8Text,
	verifiedTerms,
	type RedactionFinding
} from "../core/pdfedit/redactVerify"
import { budget } from "./timing"

const bytes = (text: string): Uint8Array => Uint8Array.from(text, char => char.charCodeAt(0))
const text = (data: Uint8Array): string => String.fromCharCode(...data)

describe("content streams", () => {
	it("parses operations with operands, strings, arrays, dictionaries and inline images", () => {
		const source = bytes(
			"q 1 0 0 1 72 500 cm /Span <</MCID 0 /ActualText (A\\(b\\)\\101)>> BDC BT /F1 12 Tf [(Hel) -20 <6c6c6f>] TJ ET EMC % note\nBI /W 2 /H 1 ID \x00EI\xff EI Q"
		)
		const operations = parseContent(source)

		expect(operations.map(operation => operation.operator)).toEqual(["q", "cm", "BDC", "BT", "Tf", "TJ", "ET", "EMC", "BI", "Q"])

		const bdc = operations[2]

		expect(bdc?.operands[1]).toMatchObject({ kind: "dict" })
		expect(
			bdc?.operands[1]?.kind === "dict" ? text((bdc.operands[1].entries.get("ActualText") as { bytes: Uint8Array }).bytes) : ""
		).toBe("A(b)A")
		expect(sectionEnd(operations, 2)).toBe(7)
		// The inline image's data holds "EI" not followed by whitespace; parsing resumes after the real end.
		expect(text(source.subarray(operations[8]?.start, operations[8]?.end))).toBe("BI /W 2 /H 1 ID \x00EI\xff EI")
	})

	it("splices edits and copies everything else verbatim", () => {
		const source = bytes("q /Sh1 sh Q /P <</MCID 1 /Alt (x)>> BDC EMC")
		const operations = parseContent(source)
		const sh = operations[1]
		const bdc = operations[3]

		if (sh === undefined || bdc === undefined) throw new Error("missing")

		const out = spliceContent(source, [
			{ start: sh.start, end: sh.end },
			{
				start: bdc.start,
				end: bdc.end,
				replacement: writeOperation("BDC", [
					{ kind: "name", value: "P" },
					{ kind: "dict", entries: new Map([["MCID", { kind: "number", value: 1 }]]) }
				])
			}
		])

		expect(text(out)).toBe("q  Q  /P <</MCID 1>> BDC  EMC")
		expect(() => spliceContent(source, [sh, sh])).toThrow()
	})

	it("reads every string and name, escapes and hex decoded", () => {
		expect(contentStrings(bytes("/Na#6De (lit\\145ral) <48 65 78> [(in) (array)] BI /W 1 ID (no)EI")).map(text)).toEqual([
			"Name",
			"literal",
			"Hex",
			"in",
			"array"
		])
	})
})

describe("terms and presets", () => {
	it("matches literally, with case and whole-word options", () => {
		const term = (value: string, matchCase: boolean, wholeWord: boolean) => ({ text: value, matchCase, wholeWord })

		expect(matchTerm("Secret secret SECRETS", term("secret", false, false))).toHaveLength(3)
		expect(matchTerm("Secret secret SECRETS", term("secret", true, false))).toEqual([{ start: 7, end: 13 }])
		expect(matchTerm("Secret secret SECRETS", term("secret", false, true))).toHaveLength(2)
		expect(matchTerm("a.b a+b", term("a.b", false, false))).toEqual([{ start: 0, end: 3 }])
		expect(matchTerm("Straße STRASSE", term("straße", false, false))).toEqual([{ start: 0, end: 6 }])
		expect(matchTerm("x", term("", false, false))).toEqual([])
	})

	it("finds emails and phone numbers, not dates or short numbers", () => {
		const found = (value: string, preset: "emails" | "phoneNumbers") =>
			matchPreset(value, preset).map(match => value.slice(match.start, match.end))

		expect(found("mail bob.smith+x@mail.example.co.uk, or jo@x.io.", "emails")).toEqual(["bob.smith+x@mail.example.co.uk", "jo@x.io"])
		expect(found("Call +49 30 1234567 or (555) 010-7788; on 2026-11-14, ref 12345, 1.234.567,00", "phoneNumbers")).toEqual([
			"+49 30 1234567",
			"(555) 010-7788"
		])
	})

	it("verifies a term only while all its findings stay marked; preset hits count literally", () => {
		const finding = (id: string, source: RedactionFinding["source"], value = "x"): RedactionFinding => ({
			id,
			page: 0,
			text: value,
			quads: [],
			source
		})
		const terms = [
			{ text: "Secret", matchCase: false, wholeWord: false },
			{ text: "Other", matchCase: true, wholeWord: true }
		]
		const findings = [
			finding("0:0", { kind: "term", index: 0 }),
			finding("0:1", { kind: "term", index: 1 }),
			finding("0:2", { kind: "term", index: 1 }),
			finding("0:3", { kind: "preset", preset: "emails" }, "a@b.io"),
			finding("0:4", { kind: "preset", preset: "emails" }, "a@b.io")
		]

		expect(verifiedTerms(terms, findings, new Set(["0:0", "0:1", "0:3"]))).toEqual([
			terms[0],
			{ text: "a@b.io", matchCase: true, wholeWord: false }
		])
	})
})

describe("decoding", () => {
	it("decodes PDF text strings, UTF-8, XML references and every stream reading", () => {
		expect(pdfTextString(Uint8Array.of(0xfe, 0xff, 0, 0x53, 0, 0x65))).toBe("Se")
		expect(pdfTextString(Uint8Array.of(0xef, 0xbb, 0xbf, 0xc3, 0xa9))).toBe("é")
		expect(utf8Text(Uint8Array.of(0xc3, 0xa9, 0xff, 0xf4, 0x90, 0x80, 0x80))).toBe("é\xff\xf4\x90\x80\x80")
		expect(decodeXmlText("S&#101;cr&#x65;t &amp; &bogus;")).toBe("Secret & &bogus;")

		const utf16le = Uint8Array.of(0, ...Array.from("Hi", char => [char.charCodeAt(0), 0]).flat())

		expect([...streamReadings(utf16le)].some(reading => reading.includes("Hi"))).toBe(true)
	})

	// The string-at-a-time loops the decoders replaced, as the reference they must agree with.
	const reference = {
		utf16(bytes: Uint8Array, from: number, littleEndian: boolean): string {
			let out = ""

			for (let index = from; index + 1 < bytes.length; index += 2) {
				const high = bytes[index] ?? 0
				const low = bytes[index + 1] ?? 0

				out += String.fromCharCode(littleEndian ? low * 256 + high : high * 256 + low)
			}

			return out
		},
		utf8(bytes: Uint8Array): string {
			let out = ""
			let index = 0

			while (index < bytes.length) {
				const first = bytes[index] ?? 0
				let length =
					first < 0x80
						? 1
						: first >= 0xc2 && first < 0xe0
							? 2
							: first >= 0xe0 && first < 0xf0
								? 3
								: first >= 0xf0 && first < 0xf5
									? 4
									: 0
				let code = length === 1 ? first : length === 2 ? first & 0x1f : length === 3 ? first & 0x0f : first & 0x07

				for (let next = 1; next < length; next++) {
					const byte = bytes[index + next]

					if (byte === undefined || (byte & 0xc0) !== 0x80) {
						length = 0

						break
					}

					code = code * 64 + (byte & 0x3f)
				}

				if (length === 0 || code > 0x10ffff) {
					out += String.fromCharCode(first)
					index++
				} else {
					out += String.fromCodePoint(code)
					index += length
				}
			}

			return out
		},
		fold(text: string): string {
			let out = ""

			for (const char of text) {
				const lower = char.toLowerCase()

				out += lower.length === char.length ? lower : char
			}

			return out
		}
	}
	const mixed = "Größe ΟΔΟΣ ΣΑΣ İstanbul 𝐀𐐀😀 \u{10400}x ẞ ǅ"
	const encoder = new TextEncoder()

	it("decodes and folds exactly as the string-at-a-time loops did", () => {
		const utf8 = Uint8Array.of(...encoder.encode(mixed), 0xff, 0xc0, 0x80, 0xe2, 0x82, 0xf4, 0x90, 0x80, 0x80, 0xed, 0xa0, 0x80, 0x41)
		const random = Uint8Array.from({ length: 40_000 }, (_, index) => (index * 2_654_435_761) >>> 24)

		for (const bytes of [utf8, random, Uint8Array.of(), Uint8Array.of(0x41)]) {
			expect(utf8Text(bytes)).toBe(reference.utf8(bytes))

			const readings = [...streamReadings(bytes)]
			const expected = [bytes.reduce((out, byte) => out + String.fromCharCode(byte), ""), decodeXmlText(reference.utf8(bytes))]

			if (bytes.length >= 2) {
				expected.push(
					reference.utf16(bytes, 0, false),
					reference.utf16(bytes, 1, false),
					reference.utf16(bytes, 0, true),
					reference.utf16(bytes, 1, true)
				)
			}

			expect(readings).toEqual(expected)
		}

		for (const text of [mixed, "plain ascii", "ΣΑΣ", "İ", "", mixed.repeat(50)]) expect(foldCase(text)).toBe(reference.fold(text))
	})

	// The string-at-a-time loops took over 20 s for this (and gigabytes of heap); the bound leaves room for a busy machine.
	it("reads and folds a 16 MiB stream in every encoding quickly", { timeout: budget(30_000) }, () => {
		const bytes = new Uint8Array(16 * 1024 * 1024)

		for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 2_654_435_761) >>> 24

		const start = performance.now()
		let length = 0

		for (const reading of streamReadings(bytes)) length += foldCase(reading).length

		expect(length).toBeGreaterThan(16 * 1024 * 1024 * 3)
		expect(performance.now() - start).toBeLessThan(budget(4000))
	})

	it("folds a text only when a term ignores case", () => {
		const lower = vi.spyOn(String.prototype, "toLowerCase")

		try {
			expect(matchedTerm("Top Secret", [{ text: "Secret", matchCase: true, wholeWord: false }])?.text).toBe("Secret")
			expect(lower).not.toHaveBeenCalled()
			expect(matchedTerm("Top Secret", [{ text: "secret", matchCase: false, wholeWord: false }])?.text).toBe("secret")
			expect(lower).toHaveBeenCalled()
		} finally {
			lower.mockRestore()
		}
	})
})

describe("geometry", () => {
	it("tests quads against rectangles by their area", () => {
		const diamond = [10, 0, 20, 10, 0, 10, 10, 20] as const

		expect(quadOverlapsRect(diamond, [8, 8, 12, 12])).toBe(true)
		// Inside the diamond's bounding box but outside the diamond.
		expect(quadOverlapsRect(diamond, [0, 0, 3, 3])).toBe(false)
		expect(quadOverlapsRect([0, 0, 10, 0, 0, 10, 10, 10], [10, 0, 20, 10])).toBe(false)
	})

	it("crosses segments with rectangles", () => {
		expect(segmentCrossesRect(0, 5, 20, 5, [5, 0, 10, 10])).toBe(true)
		expect(segmentCrossesRect(0, 15, 20, 15, [5, 0, 10, 10])).toBe(false)
		expect(segmentCrossesRect(0, 10, 20, 10, [5, 0, 10, 10])).toBe(false)
	})

	it("takes a glyph's core, not its whole advance box", () => {
		const core = glyphCore([10, 0, 0, -10, 100, 200], 0.5, false)

		expect(core.map(value => Math.round(value * 100) / 100)).toEqual([100.75, 200, 104.25, 200, 100.75, 195, 104.25, 195])
	})

	it("visits the pixels a rectangle overlaps, with row 0 at the image's top", () => {
		const visited: string[] = []

		// A 4 × 2 image drawn at (0, 0) 40 × 20, row 0 at the top as MuPDF's image matrix puts it.
		forEachCoveredPixel([40, 0, 0, 20, 0, 0], 4, 2, [12, 0, 21, 10], (column, row) => {
			visited.push(`${String(column)},${String(row)}`)

			return true
		})

		expect(visited).toEqual(["1,0", "2,0"])

		visited.length = 0
		// Exactly on pixel edges: neighbours are not covered.
		forEachCoveredPixel([40, 0, 0, 20, 0, 0], 4, 2, [10, 10, 20, 20], (column, row) => {
			visited.push(`${String(column)},${String(row)}`)

			return true
		})

		expect(visited).toEqual(["1,1"])
	})
})

describe("covered words", () => {
	it("takes the words of covered runs, trimmed of edge punctuation, long enough to mean something", () => {
		const text = "Pay Mallory, (1,000,000) now."
		const covered = Array.from(text, (_, index) => index >= 4 && index < 28)

		expect(coveredWords(text, covered)).toEqual(["Mallory", "1,000,000"])
		expect(coveredWords("été rose", [true, true, true, true, true, true, true, true])).toEqual(["rose"])
	})

	it("keeps the longest words as whole-word, case-sensitive terms up to the limit", () => {
		const words = Array.from({ length: 1200 }, (_, index) => "w".repeat(4 + (index % 50)) + String(index))
		const terms = hiddenTerms([...words, words[0] ?? ""])

		expect(terms).toHaveLength(1000)
		expect(terms.every(term => term.matchCase && term.wholeWord)).toBe(true)
		expect(terms[0]?.text.length).toBeGreaterThanOrEqual(terms.at(-1)?.text.length ?? 0)
	})
})

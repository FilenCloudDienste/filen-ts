import { describe, expect, it } from "vitest"
import { matchPdfFont, pdfFontFamily, type PdfFontTraits } from "../../core/pdfedit/fontMatch"
import { layoutTextOverlay } from "../../core/pdfedit/textLayout"
import { nodeFontAssets } from "../sheetPdfFixtures"
import { budget } from "../timing"
import { pageChars, reopen } from "./textEditFixtures"

function traits(name: string, flags: Partial<PdfFontTraits> = {}): PdfFontTraits {
	return { name, bold: false, italic: false, serif: false, mono: false, ...flags }
}

describe("PDF font family names", () => {
	it.each([
		["ABCDEF+TimesNewRomanPS-BoldItalicMT", "Times New Roman"],
		["ArialMT", "Arial"],
		["Arial-BoldMT", "Arial"],
		["CourierNewPSMT", "Courier New"],
		["Calibri,Bold", "Calibri"],
		["Helvetica-Oblique", "Helvetica"],
		["Times-Roman", "Times"],
		["SegoeUI-Semibold", "Segoe UI"],
		["QWERTY+Georgia", "Georgia"],
		["MinionPro-Regular", "Minion"],
		["Times New Roman Bold Italic", "Times New Roman"]
	])("%s is %s", (name, family) => {
		expect(pdfFontFamily(name)).toBe(family)
	})
})

describe("matching a bundled font", () => {
	it.each([
		["ABCDEF+ArialMT", {}, { family: "arimo", substitute: false, bold: false, italic: false }],
		["Helvetica-BoldOblique", {}, { family: "arimo", substitute: false, bold: true, italic: true }],
		["Times-Roman", { serif: true }, { family: "tinos", substitute: false }],
		["TimesNewRomanPS-BoldMT", { serif: true }, { family: "tinos", substitute: false, bold: true }],
		["CourierNewPSMT", { mono: true }, { family: "cousine", substitute: false }],
		["Courier", { mono: true }, { family: "cousine", substitute: false }],
		["Georgia-Italic", { serif: true }, { family: "gelasio", substitute: false, italic: true }],
		["Calibri", {}, { family: "carlito", substitute: true }],
		["Cambria-Bold", {}, { family: "caladea", substitute: true, bold: true }],
		["SegoeUI-Semibold", {}, { family: "selawik", substitute: true, bold: true }],
		["ABCDEF+Garamond-Italic", { serif: true }, { family: "tinos", substitute: true, italic: true }],
		["MinionPro-Regular", {}, { family: "tinos", substitute: true }],
		["ABCDEF+Lato-Black", {}, { family: "arimo", substitute: true, bold: true }],
		["RobotoMono-Regular", {}, { family: "cousine", substitute: true }],
		["Consolas", { mono: true }, { family: "cousine", substitute: true }],
		["Unknown", {}, { family: "arimo", substitute: true }],
		["Unknown", { serif: true }, { family: "tinos", substitute: true }],
		["Unknown", { mono: true }, { family: "cousine", substitute: true }],
		["Unknown", { bold: true, italic: true }, { family: "arimo", bold: true, italic: true }]
	] as const)("%s with %o", (name, flags, expected) => {
		expect(matchPdfFont(traits(name, flags))).toMatchObject(expected)
	})

	it("names the family for the substitute notice", () => {
		expect(matchPdfFont(traits("Calibri"))).toMatchObject({ label: "Carlito", original: "Calibri" })
	})
})

describe("text overlay layout", () => {
	const font = matchPdfFont(traits("Helvetica"))

	it(
		"wraps at word boundaries to the frame's width and aligns right-to-left lines to its far edge",
		async () => {
			const overlay = await layoutTextOverlay({
				pageWidth: 400,
				pageHeight: 400,
				frame: { origin: [50, 100], direction: [1, 0], width: 120, lineHeight: 20 },
				style: { font, size: 12, color: 0 },
				text: "one two three four five six seven eight\nمرحبا",
				assets: nodeFontAssets
			})

			expect(overlay.lines).toBeGreaterThan(2)
			expect(overlay.width).toBeLessThanOrEqual(120)

			const document = reopen(overlay.bytes)
			const chars = pageChars(document, 0)
			const baselines = [...new Set(chars.map(char => Math.round(char.y)))]

			expect(baselines[0]).toBe(100)
			expect(baselines[1]).toBe(120)
			for (const char of chars) expect(char.quad[2]).toBeLessThanOrEqual(170.5)

			// Words stay whole: every line starts at the frame's start edge with a word's first letter.
			const starts = baselines.slice(0, -1).map(y => chars.filter(char => Math.round(char.y) === y)[0]?.c)

			expect(starts.every(c => c !== undefined && "otfse".includes(c))).toBe(true)

			const arabic = chars.filter(char => /\p{Script=Arabic}/u.test(char.c))
			// The same word alone gives the line's width. (Glyph boxes are no guide: the shaped run carries its text
			// as ActualText, which readers spread over the glyphs.)
			const solo = await layoutTextOverlay({
				pageWidth: 400,
				pageHeight: 400,
				frame: { origin: [50, 100], direction: [1, 0], width: 120, lineHeight: 20 },
				style: { font, size: 12, color: 0 },
				text: "مرحبا",
				assets: nodeFontAssets
			})

			expect(Math.min(...arabic.map(char => char.quad[0]))).toBeCloseTo(170 - solo.width, 1)
			document.destroy()
		},
		budget(30_000)
	)

	it(
		"keeps hard line breaks and draws a rotated baseline",
		async () => {
			const overlay = await layoutTextOverlay({
				pageWidth: 400,
				pageHeight: 400,
				frame: { origin: [200, 100], direction: [0, 1], width: null, lineHeight: 20 },
				style: { font, size: 10, color: 0xff0000 },
				text: "Down\nNext",
				assets: nodeFontAssets
			})
			const document = reopen(overlay.bytes)
			const chars = pageChars(document, 0)
			const d = chars.find(char => char.c === "D")
			const n = chars.find(char => char.c === "N")
			const o = chars.find(char => char.c === "o")

			expect(overlay.lines).toBe(2)
			expect(d?.x).toBeCloseTo(200, 0)
			expect(d?.y).toBeCloseTo(100, 0)
			// The text runs down the page; the next line is to its left (the baseline's normal).
			expect(o?.x).toBeCloseTo(200, 0)
			expect(o?.y ?? 0).toBeGreaterThan(105)
			expect(n?.x).toBeCloseTo(180, 0)
			expect(n?.y).toBeCloseTo(100, 0)
			expect(d?.color).toBe(0xff0000)
			document.destroy()
		},
		budget(30_000)
	)
})

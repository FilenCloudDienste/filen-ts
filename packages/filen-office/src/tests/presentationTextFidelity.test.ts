import { describe, expect, it } from "vitest"
import { rgba } from "../core/drawingml/index"
import type { ParaProps, Paragraph, RunProps, TextBody } from "../core/presentation/model"
import { layoutBody, type TextEnvironment } from "../core/presentation/text/body"
import { resolveBody, type BodyContext, type TextFonts } from "../core/presentation/text/resolve"
import { DECORATION_INTS, DecorationKind, LINE_FLOATS, LINE_INTS, MeasureCache } from "../core/text/index"
import { FakeMeasurer, testFont } from "./textFixtures"

const FONTS: TextFonts = {
	color: color =>
		color.kind === "srgb" ? rgba(color.rgb) : color.kind === "scheme" && color.slot === "hlink" ? rgba("0563C1") : rgba("000000"),
	typeface: typeface => (typeface.startsWith("+") ? "Calibri" : typeface)
}

const CONTEXT: BodyContext = { listStyles: [], bodyPr: [], fonts: FONTS }

function environment(): TextEnvironment {
	const font = testFont()

	return {
		fonts: { resolve: request => ({ ...font, weight: request.bold ? 700 : 400, italic: request.italic }) },
		cache: new MeasureCache(new FakeMeasurer())
	}
}

// 12 pt runs: 16 px with the fake font (most letters 8 px, hyphens and spaces 4 px).
const SMALL: RunProps = { sz: 1200 }
const LINK: RunProps = { sz: 1200, hlinkClick: { kind: "url", href: "https://example.org/abcd-efgh/abcd-efgh" } }

function lineTexts(paragraphs: Paragraph[], width: number): string[] {
	const text: TextBody = { bodyPr: {}, paragraphs }
	const page = layoutBody(resolveBody(text, CONTEXT), { width, height: 400 }, environment()).page.page
	const out: string[] = []

	for (let line = 0; line < page.lineCount; line++) {
		const source = page.sourceTexts[page.lineInts[line * LINE_INTS + 5] ?? 0] ?? ""

		out.push(source.slice(page.lineInts[line * LINE_INTS + 2] ?? 0, page.lineInts[line * LINE_INTS + 3] ?? 0))
	}

	return out
}

describe("presentation hyperlink text", () => {
	it("moves a hyperlinked run that does not fit the rest of the line to the next line whole", () => {
		const lines = lineTexts(
			[
				{
					pPr: {},
					runs: [
						{ kind: "r", text: "Read more at ", rPr: SMALL },
						{ kind: "r", text: "abcd-efgh/abcd-efgh", rPr: LINK }
					]
				}
			],
			200
		)

		expect(lines).toEqual(["Read more at ", "abcd-efgh/abcd-efgh"])
	})

	it("keeps adjacent runs of a hyperlink together as one", () => {
		const lines = lineTexts(
			[
				{
					pPr: {},
					runs: [
						{ kind: "r", text: "Read more at ", rPr: SMALL },
						{ kind: "r", text: "abcd-efgh/", rPr: LINK },
						{ kind: "r", text: "abcd-efgh", rPr: { ...LINK, b: true } }
					]
				}
			],
			200
		)

		expect(lines).toEqual(["Read more at ", "abcd-efgh/abcd-efgh"])
	})

	it("starts a hyperlinked sentence longer than a line on a new line and wraps it at its spaces, never inside a word", () => {
		const lines = lineTexts(
			[
				{
					pPr: {},
					runs: [
						{ kind: "r", text: "See ", rPr: SMALL },
						{ kind: "r", text: "the full guidance on the government website", rPr: LINK }
					]
				}
			],
			200
		)

		expect(lines).toEqual(["See ", "the full guidance on the ", "government website"])
	})

	it("moves a multi-word hyperlink that fits a line to the next line whole", () => {
		const lines = lineTexts(
			[
				{
					pPr: {},
					runs: [
						{ kind: "r", text: "Read more in the ", rPr: SMALL },
						{ kind: "r", text: "full guidance here", rPr: LINK }
					]
				}
			],
			200
		)

		expect(lines).toEqual(["Read more in the ", "full guidance here"])
	})

	it("starts adjacent linked runs longer than a line on a new line, wrapping at their spaces with each space-free stretch whole", () => {
		const lines = lineTexts(
			[
				{
					pPr: {},
					runs: [
						{ kind: "r", text: "Read more at ", rPr: SMALL },
						{ kind: "r", text: "the site and more abcd-", rPr: LINK },
						{ kind: "r", text: "efgh/abcd-efgh", rPr: { ...LINK, b: true } }
					]
				}
			],
			200
		)

		expect(lines).toEqual(["Read more at ", "the site and more ", "abcd-efgh/abcd-efgh"])
	})

	// LibreOffice 7.5 moves a link longer than a whole line to a new line before wrapping it, leaving the line before
	// short (oracle renders of govuk__HWBoard_standard_slide_set.pptx and govuk__CCG_standard_slide_set.pptx slide 2,
	// "Public Health England supports" / "a new programme of work on tackling high blood pressure").
	it("leaves the line before a hyperlink longer than a whole line short, as LibreOffice does, costing a line over plain text", () => {
		const plain = lineTexts([paragraph("Read this: the full guidance on the government website about it")], 200)
		const linked = lineTexts(
			[
				{
					pPr: {},
					runs: [
						{ kind: "r", text: "Read this: ", rPr: SMALL },
						{ kind: "r", text: "the full guidance on the government website about it", rPr: LINK }
					]
				}
			],
			200
		)

		expect(plain).toEqual(["Read this: the full guidance ", "on the government website ", "about it"])
		expect(linked).toEqual(["Read this: ", "the full guidance on the ", "government website about ", "it"])
	})

	it("breaks a hyperlinked run longer than the line at the character that overflows, not at its hyphens", () => {
		const link = "aaaaaaaaaa-aaaaaaaaaa-aaaaaaaaaa"
		const lines = lineTexts(
			[
				{
					pPr: {},
					runs: [
						{ kind: "r", text: "x ", rPr: SMALL },
						{ kind: "r", text: link, rPr: LINK }
					]
				}
			],
			200
		)

		expect(lines).toEqual(["x ", "aaaaaaaaaa-aaaaaaaaaa-aaaa", "aaaaaa"])
	})

	it("still breaks plain text at its hyphens", () => {
		const lines = lineTexts([paragraph("Read more at abcd-efgh/abcd-efgh")], 200)

		expect(lines[0]).toBe("Read more at abcd-efgh/")
	})

	it("keeps a bullet on the line of the hyperlink that starts its paragraph", () => {
		const lines = lineTexts(
			[
				{
					pPr: { marL: 342900, indent: -342900, bullet: { kind: "char", char: "•" } },
					runs: [{ kind: "r", text: "aaaaaaaaaa-aaaaaaaaaa-aaaaaaaaaa", rPr: LINK }]
				}
			],
			200
		)

		expect(lines[0]?.startsWith("•\taaaa")).toBe(true)
	})

	it("draws the bullet of a hyperlinked paragraph without the link's colour and underline", () => {
		const text: TextBody = {
			bodyPr: {},
			paragraphs: [
				{
					pPr: { marL: 342900, indent: -342900, bullet: { kind: "char", char: "•" } },
					runs: [{ kind: "r", text: "here", rPr: LINK }]
				}
			]
		}
		const page = layoutBody(resolveBody(text, CONTEXT), { width: 400, height: 100 }, environment()).page
		const first = page.page.fragmentInts[2] ?? -1

		expect(page.styles[first]?.color).toBe("000000")
		expect(
			Array.from({ length: page.page.decorationCount }, (_, d) => page.page.decorationFloats[d * 4] ?? 0).every(x => x >= 36)
		).toBe(true)
	})

	it("underlines hyperlinked text even where its list style says u=none", () => {
		const text: TextBody = { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "here", rPr: { ...LINK, u: "none" } }] }] }
		const page = layoutBody(resolveBody(text, CONTEXT), { width: 400, height: 100 }, environment()).page.page
		const kinds = Array.from({ length: page.decorationCount }, (_, d) => page.decorationInts[d * DECORATION_INTS])

		expect(kinds).toContain(DecorationKind.UNDERLINE)
	})
})

function paragraph(text: string): Paragraph {
	return { pPr: {}, runs: [{ kind: "r", text, rPr: SMALL }] }
}

describe("presentation paragraph indents", () => {
	it("starts a first line whose hanging indent reaches past the left edge at the edge, as LibreOffice does", () => {
		const text: TextBody = {
			bodyPr: {},
			paragraphs: [{ pPr: { marL: 0, indent: -342900 }, runs: [{ kind: "r", text: "word ".repeat(20), rPr: SMALL }] }]
		}
		const page = layoutBody(resolveBody(text, CONTEXT), { width: 200, height: 400 }, environment()).page.page
		const xs = Array.from({ length: page.lineCount }, (_, line) => page.lineFloats[line * LINE_FLOATS + 3])

		expect(xs.length).toBeGreaterThan(1)
		expect(xs.every(x => x === 0)).toBe(true)
	})

	it("keeps a hanging indent that stays inside the box", () => {
		const text: TextBody = {
			bodyPr: {},
			paragraphs: [{ pPr: { marL: 342900, indent: -228600 }, runs: [{ kind: "r", text: "word ".repeat(20), rPr: SMALL }] }]
		}
		const page = layoutBody(resolveBody(text, CONTEXT), { width: 200, height: 400 }, environment()).page.page

		expect(page.lineFloats[3]).toBeCloseTo(12, 5)
		expect(page.lineFloats[LINE_FLOATS + 3]).toBeCloseTo(36, 5)
	})
})

describe("font-dependent line spacing", () => {
	// The test face: ascent 0.8, descent 0.2 and no line gap, so its own line is 1.0 of the size against the
	// font-independent 1.2.
	function baselines(fontIndependent: boolean | undefined): number[] {
		const pPr: ParaProps & { readonly fontIndependentLineSpacing?: boolean } =
			fontIndependent === undefined ? {} : { fontIndependentLineSpacing: fontIndependent }
		const text: TextBody = {
			bodyPr: {},
			paragraphs: [0, 1, 2].map(() => ({ pPr, runs: [{ kind: "r" as const, text: "line", rPr: SMALL }] }))
		}
		const page = layoutBody(resolveBody(text, CONTEXT), { width: 400, height: 400 }, environment()).page.page

		return Array.from({ length: page.lineCount }, (_, line) => page.lineFloats[line * LINE_FLOATS + 2] ?? 0)
	}

	it("spaces lines by the face's ascent and descent where ODF turns font-independent line spacing off", () => {
		const own = baselines(false)

		expect(own[0]).toBeCloseTo(12.8, 4)
		expect((own[2] ?? 0) - (own[1] ?? 0)).toBeCloseTo(16, 4)
	})

	it("keeps the font-independent single line of 1.2 times the size otherwise", () => {
		for (const lines of [baselines(undefined), baselines(true)]) {
			expect(lines[0]).toBeCloseTo(16, 4)
			expect((lines[2] ?? 0) - (lines[1] ?? 0)).toBeCloseTo(19.2, 4)
		}
	})
})

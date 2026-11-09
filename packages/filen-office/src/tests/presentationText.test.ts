import { describe, expect, it } from "vitest"
import { rgba } from "../core/drawingml/index"
import { forEachDrawingSlotRun, type DrawingSlot } from "../core/fonts/drawingSlots"
import { PresentationError, type ListStyle, type Paragraph, type RunProps, type TextBody } from "../core/presentation/model"
import { AUTONUMBER_SCHEMES, AutonumberCounters, autonumberText } from "../core/presentation/text/autonum"
import { MAX_BODY_RUNS, fontRequests, layoutBody, type TextEnvironment } from "../core/presentation/text/body"
import { fieldText } from "../core/presentation/text/fields"
import { toDocxPdfPage } from "../core/presentation/text/page"
import { DEFAULT_BODY_PR, resolveBodyPr } from "../core/presentation/inherit"
import { resolveBody, type BodyContext, type TextFonts } from "../core/presentation/text/resolve"
import { LINK_INTS } from "../core/docx/layout/index"
import {
	DECORATION_INTS,
	DecorationKind,
	FRAGMENT_FLOATS,
	FRAGMENT_INTS,
	FragmentFlag,
	LINE_FLOATS,
	LINE_INTS,
	LayoutCursor,
	LineRule,
	MeasureCache
} from "../core/text/index"
import { FakeMeasurer, GEOMETRY, harness, lines, testFont } from "./textFixtures"

const SCHEME: Readonly<Record<string, string>> = {
	tx1: "000000",
	bg1: "FFFFFF",
	dk1: "000000",
	lt1: "FFFFFF",
	accent1: "4472C4",
	accent2: "ED7D31",
	hlink: "0563C1",
	folHlink: "954F72"
}

// A theme binding as the host makes one: srgb and scheme colours with alpha, +mj/+mn typefaces.
const FONTS: TextFonts = {
	color: color => {
		const hex = color.kind === "srgb" ? color.rgb : color.kind === "scheme" ? SCHEME[color.slot] : undefined
		const alpha = color.mods?.find(mod => mod.name === "alpha")?.value

		return hex === undefined ? undefined : rgba(hex, alpha === undefined ? 1 : alpha / 100000)
	},
	typeface: typeface =>
		typeface === "+mj-lt" ? "Calibri Light" : typeface === "+mn-lt" ? "Calibri" : typeface.startsWith("+") ? undefined : typeface
}

function environment(): TextEnvironment & { requests: string[] } {
	const requests: string[] = []
	const font = testFont()

	return {
		requests,
		fonts: {
			resolve: request => {
				requests.push(`${request.family}|${request.slot}`)

				return { ...font, weight: request.bold ? 700 : 400, italic: request.italic }
			}
		},
		cache: new MeasureCache(new FakeMeasurer())
	}
}

const CONTEXT: BodyContext = { listStyles: [], bodyPr: [], fonts: FONTS }

function paragraph(text: string, rPr: RunProps = {}, pPr: Paragraph["pPr"] = {}): Paragraph {
	return { pPr, runs: [{ kind: "r", text, rPr }] }
}

function body(paragraphs: Paragraph[], bodyPr: TextBody["bodyPr"] = {}, lstStyle?: ListStyle): TextBody {
	return { bodyPr, paragraphs, ...(lstStyle === undefined ? {} : { lstStyle }) }
}

// 12 pt runs: 16 px with the fake font (advances in em per character, 1 em lines).
const SMALL: RunProps = { sz: 1200 }

function laidOut(text: TextBody, box = { width: 400, height: 300 }, context: BodyContext = CONTEXT) {
	const env = environment()

	return { result: layoutBody(resolveBody(text, context), box, env), env }
}

function pageLines(result: ReturnType<typeof laidOut>["result"]): { text: string; top: number; x: number; baseline: number }[] {
	const page = result.page.page
	const out: { text: string; top: number; x: number; baseline: number }[] = []

	for (let line = 0; line < page.lineCount; line++) {
		const source = page.lineInts[line * LINE_INTS + 5] ?? 0
		const text = page.sourceTexts[source] ?? ""

		out.push({
			text: text.slice(page.lineInts[line * LINE_INTS + 2] ?? 0, page.lineInts[line * LINE_INTS + 3] ?? 0),
			top: Math.round((page.lineFloats[line * LINE_FLOATS] ?? 0) * 100) / 100,
			x: Math.round((page.lineFloats[line * LINE_FLOATS + 3] ?? 0) * 100) / 100,
			baseline: Math.round((page.lineFloats[line * LINE_FLOATS + 2] ?? 0) * 100) / 100
		})
	}

	return out
}

// Each fragment's text and info word, in page order.
function fragmentFlags(result: ReturnType<typeof laidOut>["result"]): [string, number][] {
	const page = result.page.page
	const out: [string, number][] = []

	for (let line = 0; line < page.lineCount; line++) {
		const text = page.sourceTexts[page.lineInts[line * LINE_INTS + 5] ?? 0] ?? ""
		const first = page.lineInts[line * LINE_INTS] ?? 0
		const count = page.lineInts[line * LINE_INTS + 1] ?? 0

		for (let k = first; k < first + count; k++) {
			const at = k * FRAGMENT_INTS

			out.push([text.slice(page.fragmentInts[at] ?? 0, page.fragmentInts[at + 1] ?? 0), page.fragmentInts[at + 3] ?? 0])
		}
	}

	return out
}

describe("presentation text layout", () => {
	it("paints a condensed original's substitute at the horizontal scale it was laid out with", () => {
		const env = environment()
		const narrow = testFont(2, "fo-narrow", 1, 0.5)
		const result = layoutBody(
			resolveBody(body([paragraph("aaa", { ...SMALL, spc: 300 })]), CONTEXT),
			{ width: 400, height: 300 },
			{
				...env,
				fonts: { resolve: request => ({ ...narrow, weight: request.bold ? 700 : 400, italic: request.italic }) }
			}
		)
		const id = result.page.styles.findIndex(s => s.letterSpacing !== 0)

		expect(result.page.styles[id]).toMatchObject({ scaleX: 0.5, letterSpacing: (3 * 96) / 72 / 0.5 })
		expect(result.styles.scaleX[id]).toBe(0.5)
		expect(result.styles.letterSpacing[id]).toBeCloseTo((3 * 96) / 72 / 0.5, 9)
	})

	it("lays out paragraphs into a complete page the docx painters read", () => {
		const { result } = laidOut(body([paragraph("Hello world", SMALL), paragraph("Second", SMALL)]))
		const page = result.page.page

		expect(page.width).toBe(400)
		expect(page.height).toBe(300)
		expect(page.lineCount).toBe(2)
		expect(page.sourceCount).toBe(2)
		expect(page.sourceTexts).toEqual(["Hello world", "Second"])
		expect(page.graphicCount).toBe(0)
		expect(page.objectCount).toBe(0)
		expect(page.lineFloats.length).toBe(2 * LINE_FLOATS)
		expect(result.page.styles.length).toBeGreaterThan(0)
		expect(result.overflow).toBe(false)

		// Every field the PDF painter reads is there.
		const pdf = toDocxPdfPage(result.page)

		expect(pdf.roles).toHaveLength(2)
		expect(pdf.clipCount).toBe(0)
		expect(pdf.lineInts).toBe(page.lineInts)
	})

	it("wraps at the box width and reports the height spAutoFit grows to", () => {
		const { result } = laidOut(body([paragraph("aaaa bbbb cccc dddd eeee", SMALL)]), { width: 60, height: 10 })

		expect(result.page.page.lineCount).toBeGreaterThan(1)
		expect(result.overflow).toBe(true)
		expect(result.height).toBeGreaterThan(10)
	})

	it("draws a bullet at the indent with the text at marL, and none on an empty paragraph", () => {
		const pPr = { marL: 342900, indent: -342900, bullet: { kind: "char" as const, char: "•" } }
		const { result } = laidOut(body([paragraph("Item", SMALL, pPr), { pPr, runs: [] }]))
		const view = pageLines(result)

		expect(view[0]?.text).toBe("•\tItem")
		expect(result.prefixes[0]).toBe(2)
		expect(result.prefixes[1]).toBe(0)

		const fragments = lines(result.layout, result.page.page.sourceTexts[0] ?? "")[0]?.fragments ?? []

		// The text fragment starts at marL (36 px).
		expect(fragments.at(-1)?.x).toBe(36)
	})

	it("starts the text right after a bullet that leaves no room before marL, as LibreOffice does", () => {
		const flush = { marL: 0, indent: 0, bullet: { kind: "char" as const, char: "•" } }
		const { result } = laidOut(body([paragraph("Item", SMALL, flush)]))
		const fragments = lines(result.layout, result.page.page.sourceTexts[0] ?? "")[0]?.fragments ?? []

		expect(pageLines(result)[0]?.text).toBe("•Item")
		expect(result.prefixes[0]).toBe(1)
		// The bullet is half an em (8 px) wide: no tab to the next default stop.
		expect(fragments.at(-1)?.x).toBe(8)

		// A hanging indent narrower than the bullet: the same.
		const narrow = laidOut(body([paragraph("Item", SMALL, { ...flush, marL: 4 * 9525, indent: -4 * 9525 })])).result

		expect(lines(narrow.layout, narrow.page.page.sourceTexts[0] ?? "")[0]?.fragments.at(-1)?.x).toBe(8)
	})

	it("numbers paragraphs per level, restarting after a shallower or unnumbered paragraph", () => {
		const numbered = (level: number): Paragraph["pPr"] => ({
			lvl: level,
			marL: 342900,
			indent: -342900,
			bullet: { kind: "autoNum", scheme: level === 0 ? "arabicPeriod" : "alphaLcParenR" }
		})
		const { result } = laidOut(
			body([
				paragraph("a", SMALL, numbered(0)),
				paragraph("b", SMALL, numbered(1)),
				paragraph("c", SMALL, numbered(1)),
				paragraph("d", SMALL, numbered(0)),
				paragraph("e", SMALL, numbered(1)),
				paragraph("plain", SMALL, { bullet: { kind: "none" } }),
				paragraph("f", SMALL, numbered(0))
			])
		)
		const texts = result.page.page.sourceTexts.map(text => text.split("\t")[0])

		expect(texts).toEqual(["1.", "a)", "b)", "2.", "a)", "plain", "1."])
	})

	it("formats every autonumber scheme", () => {
		expect(AUTONUMBER_SCHEMES).toHaveLength(41)

		const expected: Readonly<Record<string, string>> = {
			alphaLcParenBoth: "(c)",
			alphaUcPeriod: "C.",
			arabicParenR: "3)",
			arabicPlain: "3",
			romanUcPeriod: "III.",
			romanLcParenBoth: "(iii)",
			circleNumDbPlain: "③",
			circleNumWdBlackPlain: "➌",
			circleNumWdWhitePlain: "➂",
			arabicDbPeriod: "３．",
			ea1ChsPeriod: "三.",
			ea1JpnChsDbPeriod: "三．",
			thaiNumPeriod: "๓.",
			hindiNumParenR: "३)",
			hebrew2Minus: "ג-"
		}

		for (const [scheme, text] of Object.entries(expected)) expect(autonumberText(scheme, 3)).toBe(text)
		for (const scheme of AUTONUMBER_SCHEMES) expect(autonumberText(scheme, 27).length).toBeGreaterThan(0)

		expect(autonumberText("alphaLcPeriod", 27)).toBe("aa.")
		expect(autonumberText("romanUcPeriod", 1994)).toBe("MCMXCIV.")
		expect(autonumberText("ea1ChsPlain", 21)).toBe("二十一")
		expect(autonumberText("hebrew2Minus", 15)).toBe("טו-")
		expect(autonumberText("unknownScheme", 4)).toBe("4.")

		const counters = new AutonumberCounters()

		expect(counters.next(0, "arabicPeriod", 5)).toBe(5)
		expect(counters.next(0, "arabicPeriod", 5)).toBe(6)
		counters.skip(1)
		expect(counters.next(0, "arabicPeriod", 5)).toBe(7)
	})

	it("applies every normAutofit pair the corpus stores, exactly", () => {
		// (fontScale, lnSpcReduction) as the frozen corpus writes them, with how often.
		const pairs: readonly (readonly [number, number])[] = [
			[1, 0],
			[0.9, 0],
			[0.925, 0.1],
			[1, 0.1],
			[1, 0.09999],
			[0.85, 0.2],
			[0.925, 0.2],
			[0.85, 0.1],
			[0.775, 0.2],
			[0.7, 0.2],
			[0.975, 0],
			[0.85, 0.09999],
			[0.25, 0.2],
			[0.475, 0.2],
			[0.975, 0.1],
			[0.9, 0.2],
			[0.625, 0.2]
		]

		for (const [fontScale, lineSpacingReduction] of pairs) {
			const { result } = laidOut(
				body([paragraph("One", { sz: 2400 }), paragraph("Two", { sz: 2400 })], {
					autofit: "normal",
					fontScale,
					lineSpacingReduction
				})
			)
			const view = pageLines(result)
			const size = ((24 * 96) / 72) * fontScale
			// Single spacing is 1.2 times the size, less the reduction.
			const pitch = size * 1.2 * (1 - lineSpacingReduction)

			expect(result.styles.em[result.layout.fragmentInts[2] ?? -1]).toBeCloseTo(size, 6)
			expect((view[1]?.top ?? 0) - (view[0]?.top ?? 0)).toBeCloseTo(pitch, 2)
			// The baseline at the size, or at four fifths of a reduced line.
			expect((view[0]?.baseline ?? 0) - (view[0]?.top ?? 0)).toBeCloseTo(
				lineSpacingReduction > 0 ? Math.min(size, pitch * 0.8) : size,
				2
			)
		}
	})

	it("flows into the next column when a column is full", () => {
		const paragraphs = Array.from({ length: 6 }, (_, k) => paragraph(`line ${k}`, SMALL))
		const { result } = laidOut(body(paragraphs, { columns: 2, columnSpacing: 20 }), { width: 220, height: 50 })
		const view = pageLines(result)
		const second = view.filter(line => line.x >= 120)

		expect(second.length).toBeGreaterThan(0)
		expect(second[0]?.top).toBe(0)
	})

	it("anchors the text block at the middle and the bottom", () => {
		const middle = pageLines(laidOut(body([paragraph("x", SMALL)], { anchor: "ctr" }), { width: 100, height: 100 }).result)
		const bottom = pageLines(laidOut(body([paragraph("x", SMALL)], { anchor: "b" }), { width: 100, height: 100 }).result)

		// One 12 pt line is 1.2 × 16 px high.
		expect(middle[0]?.top).toBeCloseTo((100 - 19.2) / 2, 3)
		expect(bottom[0]?.top).toBeCloseTo(100 - 19.2, 3)
	})

	it("keeps an unwrapped line whole and centres it on the box", () => {
		const view = pageLines(
			laidOut(body([paragraph("a very long unwrapped line", SMALL, { algn: "ctr" })], { wrap: false }), { width: 40, height: 40 })
				.result
		)

		expect(view).toHaveLength(1)
		expect((view[0]?.x ?? 0) < 0).toBe(true)
	})

	it("places an unwrapped right-to-left line inside the box by its physical algn", () => {
		// "abc" with the fake font is 24 px wide in a 200 px box.
		const at = (pPr: Paragraph["pPr"]) =>
			pageLines(
				laidOut(body([paragraph("abc", SMALL, { rtl: true, ...pPr })], { wrap: false }), { width: 200, height: 40 }).result
			)[0]?.x

		expect(at({})).toBeCloseTo(0, 3)
		expect(at({ algn: "l" })).toBeCloseTo(0, 3)
		expect(at({ algn: "ctr" })).toBeCloseTo(88, 3)
		expect(at({ algn: "r" })).toBeCloseTo(176, 3)

		// The justify family leaves a single line at its start edge, the right one, less marL as when wrapped.
		for (const algn of ["just", "justLow", "dist", "thaiDist"] as const) expect(at({ algn })).toBeCloseTo(176, 3)

		expect(at({ algn: "just", marL: 12 * 9525 })).toBeCloseTo(164, 3)

		// Left-to-right lines keep their positions.
		const ltr = (pPr: Paragraph["pPr"]) =>
			pageLines(laidOut(body([paragraph("abc", SMALL, pPr)], { wrap: false }), { width: 200, height: 40 }).result)[0]?.x

		expect(ltr({})).toBeCloseTo(0, 3)
		expect(ltr({ algn: "just", marL: 12 * 9525 })).toBeCloseTo(12, 3)
		expect(ltr({ algn: "r" })).toBeCloseTo(176, 3)
	})

	it("turns vert270 text and stacks WordArt vertical text upright, one character per line", () => {
		// The renderer hands turned text its box turned (textBox): the page is that box.
		const turned = laidOut(body([paragraph("ab cd ef", SMALL)], { vertical: "vert270" }), { width: 200, height: 50 }).result

		expect(turned.turn).toBe(270)
		expect(pageLines(turned).map(line => line.text)).toEqual(["ab cd ef"])
		expect(turned.page.page.width).toBe(200)
		expect(turned.page.page.height).toBe(50)

		const stacked = laidOut(body([paragraph("日本", SMALL)], { vertical: "wordArtVertRtl" }), { width: 50, height: 200 }).result
		const view = pageLines(stacked)

		expect(stacked.turn).toBe(0)
		expect(stacked.page.page.width).toBe(50)
		expect(view.map(line => line.text)).toEqual(["日", "本"])
		expect((view[1]?.top ?? 0) - (view[0]?.top ?? 0)).toBeCloseTo(16, 3)
	})

	it("runs WordArt vertical columns from the left edge and right-to-left WordArt from the right edge", () => {
		const column = (vertical: "wordArtVert" | "wordArtVertRtl") =>
			pageLines(laidOut(body([paragraph("a", SMALL), paragraph("b", SMALL)], { vertical }), { width: 100, height: 200 }).result).map(
				line => line.x
			)
		const leftToRight = column("wordArtVert")
		const rightToLeft = column("wordArtVertRtl")

		expect((leftToRight[0] ?? 0) < (leftToRight[1] ?? 0)).toBe(true)
		expect((rightToLeft[0] ?? 0) > (rightToLeft[1] ?? 0)).toBe(true)
	})

	it("turns eaVert Latin text sideways and wraps it across the turned box, as vert does", () => {
		const text = body([paragraph("ab cd ef gh", SMALL)], { vertical: "eaVert" })
		const sideways = laidOut(text, { width: 60, height: 50 }).result
		const vert = laidOut({ ...text, bodyPr: { vertical: "vert" } }, { width: 60, height: 50 }).result
		const view = pageLines(sideways)

		expect(sideways.turn).toBe(90)
		expect(sideways.page.page.width).toBe(60)
		expect(sideways.page.page.height).toBe(50)
		expect(view.length).toBeGreaterThan(1)
		expect(view.map(line => line.text.trim())).toEqual(["ab cd ef", "gh"])
		expect(view).toEqual(pageLines(vert))
		expect(fragmentFlags(sideways).every(([, info]) => (info & FragmentFlag.UPRIGHT) === 0)).toBe(true)
	})

	it("keeps East Asian characters of eaVert text upright, one cluster per fragment, and Latin ones sideways", () => {
		const { result } = laidOut(body([paragraph("ab日本", SMALL)], { vertical: "eaVert" }), { width: 400, height: 50 })
		const fragments = fragmentFlags(result).map(([text, info]) => [text, (info & FragmentFlag.UPRIGHT) !== 0])

		expect(result.turn).toBe(90)
		expect(fragments).toEqual([
			["ab", false],
			["日", true],
			["本", true]
		])

		const page = result.page.page
		const x = (k: number) => page.fragmentFloats[k * FRAGMENT_FLOATS] ?? 0
		const width = (k: number) => page.fragmentFloats[k * FRAGMENT_FLOATS + 1] ?? 0

		// a and b are half an em each, 日 and 本 one em (16 px): the upright cells follow on without gaps.
		expect([x(0), width(0), x(1), width(1), x(2), width(2)]).toEqual([0, 16, 16, 16, 32, 16])
		expect(result.layout.fragmentCount).toBe(3)
	})

	it("draws East Asian brackets and the long vowel mark of eaVert text sideways, as their vertical forms are", () => {
		const { result } = laidOut(body([paragraph("「日ー」", SMALL)], { vertical: "eaVert" }), { width: 400, height: 50 })
		const fragments = fragmentFlags(result).map(([text, info]) => [text, (info & FragmentFlag.UPRIGHT) !== 0])

		expect(fragments).toEqual([
			["「", false],
			["日", true],
			["ー」", false]
		])
	})

	it("runs mongolianVert lines left to right: the first line at the turned page's bottom", () => {
		const { result } = laidOut(body([paragraph("a", SMALL), paragraph("b", SMALL)], { vertical: "mongolianVert" }), {
			width: 200,
			height: 100
		})
		const view = pageLines(result)
		const ea = pageLines(
			laidOut(body([paragraph("a", SMALL), paragraph("b", SMALL)], { vertical: "eaVert" }), { width: 200, height: 100 }).result
		)

		expect(result.turn).toBe(90)
		expect((view[0]?.top ?? 0) > (view[1]?.top ?? 0)).toBe(true)
		// Mirrored across the page: each line sits as far from the bottom as eaVert's from the top.
		expect(view[0]?.top).toBeCloseTo(100 - (ea[0]?.top ?? 0) - ((ea[1]?.top ?? 0) - (ea[0]?.top ?? 0)), 3)
		expect((ea[0]?.top ?? 0) < (ea[1]?.top ?? 0)).toBe(true)
	})

	it("keeps a bullet larger than the text out of the line's height, as LibreOffice draws it", () => {
		const first = (pPr: Paragraph["pPr"]) => pageLines(laidOut(body([paragraph("text", SMALL, pPr), paragraph("next", SMALL)])).result)
		const plain = first({ bullet: { kind: "char", char: "•" } })
		const large = first({ bullet: { kind: "char", char: "•" }, buSz: { pct: 200000 } })

		expect(large.map(line => [line.top, line.baseline])).toEqual(plain.map(line => [line.top, line.baseline]))
	})

	it("keeps an empty first paragraph's line at single spacing, its proportional spacing unapplied, as LibreOffice does", () => {
		const half: Paragraph["pPr"] = { lnSpc: { pct: 50000 } }
		const empty = pageLines(laidOut(body([{ pPr: half, runs: [], endRPr: SMALL }, paragraph("x", SMALL, half)])).result)
		const full = pageLines(laidOut(body([paragraph("y", SMALL, half), paragraph("x", SMALL, half)])).result)

		// Single is 1.2 × 16 px; half of it is 9.6 px.
		expect(empty[1]?.top).toBeCloseTo(19.2, 3)
		expect(full[1]?.top).toBeCloseTo(9.6, 3)
		// A later empty paragraph keeps its spacing.
		const later = pageLines(
			laidOut(body([paragraph("y", SMALL, half), { pPr: half, runs: [], endRPr: SMALL }, paragraph("x", SMALL, half)])).result
		)

		expect(later[2]?.top).toBeCloseTo(19.2, 3)
	})

	it("lays a table cell's lines out at the face's own height, not the font-independent single line", () => {
		const text = body([paragraph("a", SMALL), paragraph("b", SMALL)])
		const env = environment()
		const cell = layoutBody(resolveBody(text, CONTEXT), { width: 400, height: 300 }, env, { lineMetrics: "face" })
		const lines = pageLines({ ...cell })

		// The fake face: ascent 0.8 em and descent 0.2 em, so a 16 px line with its baseline at 12.8.
		expect(lines.map(line => [line.top, line.baseline])).toEqual([
			[0, 12.8],
			[16, 28.8]
		])
	})

	it("takes percentage space before from the largest text on the paragraph's first line", () => {
		const second = (pPr: Paragraph["pPr"], runs: Paragraph["runs"]): number => {
			const view = pageLines(laidOut(body([paragraph("x", SMALL), { pPr, runs }])).result)

			return view[1]?.top ?? 0
		}
		const mixed: Paragraph["runs"] = [
			{ kind: "r", text: "a", rPr: SMALL },
			{ kind: "r", text: "b", rPr: { sz: 2400 } }
		]
		const later: Paragraph["runs"] = [
			{ kind: "r", text: "a", rPr: SMALL },
			{ kind: "br", rPr: SMALL },
			{ kind: "r", text: "b", rPr: { sz: 2400 } }
		]

		// 24 pt is 32 px: 100% of it, not of the 12 pt first run.
		expect(second({ spcBef: { pct: 100000 } }, mixed) - second({}, mixed)).toBeCloseTo(32, 3)
		// The larger run on a later line does not count.
		expect(second({ spcBef: { pct: 100000 } }, later) - second({}, later)).toBeCloseTo(16, 3)
	})

	it("takes percentage space after from the largest text on the paragraph's last line", () => {
		const next = (pPr: Paragraph["pPr"], runs: Paragraph["runs"]): number => {
			const view = pageLines(laidOut(body([{ pPr, runs }, paragraph("x", SMALL)])).result)

			return view[view.length - 1]?.top ?? 0
		}
		const later: Paragraph["runs"] = [
			{ kind: "r", text: "b", rPr: { sz: 2400 } },
			{ kind: "br", rPr: SMALL },
			{ kind: "r", text: "a", rPr: SMALL }
		]
		const mixed: Paragraph["runs"] = [
			{ kind: "r", text: "a", rPr: SMALL },
			{ kind: "br", rPr: SMALL },
			{ kind: "r", text: "a", rPr: SMALL },
			{ kind: "r", text: "b", rPr: { sz: 2400 } }
		]

		expect(next({ spcAft: { pct: 100000 } }, later) - next({}, later)).toBeCloseTo(16, 3)
		expect(next({ spcAft: { pct: 100000 } }, mixed) - next({}, mixed)).toBeCloseTo(32, 3)
	})

	it("carries gradient fills, outlines, effects and alpha in the page tables", () => {
		const rPr: RunProps = {
			sz: 1200,
			fill: {
				kind: "gradient",
				stops: [
					{ pos: 0, color: { kind: "scheme", slot: "accent1" } },
					{ pos: 100000, color: { kind: "scheme", slot: "accent2" } }
				],
				linear: { angle: 5400000, scaled: false }
			},
			ln: { w: 12700, fill: { kind: "solid", color: { kind: "srgb", rgb: "FF0000" } } },
			effects: {
				effects: [{ kind: "glow", color: { kind: "srgb", rgb: "FFC000", mods: [{ name: "alpha", value: 60000 }] }, rad: 38100 }]
			}
		}
		const translucent: RunProps = {
			sz: 1200,
			fill: { kind: "solid", color: { kind: "srgb", rgb: "00FF00", mods: [{ name: "alpha", value: 50000 }] } }
		}
		const { result } = laidOut(body([paragraph("Title", rPr), paragraph("Half", translucent)]))
		const page = result.page
		const styled = page.styles.find(style => style.paint !== undefined)
		const half = page.styles.find(style => style.alpha !== undefined)

		expect(styled).toBeDefined()
		expect(page.paints[styled?.paint ?? -1]?.kind).toBe("linear")
		expect(page.strokes[styled?.outline ?? -1]?.width).toBeCloseTo(12700 / 9525, 4)
		expect(page.paints[page.strokes[styled?.outline ?? -1]?.paint ?? -1]).toEqual({ kind: "solid", color: rgba("FF0000") })
		expect(page.textEffects[styled?.effects ?? -1]?.[0]).toMatchObject({ kind: "glow", radius: 4 })
		expect(half?.alpha).toBeCloseTo(0.5, 2)
		expect(half?.color).toBe("00FF00")
	})

	it("marks hyperlinks: a link range, the theme's hyperlink colour and an underline", () => {
		const rPr: RunProps = { sz: 1200, hlinkClick: { kind: "url", href: "https://filen.io" } }
		const refused: RunProps = { sz: 1200, hlinkClick: { kind: "refused", what: "program", raw: "ppaction://program" } }
		const media: RunProps = { sz: 1200, hlinkClick: { kind: "media" } }
		const { result } = laidOut(
			body([
				{
					pPr: {},
					runs: [
						{ kind: "r", text: "go ", rPr: SMALL },
						{ kind: "r", text: "here", rPr },
						{ kind: "r", text: "x", rPr: refused },
						{ kind: "r", text: "play", rPr: media }
					]
				}
			])
		)
		const page = result.page

		expect(page.page.linkCount).toBe(1)
		expect(Array.from(page.page.linkInts.subarray(0, LINK_INTS))).toEqual([0, 3, 7, 0])
		expect(page.links[0]).toEqual({ kind: "external", href: "https://filen.io", tooltip: undefined })
		expect(page.styles.some(style => style.color === "0563C1")).toBe(true)

		const kinds = Array.from({ length: page.page.decorationCount }, (_, d) => page.page.decorationInts[d * DECORATION_INTS])

		expect(kinds).toContain(DecorationKind.UNDERLINE)
	})

	it("draws a recoloured hyperlink (color tx) in its own colour, still underlined", () => {
		const rPr: RunProps = {
			sz: 1200,
			fill: { kind: "solid", color: { kind: "srgb", rgb: "00B050" } },
			hlinkClick: { kind: "url", href: "https://filen.io", color: "tx" }
		}
		const page = laidOut(body([paragraph("own", rPr)])).result.page
		const kinds = Array.from({ length: page.page.decorationCount }, (_, d) => page.page.decorationInts[d * DECORATION_INTS])

		expect(page.page.linkCount).toBe(1)
		expect(page.styles.some(style => style.color === "00B050")).toBe(true)
		expect(page.styles.some(style => style.color === "0563C1")).toBe(false)
		expect(kinds).toContain(DecorationKind.UNDERLINE)
	})

	it("refuses a body over the run budget before laying anything out", () => {
		const runs = Array.from({ length: MAX_BODY_RUNS + 1 }, () => ({ kind: "br" as const, rPr: {} }))

		expect(() => laidOut(body([{ pPr: {}, runs }]))).toThrow(PresentationError)
	})

	it("draws each character with its DrawingML slot's font", () => {
		const { env } = laidOut(
			body([
				paragraph("Hi 日本 שלום", {
					sz: 1200,
					latin: { typeface: "+mn-lt" },
					ea: { typeface: "MS Mincho" },
					cs: { typeface: "Arial" }
				})
			])
		)

		expect(env.requests).toContain("Calibri|ascii")
		expect(env.requests).toContain("MS Mincho|eastAsia")
		expect(env.requests).toContain("Arial|cs")
		expect(
			fontRequests(resolveBody(body([paragraph("x", { latin: { typeface: "+mj-lt" } })]), CONTEXT)).map(request => request.family)
		).toContain("Calibri Light")
	})

	it("treats an empty typeface as absent, down to Arial when the theme's own is empty, as LibreOffice draws it", () => {
		const blank: BodyContext = {
			...CONTEXT,
			fonts: {
				...FONTS,
				typeface: typeface => (typeface === "+mn-lt" || typeface === "" ? "" : typeface.startsWith("+") ? undefined : typeface)
			}
		}
		const families = (rPr: RunProps) => {
			const env = environment()

			layoutBody(resolveBody(body([paragraph("x", rPr)]), blank), { width: 400, height: 300 }, env)

			return [...new Set(env.requests.filter(request => request.endsWith("|ascii")))]
		}

		expect(families({ sz: 1200 })).toEqual(["Arial|ascii"])
		expect(families({ sz: 1200, latin: { typeface: "" } })).toEqual(["Arial|ascii"])
		expect(families({ sz: 1200, latin: { typeface: "Georgia" } })).toContain("Georgia|ascii")
	})
})

describe("DrawingML font slots", () => {
	it("splits text by script, weak characters joining their neighbours", () => {
		const pieces: [string, DrawingSlot][] = []
		const text = "(Hello, 日本語!) مرحبا "

		forEachDrawingSlotRun(text, true, "latin", (start, end, slot) => pieces.push([text.slice(start, end), slot]))

		expect(pieces).toEqual([
			["(Hello, ", "latin"],
			["日本語!) ", "ea"],
			["مرحبا ", "cs"],
			["", "sym"]
		])

		const noSymbol: DrawingSlot[] = []

		forEachDrawingSlotRun("", false, "ea", (_s, _e, slot) => noSymbol.push(slot))
		expect(noSymbol).toEqual(["latin"])

		const weak: DrawingSlot[] = []

		forEachDrawingSlotRun("123 ", false, "ea", (_s, _e, slot) => weak.push(slot))
		expect(weak).toEqual(["ea"])
	})
})

describe("text fields", () => {
	const now = new Date(2026, 9, 26, 14, 5, 9)

	it("shows the slide number and the thirteen date and time formats", () => {
		expect(fieldText("slidenum", "‹#›", { slideNumber: 7 })).toBe("7")
		expect(fieldText("slidenum", "‹#›", {})).toBe("‹#›")
		expect(fieldText("datetime1", "x", { now })).toBe("10/26/2026")
		expect(fieldText("datetime2", "x", { now })).toBe("Monday, October 26, 2026")
		expect(fieldText("datetime5", "x", { now })).toBe("26-Oct-26")
		expect(fieldText("datetime8", "x", { now })).toBe("10/26/2026 2:05 PM")
		expect(fieldText("datetime11", "x", { now })).toBe("14:05:09")
		expect(fieldText("datetime13", "x", { now })).toBe("2:05:09 PM")
		expect(fieldText("ftr", "Footer text", { now })).toBe("Footer text")
		expect(fieldText("datetime1", "stored", {})).toBe("stored")
	})

	it("names months and days in the field run's language, the numeric patterns as ECMA-376 lists them", () => {
		const german = new Intl.DateTimeFormat("de-DE", { weekday: "long" }).format(now)
		const month = new Intl.DateTimeFormat("de-DE", { month: "long" }).format(now)
		const field: TextBody = {
			bodyPr: {},
			paragraphs: [{ pPr: {}, runs: [{ kind: "fld", type: "datetime2", id: "{1}", text: "x", rPr: { lang: "de-DE" } }] }]
		}
		const laid = layoutBody(resolveBody(field, CONTEXT), { width: 2000, height: 300 }, environment(), { fields: { now } })

		expect(fieldText("datetime2", "x", { now }, "de-DE")).toBe(`${german}, ${month} 26, 2026`)
		expect(fieldText("datetime1", "x", { now }, "de-DE")).toBe("10/26/2026")
		expect(fieldText("datetime2", "x", { now }, "x-none")).toBe("Monday, October 26, 2026")
		expect(laid.page.page.sourceTexts).toEqual([`${german}, ${month} 26, 2026`])
	})
})

describe("text inheritance", () => {
	it("merges list styles weakest first, the body's own over them, and places the shape's font reference", () => {
		const master: ListStyle = { levels: [{ algn: "ctr", defRPr: { sz: 4400, b: true } }] }
		const layout: ListStyle = { levels: [{ defRPr: { sz: 3200 } }] }
		const own: ListStyle = { levels: [{ defRPr: { i: true } }] }
		const context: BodyContext = {
			listStyles: [master, layout],
			bodyPr: [{ anchor: "b", insets: { left: 1, top: Number.NaN, right: Number.NaN, bottom: Number.NaN } }],
			fontRef: { font: "minor", color: { kind: "scheme", slot: "lt1" }, above: 1 },
			fonts: FONTS
		}
		const resolved = resolveBody(body([paragraph("x", { b: false })], { anchor: "ctr" }, own), context)
		const first = resolved.paragraphs[0]
		const run = first?.runs[0]

		expect(first?.pPr.algn).toBe("ctr")
		expect(run?.kind === "r" ? run.rPr : undefined).toMatchObject({ sz: 3200, b: false, i: true, latin: { typeface: "+mn-lt" } })
		expect(resolved.bodyPr.anchor).toBe("ctr")
		expect(resolved.bodyPr.insets).toEqual({ ...DEFAULT_BODY_PR.insets, left: 1 })
		expect(resolveBodyPr([]).insets).toEqual(DEFAULT_BODY_PR.insets)
	})
})

describe("core/text EditEngine spacing", () => {
	it("keeps the baseline at four fifths of a reduced proportional line, and the extra above an enlarged one", () => {
		const h = harness()
		const prepare = (text: string) => h.layouter.prepare(h.builder.reset(h.base).append(text, h.base).finish(), { rtl: false })
		const layout = (spacing: number) => {
			h.out.reset()
			h.layouter.layout(
				prepare("a"),
				{ ...GEOMETRY, editEngineSpacing: true, lineRule: LineRule.AUTO, lineSpacing: spacing },
				h.out,
				new LayoutCursor(),
				0
			)

			return { height: h.out.lineFloats[1] ?? 0, baseline: h.out.lineFloats[2] ?? 0 }
		}

		// The fake face: 20 px, ascent 16, descent 4.
		expect(layout(0.5)).toEqual({ height: 10, baseline: 8 })
		expect(layout(1.5)).toEqual({ height: 30, baseline: 26 })
		expect(layout(1)).toEqual({ height: 20, baseline: 16 })
	})
})

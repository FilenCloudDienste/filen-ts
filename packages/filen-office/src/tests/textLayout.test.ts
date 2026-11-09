import { describe, expect, it } from "vitest"
import {
	Alignment,
	BreakKind,
	Caps,
	DecorationKind,
	DECORATION_FLOATS,
	DECORATION_INTS,
	Exclusions,
	FragmentFlag,
	FragmentKind,
	HitTester,
	KINSOKU_JAPANESE,
	LayoutCursor,
	LayoutStatus,
	LineFlag,
	LineRule,
	MeasureCache,
	ParagraphBuilder,
	ParagraphLayouter,
	StyleTable,
	TabAlignment,
	TabLeader,
	TabStops,
	TextLayout,
	Wrap,
	kinsokuOf,
	lineExtents,
	paragraphGap,
	verticalAlignment
} from "../core/text/index"
import { lineSpacingUnits, verticalMetrics } from "../core/fonts/index"
import { FakeMeasurer, GEOMETRY, harness, layOut, lines, testFont, texts } from "./textFixtures"
import { budget, cpuMs } from "./timing"

// The fake font at 20 px: "a" 10, space 5, "i"/"l"/"." 5, "m"/"w" 15, ideographs 20; lines 20 px high.

describe("ranges that start a new line", () => {
	it("moves a range that fits a line but not the rest of this one to the next line", () => {
		const h = harness()

		expect(texts(layOut(h, b => b.append("aaa aaaa aa aa", h.base), {}, { breakBefore: [9, 14] }))).toEqual(["aaa aaaa ", "aa aa"])
	})

	it("leaves a range that fits the rest of the line where it is", () => {
		const h = harness()

		expect(texts(layOut(h, b => b.append("aa aa aa", h.base), {}, { breakBefore: [3, 8] }))).toEqual(["aa aa aa"])
	})

	it("starts a range longer than a line on a new line, then wraps it at its spaces", () => {
		const h = harness()

		expect(texts(layOut(h, b => b.append("aa aaaa aaaa aaaa", h.base), {}, { breakBefore: [3, 17] }))).toEqual([
			"aa ",
			"aaaa aaaa ",
			"aaaa"
		])
	})

	it("adds no empty line for a range that already starts a line", () => {
		const h = harness()

		expect(texts(layOut(h, b => b.append("aaaa aaaa aaaa", h.base), {}, { breakBefore: [0, 14] }))).toEqual(["aaaa aaaa ", "aaaa"])
	})

	it("ignores a range where no break is allowed before it", () => {
		const h = harness()

		expect(texts(layOut(h, b => b.append("aaaaaaaa aa", h.base), {}, { breakBefore: [4, 11] }))).toEqual(["aaaaaaaa ", "aa"])
	})
})

describe("greedy line breaking", () => {
	it("fills lines greedily and lets line-end spaces hang", () => {
		const h = harness()
		const view = layOut(h, b => b.append("aaaa aaaa aaaa", h.base))

		expect(texts(view)).toEqual(["aaaa aaaa ", "aaaa"])
		expect(view[0]?.width).toBe(85)
		expect(view[0]?.fragments.map(f => f.text)).toEqual(["aaaa aaaa"])
		expect(view.map(v => v.top)).toEqual([0, 20])
		expect((view[1]?.flags ?? 0) & LineFlag.LAST).toBe(LineFlag.LAST)
	})

	it("keeps any number of trailing spaces on the line", () => {
		const h = harness()

		expect(texts(layOut(h, b => b.append("aaaaaaaaa          aa", h.base)))).toEqual(["aaaaaaaaa          ", "aa"])
	})

	it("breaks a word wider than the line at the last character that fits", () => {
		const h = harness()

		expect(texts(layOut(h, b => b.append("aaaaaaaaaaaaaaaaaaaaaaa", h.base)))).toEqual(["aaaaaaaaaa", "aaaaaaaaaa", "aaa"])
	})

	it("keeps the width of a piece added as the piece arrays grow (a word broken inside, a tab past the last stop)", () => {
		const h = harness()
		const other = h.style({ letterSpacing: 0 })
		// 64 one-character runs fill the first 64 pieces; the 65th grows the arrays.
		const runs = (b: ParagraphBuilder): ParagraphBuilder => {
			for (let k = 0; k < 64; k++) b.append("a", k % 2 === 0 ? h.base : other)

			return b
		}
		const broken = layOut(h, b => runs(b).append("aaaa", h.base), { width: 665 })

		expect(texts(broken)).toEqual(["a".repeat(66), "aa"])
		expect(broken[0]?.width).toBe(660)
		expect(broken[0]?.fragments.at(-1)).toMatchObject({ text: "aa", width: 20 })

		const tab = layOut(h, b => runs(b).tab(h.base).append("a", h.base), { width: 665 })

		expect(tab[0]?.fragments.at(-1)).toMatchObject({ text: "\t", width: 25 })
	})

	it("places at least one character on a line narrower than it", () => {
		const h = harness()

		expect(texts(layOut(h, b => b.append("mm", h.base), { width: 4 }))).toEqual(["m", "m"])
	})

	it("breaks across runs of different styles and merges fragments of one style", () => {
		const h = harness()
		const bold = h.style({ letterSpacing: 0 })
		const big = h.style({ size: 40 })
		const view = layOut(h, b => b.append("aa", h.base).append("aa ", bold).append("aaaa ", h.base).append("aa", big))

		expect(texts(view)).toEqual(["aaaa aaaa ", "aa"])
		expect(view[0]?.fragments.map(f => f.text)).toEqual(["aa", "aa ", "aaaa"])
		// The big run makes the second line taller: 40 px.
		expect(view[1]?.height).toBe(40)
		expect(view[1]?.baseline).toBe(20 + 32)
	})

	it("shows a hyphen when breaking at a soft hyphen", () => {
		const h = harness()
		const view = layOut(h, b => b.append("aaaaaa­aaaaa", h.base))

		expect(texts(view)).toEqual(["aaaaaa­", "aaaaa"])
		expect((view[0]?.flags ?? 0) & LineFlag.HYPHENATED).toBe(LineFlag.HYPHENATED)
		expect((view[0]?.fragments[0]?.info ?? 0) & FragmentFlag.HYPHEN).toBe(FragmentFlag.HYPHEN)
		// 60 for the letters, 5 for the hyphen.
		expect(view[0]?.width).toBe(65)
	})

	it("uses a hyphenator's opportunities", () => {
		const h = harness()
		const view = layOut(
			h,
			b => b.append("aaaaaaaaaaaaa", h.base),
			{},
			{
				hyphenator: {
					hyphenate(_paragraph, _styles, breaks) {
						breaks[5] = 3
					}
				}
			}
		)

		expect(texts(view)).toEqual(["aaaaa", "aaaaaaaa"])
		expect((view[0]?.flags ?? 0) & LineFlag.HYPHENATED).toBe(LineFlag.HYPHENATED)
	})

	it("never breaks at a no-break space or no-break hyphen", () => {
		const h = harness()

		expect(texts(layOut(h, b => b.append("aaaaaa aa aa", h.base)))).toEqual(["aaaaaa ", "aa aa"])
		expect(texts(layOut(h, b => b.append("aaaaaa aa‑aa", h.base)))).toEqual(["aaaaaa ", "aa‑aa"])
		expect(texts(layOut(h, b => b.append("aaaaaa aa-aa", h.base)))).toEqual(["aaaaaa aa-", "aa"])
	})

	it("breaks between ideographs and applies kinsoku", () => {
		const h = harness()
		const kinsoku = kinsokuOf(KINSOKU_JAPANESE)

		// Five ideographs per line; "。" may not start a line, so the fifth ideograph moves with it.
		expect(texts(layOut(h, b => b.append("日本語日本。語", h.base), {}, { kinsoku }))).toEqual(["日本語日", "本。語"])
	})

	it("wraps Korean at spaces by default and between syllables without word wrap", () => {
		const h = harness()
		const text = "한국어 문장은 띄어쓰기를 사용합니다"

		// Syllables are 20 px, spaces 5 px.
		expect(texts(layOut(h, b => b.append(text, h.base)))).toEqual(["한국어 ", "문장은 ", "띄어쓰기를 ", "사용합니다"])
		expect(texts(layOut(h, b => b.append(text, h.base), {}, { wordWrap: false }))).toEqual([
			"한국어 문",
			"장은 띄어",
			"쓰기를 사",
			"용합니다"
		])
	})

	it("lets East Asian full stops hang past the line end with overflowPunct", () => {
		const h = harness()

		expect(texts(layOut(h, b => b.append("日本語日本。語", h.base), {}, { hangingPunctuation: true }))).toEqual(["日本語日本。", "語"])
	})

	it("ends lines at text-wrapping breaks and gives a trailing break its own empty line", () => {
		const h = harness()
		const view = layOut(h, b => b.append("aa", h.base).lineBreak(h.base).append("bb", h.base).lineBreak(h.base))

		expect(texts(view)).toEqual(["aa\u000b", "bb\u000b", ""])
		expect((view[0]?.flags ?? 0) & LineFlag.LINE_BREAK).toBe(LineFlag.LINE_BREAK)
		expect((view[2]?.flags ?? 0) & LineFlag.LAST).toBe(LineFlag.LAST)
	})

	it("lays out an empty paragraph as one line of the paragraph mark", () => {
		const h = harness()
		const mark = h.style({ size: 30 })

		h.builder.reset(mark)

		const prepared = h.layouter.prepare(h.builder.finish(), { rtl: false })

		h.out.reset()
		expect(h.layouter.layout(prepared, GEOMETRY, h.out, new LayoutCursor(), 0)).toBe(LayoutStatus.DONE)

		const view = lines(h.out, "")

		expect(view).toHaveLength(1)
		expect(view[0]?.height).toBe(30)
	})

	it("includes the paragraph mark in the last line's height", () => {
		const h = harness()

		h.builder.reset(h.style({ size: 40 }))
		h.builder.append("aaaa aaaa aaaa", h.base)
		h.out.reset()
		h.layouter.layout(h.layouter.prepare(h.builder.finish(), { rtl: false }), GEOMETRY, h.out, new LayoutCursor(), 0)

		expect(lines(h.out, "").map(v => v.height)).toEqual([20, 40])
	})
})

describe("indents and alignment", () => {
	it("applies start, end and first-line indents", () => {
		const h = harness()
		const view = layOut(h, b => b.append("aaa aaa aaa aaa", h.base), { startIndent: 10, endIndent: 10, firstLineIndent: 20 })

		expect(texts(view)).toEqual(["aaa ", "aaa aaa ", "aaa"])
		expect(view.map(v => v.x)).toEqual([30, 10, 10])
	})

	it("applies a hanging indent", () => {
		const h = harness()
		const view = layOut(h, b => b.append("aaa aaa aaa aaa", h.base), { startIndent: 20, firstLineIndent: -20 })

		expect(texts(view)).toEqual(["aaa aaa aaa ", "aaa"])
		expect(view.map(v => v.x)).toEqual([0, 20])
	})

	it("centres and end-aligns lines", () => {
		const h = harness()

		expect(layOut(h, b => b.append("aaaa", h.base), { alignment: Alignment.CENTER })[0]?.x).toBe(30)
		expect(layOut(h, b => b.append("aaaa   ", h.base), { alignment: Alignment.END })[0]?.x).toBe(60)
	})

	it("justifies every line but the last, widening spaces", () => {
		const h = harness()
		const view = layOut(h, b => b.append("aaa aa aaa aaaa", h.base), { alignment: Alignment.BOTH })

		expect(texts(view)).toEqual(["aaa aa aaa ", "aaaa"])
		// 90 of 100 used with two spaces: 5 more each.
		expect(view[0]?.fragments[0]?.wordSpacing).toBe(5)
		expect(view[0]?.width).toBe(100)
		expect((view[0]?.flags ?? 0) & LineFlag.JUSTIFIED).toBe(LineFlag.JUSTIFIED)
		expect(view[1]?.fragments[0]?.wordSpacing).toBe(0)
		expect(view[1]?.width).toBe(40)
	})

	it("justifies lines ending in a line break unless told not to", () => {
		const h = harness()
		const build = (b: typeof h.builder): void => {
			b.append("aa aa", h.base).lineBreak(h.base).append("aa", h.base)
		}

		expect(layOut(h, build, { alignment: Alignment.BOTH })[0]?.width).toBe(100)
		expect(layOut(h, build, { alignment: Alignment.BOTH, expandLineBreaks: false })[0]?.width).toBe(45)
	})

	it("distributes every line including the last across characters", () => {
		const h = harness()
		const view = layOut(h, b => b.append("aaaaa", h.base), { alignment: Alignment.DISTRIBUTE })

		// 50 px of slack over four gaps.
		expect(view[0]?.fragments[0]?.letterSpacing).toBe(12.5)
	})

	it("leaves a justified Latin line without spaces as it is", () => {
		const h = harness()
		const view = layOut(h, b => b.append("ab cdefghijklmnopqrst", h.base), { alignment: Alignment.BOTH })

		expect(texts(view)).toEqual(["ab ", "cdefghijkl", "mnopqrst"])
		expect(view[0]?.width).toBe(20)
		expect(view[0]?.fragments[0]?.letterSpacing).toBe(0)
	})

	it("distributes within the column, left to right and right to left", () => {
		const h = harness()

		for (const rtl of [false, true]) {
			const view = layOut(
				h,
				b => b.append(rtl ? "\u05d0\u05d1\u05d2 \u05d3\u05d4" : "abc de", h.base),
				{ rtl, alignment: Alignment.DISTRIBUTE },
				{ rtl }
			)

			expect([view[0]?.x, view[0]?.width]).toEqual([0, 100])
		}
	})

	it("justifies East Asian lines without spaces across characters", () => {
		const h = harness()
		const view = layOut(h, b => b.append("日本語日本語日本語", h.base), { alignment: Alignment.BOTH, width: 90 })

		expect(texts(view)).toEqual(["日本語日", "本語日本", "語"])
		expect(view[0]?.fragments[0]?.letterSpacing).toBeCloseTo(10 / 3, 2)
		// Three gaps between four ideographs: no spacing after the last.
		expect(view[0]?.width).toBe(90)
	})
})

describe("tabs", () => {
	const stops = (...list: [number, number, number?][]): TabStops =>
		new TabStops(
			list.map(([position, alignment, leader]) => ({
				position,
				alignment: alignment as TabAlignment,
				leader: (leader ?? 0) as TabLeader
			}))
		)

	it("advances to default stops measured from the column's start edge", () => {
		const h = harness()
		const view = layOut(h, b => b.append("aa", h.base).tab(h.base).append("b", h.base), { width: 200, startIndent: 10 })
		const [first, tab, b] = view[0]?.fragments ?? []

		expect(first?.x).toBe(10)
		expect(tab?.kind).toBe(FragmentKind.TAB)
		expect(tab?.x).toBe(30)
		expect(tab?.width).toBe(18)
		expect(b?.x).toBe(48)
	})

	it("aligns text at right, centre and decimal stops", () => {
		const h = harness()
		const tabs = stops([100, TabAlignment.END], [150, TabAlignment.CENTER], [200, TabAlignment.DECIMAL])
		const view = layOut(
			h,
			b =>
				b
					.append("a", h.base)
					.tab(h.base)
					.append("bbbb", h.base)
					.tab(h.base)
					.append("cc", h.base)
					.tab(h.base)
					.append("12.50", h.base),
			{
				width: 300,
				tabs
			}
		)
		const fragments = view[0]?.fragments ?? []

		expect(fragments.map(f => f.text)).toEqual(["a", "\t", "bbbb", "\t", "cc", "\t", "12.50"])
		// Right: ends at 100. Centre: centred on 150. Decimal: "." at 200.
		expect(fragments[2]?.x).toBe(60)
		expect(fragments[4]?.x).toBe(140)
		expect(fragments[6]?.x).toBe(180)
	})

	it("records leaders and draws bar stops", () => {
		const h = harness()
		const tabs = stops([80, TabAlignment.START, TabLeader.DOT], [40, TabAlignment.BAR])
		const view = layOut(h, b => b.append("a", h.base).tab(h.base).append("1", h.base), { tabs })

		expect(view[0]?.fragments[1]?.aux).toBe(TabLeader.DOT)
		expect(view[0]?.fragments[1]?.width).toBe(70)
		expect(h.out.decorationCount).toBe(1)
		expect(h.out.decorationInts[0]).toBe(DecorationKind.BAR)
		expect(h.out.decorationFloats[0]).toBe(40)
	})

	it("treats a hanging indent as a stop after list numbers", () => {
		const h = harness()
		const view = layOut(h, b => b.append("1.", h.base).tab(h.base).append("aaa", h.base), { startIndent: 36, firstLineIndent: -36 })

		expect(view[0]?.fragments[2]?.x).toBe(36)
		expect(
			layOut(h, b => b.append("1.", h.base).tab(h.base).append("aaa", h.base), {
				startIndent: 36,
				firstLineIndent: -36,
				hangingIndentTab: false
			})[0]?.fragments[2]?.x
		).toBe(48)
	})

	it("wraps after a tab that has no stop left on the line", () => {
		const h = harness()
		// The next default stop (96) is past the line end (95).
		const view = layOut(h, b => b.append("aaaaaaa", h.base).tab(h.base).append("b", h.base), { width: 95 })

		expect(texts(view)).toEqual(["aaaaaaa\t", "b"])
		expect(view[0]?.fragments[1]?.width).toBe(25)
	})

	it("honours an explicit tab position (absolute position tab)", () => {
		const h = harness()
		const view = layOut(h, b =>
			b.append("a", h.base).tab(h.base, { position: 90, alignment: TabAlignment.END, leader: TabLeader.NONE }).append("bb", h.base)
		)

		expect(view[0]?.fragments[2]?.x).toBe(70)
	})

	it("aligns at a decimal stop without a separator like a right stop", () => {
		const h = harness()
		const view = layOut(h, b => b.append("a", h.base).tab(h.base).append("125", h.base), { tabs: stops([80, TabAlignment.DECIMAL]) })

		expect(view[0]?.fragments[2]?.x).toBe(50)
	})

	it("runs tabs from the right edge in right-to-left paragraphs", () => {
		const h = harness()
		const view = layOut(h, b => b.append("\u05d0", h.base).tab(h.base).append("\u05d1", h.base), { rtl: true })

		expect(view[0]?.fragments.map(f => [f.kind, f.x, f.width])).toEqual([
			[FragmentKind.TEXT, 90, 10],
			[FragmentKind.TAB, 52, 38],
			[FragmentKind.TEXT, 42, 10]
		])
	})

	it("justifies only text after the last tab", () => {
		const h = harness()
		const view = layOut(h, b => b.append("a a", h.base).tab(h.base).append("bb bb bb bb", h.base), { alignment: Alignment.BOTH })

		expect(view[0]?.fragments[0]?.wordSpacing).toBe(0)
		expect(view[0]?.fragments[2]?.wordSpacing).toBeGreaterThan(0)
	})
})

describe("line spacing", () => {
	it("multiplies, fixes or floors the line height", () => {
		const h = harness()
		const text = (b: typeof h.builder): void => {
			b.append("aaaa aaaa aaaa", h.base)
		}

		const multiple = layOut(h, text, { lineRule: LineRule.AUTO, lineSpacing: 1.5 })

		expect(multiple.map(v => v.height)).toEqual([30, 30])
		// The extra space sits above the text.
		expect(multiple[0]?.baseline).toBe(26)

		const exact = layOut(h, text, { lineRule: LineRule.EXACT, lineSpacing: 12 })

		expect(exact.map(v => v.top)).toEqual([0, 12])
		expect(exact[0]?.baseline).toBe(8)
		expect(layOut(h, text, { lineRule: LineRule.AT_LEAST, lineSpacing: 12 }).map(v => v.height)).toEqual([20, 20])
		expect(layOut(h, text, { lineRule: LineRule.AT_LEAST, lineSpacing: 25 }).map(v => v.height)).toEqual([25, 25])
	})

	it("splits a face's line into ascent and descent that add up to the spacing rule", () => {
		const metrics = verticalMetrics(2048, 1854, -434, 67, 1491, -431, 307, 1854, 434, false)
		const font = { ...testFont(), metrics }

		for (const rule of ["gdi", "typoWhenFlagged"] as const) {
			const extents = lineExtents(font, rule)

			expect(((extents?.ascent ?? 0) + (extents?.descent ?? 0)) * 2048).toBeCloseTo(lineSpacingUnits(metrics, rule), 6)
		}
	})

	it("raises line height for superscripts and inline objects", () => {
		const h = harness()
		const superscript = h.style(verticalAlignment(20, "superscript"))
		const view = layOut(h, b => b.append("aa", h.base).append("2", superscript))

		// Ascent 16; the superscript's 10.67 raised by 6.67 reaches 17.33.
		expect(view[0]?.height).toBeCloseTo(21.333, 3)

		const withObject = layOut(h, b => b.append("aa ", h.base).object(h.base, 30, 50, 0, 7).append(" aa", h.base))

		expect(withObject[0]?.height).toBe(54)
		expect(withObject[0]?.fragments.find(f => f.kind === FragmentKind.OBJECT)).toMatchObject({ width: 30, aux: 7 })
	})

	it("adds space after and before without collapsing, unless contextual within a style", () => {
		expect(
			paragraphGap(
				{ before: 0, after: 10, contextual: false, styleKey: "A" },
				{ before: 6, after: 0, contextual: false, styleKey: "A" }
			)
		).toBe(16)
		expect(
			paragraphGap(
				{ before: 0, after: 10, contextual: true, styleKey: "A" },
				{ before: 6, after: 0, contextual: false, styleKey: "A" }
			)
		).toBe(6)
		expect(
			paragraphGap(
				{ before: 0, after: 10, contextual: true, styleKey: "A" },
				{ before: 6, after: 0, contextual: true, styleKey: "B" }
			)
		).toBe(16)
	})
})

describe("bidirectional text", () => {
	it("mirrors right-to-left paragraphs: start indent and alignment from the right", () => {
		const h = harness()
		const view = layOut(h, b => b.append("אבג דה", h.base), { rtl: true, startIndent: 10 })

		expect(view[0]?.x).toBe(100 - 10 - 55)
		expect(view[0]?.fragments[0]?.level).toBe(1)
		expect((view[0]?.flags ?? 0) & LineFlag.RTL).toBe(LineFlag.RTL)
	})

	it("reorders a right-to-left run inside left-to-right text", () => {
		const h = harness()
		const view = layOut(h, b => b.append("ab אב גד cd", h.base), { width: 300 })
		const fragments = view[0]?.fragments ?? []

		// The space between the Hebrew words is right-to-left, the one before "cd" left-to-right; the
		// right-to-left fragment is one logical range drawn right to left.
		expect(fragments.map(f => [f.text, f.level])).toEqual([
			["ab ", 0],
			["אב גד", 1],
			[" cd", 0]
		])
		expect(fragments.map(f => f.x)).toEqual([0, 25, 70])
	})

	it("keeps numbers left-to-right inside right-to-left text", () => {
		const h = harness()
		const view = layOut(h, b => b.append("א 123 ב", h.base), { rtl: true, width: 300 })

		expect(view[0]?.fragments.map(f => [f.text, f.level])).toEqual([
			[" ב", 1],
			["123", 2],
			["א ", 1]
		])
	})
})

describe("floats", () => {
	it("flows text beside an obstacle on both sides", () => {
		const h = harness()
		const exclusions = new Exclusions()

		exclusions.add(40, 0, 60, 30, Wrap.BOTH)

		const view = layOut(h, b => b.append("aaa aaa aaa aaa", h.base), { exclusions })

		expect(texts(view)).toEqual(["aaa ", "aaa ", "aaa ", "aaa"])
		expect(view.map(v => [v.top, v.x])).toEqual([
			[0, 0],
			[0, 60],
			[20, 0],
			[20, 60]
		])
		expect((view[0]?.flags ?? 0) & LineFlag.CONTINUES).toBe(LineFlag.CONTINUES)
	})

	it("moves down past an obstacle leaving no usable room", () => {
		const h = harness()
		const exclusions = new Exclusions()

		exclusions.add(0, 0, 80, 50, Wrap.BOTH)

		const view = layOut(h, b => b.append("aaaa", h.base), { exclusions })

		expect(view[0]?.top).toBe(50)
		expect(view[0]?.x).toBe(0)
	})

	it("narrows lines beside a left-wrapped obstacle", () => {
		const h = harness()
		const exclusions = new Exclusions()

		exclusions.add(50, 0, 70, 40, Wrap.LEFT)

		const view = layOut(h, b => b.append("aaa aaa aaa", h.base), { exclusions })

		expect(texts(view)).toEqual(["aaa ", "aaa ", "aaa"])
		expect(view[2]?.top).toBe(40)
	})

	it("continues below floats after a clearing line break", () => {
		const h = harness()
		const exclusions = new Exclusions()

		exclusions.add(60, 0, 100, 70, Wrap.BOTH)

		const view = layOut(h, b => b.append("a", h.base).lineBreak(h.base, BreakKind.LINE_CLEAR_ALL).append("b", h.base), { exclusions })

		expect(view[1]?.top).toBe(70)
	})
})

describe("pagination", () => {
	it("stops at the bottom edge and resumes in the next area", () => {
		const h = harness()

		h.builder.reset(h.base).append("aaaa aaaa aaaa aaaa aaaa", h.base)

		const prepared = h.layouter.prepare(h.builder.finish(), { rtl: false })
		const cursor = new LayoutCursor()
		const out = new TextLayout()

		expect(h.layouter.layout(prepared, GEOMETRY, out, cursor, 0, 45)).toBe(LayoutStatus.OVERFLOW)
		expect(out.lineCount).toBe(2)
		expect(h.layouter.layout(prepared, GEOMETRY, out, cursor, 100, 200)).toBe(LayoutStatus.DONE)
		expect(out.lineCount).toBe(3)
		expect(out.lineTop(2)).toBe(100)
		expect(h.layouter.layout(prepared, GEOMETRY, out, new LayoutCursor(), 0, 10, false)).toBe(LayoutStatus.OVERFLOW)
	})

	it("does not force a first line that floats push below the area", () => {
		const h = harness()
		const exclusions = new Exclusions()

		exclusions.add(-10, 0, 200, 150, Wrap.BOTH)
		h.builder.reset(h.base).append("aaaa", h.base)

		const prepared = h.layouter.prepare(h.builder.finish(), { rtl: false })
		const out = new TextLayout()

		const cursor = new LayoutCursor()

		expect(h.layouter.layout(prepared, { ...GEOMETRY, exclusions }, out, cursor, 0, 100)).toBe(LayoutStatus.NO_ROOM)
		expect(out.lineCount).toBe(0)
		// Where the row was pushed, for callers whose next area continues below.
		expect(cursor.y).toBe(150)
		expect(h.layouter.layout(prepared, { ...GEOMETRY, exclusions }, out, new LayoutCursor(), 0, 200)).toBe(LayoutStatus.DONE)
		expect(out.lineTop(0)).toBe(150)
	})

	it("reports page and column breaks", () => {
		const h = harness()

		h.builder
			.reset(h.base)
			.append("a", h.base)
			.lineBreak(h.base, BreakKind.PAGE)
			.append("b", h.base)
			.lineBreak(h.base, BreakKind.COLUMN)

		const prepared = h.layouter.prepare(h.builder.finish(), { rtl: false })
		const cursor = new LayoutCursor()
		const out = new TextLayout()

		expect(h.layouter.layout(prepared, GEOMETRY, out, cursor, 0)).toBe(LayoutStatus.PAGE_BREAK)
		expect(h.layouter.layout(prepared, GEOMETRY, out, cursor, 0)).toBe(LayoutStatus.COLUMN_BREAK)
		// The paragraph mark stays with the column break that ends the paragraph: no further line, and the
		// break's line is the last.
		expect(h.layouter.layout(prepared, GEOMETRY, out, cursor, 0)).toBe(LayoutStatus.DONE)
		expect(out.lineCount).toBe(2)
		expect(out.lineFlags(1) & (LineFlag.LAST | LineFlag.COLUMN_BREAK)).toBe(LineFlag.LAST | LineFlag.COLUMN_BREAK)

		const tall = h.style({ size: 40 })

		h.builder.reset(tall).append("a", h.base).lineBreak(h.base, BreakKind.PAGE)
		out.reset()
		expect(h.layouter.layout(h.layouter.prepare(h.builder.finish(), { rtl: false }), GEOMETRY, out, new LayoutCursor(), 0)).toBe(
			LayoutStatus.PAGE_BREAK
		)
		expect(out.lineCount).toBe(1)
		expect(out.lineHeight(0)).toBe(40)
		expect(out.lineFlags(0) & (LineFlag.LAST | LineFlag.PAGE_BREAK)).toBe(LineFlag.LAST | LineFlag.PAGE_BREAK)
		expect((out.lineFlags(0) & LineFlag.PAGE_BREAK) !== 0).toBe(true)
	})
})

describe("decorations and transforms", () => {
	it("merges underlines across runs and skips line-end spaces", () => {
		const h = harness()
		const underlined = h.style({ underline: 1 })
		const underlinedToo = h.style({ underline: 1, size: 20, letterSpacing: 0.0001 })

		layOut(h, b => b.append("aa ", underlined).append("aa ", underlinedToo).append("aaaa aaaa", underlined))

		const underlines: number[][] = []

		for (let d = 0; d < h.out.decorationCount; d++) {
			if (h.out.decorationInts[d * DECORATION_INTS] !== DecorationKind.UNDERLINE) continue

			underlines.push(
				[...h.out.decorationFloats.subarray(d * DECORATION_FLOATS, d * DECORATION_FLOATS + 3)].map(v => Math.round(v * 100) / 100)
			)
		}

		expect(underlines).toEqual([
			[0, 18.4, 90],
			[0, 38.4, 40]
		])
	})

	it("underlines words only", () => {
		const h = harness()
		const words = h.style({ underline: 2, underlineWords: true })

		layOut(h, b => b.append("aa aa", words))

		expect(h.out.decorationCount).toBe(2)
		expect(h.out.decorationFloats[2]).toBe(20)
	})

	it("emits highlight and shading behind the text box", () => {
		const h = harness()

		layOut(h, b => b.append("aa", h.style({ highlight: 5, shading: 6 })))

		expect([...h.out.decorationInts.subarray(0, 2 * DECORATION_INTS)]).toEqual([
			DecorationKind.SHADING,
			6,
			0,
			DecorationKind.HIGHLIGHT,
			5,
			0
		])
		expect([...h.out.decorationFloats.subarray(0, 4)]).toEqual([0, 0, 20, 20])
	})

	it("measures caps and small caps upper-cased", () => {
		const h = harness()
		const caps = h.style({ caps: Caps.CAPS })
		const small = h.style({ caps: Caps.SMALL_CAPS })

		// "m" is 15 px, "M" 15 px; "i" 5 px but "I" 10 px.
		expect(layOut(h, b => b.append("ii", caps))[0]?.width).toBe(20)

		const view = layOut(h, b => b.append("Aii", small))

		expect(view[0]?.fragments.map(f => [f.text, (f.info & FragmentFlag.SMALL_CAPS) !== 0])).toEqual([
			["A", false],
			["ii", true]
		])
		expect(view[0]?.width).toBeCloseTo(10 + 2 * 10 * 0.7, 6)
	})

	it("applies letter spacing and horizontal scale", () => {
		const h = harness()

		// A joiner sequence (20 + 0 + 20 px in the fake font) is one character for letter spacing.
		expect(layOut(h, b => b.append("a\u{1F468}\u200d\u{1F469}", h.style({ letterSpacing: 2 })))[0]?.width).toBe(50 + 2 * 2)
		// Condensed text never advances backwards.
		expect(layOut(h, b => b.append("hello world", h.style({ letterSpacing: -15 })))[0]?.x).toBe(0)
		expect(layOut(h, b => b.append("hello world", h.style({ letterSpacing: -15 })))[0]?.width).toBe(0)

		expect(layOut(h, b => b.append("aaa", h.style({ letterSpacing: 2 })))[0]?.width).toBe(36)
		expect(layOut(h, b => b.append("aaa", h.style({ scaleX: 0.5 })))[0]?.width).toBe(15)
	})

	it("narrows a condensed original's substitute horizontally only, leaving letter spacing and height", () => {
		const h = harness()
		const narrow = testFont(2, "fo-narrow", 1, 0.5)
		const plain = h.style({})
		const condensed = h.style({ font: narrow })

		expect(layOut(h, b => b.append("aaa", condensed))[0]?.width).toBe(15)
		expect(layOut(h, b => b.append("aaa", h.style({ font: narrow, letterSpacing: 2 })))[0]?.width).toBe(15 + 3 * 2)
		expect(layOut(h, b => b.append("aaa", h.style({ font: narrow, scaleX: 0.5 })))[0]?.width).toBe(7.5)
		expect(h.styles.spaceWidth[condensed]).toBe((h.styles.spaceWidth[plain] ?? 0) * 0.5)
		expect(h.styles.ascent[condensed]).toBe(h.styles.ascent[plain])
		expect(h.styles.descent[condensed]).toBe(h.styles.descent[plain])
	})
})

describe("measurement", () => {
	it("measures each string once and batches misses per font", () => {
		const h = harness()

		layOut(h, b => b.append("lorem ipsum dolor lorem ipsum dolor", h.base).append(" big", h.style({ size: 40 })))

		const strings = h.measurer.strings

		layOut(h, b => b.append("lorem ipsum dolor lorem ipsum dolor", h.base).append(" big", h.style({ size: 40 })))
		expect(h.measurer.strings).toBe(strings)
		// One measurer call per font per paragraph.
		expect(h.measurer.calls).toBeLessThanOrEqual(4)
	})

	it("sums per-character widths for kerning-off runs when the canvas always kerns", () => {
		const control = new MeasureCache(new FakeMeasurer(true))
		const always = new MeasureCache(new FakeMeasurer(false))

		expect(control.width(control.font("20px x", false), "AVA", 0, 3)).toBe(30)
		expect(control.width(control.font("20px x", true), "AVA", 0, 3)).toBe(28)
		expect(always.width(always.font("20px x", false), "AVA", 0, 3)).toBe(30)
		expect(always.width(always.font("20px x", true), "AVA", 0, 3)).toBe(28)
	})

	it("stays bounded", () => {
		const cache = new MeasureCache(new FakeMeasurer(), 100)
		const font = cache.font("20px x", true)

		for (let i = 0; i < 1000; i++) cache.width(font, `w${i}`, 0, `w${i}`.length)

		// Two generations of at most 100.
		expect(cache.entries).toBeLessThanOrEqual(200)
		expect(cache.width(font, "w999", 0, 4)).toBe(FakeMeasurer.width("w999", 20, true))
	})

	it("never loses queued widths when a generation fills during a paragraph", () => {
		for (const limit of [4, 16, 1 << 16]) {
			const measurer = new FakeMeasurer()
			const cache = new MeasureCache(measurer, limit)
			const styles = new StyleTable(cache)
			const base = styles.add({ font: testFont(), size: 20 })
			const layouter = new ParagraphLayouter(styles)
			const words = Array.from({ length: 40 }, (_, i) => `w${i.toString(36).padStart(3, "q")}`).join(" ")
			const prepared = layouter.prepare(new ParagraphBuilder().reset(base).append(words, base).finish(), { rtl: false })

			for (let item = 0; item < prepared.count; item++) {
				const word = prepared.text.slice(prepared.start[item], prepared.contentEnd[item])

				expect(prepared.width[item]).toBe(FakeMeasurer.width(word, 20, true))
			}
		}
	})

	it("never writes NaN widths when generations turn over during a paragraph", () => {
		const words = Array.from({ length: 40 }, (_, i) => `w${i.toString(36)}`)

		for (const kerningControl of [true, false]) {
			for (const limit of [2, 8]) {
				const cache = new MeasureCache(new FakeMeasurer(kerningControl), limit)
				const styles = new StyleTable(cache)
				const base = styles.add({ font: testFont(), size: 20, kerning: false })
				const layouter = new ParagraphLayouter(styles)
				const text = [...words, ...words, "abcdefghijklmnopqrstuvwxyz"].join(" ")
				const prepared = layouter.prepare(new ParagraphBuilder().reset(base).append(text, base).finish(), { rtl: false })

				for (let item = 0; item < prepared.count; item++) {
					const word = prepared.text.slice(prepared.start[item], prepared.contentEnd[item])

					expect(prepared.width[item]).toBe(FakeMeasurer.width(word, 20, !kerningControl))
				}
			}
		}
	})

	it("does not cache long strings or probes", () => {
		const h = harness()
		const before = h.cache.entries

		layOut(h, b => b.append("x".repeat(500), h.base))
		expect(h.cache.entries).toBe(before)
		expect(h.cache.measure(h.cache.font("400 20px x", true), "abc", 0, 3)).toBe(30)
		expect(h.cache.entries).toBe(before)
	})
})

describe("hit testing", () => {
	it("puts the caret of an empty centred or end-aligned line at its alignment position", () => {
		const h = harness()
		const tester = new HitTester(h.styles)
		const caret = (geometry: Partial<typeof GEOMETRY>): number => {
			layOut(h, () => undefined, geometry)

			return tester.xAtOffset(h.out, 0, "", 0)
		}

		expect(caret({ alignment: Alignment.START })).toBe(0)
		expect(caret({ alignment: Alignment.CENTER })).toBe(50)
		expect(caret({ alignment: Alignment.END })).toBe(100)
		expect(caret({ alignment: Alignment.CENTER, startIndent: 20 })).toBe(60)
		expect(caret({ alignment: Alignment.START, rtl: true })).toBe(100)
		expect(caret({ alignment: Alignment.END, rtl: true })).toBe(0)
	})

	it("maps offsets to x and back on left-to-right and right-to-left lines", () => {
		const h = harness()
		const tester = new HitTester(h.styles)
		const text = "aaa iii mmm"

		layOut(h, b => b.append(text, h.base), { width: 300, alignment: Alignment.BOTH })

		expect(tester.xAtOffset(h.out, 0, text, 0)).toBe(0)
		expect(tester.xAtOffset(h.out, 0, text, 4)).toBe(35)
		expect(tester.xAtOffset(h.out, 0, text, 11)).toBe(100)
		expect(tester.offsetAtX(h.out, 0, text, 37)).toBe(4)
		expect(tester.offsetAtX(h.out, 0, text, 39)).toBe(5)
		expect(tester.offsetAtX(h.out, 0, text, 500)).toBe(11)

		// "aaa ii mmm " uses 95 of 100 px: its two spaces widen by 2.5 px each.
		const justified = "aaa ii mmm mmm"

		layOut(h, b => b.append(justified, h.base), { alignment: Alignment.BOTH })
		expect(tester.xAtOffset(h.out, 0, justified, 7)).toBe(55)
		expect(tester.offsetAtX(h.out, 0, justified, 56)).toBe(7)

		const hebrew = "אבג"

		layOut(h, b => b.append(hebrew, h.base), { rtl: true })
		expect(tester.xAtOffset(h.out, 0, hebrew, 0)).toBe(100)
		expect(tester.xAtOffset(h.out, 0, hebrew, 1)).toBe(90)
		expect(tester.offsetAtX(h.out, 0, hebrew, 79)).toBe(2)
		// Left of a right-to-left line's last character: the line's end.
		expect(tester.offsetAtX(h.out, 0, hebrew, 10)).toBe(3)
		expect(tester.lineAtY(h.out, 5)).toBe(0)
	})
})

describe("hit testing cost", () => {
	it("bisects inside a long fragment", () => {
		const h = harness()
		const text = Array.from({ length: 2000 }, (_, i) => `word${i % 10}`).join(" ")

		layOut(h, b => b.append(text, h.base), { width: 5000 })

		const calls = h.measurer.calls
		const tester = new HitTester(h.styles)
		const offset = tester.offsetAtX(h.out, 0, text, 4500)

		expect(h.measurer.calls - calls).toBeLessThan(40)
		expect(Math.abs(tester.xAtOffset(h.out, 0, text, offset) - 4500)).toBeLessThanOrEqual(5)
	})
})

describe("performance", () => {
	it("lays out a long unbreakable run in about linear time", () => {
		const time = (length: number): number => {
			const h = harness()
			const text = Array.from({ length }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join("")
			const started = cpuMs()
			const view = layOut(h, b => b.append(text, h.base), { width: 624 })

			expect(view.map(line => line.text).join("")).toBe(text)

			return cpuMs() - started
		}

		time(2_000)

		const small = time(20_000)
		const large = time(200_000)

		// Ten times the text; quadratic work would be a hundred times slower.
		expect(large / Math.max(small, 1)).toBeLessThan(30)
	})

	it("lays out a 1 MB unbreakable paragraph and releases its scratch afterwards", () => {
		const h = harness()
		const started = performance.now()
		const view = layOut(h, b => b.append("x".repeat(1 << 20), h.base), { width: 624 })

		expect(view.length).toBeGreaterThan(10_000)
		expect(performance.now() - started).toBeLessThan(budget(10_000))

		const prepared = h.layouter.prepare(h.builder.reset(h.base).append("short", h.base).finish(), { rtl: false })

		expect(prepared.start.length).toBeLessThan(1 << 16)
	})

	it("lays out 10k paragraphs quickly and without per-paragraph growth", () => {
		const h = harness()
		const words = [
			"lorem",
			"ipsum",
			"dolor",
			"sit",
			"amet",
			"consectetur",
			"adipiscing",
			"elit",
			"sed",
			"do",
			"eiusmod",
			"tempor",
			"Größe",
			"naïve"
		]
		const bold = h.style({ letterSpacing: 0.5 })
		const paragraphs: string[][] = []

		for (let p = 0; p < 10_000; p++) {
			const runs: string[] = []

			for (let r = 0; r < 3; r++) {
				const run: string[] = []

				for (let w = 0; w < 20; w++) run.push(words[(p * 7 + r * 5 + w * 3) % words.length] ?? "")

				runs.push(`${run.join(" ")} `)
			}

			paragraphs.push(runs)
		}

		const geometry = { ...GEOMETRY, width: 624, alignment: Alignment.BOTH }
		const out = new TextLayout()
		const cursor = new LayoutCursor()
		const run = (): number => {
			let lineCount = 0

			for (const runs of paragraphs) {
				h.builder.reset(h.base)

				for (let r = 0; r < runs.length; r++) h.builder.append(runs[r] ?? "", r === 1 ? bold : h.base)

				const prepared = h.layouter.prepare(h.builder.finish(), { rtl: false })

				out.reset()
				cursor.reset()
				h.layouter.layout(prepared, geometry, out, cursor, 0)
				lineCount += out.lineCount
			}

			return lineCount
		}

		// Warm: caches filled, buffers grown.
		run()

		const heapBefore = process.memoryUsage().heapUsed
		const started = performance.now()
		const lineCount = run()
		const elapsed = performance.now() - started
		const heapAfter = process.memoryUsage().heapUsed

		console.log(
			`text layout: 10k paragraphs, ${lineCount} lines in ${elapsed.toFixed(1)} ms (${((elapsed * 1000) / lineCount).toFixed(2)} µs/line), heap +${((heapAfter - heapBefore) / 1024 / 1024).toFixed(1)} MB, ${h.cache.entries} cached widths`
		)
		expect(lineCount).toBeGreaterThan(40_000)
		// Generous: vitest's module runner slows hot loops several times over a bundled build (src/bench/textBench.ts),
		// and loaded CI machines slow it further; a quadratic regression would still be far beyond this.
		expect(elapsed).toBeLessThan(budget(15_000))
	}, 60_000)
})

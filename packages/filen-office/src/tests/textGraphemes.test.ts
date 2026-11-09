import { describe, expect, it } from "vitest"
import { clusterStart, HitTester, nextCluster } from "../core/text/index"
import { harness, layOut, lines } from "./textFixtures"
import { budget, cpuMs } from "./timing"

// Caret stops, emergency line breaks and vertical stacking go by nextCluster(), which must give UAX #29 extended
// grapheme clusters as Intl.Segmenter does.

const TEXTS = [
	"plain ascii",
	"éạ̀b",
	"\u{1F44D}\u{1F3FD}x\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}y",
	"\u{1F1E9}\u{1F1EA}\u{1F1EB}\u{1F1F7}\u{1F1EE}",
	"1️⃣#️⃣",
	"\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} scot",
	"a\r\nb\nc",
	"क्षत्रिय हिन्दी",
	"क्‍ष क्षि",
	"বাংলা ক্ষ",
	"한국어 텍스트",
	"각ᄀ가각ᆨᅡ",
	"日本語のテキスト",
	"\u{10000}\u{1F600}",
	"x‌y‍z",
	"\u{1F600}‍क a‍\u{1F600}",
	"ﷺ مرحبا ؀١٢",
	"ä̈̈",
	"a‏b‎́\tc­́",
	"กำน้ำ"
]

function segments(text: string): number[] {
	const out: number[] = []

	for (const { index, segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text))
		out.push(index + segment.length)

	return out
}

function clusters(text: string): number[] {
	const out: number[] = []

	for (let at = 0; at < text.length;) out.push((at = nextCluster(text, at, text.length)))

	return out
}

describe("grapheme clusters", () => {
	it("match Intl.Segmenter", () => {
		for (const text of TEXTS) expect(clusters(text), JSON.stringify(text)).toEqual(segments(text))
	})

	it("keep emoji modifier sequences, flags, conjuncts and jamo syllables whole", () => {
		expect(clusters("\u{1F44D}\u{1F3FD}")).toEqual([4])
		expect(clusters("\u{1F1E9}\u{1F1EA}")).toEqual([4])
		expect(clusters("क्षि")).toEqual([4])
		expect(clusters("각")).toEqual([3])
	})

	it("finds the start of the cluster containing an offset", () => {
		const text = "a\u{1F1E9}\u{1F1EA}\u{1F1EB}\u{1F1F7}"

		expect(clusterStart(text, 3, 0)).toBe(1)
		expect(clusterStart(text, 5, 0)).toBe(5)
		expect(clusterStart(text, 7, 0)).toBe(5)
	})

	it("never puts the caret inside an emoji or a flag", () => {
		const h = harness()
		const tester = new HitTester(h.styles)

		// 10 px per code unit in the fake font: the emoji spans [10, 50).
		for (const middle of ["\u{1F44D}\u{1F3FD}", "\u{1F1E9}\u{1F1EA}"]) {
			const text = `a${middle}b`

			layOut(h, b => b.append(text, h.base), { width: 300 })

			for (let x = 12; x < 50; x += 4) expect([1, 5], `${JSON.stringify(text)} ${x}`).toContain(tester.offsetAtX(h.out, 0, text, x))
		}
	})

	it("breaks a word too long for the line between clusters only", () => {
		const h = harness()
		// Word joiners forbid every break: the line breaks inside the word.
		const text = Array.from({ length: 6 }, () => "\u{1F44D}\u{1F3FD}").join("⁠")

		layOut(h, b => b.append(text, h.base), { width: 70 })

		const views = lines(h.out, text)

		expect(views.length).toBeGreaterThan(1)

		for (const view of views) expect(view.text.startsWith("\u{1F3FD}"), JSON.stringify(view.text)).toBe(false)
	})

	it("walks a long run of viramas and marks in time linear in it", () => {
		const text = `क${"्".repeat(40_000)}ष${"\u{1F3FD}".repeat(20_000)}!`
		const started = cpuMs()

		expect(nextCluster(text, 0, text.length)).toBe(text.length - 1)
		expect(cpuMs() - started).toBeLessThan(budget(250))
	})
})

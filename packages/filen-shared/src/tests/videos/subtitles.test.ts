import { describe, expect, it } from "vitest"
import {
	activeCueIndices,
	applyCueOffset,
	assBlockText,
	CueBuilder,
	firstCueAtOrAfter,
	isMicroDvd,
	MAX_CONCURRENT_CUES,
	MAX_CUE_SECONDS,
	MAX_SUBTITLE_CUES,
	normalizeCueText,
	parseAss,
	parseFormatOf,
	parseMicroDvd,
	parseSmi,
	parseSrt,
	parseSubtitle,
	parseSubtitleTimestamp,
	parseVtt,
	subtitleFormat,
	subtitleFormatFromExtension,
	type CueStore
} from "@filen/shared/videos"

function mustParse(store: CueStore | null): CueStore {
	expect(store).not.toBeNull()

	return store as CueStore
}

function seeded(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) >>> 0

		let t = state

		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

describe("parseSubtitleTimestamp", () => {
	it.each([
		["00:00:01,500", 1.5],
		["01:02:03.250", 3723.25],
		["02:03.5", 123.5],
		["0:00:01.50", 1.5],
		["00:00:01,5", 1.5],
		["100:00:00,000", 360000]
	])("%s", (input, seconds) => {
		expect(parseSubtitleTimestamp(input)?.seconds).toBeCloseTo(seconds, 6)
	})

	it.each(["", "abc", "12", "1:", ":12", "00:00:01,", "-1:00"])("rejects %j", input => {
		expect(parseSubtitleTimestamp(input)).toBeNull()
	})
})

describe("cue store", () => {
	it("finds active cues by binary search, including overlaps and a long early cue", () => {
		const b = new CueBuilder()

		b.add(0, 100, "long")
		b.add(5, 7, "a")
		b.add(6, 9, "b")
		b.add(20, 21, "c")

		const store = b.finish()

		expect(activeCueIndices(store, 6.5).map(i => store.texts[i])).toEqual(["long", "a", "b"])
		expect(activeCueIndices(store, 7).map(i => store.texts[i])).toEqual(["long", "b"])
		expect(activeCueIndices(store, 20.5).map(i => store.texts[i])).toEqual(["long", "c"])
		expect(activeCueIndices(store, 100)).toEqual([])
		expect(activeCueIndices(store, -1)).toEqual([])
		expect(firstCueAtOrAfter(store, 6)).toBe(2)
		expect(firstCueAtOrAfter(store, 1000)).toBe(4)
	})

	it("sorts out-of-order cues stably and drops invalid ones", () => {
		const b = new CueBuilder()

		b.add(10, 12, "late")
		b.add(1, 2, "early")
		b.add(1, 3, "tie")

		expect(b.add(5, 4, "backwards")).toBe(false)
		expect(b.add(NaN, 4, "nan")).toBe(false)
		expect(b.add(1, 4, "")).toBe(false)

		expect(b.finish().texts).toEqual(["early", "tie", "late"])
	})

	it("applies an offset without touching the original and clamps at zero", () => {
		const b = new CueBuilder()

		b.add(1, 2, "a", 8)
		b.add(10, 12, "b")

		const store = b.finish()
		const later = applyCueOffset(store, 2.5)
		const earlier = applyCueOffset(store, -5)

		expect(Array.from(later.starts)).toEqual([3.5, 12.5])
		expect(Array.from(earlier.starts)).toEqual([0, 5])
		expect(Array.from(earlier.ends)).toEqual([0, 7])
		expect(Array.from(store.starts)).toEqual([1, 10])
		expect(later.hints).toBe(store.hints)
		expect(activeCueIndices(later, 13)).toEqual([1])
		expect(applyCueOffset(store, 0)).toBe(store)
	})

	it("shows no cue longer than MAX_CUE_SECONDS", () => {
		const b = new CueBuilder()

		b.add(10, 3 * 3600, "hours")

		const store = b.finish()

		expect(Array.from(store.ends)).toEqual([10 + MAX_CUE_SECONDS])
		expect(store.maxDuration).toBe(MAX_CUE_SECONDS)
		expect(activeCueIndices(store, 11 + MAX_CUE_SECONDS)).toEqual([])
	})

	it("keeps no more than MAX_CONCURRENT_CUES showing at once, the newest ones", () => {
		const b = new CueBuilder()

		// Added backwards, so the cap is applied in start order.
		for (let i = 99_998; i >= 0; i--) {
			b.add(i / 1000, MAX_CUE_SECONDS, `c${String(i)}`)
		}

		b.add(MAX_CUE_SECONDS, MAX_CUE_SECONDS + 1, "after")

		const store = b.finish()

		for (const time of [0.0035, 7, 50, 99.998, 300]) {
			const newest = Math.min(Math.floor(time * 1000 + 1e-6), 99_998)

			expect(activeCueIndices(store, time).map(i => store.texts[i])).toEqual(
				Array.from(
					{ length: Math.min(newest + 1, MAX_CONCURRENT_CUES) },
					(_, k) => `c${String(newest - Math.min(newest, MAX_CONCURRENT_CUES - 1) + k)}`
				)
			)
		}

		expect(activeCueIndices(store, MAX_CUE_SECONDS).map(i => store.texts[i])).toEqual(["after"])
	})

	// Each case runs as found in real files and again filling every place, so the longest cue has to give way.
	it.each([4, MAX_CONCURRENT_CUES / 2])("shows two speakers over two signs of %i layers", layers => {
		const b = new CueBuilder()

		for (let layer = 0; layer < layers; layer++) {
			b.add(10, 15, `sign A ${String(layer)}`, 8)
			b.add(10, 15, `sign B ${String(layer)}`, 7)
		}

		b.add(11, 14, "Speaker 1")
		b.add(12, 14.5, "Speaker 2")

		const store = b.finish()
		const at13 = activeCueIndices(store, 13).map(i => store.texts[i])

		expect(at13).toContain("Speaker 1")
		expect(at13).toContain("Speaker 2")
		expect(at13.length).toBeLessThanOrEqual(MAX_CONCURRENT_CUES)
		expect(activeCueIndices(store, 10.5)).toHaveLength(layers * 2)
	})

	it.each([7, MAX_CONCURRENT_CUES - 1])("keeps dialogue under %i sign layers when another layer starts", layers => {
		const b = new CueBuilder()

		for (let layer = 0; layer < layers; layer++) {
			b.add(10, 20, `sign ${String(layer)}`)
		}

		b.add(11, 14, "Dialogue")
		b.add(12, 20, "late sign")

		const store = b.finish()
		const at13 = activeCueIndices(store, 13).map(i => store.texts[i])

		expect(at13).toContain("Dialogue")
		expect(at13).toContain("late sign")
		expect(at13.length).toBeLessThanOrEqual(MAX_CONCURRENT_CUES)
	})

	it.each([8, MAX_CONCURRENT_CUES])("keeps dialogue stored before %i signs starting with it", signs => {
		const b = new CueBuilder()

		b.add(10, 13, "Dialogue")

		for (let i = 0; i < signs; i++) {
			b.add(10, 15, `sign ${String(i)}`)
		}

		const store = b.finish()
		const at12 = activeCueIndices(store, 12).map(i => store.texts[i])

		expect(at12).toContain("Dialogue")
		expect(at12).toHaveLength(Math.min(signs + 1, MAX_CONCURRENT_CUES))
	})

	it("drops a sign starting while MAX_CONCURRENT_CUES shorter lines show", () => {
		const b = new CueBuilder()

		for (let i = 0; i < MAX_CONCURRENT_CUES; i++) {
			b.add(10, 12, `line ${String(i)}`)
		}

		b.add(10.5, 20, "sign")

		const store = b.finish()

		expect(store.texts).toHaveLength(MAX_CONCURRENT_CUES)
		expect(store.texts).not.toContain("sign")
		expect(Array.from(store.ends).every(end => end === 12)).toBe(true)
	})

	it("shows a line starting with MAX_CONCURRENT_CUES others but stored after them", () => {
		const b = new CueBuilder()

		for (let i = 0; i < MAX_CONCURRENT_CUES; i++) {
			b.add(10, 15, `sign ${String(i)}`)
		}

		b.add(10, 13, "Dialogue")

		const store = b.finish()

		expect(store.texts).toHaveLength(MAX_CONCURRENT_CUES)
		expect(activeCueIndices(store, 12).map(i => store.texts[i])).toContain("Dialogue")
		expect(Array.from(store.ends).every(end => end > 10)).toBe(true)
	})

	it("keeps one of identical layered cues, so they take a single place", () => {
		const b = new CueBuilder()

		for (let layer = 0; layer < 4; layer++) {
			b.add(10, 15, "Sign", 8)
			b.add(10, 15, "Other sign")
		}

		b.add(10, 15, "Sign", 2)
		b.add(10, 16, "Sign", 8)
		b.add(11, 14, "Dialogue")

		const store = b.finish()

		expect(store.texts).toEqual(["Sign", "Other sign", "Sign", "Sign", "Dialogue"])
		expect(Array.from(store.ends)).toEqual([15, 15, 15, 16, 14])
	})

	it("never has more than MAX_CONCURRENT_CUES active, and shows every kept cue from its start", () => {
		const random = seeded(11)

		for (let round = 0; round < 20; round++) {
			const b = new CueBuilder()

			for (let i = 0; i < 3000; i++) {
				const start = Math.floor(random() * 2000) / 10

				b.add(start, start + random() * 20, String(i % 50), i % 3)
			}

			const store = b.finish()

			for (let i = 0; i < store.starts.length; i++) {
				const start = store.starts[i] as number
				const active = activeCueIndices(store, start)

				expect(store.ends[i]).toBeGreaterThan(start)
				expect(active.length).toBeLessThanOrEqual(MAX_CONCURRENT_CUES)
				expect(active).toContain(i)
			}
		}
	})

	it("stays bounded and fast when MAX_SUBTITLE_CUES cues all overlap", () => {
		const random = seeded(3)

		for (const shape of ["same start", "random"] as const) {
			const b = new CueBuilder()

			for (let i = 0; i < MAX_SUBTITLE_CUES; i++) {
				const start = shape === "same start" ? 0 : random() * 60

				b.add(start, 60 + random() * 500, String(i))
			}

			const started = performance.now()
			const store = b.finish()

			expect(performance.now() - started).toBeLessThan(1000)

			if (shape === "same start") {
				expect(store.texts).toHaveLength(MAX_CONCURRENT_CUES)
			}

			for (let time = 0; time < 600; time += 0.5) {
				expect(activeCueIndices(store, time).length).toBeLessThanOrEqual(MAX_CONCURRENT_CUES)
			}
		}
	})

	it("finds the same active cues as a full scan, over runs that ended and runs that didn't", () => {
		const random = seeded(7)

		for (let round = 0; round < 20; round++) {
			const b = new CueBuilder()

			for (let i = 0; i < 2000; i++) {
				const start = random() * 600
				// Mostly short cues, a few long ones reaching over many runs.
				const length = random() < 0.01 ? random() * 300 : random() * 2

				b.add(start, start + length, String(i))
			}

			const store = applyCueOffset(b.finish(), round % 2 === 0 ? 0 : -3)

			for (let probe = 0; probe < 200; probe++) {
				const time = random() * 620 - 10
				const expected: number[] = []

				for (let i = 0; i < store.starts.length; i++) {
					if ((store.starts[i] as number) <= time && (store.ends[i] as number) > time) {
						expected.push(i)
					}
				}

				expect(activeCueIndices(store, time)).toEqual(expected)
			}
		}
	})

	it("skips the cues that ended when one long cue keeps the scan reaching back", () => {
		const b = new CueBuilder()

		b.add(0, MAX_CUE_SECONDS, "long")

		// 1 ms cues packed into the long cue's span.
		for (let i = 1; i < 100_000; i++) {
			const start = (i * MAX_CUE_SECONDS) / 100_000

			b.add(start, start + 0.001, "short")
		}

		const store = b.finish()
		const out: number[] = []
		const started = performance.now()
		let hits = 0

		for (let i = 0; i < 50_000; i++) {
			hits += activeCueIndices(store, ((i * 7919) % 590_000) / 1000 + 5.0005, out).length
		}

		expect(hits).toBeGreaterThanOrEqual(50_000)
		expect(performance.now() - started).toBeLessThan(1000)
	})
})

describe("normalizeCueText", () => {
	it.each([
		["plain", "srt", "plain"],
		["<i>x</i> <b>y</b> <u>z</u>", "srt", "<i>x</i> <b>y</b> <u>z</u>"],
		["<I>x</I>", "srt", "<i>x</i>"],
		['<font color="#fff">x</font>', "srt", "x"],
		["a < b & c", "srt", "a &lt; b &amp; c"],
		["1 &lt; 2 &amp;&amp; 3&nbsp;4 &quot;q&quot;", "srt", '1 &lt; 2 &amp;&amp; 3&nbsp;4 "q"'],
		["&#65;&#x42;&#60;", "srt", "AB&lt;"],
		["a<br>b<br/>c", "srt", "a\nb\nc"],
		["<script>alert(1)</script>", "srt", "alert(1)"],
		["  one  \n\n  two  ", "srt", "one\ntwo"],
		["{\\an8}top", "srt", "top"],
		["keep {braces} literal", "srt", "keep {braces} literal"],
		["<v Roger>hello</v> <c.yellow>x</c> <00:01.000>y", "vtt", "hello x y"],
		["{\\i1}Hello{\\i0}\\Nworld\\hx", "ass", "Hello\nworld&nbsp;x"],
		["a<b>c", "ass", "a&lt;b>c"],
		["a &toString; b &__proto__; c &valueOf;", "srt", "a &amp;toString; b &amp;__proto__; c &amp;valueOf;"]
	] as const)("%j (%s)", (input, mode, expected) => {
		expect(normalizeCueText(input, mode).text).toBe(expected)
	})

	it("extracts the alignment hint and detects drawings", () => {
		expect(normalizeCueText("{\\an8}x", "srt").hint).toBe(8)
		expect(normalizeCueText("{\\pos(1,2)\\an7}x", "ass").hint).toBe(7)
		expect(normalizeCueText("{\\an0}x", "ass").hint).toBe(0)
		expect(normalizeCueText("{\\p1}m 0 0 l 10 10{\\p0}", "ass").drawing).toBe(true)
		expect(normalizeCueText("{\\pos(1,2)}x", "ass").drawing).toBe(false)
	})

	it("caps cue length", () => {
		expect(normalizeCueText("x".repeat(100_000), "srt").text.length).toBeLessThanOrEqual(2048)
	})
})

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello <i>world</i>

2
00:00:04,000 --> 00:00:06,000 X1:100
{\\an8}Top line
second line

3
00:01:00,000 --> 00:01:02,000
Last
`

describe("parseSrt", () => {
	it("parses cues, markup and alignment hints", () => {
		const store = mustParse(parseSrt(SRT))

		expect(store.texts).toEqual(["Hello <i>world</i>", "Top line\nsecond line", "Last"])
		expect(Array.from(store.starts)).toEqual([1, 4, 60])
		expect(Array.from(store.ends)).toEqual([3.5, 6, 62])
		expect(Array.from(store.hints ?? [])).toEqual([0, 8, 0])
	})

	it("copes with CRLF, lone CR, BOM, missing blank lines and missing indexes", () => {
		const crlf = mustParse(parseSrt(SRT.replace(/\n/g, "\r\n")))
		const cr = mustParse(parseSrt(SRT.replace(/\n/g, "\r")))
		const bom = mustParse(parseSrt(`${String.fromCharCode(0xfeff)}${SRT}`))
		const glued = mustParse(parseSrt("1\n00:00:01,000 --> 00:00:02,000\nA\n2\n00:00:03,000 --> 00:00:04,000\nB\n"))
		const noIndex = mustParse(parseSrt("00:00:01,000 --> 00:00:02,000\nA\n\n00:00:03,000 --> 00:00:04,000\nB"))

		expect(crlf.texts).toHaveLength(3)
		expect(cr.texts).toHaveLength(3)
		expect(bom.texts).toHaveLength(3)
		expect(glued.texts).toEqual(["A", "B"])
		expect(noIndex.texts).toEqual(["A", "B"])
	})

	it("keeps numeric text lines that are not indexes", () => {
		const store = mustParse(parseSrt("1\n00:00:01,000 --> 00:00:02,000\n42\nsecond\n"))

		expect(store.texts).toEqual(["42\nsecond"])
	})

	it("skips garbage and empty cues", () => {
		expect(mustParse(parseSrt("")).texts).toEqual([])
		expect(mustParse(parseSrt("not a subtitle at all\n--> -->\n")).texts).toEqual([])
		expect(mustParse(parseSrt("1\n00:00:01,000 --> 00:00:02,000\n\n")).texts).toEqual([])
		expect(mustParse(parseSrt("1\n00:00:05,000 --> 00:00:02,000\nbackwards\n")).texts).toEqual([])
	})

	it("refuses input over the size cap", () => {
		expect(parseSrt("x".repeat(8 * 1024 * 1024 + 1))).toBeNull()
	})
})

describe("parseVtt", () => {
	const VTT = `WEBVTT - title

STYLE
::cue { color: red }

NOTE a comment
spanning lines

REGION
id:r1

intro
00:01.000 --> 00:03.000 line:0 align:start
<v Alice>Hi <c.loud>there</c></v>

00:00:04.000 --> 00:00:05.000 line:50%
middle

00:00:06.000 --> 00:00:07.000 line:-1
bottom &amp; <b>bold</b>
`

	it("parses cues, drops non-cue blocks, strips voice tags and maps line settings", () => {
		const store = mustParse(parseVtt(VTT))

		expect(store.texts).toEqual(["Hi there", "middle", "bottom &amp; <b>bold</b>"])
		expect(Array.from(store.starts)).toEqual([1, 4, 6])
		expect(Array.from(store.hints ?? [])).toEqual([8, 5, 0])
	})

	it("accepts a header-less file and CRLF", () => {
		expect(mustParse(parseVtt("00:01.000 --> 00:02.000\r\nx\r\n")).texts).toEqual(["x"])
	})
})

describe("MicroDVD", () => {
	it("confirms the signature", () => {
		expect(isMicroDvd("{1}{50}Hello")).toBe(true)
		expect(isMicroDvd("\n\n  {10}{20}x")).toBe(true)
		expect(isMicroDvd("﻿{10}{20}x")).toBe(true)
		expect(isMicroDvd("# VobSub index file")).toBe(false)
		expect(isMicroDvd("{a}{b}x")).toBe(false)
		expect(isMicroDvd("")).toBe(false)
	})

	it("converts frames with the given fps and splits lines on |", () => {
		const store = mustParse(parseMicroDvd("{25}{75}One|Two\n{100}{150}{y:i}Slanted", 25))

		expect(Array.from(store.starts)).toEqual([1, 4])
		expect(Array.from(store.ends)).toEqual([3, 6])
		expect(store.texts).toEqual(["One\nTwo", "<i>Slanted</i>"])
	})

	it("reads the fps header and drops other control codes", () => {
		const store = mustParse(parseMicroDvd("{1}{1}20\n{40}{60}{c:$0000ff}{f:Arial}Hi"))

		expect(Array.from(store.starts)).toEqual([2])
		expect(Array.from(store.ends)).toEqual([3])
		expect(store.texts).toEqual(["Hi"])
	})

	it("falls back to the default fps for bad values", () => {
		const store = mustParse(parseMicroDvd("{24}{48}x", Number.NaN))

		expect(store.starts[0]).toBeCloseTo(24 / 23.976, 6)
	})
})

describe("parseSmi", () => {
	const SMI = `<SAMI>
<HEAD>
<TITLE>t</TITLE>
<STYLE TYPE="text/css">
<!--
P { margin-left:8pt; }
.ENCC { Name:English; lang:en-US; SAMIType:CC; }
.KRCC { Name:Korean; lang:ko-KR; SAMIType:CC; }
-->
</STYLE>
</HEAD>
<BODY>
<SYNC Start=1000><P Class=ENCC>Hello<br>there
<P Class=KRCC>안녕
<SYNC Start=3000><P Class=ENCC>&nbsp;
<SYNC Start=4000><P Class=ENCC><i>Again</i>
<P Class=KRCC>&nbsp;
<SYNC Start=7500><P Class=ENCC>&nbsp;
</BODY>
</SAMI>`

	it("splits tracks by class and maps languages", () => {
		const tracks = parseSmi(SMI) ?? []

		expect(tracks.map(t => [t.className, t.lang])).toEqual([
			["ENCC", "en"],
			["KRCC", "ko"]
		])

		const en = (tracks[0] as { store: CueStore }).store

		expect(en.texts).toEqual(["Hello\nthere", "<i>Again</i>"])
		expect(Array.from(en.starts)).toEqual([1, 4])
		expect(Array.from(en.ends)).toEqual([3, 7.5])

		const ko = (tracks[1] as { store: CueStore }).store

		expect(ko.texts).toEqual(["안녕"])
		expect(Array.from(ko.ends)).toEqual([4])
	})

	it("gives the last unterminated cue a short tail and handles lower-case tags", () => {
		const tracks = parseSmi("<sami><body><sync start=2000><p class=a>bye</body></sami>") ?? []
		const store = (tracks[0] as { store: CueStore }).store

		expect(store.texts).toEqual(["bye"])
		expect(store.ends[0]).toBe(7)
	})

	it("is selected through parseSubtitle by class or language", () => {
		expect(mustParse(parseSubtitle(SMI, "smi", { smiLang: "ko" })).texts).toEqual(["안녕"])
		expect(mustParse(parseSubtitle(SMI, "smi", { smiClass: "ENCC" })).texts).toHaveLength(2)
		expect(mustParse(parseSubtitle(SMI, "smi")).texts).toHaveLength(2)
		expect(parseSubtitle("<html></html>", "smi")).toBeNull()
	})
})

describe("SMI blank sync", () => {
	it("a sync without entries ends the active cue of every class", () => {
		const tracks =
			parseSmi(
				"<SAMI><BODY><SYNC Start=1000><P Class=A>one<P Class=B>uno<SYNC Start=2000>&nbsp;<SYNC Start=5000><P Class=A>two</BODY></SAMI>"
			) ?? []
		const a = (tracks.find(t => t.className === "A") as { store: CueStore }).store
		const b = (tracks.find(t => t.className === "B") as { store: CueStore }).store

		expect(Array.from(a.ends)).toEqual([2, 10])
		expect(Array.from(b.ends)).toEqual([2])
	})

	it("keeps the first classes only, and an entry of a dropped class still counts as one", () => {
		let input = "<SAMI><BODY><SYNC Start=0><P Class=keep>first"

		for (let i = 0; i < 1000; i++) {
			input += `<SYNC Start=${1000 + i * 10}><P Class=c${i}>x${i}`
		}

		input += "<SYNC Start=20000><P Class=keep>&nbsp;</BODY></SAMI>"

		const tracks = parseSmi(input) ?? []

		expect(tracks).toHaveLength(32)
		expect(tracks.map(t => t.className)).toEqual(["keep", ...Array.from({ length: 31 }, (_, i) => `c${i}`)])
		expect(Array.from((tracks[0] as { store: CueStore }).store.ends)).toEqual([20])
	})

	it("also closes at a trailing blank sync", () => {
		const tracks = parseSmi("<SAMI><BODY><SYNC Start=1000><P Class=A>one<SYNC Start=4000></BODY></SAMI>") ?? []

		expect(Array.from((tracks[0] as { store: CueStore }).store.ends)).toEqual([4])
	})
})

describe("long markup is stripped, not leaked", () => {
	it("removes long <font> tags and long ASS overrides", () => {
		const attrs = "x=".concat("a".repeat(300))

		expect(normalizeCueText(`<font ${attrs}>hello</font>`, "srt").text).toBe("hello")
		expect(normalizeCueText(`{\\fn${"a".repeat(500)}}hello`, "ass").text).toBe("hello")
		expect(normalizeCueText(`{\\fn${"a".repeat(500)}}hello`, "srt").text).toBe("hello")
		expect(normalizeCueText(`a<${"b".repeat(5000)}`, "srt").text.startsWith("a&lt;")).toBe(true)
	})

	it("keeps output free of raw angle brackets from markup", () => {
		const out = normalizeCueText(`<font ${"q".repeat(900)}>x</font><script>y</script>`, "srt").text

		expect(out).toBe("xy")
	})
})

describe("MicroDVD control-code scan", () => {
	it("does not treat a far closing brace as a control code", () => {
		const store = mustParse(parseMicroDvd(`{1}{2}{y:${"i".repeat(100)}} text`, 25))

		expect(store.texts[0]?.startsWith("{y:")).toBe(true)
	})
})

describe("ASS", () => {
	const ASS = `[Script Info]
Title: x

[V4+ Styles]
Format: Name, Fontname
Style: Default,Arial

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\an8}{\\i1}Hello{\\i0}\\Nworld, with comma
Comment: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,ignored
Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\p1}m 0 0 l 5 5{\\p0}
Dialogue: 1,0:01:00.00,0:01:01.25,Default,,0,0,0,,a & b <c>
`

	it("keeps text, drops overrides and drawings, keeps the alignment hint", () => {
		const store = mustParse(parseAss(ASS))

		expect(store.texts).toEqual(["Hello\nworld, with comma", "a &amp; b &lt;c>"])
		expect(Array.from(store.starts)).toEqual([1, 60])
		expect(Array.from(store.ends)).toEqual([3.5, 61.25])
		expect(Array.from(store.hints ?? [])).toEqual([8, 0])
	})

	it("honours a custom Format line", () => {
		const store = mustParse(
			parseAss("[Events]\nFormat: Marked, Start, End, Style, Text\nDialogue: Marked=0,0:00:01.00,0:00:02.00,Default,Hi, there\n")
		)

		expect(store.texts).toEqual(["Hi, there"])
	})

	it("reads the text field of a Matroska ASS block, and a malformed block whole", () => {
		expect(assBlockText("12,0,Default,Bob,0,0,0,,Hi, there")).toBe("Hi, there")
		expect(assBlockText("12,0,Default,Bob,0,0,0,,")).toBe("")
		expect(assBlockText("broken")).toBe("broken")
		expect(assBlockText("1,0,Default,,0,0,0")).toBe("1,0,Default,,0,0,0")
	})
})

describe("parseSubtitle", () => {
	it("maps extensions and applies options", () => {
		expect(subtitleFormatFromExtension(".SRT")).toBe("srt")
		expect(subtitleFormatFromExtension("ssa")).toBe("ass")
		expect(subtitleFormatFromExtension("sami")).toBe("smi")
		expect(subtitleFormatFromExtension("sub")).toBe("sub")
		expect(subtitleFormatFromExtension("idx")).toBeNull()

		expect(mustParse(parseSubtitle(SRT, "srt", { offset: 1 })).starts[0]).toBe(2)
		expect(mustParse(parseSubtitle("{25}{50}x", "sub", { fps: 25 })).starts[0]).toBe(1)
		expect(parseSubtitle("# VobSub index", "sub")).toBeNull()
		expect(parseSubtitle("x".repeat(8 * 1024 * 1024 + 1), "vtt")).toBeNull()
	})

	it("gives every text extension the same parser through the extension and the sidecar entry points", () => {
		for (const extension of ["srt", "vtt", "ass", "ssa", "smi", "sami", "sub", "idx", "sup", "txt"]) {
			const sidecar = subtitleFormat(extension, false)

			expect(subtitleFormatFromExtension(extension)).toBe(sidecar === null ? null : parseFormatOf(sidecar))
		}

		// A `.sub` without an `.idx` partner is MicroDVD only when its content says so.
		expect(parseFormatOf("microdvd")).toBe("sub")
		expect(parseFormatOf("vobsub")).toBeNull()
		expect(parseFormatOf("pgs")).toBeNull()
		expect(subtitleFormatFromExtension("sup")).toBeNull()
	})
})

describe("robustness", () => {
	const pieces = [
		"1",
		"00:00:01,000 --> 00:00:02,000",
		"-->",
		"<",
		">",
		"{",
		"}",
		"\\N",
		"&",
		";",
		"<i>",
		"</i>",
		"{\\an8}",
		"<SYNC Start=1>",
		"<P Class=A>",
		"Dialogue: 0,0:00:01.00,0:00:02.00,S,,0,0,0,,x",
		"[Events]",
		"Format: Start, End, Text",
		"{1}{2}",
		"WEBVTT",
		"\r",
		"\n",
		"\n\n",
		"\u0000",
		"é",
		"&#999999999;",
		"<!--",
		"-->",
		"text"
	]

	it("never throws on random token soup", () => {
		const rand = seeded(1234)

		for (let round = 0; round < 400; round++) {
			let input = ""
			const parts = 1 + Math.floor(rand() * 60)

			for (let i = 0; i < parts; i++) {
				input += pieces[Math.floor(rand() * pieces.length)]
			}

			for (const parse of [parseSrt, parseVtt, parseAss, parseSmi, (t: string) => parseMicroDvd(t, 25)] as const) {
				expect(() => parse(input)).not.toThrow()
			}
		}
	})

	it("never throws on random bytes-as-text", () => {
		const rand = seeded(99)

		for (let round = 0; round < 100; round++) {
			let input = ""

			for (let i = 0; i < 500; i++) {
				input += String.fromCharCode(Math.floor(rand() * 0x2fff))
			}

			expect(() => parseSrt(input)).not.toThrow()
			expect(() => parseSmi(input)).not.toThrow()
		}
	})

	it("stays linear on adversarial runs, per input and per parser", () => {
		const n = 2 * 1024 * 1024
		const cue = "1\n00:00:01,000 --> 00:00:02,000\n"
		const shapes: Record<string, string> = {
			lt: "<".repeat(n),
			brace: "{".repeat(n),
			amp: "&".repeat(n),
			tagOpeners: "<i".repeat(n / 2),
			overrideOpeners: "{\\".repeat(n / 2),
			arrows: "00:00:01,000 --> ".repeat(n / 17),
			lessInCue: `${cue}${"<".repeat(n)}\n`,
			longFontTag: `${cue}<font ${"a".repeat(n)}>x</font>\n`,
			longOverride: `${cue}{\\${"a".repeat(n)}}x\n`,
			syncOpeners: `<SYNC Start=1><P>${"<b".repeat(n / 2)}`,
			syncRun: "<SYNC Start=1><P Class=A>x".repeat(n / 26),
			syncNoClose: `<SYNC Start=1>${"<P ".repeat(n / 3)}`,
			pRun: `<SYNC Start=1>${"<P Class=".repeat(n / 9)}`,
			styleRun: `<STYLE>${".a{lang:en}".repeat(n / 11)}</STYLE><SYNC Start=1><P Class=a>x`,
			manyStyles: "<STYLE>.a{lang:en}</STYLE>".repeat(n / 26),
			commentRun: "<!--".repeat(n / 4),
			dvdPrefix: "{1}{".repeat(n / 4),
			dvdBraces: "{12}{34}{".repeat(n / 9),
			dvdControl: `{1}{2}${"{y:".repeat(n / 3)}`,
			dvdNoClose: `{1}{2}${"{".repeat(n)}`,
			dvdLines: "{1}{".repeat(n / 8).replace(/\{1\}\{/g, "{1}{\n")
		}

		for (const [name, input] of Object.entries(shapes)) {
			for (const [parser, parse] of [
				["srt", parseSrt],
				["vtt", parseVtt],
				["smi", parseSmi],
				["ass", parseAss],
				["microdvd", (t: string) => parseMicroDvd(t, 25)]
			] as const) {
				const started = performance.now()

				parse(input)

				const ms = performance.now() - started

				expect(ms, `${parser} on ${name}: ${String(Math.round(ms))} ms`).toBeLessThan(2000)
			}
		}
	})

	it("parses 20k STYLE blocks in linear time", () => {
		const input = `${"<STYLE>.c{lang:en}</STYLE>".repeat(20_000)}<SYNC Start=1><P Class=c>hi<SYNC Start=2><P Class=c>&nbsp;`
		const started = performance.now()
		const tracks = parseSmi(input) ?? []

		expect(tracks[0]?.lang).toBe("en")
		expect(performance.now() - started).toBeLessThan(2000)
	})

	it("bounds cue count and cue length", () => {
		let input = ""

		// One cue a second, so none overlap.
		for (let i = 0; i < 120_000; i++) {
			const at = `${String(Math.floor(i / 3600)).padStart(2, "0")}:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`

			input += `${at},000 --> ${at},500\nx\n\n`
		}

		expect(mustParse(parseSrt(input)).texts.length).toBe(100_000)
		expect(mustParse(parseSrt(`00:00:01,000 --> 00:00:02,000\n${"y".repeat(500_000)}\n`)).texts[0]?.length).toBeLessThanOrEqual(2048)
	})
})

describe("performance", () => {
	it("parses a 10k-cue SRT quickly and looks cues up in microseconds", () => {
		let input = ""

		for (let i = 0; i < 10_000; i++) {
			const s = i * 2
			const hh = String(Math.floor(s / 3600)).padStart(2, "0")
			const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0")
			const ss = String(s % 60).padStart(2, "0")

			input += `${String(i + 1)}\n${hh}:${mm}:${ss},000 --> ${hh}:${mm}:${ss},900\n<i>Line ${String(i)}</i> with some words\nand a second line\n\n`
		}

		const started = performance.now()
		const store = mustParse(parseSrt(input))
		const parseMs = performance.now() - started

		expect(store.texts).toHaveLength(10_000)
		console.info(`10k-cue SRT parse: ${parseMs.toFixed(1)} ms`)
		expect(parseMs).toBeLessThan(2000)

		const lookups = performance.now()
		const out: number[] = []
		let hits = 0

		for (let i = 0; i < 100_000; i++) {
			hits += activeCueIndices(store, (i % 20_000) + 0.5, out).length
		}

		expect(hits).toBeGreaterThan(0)
		expect(performance.now() - lookups).toBeLessThan(2000)
	})
})

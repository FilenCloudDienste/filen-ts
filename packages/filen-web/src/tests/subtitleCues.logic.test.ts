import { describe, expect, it } from "vitest"
import {
	cuePlainText,
	cuesSpan,
	formatCueSpan,
	formatCueTime,
	matchingCues,
	readSubtitleText
} from "@/features/preview/lib/subtitleCues.logic"

describe("cuePlainText", () => {
	it("drops the cue markup and decodes its three escapes once", () => {
		expect(cuePlainText("<i>Hello</i> <b>there</b> <u>you</u>")).toBe("Hello there you")
		expect(cuePlainText("Tom &amp; Jerry &lt;3&nbsp;!")).toBe("Tom & Jerry <3 !")
		// An escaped escape stays one level escaped.
		expect(cuePlainText("&amp;lt;")).toBe("&lt;")
		expect(cuePlainText("line one\nline two")).toBe("line one\nline two")
	})
})

describe("cue times", () => {
	it("formats with hours and milliseconds, and the span without milliseconds", () => {
		expect(formatCueTime(1.2)).toBe("00:00:01.200")
		expect(formatCueTime(6130.4567)).toBe("01:42:10.457")
		expect(formatCueTime(-1)).toBe("00:00:00.000")
		expect(formatCueSpan(6130.4567)).toBe("01:42:10")
	})

	it("spans to the latest end, not the last cue's", () => {
		expect(cuesSpan({ status: "ok", starts: Float64Array.of(0, 5), ends: Float64Array.of(90, 7), texts: ["a", "b"] })).toBe(90)
	})
})

describe("matchingCues", () => {
	const lowered = ["hello there", "general kenobi", "hello again"]

	it("keeps every cue for an empty query", () => {
		expect(matchingCues(lowered, "  ")).toBeNull()
	})

	it("finds cues by text, case-insensitively", () => {
		expect(Array.from(matchingCues(lowered, "HELLO") ?? [])).toEqual([0, 2])
		expect(Array.from(matchingCues(lowered, "nothing") ?? [])).toEqual([])
	})
})

describe("readSubtitleText", () => {
	it("reads an SRT's cues as times and plain text", () => {
		const reading = readSubtitleText(
			"1\n00:00:01,200 --> 00:00:03,900\n<i>Hello</i> &amp; bye\n\n2\n00:00:04,000 --> 00:00:05,000\nTwo\n",
			"srt"
		)

		expect(reading.status).toBe("ok")

		if (reading.status === "ok") {
			expect(Array.from(reading.starts)).toEqual([1.2, 4])
			expect(Array.from(reading.ends)).toEqual([3.9, 5])
			expect(reading.texts).toEqual(["Hello & bye", "Two"])
		}
	})

	it("reads a MicroDVD .sub, and says a .sub of anything else or an unknown format has no cues", () => {
		expect(readSubtitleText("{25}{50}Hello\n", "sub").status).toBe("ok")
		expect(readSubtitleText("not subtitles at all", "sub")).toEqual({ status: "unreadable" })
		expect(readSubtitleText("1\n00:00:01,200 --> 00:00:03,900\nHi\n", "txt")).toEqual({ status: "unreadable" })
		expect(readSubtitleText("", "srt")).toEqual({ status: "unreadable" })
	})
})

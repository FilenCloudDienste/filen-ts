import { describe, expect, it } from "vitest"
import i18n from "i18next"
import "@/lib/i18n"
import { audioTrackName, audioTrackNotice, subtitleTrackName, subtitleTrackNotice } from "@/features/videos/lib/player/trackLabels.logic"

// What the video player says over the picture when its keys switch the audio or the subtitles (the subtitle delay's
// notice, reused): the track as the tracks menu names it, or that subtitles are off.

const t = i18n.getFixedT("en", "videos")

describe("track notices", () => {
	it("names an audio track as the tracks menu does", () => {
		expect(audioTrackName({ lang: "en", ch: 6 }, 0, t)).toBe("English 5.1")
		expect(audioTrackNotice({ lang: "en", ch: 6 }, 0, t)).toBe("Audio: English 5.1")
		// No language: its number; no channel count: nothing after it.
		expect(audioTrackNotice({ lang: null, ch: null }, 2, t)).toBe("Audio: Track 3")
		expect(audioTrackNotice({ lang: "de", ch: 2 }, 1, t)).toBe("Audio: German Stereo")
	})

	it("names a subtitle track, or says subtitles are off", () => {
		expect(subtitleTrackName({ lang: "de", forced: false, hi: false }, t)).toBe("German")
		expect(subtitleTrackNotice({ lang: "de", forced: false, hi: false }, t)).toBe("Subtitles: German")
		expect(subtitleTrackNotice({ lang: "en", forced: true, hi: true }, t)).toBe("Subtitles: English · Forced · SDH")
		expect(subtitleTrackNotice({ lang: null, forced: false, hi: false }, t)).toBe("Subtitles: Unknown language")
		expect(subtitleTrackNotice(null, t)).toBe("Subtitles off")
	})
})

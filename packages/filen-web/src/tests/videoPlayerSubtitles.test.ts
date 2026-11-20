import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CueBuilder, MAX_CONCURRENT_CUES, type VideoProbe } from "@filen/shared/videos"
import {
	DEFAULT_SUBTITLE_STYLE,
	clampSubtitleDelay,
	cueSegments,
	formatSubtitleDelay,
	normalizeSubtitleStyle,
	subtitleCss,
	subtitleRegionsAt,
	subtitleRegionsKey
} from "@/lib/media/subtitles/subtitleStyle.logic"
import {
	decodeRememberedSubtitle,
	encodeRememberedSubtitle,
	parseFormatOf,
	resolveSubtitleChoice,
	embeddedTrackNumber,
	restoreSubtitleTrack,
	subtitleChoiceFor,
	subtitleTracksOf
} from "@/features/videos/lib/player/subtitles.logic"
import type { VideoPartView } from "@/workers/videoIndex/view.logic"

const { kvStore, kvSetJson } = vi.hoisted(() => {
	const store = new Map<string, unknown>()

	return {
		kvStore: store,
		kvSetJson: vi.fn((key: string, value: unknown) => {
			store.set(key, value)

			return Promise.resolve()
		})
	}
})

vi.mock("@/lib/storage/adapter", async () => {
	const { type } = await import("arktype")

	return {
		kvGetJson: (key: string, schema: (value: unknown) => unknown) => {
			const parsed = kvStore.has(key) ? schema(kvStore.get(key)) : null

			return Promise.resolve(parsed instanceof type.errors ? null : parsed)
		},
		kvSetJson
	}
})

function store() {
	const builder = new CueBuilder()

	builder.add(1, 3, "Hello <i>there</i>")
	builder.add(2, 4, "Second &amp; line")
	builder.add(2.5, 3.5, "On top", 8)
	builder.add(10, 12, "Later")

	return builder.finish()
}

describe("subtitle overlay cues", () => {
	it("shows the cues active at the time, grouped by placement", () => {
		const cues = store()

		expect(subtitleRegionsAt(cues, 0.5, 0)).toEqual([])
		expect(subtitleRegionsAt(cues, 1.5, 0)).toEqual([{ key: "bottom", align: "center", cues: ["Hello <i>there</i>"] }])
		expect(subtitleRegionsAt(cues, 2.7, 0)).toEqual([
			{ key: "bottom", align: "center", cues: ["Hello <i>there</i>", "Second &amp; line"] },
			{ key: "top", align: "center", cues: ["On top"] }
		])
	})

	it("shows the newest of a bounded set of cues when thousands overlap", () => {
		const builder = new CueBuilder()

		// Cue i starts at i * 10 ms and every one runs to three hours.
		for (let i = 0; i < 10_000; i++) {
			builder.add(i / 100, 10_800, `c${String(i)}`)
		}

		const regions = subtitleRegionsAt(builder.finish(), 300, 0)

		expect(regions).toEqual([
			{
				key: "bottom",
				align: "center",
				cues: Array.from({ length: MAX_CONCURRENT_CUES }, (_, i) => `c${String(10_000 - MAX_CONCURRENT_CUES + i)}`)
			}
		])
		expect(subtitleRegionsKey(regions).length).toBeLessThan(MAX_CONCURRENT_CUES * 8)
	})

	it("shows dialogue that starts under a fully layered sign", () => {
		const builder = new CueBuilder()

		for (let layer = 0; layer < MAX_CONCURRENT_CUES; layer++) {
			builder.add(10, 15, `sign ${String(layer)}`, 8)
		}

		builder.add(11, 14, "Dialogue")

		const regions = subtitleRegionsAt(builder.finish(), 12, 0)

		expect(regions.find(region => region.key === "bottom")?.cues).toEqual(["Dialogue"])
		expect(regions.find(region => region.key === "top")?.cues).toHaveLength(MAX_CONCURRENT_CUES - 1)
	})

	it("applies the delay (positive shows them later)", () => {
		const cues = store()

		expect(subtitleRegionsAt(cues, 1.5, 1)).toEqual([])
		expect(subtitleRegionsAt(cues, 11, 1)[0]?.cues).toEqual(["Later"])
		expect(subtitleRegionsAt(cues, 9.5, -1)[0]?.cues).toEqual(["Later"])
	})

	it("keys what shows, so an unchanged frame doesn't re-render", () => {
		const cues = store()

		expect(subtitleRegionsKey(subtitleRegionsAt(cues, 1.2, 0))).toBe(subtitleRegionsKey(subtitleRegionsAt(cues, 1.8, 0)))
		expect(subtitleRegionsKey(subtitleRegionsAt(cues, 1.8, 0))).not.toBe(subtitleRegionsKey(subtitleRegionsAt(cues, 2.2, 0)))
	})

	it("turns cue markup into text runs, never HTML", () => {
		expect(cueSegments("Hello <i>there</i> &amp; <b>you</b>&lt;3")).toEqual([
			{ text: "Hello ", italic: false, bold: false, underline: false },
			{ text: "there", italic: true, bold: false, underline: false },
			{ text: " & ", italic: false, bold: false, underline: false },
			{ text: "you", italic: false, bold: true, underline: false },
			{ text: "<3", italic: false, bold: false, underline: false }
		])
		expect(cueSegments("<script>alert(1)</script>")).toEqual([
			{ text: "<script>alert(1)</script>", italic: false, bold: false, underline: false }
		])
	})
})

describe("subtitle style", () => {
	it("normalizes stored values and maps them to CSS", () => {
		expect(normalizeSubtitleStyle({ ...DEFAULT_SUBTITLE_STYLE, size: 99, position: -1 })).toEqual(DEFAULT_SUBTITLE_STYLE)
		expect(subtitleCss({ ...DEFAULT_SUBTITLE_STYLE, size: 5, color: "yellow", background: "solid" })).toMatchObject({
			scale: 2.2,
			color: "#fde047",
			background: "rgb(0 0 0 / 0.9)"
		})
	})

	it("clamps and formats the delay in 0.1 s steps up to ±30 s", () => {
		expect(clampSubtitleDelay(0.1 + 0.2)).toBe(0.3)
		expect(clampSubtitleDelay(45)).toBe(30)
		expect(clampSubtitleDelay(-45)).toBe(-30)
		expect(clampSubtitleDelay(Number.NaN)).toBe(0)
		expect(formatSubtitleDelay(0.3)).toBe("+0.3 s")
		expect(formatSubtitleDelay(-1.26)).toBe("−1.3 s")
		expect(formatSubtitleDelay(0)).toBe("0.0 s")
	})

	describe("persistence", () => {
		beforeEach(() => {
			kvStore.clear()
			vi.resetModules()
		})

		afterEach(() => {
			vi.resetModules()
		})

		it("loads the stored style and writes changes normalized", async () => {
			kvStore.set("media.subtitles.v1", { ...DEFAULT_SUBTITLE_STYLE, color: "cyan" })

			const module = await import("@/lib/media/subtitles/subtitleStyle")

			await module.warmSubtitleStyle()

			expect(module.useSubtitleStyleStore.getState().color).toBe("cyan")

			module.setSubtitleStyle({ size: 42, edge: "shadow" })

			expect(module.useSubtitleStyleStore.getState()).toMatchObject({
				size: DEFAULT_SUBTITLE_STYLE.size,
				edge: "shadow",
				color: "cyan"
			})
			expect(kvStore.get("media.subtitles.v1")).toMatchObject({ edge: "shadow", size: DEFAULT_SUBTITLE_STYLE.size })
		})

		it("falls back to the default for a malformed record, and a change made first wins", async () => {
			kvStore.set("media.subtitles.v1", { size: "big" })

			const module = await import("@/lib/media/subtitles/subtitleStyle")
			const warming = module.warmSubtitleStyle()

			module.setSubtitleStyle({ color: "green" })
			await warming

			expect(module.useSubtitleStyleStore.getState().color).toBe("green")
		})
	})
})

function file(stableUuid: string) {
	return { stableUuid, uuid: `${stableUuid}-u`, name: `${stableUuid}.srt`, size: 100 }
}

const PART: VideoPartView = {
	file: { stableUuid: "v", uuid: "v-u", name: "Movie.mkv", size: 1000 },
	container: "mkv",
	unsupported: false,
	height: 1080,
	subtitles: [
		{ file: file("en"), format: "srt", language: "eng", forced: false, sdh: false, isDefault: false, title: "" },
		{ file: file("de-forced"), format: "srt", language: "ger", forced: true, sdh: false, isDefault: false, title: "" },
		{ file: file("pgs"), format: "pgs", language: "fre", forced: false, sdh: false, isDefault: false, title: "" }
	],
	nfo: null,
	thumb: null,
	edl: null
}

const PROBE: VideoProbe = {
	v: 1,
	container: "mkv",
	durationSec: 60,
	index: "cues",
	video: null,
	audio: [],
	subs: [
		{ id: 3, codecId: "S_TEXT/UTF8", lang: "jpn", name: "Signs", def: false, forced: false, hi: false },
		{ id: 4, codecId: "S_HDMV/PGS", lang: "eng", name: null, def: false, forced: false, hi: false }
	],
	chapters: [],
	cover: null,
	coverLand: null,
	partial: false
}

describe("subtitle choices", () => {
	const tracks = subtitleTracksOf(PART, PROBE)

	it("lists sidecars first, then the file's own tracks, marking what can't be shown", () => {
		expect(tracks.map(track => [track.id, track.unavailable])).toEqual([
			["s:en", null],
			["s:de-forced", null],
			["s:pgs", "image"],
			["e:3", null],
			["e:4", "image"]
		])
	})

	it("Smart shows a preferred language under foreign audio, and only forced ones under preferred audio", () => {
		const base = { choice: { kind: "auto" } as const, tracks, userLanguages: ["en-US"], remembered: null }

		expect(resolveSubtitleChoice({ ...base, audioLang: "jpn" })?.id).toBe("s:en")
		expect(resolveSubtitleChoice({ ...base, audioLang: "eng" })).toBeNull()
		expect(resolveSubtitleChoice({ ...base, audioLang: "ger", userLanguages: ["de"] })?.id).toBe("s:de-forced")
	})

	it("follows the series' remembered choice, off included, and never picks an unavailable track", () => {
		const base = { choice: { kind: "auto" } as const, tracks, userLanguages: ["en"], audioLang: "jpn" }

		expect(resolveSubtitleChoice({ ...base, remembered: "none" })).toBeNull()
		expect(resolveSubtitleChoice({ ...base, remembered: decodeRememberedSubtitle("ger|f") })?.id).toBe("s:de-forced")
		expect(resolveSubtitleChoice({ ...base, choice: { kind: "track", id: "e:4" }, remembered: null })).toBeNull()
		expect(resolveSubtitleChoice({ ...base, choice: { kind: "track", id: "e:3" }, remembered: null })?.id).toBe("e:3")
		expect(resolveSubtitleChoice({ ...base, choice: { kind: "off" }, remembered: null })).toBeNull()
	})

	it("remembers a choice as language and flags, never as an index", () => {
		const forced = tracks.find(track => track.forced) ?? null

		expect(encodeRememberedSubtitle(forced)).toBe("de|f")
		expect(encodeRememberedSubtitle(null)).toBeNull()
		expect(decodeRememberedSubtitle("ger|f")).toEqual({ lang: "de", forced: true, hi: false })
		expect(decodeRememberedSubtitle(null)).toBe("none")
		expect(decodeRememberedSubtitle(undefined)).toBeNull()
		expect(decodeRememberedSubtitle("und|h")).toEqual({ lang: null, forced: false, hi: true })
	})

	it("parses each sidecar format with its parser", () => {
		expect(parseFormatOf("ssa")).toBe("ass")
		expect(parseFormatOf("microdvd")).toBe("sub")
		expect(parseFormatOf("vobsub")).toBeNull()
	})
})

describe("embedded text subtitles", () => {
	const forcedEnglish: VideoProbe = {
		...PROBE,
		subs: [
			{ id: 3, codecId: "S_TEXT/UTF8", lang: "eng", name: null, def: false, forced: true, hi: false },
			{ id: 4, codecId: "S_TEXT/ASS", lang: "jpn", name: null, def: false, forced: false, hi: false }
		]
	}
	const bare: VideoPartView = { ...PART, subtitles: [] }

	it("are offered from a Matroska file for its text codecs", () => {
		expect(subtitleTracksOf(bare, forcedEnglish).map(track => track.unavailable)).toEqual([null, null])
	})

	it("are offered from an MP4 for timed text and WebVTT, but not from a fragmented one", () => {
		const mp4: VideoProbe = {
			...PROBE,
			container: "mp4",
			index: "moov",
			subs: [
				{ id: 2, codecId: "tx3g", lang: "eng", name: "English", def: true, forced: false, hi: false },
				{ id: 3, codecId: "wvtt", lang: "ger", name: null, def: false, forced: false, hi: false },
				{ id: 4, codecId: "stpp", lang: "fre", name: null, def: false, forced: false, hi: false },
				{ id: 5, codecId: "mp4s", lang: "spa", name: null, def: false, forced: false, hi: false },
				{ id: 6, codecId: "S_TEXT/UTF8", lang: "ita", name: null, def: false, forced: false, hi: false }
			]
		}

		expect(subtitleTracksOf(bare, mp4).map(track => track.unavailable)).toEqual([null, null, "embedded", "image", "embedded"])
		expect(subtitleTracksOf(bare, { ...mp4, container: "mov", index: null }).map(track => track.unavailable)).toEqual([
			null,
			null,
			"embedded",
			"image",
			"embedded"
		])
		expect(subtitleTracksOf(bare, { ...mp4, index: "mfra" }).map(track => track.unavailable)).toEqual([
			"embedded",
			"embedded",
			"embedded",
			"image",
			"embedded"
		])
		expect(subtitleTracksOf(bare, { ...mp4, container: "ts" }).map(track => track.unavailable)[0]).toBe("embedded")
	})

	it("Smart shows the file's forced foreign dialogue under audio in a preferred language", () => {
		const picked = resolveSubtitleChoice({
			choice: { kind: "auto" },
			tracks: subtitleTracksOf(bare, forcedEnglish),
			audioLang: "eng",
			userLanguages: ["en"],
			remembered: null
		})

		expect(picked?.id).toBe("e:3")
		expect(embeddedTrackNumber(picked)).toBe(3)
		expect(embeddedTrackNumber(subtitleTracksOf(PART, null)[0] ?? null)).toBeNull()
	})
})

describe("subtitle toggling and per-item choice", () => {
	const tracks = subtitleTracksOf(PART, PROBE)
	const english = tracks.find(track => track.id === "s:en") ?? null

	it("C brings back the track shown last, or one in its language with the same flags on another item", () => {
		expect(restoreSubtitleTrack(tracks, english)?.id).toBe("s:en")

		const nextEpisode = subtitleTracksOf(
			{
				...PART,
				subtitles: [{ file: file("en-2"), format: "srt", language: "en", forced: false, sdh: false, isDefault: false, title: "" }]
			},
			null
		)

		expect(restoreSubtitleTrack(nextEpisode, english)?.id).toBe("s:en-2")
		expect(restoreSubtitleTrack(nextEpisode, tracks.find(track => track.id === "s:de-forced") ?? null)).toBeNull()
		expect(restoreSubtitleTrack(tracks, null)).toBeNull()
	})

	it("a choice holds for its item only; the next one starts from Smart", () => {
		const state = { key: "ep1", choice: { kind: "track" as const, id: "s:en" } }

		expect(subtitleChoiceFor(state, "ep1")).toEqual({ kind: "track", id: "s:en" })
		expect(subtitleChoiceFor(state, "ep2")).toEqual({ kind: "auto" })
		expect(subtitleChoiceFor({ key: null, choice: { kind: "off" } }, null)).toEqual({ kind: "auto" })
	})
})

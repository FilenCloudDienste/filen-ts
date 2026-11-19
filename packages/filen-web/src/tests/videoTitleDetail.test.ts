import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DirsAndFiles } from "@filen/sdk-rs"
import {
	activeLibraryOverrides,
	emptyLibraryConfig,
	newSeriesId,
	selectSeriesPrimaryAction,
	rawLibraryOverride,
	splitOverrideKey,
	withLibraryOverride,
	type LibraryConfigDoc,
	type LibraryOverride,
	type VideoProbe
} from "@filen/shared/videos"
import {
	defaultSeason,
	defaultVersion,
	detailHeaderMode,
	detailSlots,
	entriesByStableUuid,
	extrasShelf,
	ladderBadge,
	moviePrimaryAction,
	seasonKeys,
	seasonLayout,
	seasonProgress,
	seriesButton,
	showsVersionPicker
} from "@/features/videos/lib/titleDetail.logic"
import {
	NEW_SERIES,
	canSplit,
	destinationOf,
	draftErrors,
	draftFor,
	episodeSubject,
	hasCorrection,
	hideEdit,
	mergeEdit,
	overrideFromDraft,
	resetEdit,
	sameOverride,
	splitEdit,
	titleSubject,
	unhideEdit,
	type CorrectionSubject
} from "@/features/videos/lib/corrections.logic"
import { buildVideoHomeIndex } from "@/features/videos/lib/titleWatch.logic"
import { VideoIndexEngine, type SnapshotStore } from "@/workers/videoIndex/engine"
import type {
	VideoEpisodeView,
	VideoExtraView,
	VideoHomeItem,
	VideoPartView,
	VideoSeasonView,
	VideoTitleView,
	VideoVersionView
} from "@/workers/videoIndex/view.logic"
import { episodeItem, movieItem, progress, title, watched } from "@/tests/support/videoHome"
import { FakeDrive, hexUuid } from "@/tests/support/videoDrive"
import { memoryCatalogStore, trackCatalogTitles } from "@/tests/support/videoIndex"

const NOW = Date.UTC(2026, 9, 1, 20, 0)

function part(stableUuid: string, patch: Partial<VideoPartView> = {}): VideoPartView {
	return {
		file: { stableUuid, uuid: `${stableUuid}-u`, name: `${stableUuid}.mkv`, size: 100 },
		container: "mkv",
		unsupported: false,
		height: 0,
		subtitles: [],
		nfo: null,
		thumb: null,
		edl: null,
		...patch
	}
}

function version(stableUuid: string, label = ""): VideoVersionView {
	return { label, parts: [part(stableUuid)] }
}

function probe(patch: Partial<VideoProbe> = {}): VideoProbe {
	return {
		v: 1,
		container: "mkv",
		durationSec: 2 * 3600 + 44 * 60,
		index: "cues",
		video: { codec: "hevc", fourcc: "hvc1", codecString: null, w: 3840, h: 2160, par: 1, rotation: 0, bitDepth: 10, transfer: "pq" },
		audio: [
			{
				id: 1,
				codec: "eac3",
				codecString: null,
				ch: 6,
				rate: 48000,
				lang: "eng",
				name: null,
				def: true,
				forced: false,
				commentary: false
			}
		],
		subs: [{ id: 2, codecId: "S_TEXT/UTF8", lang: "eng", name: null, def: false, forced: false, hi: false }],
		chapters: [],
		cover: null,
		coverLand: null,
		partial: false,
		...patch
	}
}

function indexOf(items: VideoHomeItem[], records: Parameters<typeof buildVideoHomeIndex>[0]["watchItems"] = {}) {
	return buildVideoHomeIndex({ items, watchItems: records, lastPlayedCeilingMs: undefined, durationOf: () => null })
}

function season(number: number, episodes: number): VideoSeasonView {
	return {
		number,
		dirUuid: `season-${String(number)}`,
		poster: null,
		backdrop: null,
		nfo: null,
		episodes: Array.from({ length: episodes }, (_, i) => ({
			season: number,
			episode: i + 1,
			episodeEnd: i + 1,
			date: 0,
			title: "",
			dateAdded: 0,
			versions: [version(`show-s${String(number)}e${String(i + 1)}-v`)]
		}))
	}
}

describe("movie page decisions", () => {
	it("uses the cinematic header only for a real backdrop", () => {
		expect(detailHeaderMode(title("a"))).toBe("band")
		expect(detailHeaderMode(title("a", { backdrop: { stableUuid: "f", uuid: "f", name: "fanart.jpg", size: 1 } }))).toBe("backdrop")
	})

	it("reserves every probe-dependent slot while the probe is out, then fills or empties each for good", () => {
		const pending = detailSlots({ probe: undefined, part: part("m"), height: 0, nfoRuntimeMinutes: null, resumeSec: 0, now: NOW })
		const ready = detailSlots({ probe: probe(), part: part("m"), height: 0, nfoRuntimeMinutes: null, resumeSec: 600, now: NOW })
		const none = detailSlots({ probe: null, part: part("m"), height: 1080, nfoRuntimeMinutes: 101, resumeSec: 0, now: NOW })

		// The same slots in every state, so nothing below them moves when the probe lands.
		expect(Object.keys(pending)).toEqual(Object.keys(ready))
		expect([pending.runtimeSec, pending.badges, pending.endsAtMs, pending.tracks].every(slot => slot.state === "pending")).toBe(true)
		expect(ready).toEqual({
			runtimeSec: { state: "ready", value: 9840 },
			badges: { state: "ready", value: ["4K", "HDR", "5.1", "CC"] },
			endsAtMs: { state: "ready", value: NOW + (9840 - 600) * 1000 },
			tracks: { state: "ready", value: true }
		})
		// No probe to be had: the NFO's runtime and the name's resolution, the rest empty.
		expect(none).toEqual({
			runtimeSec: { state: "ready", value: 6060 },
			badges: { state: "ready", value: ["1080p"] },
			endsAtMs: { state: "ready", value: NOW + 6060 * 1000 },
			tracks: { state: "empty" }
		})
		// An NFO runtime shows before the probe.
		expect(detailSlots({ probe: undefined, part: null, height: 0, nfoRuntimeMinutes: 90, resumeSec: 0, now: NOW }).runtimeSec).toEqual({
			state: "ready",
			value: 5400
		})
		expect(
			detailSlots({
				probe: probe({ video: { ...probe().video, transfer: "pq", dv: { profile: 8, compat: 1 } } as VideoProbe["video"] }),
				part: null,
				height: 0,
				nfoRuntimeMinutes: null,
				resumeSec: 0,
				now: NOW
			}).badges
		).toEqual({
			state: "ready",
			value: ["4K", "DV", "5.1", "CC"]
		})
	})

	it("offers Resume with its bar for the chosen version's resume point, Play otherwise", () => {
		const item = movieItem("m")
		const index = indexOf([item], Object.fromEntries([progress(item, { pos: 2530, dur: 6000, at: NOW - 1000 })]))
		const entries = entriesByStableUuid(index)

		expect(moviePrimaryAction("m-v", entries.get("m-v"))).toEqual({
			kind: "resume",
			stableUuid: "m-v",
			positionSec: 2530,
			durationSec: 6000,
			progress: 2530 / 6000,
			remainingSec: 3470
		})
		expect(moviePrimaryAction("other-v", entries.get("other-v"))).toEqual({ kind: "play", stableUuid: "other-v" })
	})

	it("opens on the version played last and shows the picker only with two or more", () => {
		const a = movieItem("m", { stableUuid: "a", uuid: "a-u", group: "m" })
		const b = movieItem("m", { stableUuid: "b", uuid: "b-u", group: "m" })
		const entries = entriesByStableUuid(indexOf([a, b], Object.fromEntries([watched(b, NOW - 5000)])))
		const versions = [version("a", "1080p"), version("b", "4K")]

		expect(defaultVersion(versions, entries)).toBe(1)
		expect(defaultVersion(versions, new Map())).toBe(0)
		expect(showsVersionPicker([version("a")])).toBe(false)
		expect(showsVersionPicker(versions)).toBe(true)
		expect(["direct", "remux", "remux+transcode", "video-only", "unsupported"].map(path => ladderBadge(path as never))).toEqual([
			"direct",
			"remux",
			"remux",
			"remux",
			"unsupported"
		])
	})

	it("orders the extras shelf by type, keeping name order within a type", () => {
		const extra = (type: VideoExtraView["type"], name: string): VideoExtraView => ({ type, title: name, part: part(name) })
		const shelf = extrasShelf([
			extra("deletedScene", "D1"),
			extra("unknown", "U"),
			extra("trailer", "T2"),
			extra("featurette", "F"),
			extra("trailer", "T1"),
			extra("behindTheScenes", "B")
		])

		expect(shelf.map(item => item.title)).toEqual(["T2", "T1", "F", "B", "D1", "U"])
	})
})

describe("series page decisions", () => {
	const items = [1, 2, 3].map(e => episodeItem("show", 1, e)).concat([1, 2].map(e => episodeItem("show", 2, e)))

	it("uses tabs up to six seasons, a select past that, and keeps specials apart", () => {
		const six = seasonLayout([season(0, 2), ...[1, 2, 3, 4, 5, 6].map(n => season(n, 1))])
		const seven = seasonLayout([1, 2, 3, 4, 5, 6, 7].map(n => season(n, 1)))

		expect(six.selector).toBe("tabs")
		expect(six.regular.map(item => item.number)).toEqual([1, 2, 3, 4, 5, 6])
		expect(six.specials?.number).toBe(0)
		expect(seven.selector).toBe("select")
		expect(seasonLayout([season(1, 3)]).selector).toBe("none")
	})

	it("opens on the Next Up season, else the season last viewed, else the first", () => {
		const nextUp = selectSeriesPrimaryAction({
			index: indexOf(
				items,
				Object.fromEntries([1, 2, 3].map(e => watched(items[e - 1] ?? items[0] ?? movieItem("x"), NOW - e * 1000)))
			),
			seriesId: "show"
		})
		const fresh = selectSeriesPrimaryAction({ index: indexOf(items), seriesId: "show" })

		expect(defaultSeason({ regular: [1, 2], action: nextUp, lastViewed: 1 })).toBe(2)
		expect(defaultSeason({ regular: [1, 2], action: fresh, lastViewed: 2 })).toBe(2)
		expect(defaultSeason({ regular: [1, 2], action: fresh, lastViewed: 9 })).toBe(1)
		expect(defaultSeason({ regular: [], action: null, lastViewed: null })).toBeNull()
	})

	it("labels the smart button from Next Up: Resume with time left, Play the next one, or Play", () => {
		const [e1, e2] = items
		const resumeIndex = indexOf(
			items,
			Object.fromEntries([
				...(e1 === undefined ? [] : [watched(e1, NOW - 9000)]),
				...(e2 === undefined ? [] : [progress(e2, { pos: 600, dur: 1860, at: NOW - 1000 })])
			])
		)
		const nextIndex = indexOf(items, Object.fromEntries(e1 === undefined ? [] : [watched(e1, NOW - 9000)]))

		expect(seriesButton(selectSeriesPrimaryAction({ index: resumeIndex, seriesId: "show" }))).toEqual({
			kind: "resume",
			stableUuid: e2?.stableUuid,
			season: 1,
			episode: 2,
			remainingSec: 1260
		})
		expect(seriesButton(selectSeriesPrimaryAction({ index: nextIndex, seriesId: "show" }))).toEqual({
			kind: "next",
			stableUuid: e2?.stableUuid,
			season: 1,
			episode: 2
		})
		expect(seriesButton(selectSeriesPrimaryAction({ index: indexOf(items), seriesId: "show" }))).toEqual({
			kind: "play",
			stableUuid: e1?.stableUuid
		})
	})

	it("counts a season's unwatched episodes and marks it with every version in one edit", () => {
		const one = season(1, 3)
		const first = one.episodes[0]

		if (first !== undefined) {
			first.versions.push(version("show-s1e1-720"))
		}

		const item = episodeItem("show", 1, 1)
		const entries = entriesByStableUuid(indexOf([item], Object.fromEntries([watched(item, NOW)])))

		expect(seasonKeys(one)).toEqual(["show-s1e1-v", "show-s1e1-720", "show-s1e2-v", "show-s1e3-v"])
		expect(seasonProgress(one, entries)).toEqual({ unwatched: 2, watched: false })
		expect(seasonProgress(season(1, 1), entries)).toEqual({ unwatched: 0, watched: true })
	})
})

describe("manual corrections", () => {
	const plain = { year: 0, season: 0, episode: 0, episodeEnd: 0, seriesKey: "" }
	const movie: CorrectionSubject = {
		key: "d:dir",
		original: { ...plain, kind: "movie", title: "Heat", year: 1995 },
		seriesId: "",
		mergeKey: "",
		autoMergedRoots: 1
	}
	const episode: CorrectionSubject = {
		key: "s:ep",
		original: { ...plain, kind: "episode", title: "Pilot", season: 1, episode: 1, episodeEnd: 1, seriesKey: "d:show" },
		seriesId: "",
		mergeKey: "",
		autoMergedRoots: 1
	}
	const series: CorrectionSubject = {
		key: "d:show",
		original: { ...plain, kind: "series", title: "Show", year: 2020 },
		seriesId: "show",
		mergeKey: "show|2020",
		autoMergedRoots: 2
	}
	// Saving the dialog as it opens: what a re-save without changes stores.
	const resave = (subject: CorrectionSubject, stored: LibraryOverride & Record<string, unknown>) =>
		overrideFromDraft({ subject, draft: draftFor(subject, stored), raw: stored })

	it("stores only what differs from the classifier, and nothing when nothing does", () => {
		expect(overrideFromDraft({ subject: movie, draft: draftFor(movie, null), raw: null })).toBeNull()
		expect(
			overrideFromDraft({
				subject: movie,
				draft: { ...draftFor(movie, null), title: "Heat (Director's Cut)", year: "1996" },
				raw: null
			})
		).toEqual({
			title: "Heat (Director's Cut)",
			year: 1996
		})
		expect(overrideFromDraft({ subject: movie, draft: { ...draftFor(movie, null), kind: "other", hidden: true }, raw: null })).toEqual({
			kind: "other",
			hidden: true
		})
	})

	it("keeps every stored field, unknown ones included, when saved again unchanged", () => {
		const stored: [CorrectionSubject, LibraryOverride & Record<string, unknown>][] = [
			[movie, { title: "Heat!", year: 1996, hidden: true, future: { x: 1 } }],
			[movie, { kind: "episode", season: 2, episode: 5, episodeEnd: 6, mergeInto: "d:other", title: "Ep" }],
			[movie, { kind: "other", hidden: true }],
			[episode, { kind: "movie", year: 2001, title: "Not an episode" }],
			[episode, { kind: "episode", season: 3, episode: 4 }],
			[episode, { mergeInto: "d:elsewhere" }],
			[series, { title: "The Show", year: 2021, mergeInto: "d:x", split: true, hidden: true }]
		]

		for (const [subject, current] of stored) {
			expect(resave(subject, current)).toEqual(current)
		}
	})

	it("drops a field set back to the classifier's value, keeping the rest", () => {
		const current = { title: "Heat!", year: 1996, future: 1 }

		expect(overrideFromDraft({ subject: movie, draft: { ...draftFor(movie, current), title: "Heat" }, raw: current })).toEqual({
			year: 1996,
			future: 1
		})
		expect(
			overrideFromDraft({
				subject: episode,
				draft: { ...draftFor(episode, { kind: "movie" }), kind: "episode" },
				raw: { kind: "movie" }
			})
		).toBeNull()
	})

	it("requires a season and episode number (and an end not before it) to show something as an episode", () => {
		const draft = { ...draftFor(movie, null), kind: "episode" as const }

		expect(draftErrors(movie, draft)).toEqual(["season", "episode"])
		expect(draftErrors(movie, { ...draft, season: "1", episode: "0" })).toEqual(["episode"])
		expect(draftErrors(movie, { ...draft, season: "1", episode: "4", episodeEnd: "3" })).toEqual(["episode"])
		expect(draftErrors(movie, { ...draftFor(movie, null), year: "12" })).toEqual(["year"])
		expect(
			overrideFromDraft({ subject: movie, draft: { ...draft, season: "2", episode: "5", series: NEW_SERIES }, raw: null })
		).toEqual({
			kind: "episode",
			season: 2,
			episode: 5
		})
		expect(
			overrideFromDraft({
				subject: movie,
				draft: { ...draft, season: "2", episode: "5", episodeEnd: "6", series: "d:show" },
				raw: null
			})
		).toEqual({
			kind: "episode",
			season: 2,
			episode: 5,
			episodeEnd: 6,
			mergeInto: "d:show"
		})
	})

	it("checks the year only where the dialog shows it (a movie's or a series')", () => {
		const draft = { ...draftFor(movie, null), year: "19" }

		expect(draftErrors(movie, draft)).toEqual(["year"])
		expect(draftErrors(movie, { ...draft, kind: "episode", season: "1", episode: "2" })).toEqual([])
		expect(draftErrors(movie, { ...draft, kind: "other" })).toEqual([])
		expect(draftErrors(series, { ...draftFor(series, null), year: "19" })).toEqual(["year"])
		expect(draftErrors(movie, { ...draft, year: "", title: "  " })).toEqual(["title"])
	})

	it("follows a saved item to the title it is shown as now", () => {
		const draft = draftFor(movie, null)

		expect(destinationOf(series, draftFor(series, null))).toBeNull()
		expect(destinationOf(movie, draft)).toBe("dir")
		expect(destinationOf(movie, { ...draft, kind: "other" })).toBe("dir")
		expect(destinationOf(movie, { ...draft, kind: "episode", series: NEW_SERIES })).toBe(newSeriesId("dir"))
		expect(destinationOf(movie, { ...draft, kind: "episode", series: "d:show" })).toBe("show")
		expect(destinationOf(episode, draftFor(episode, null))).toBe("show")
	})

	it("builds a title's subject from its detail, under its own key unless the index names another", () => {
		const twoVersions = { kind: "movie" as const, versions: [version("m1"), version("m1-cut")], extras: [], nfo: null }

		// A movie without a directory of its own has one of its files' stable uuids as its id.
		expect(titleSubject({ ...twoVersions, title: title("m1", { year: 1995 }) })).toEqual({
			key: "s:m1",
			original: { ...plain, kind: "movie", title: "m1", year: 1995 },
			seriesId: "",
			mergeKey: "",
			autoMergedRoots: 1
		})
		expect(titleSubject({ ...twoVersions, title: title("dir") }).key).toBe("d:dir")
		expect(titleSubject({ ...twoVersions, title: title("m1"), overrideKey: "d:elsewhere", original: movie.original })).toMatchObject({
			key: "d:elsewhere",
			original: movie.original,
			mergeKey: ""
		})

		const show = title("show", { kind: "series", title: "Show", year: 2020, mergeKey: "show|2020" })
		const seriesDetail = { kind: "series" as const, title: show, seasons: [], extras: [], nfo: null }

		expect(titleSubject({ ...seriesDetail, autoMergedRoots: 2 })).toEqual(series)
		expect(titleSubject(seriesDetail)).toMatchObject({ key: "d:show", seriesId: "show", mergeKey: "show|2020", autoMergedRoots: 1 })
		expect(titleSubject({ ...seriesDetail, overrideKey: "d:root-b", original: series.original }).key).toBe("d:root-b")
	})

	it("builds an episode's subject from its first file, and none for an episode without files", () => {
		const view: VideoEpisodeView = {
			season: 1,
			episode: 1,
			episodeEnd: 1,
			date: 0,
			title: "Pilot",
			dateAdded: 0,
			versions: [version("ep"), version("ep-hd")]
		}

		expect(episodeSubject("show", view)).toEqual(episode)
		expect(episodeSubject("show", { ...view, overrideKey: "s:moved", original: episode.original })).toMatchObject({
			key: "s:moved",
			original: episode.original
		})
		expect(episodeSubject("show", { ...view, versions: [] })).toBeNull()
	})

	it("resets a split series completely, and leaves other titles' splits alone", () => {
		let doc: LibraryConfigDoc = withLibraryOverride({
			doc: emptyLibraryConfig(),
			key: series.key,
			override: { title: "The Show" },
			stamp: { t: 1, d: "w" },
			at: 1
		})

		doc = splitEdit(series)(doc, { t: 2, d: "w" })
		doc = splitEdit({ seriesId: "other", mergeKey: "other|1999", autoMergedRoots: 2 })(doc, { t: 3, d: "w" })

		expect(hasCorrection(doc, series)).toBe(true)
		// The split alone is something Reset removes too.
		expect(hasCorrection(withLibraryOverride({ doc, key: series.key, override: null, stamp: { t: 4, d: "w" }, at: 4 }), series)).toBe(
			true
		)

		const reset = resetEdit(series)(doc, { t: 5, d: "w" })

		expect(rawLibraryOverride(reset, series.key)).toBeNull()
		expect(rawLibraryOverride(reset, splitOverrideKey("show|2020"))).toBeNull()
		expect(rawLibraryOverride(reset, splitOverrideKey("other|1999"))).toEqual({ split: true })
		expect(hasCorrection(reset, series)).toBe(false)

		const withMovie = withLibraryOverride({ doc, key: movie.key, override: { title: "Heat!" }, stamp: { t: 6, d: "w" }, at: 6 })

		expect(hasCorrection(withMovie, movie)).toBe(true)

		const movieReset = resetEdit(movie)(withMovie, { t: 7, d: "w" })

		expect(hasCorrection(movieReset, movie)).toBe(false)
		expect(activeLibraryOverrides(movieReset)).toEqual(activeLibraryOverrides(doc))
	})

	it("moves an episode to another series, renumbers it as a whole, or makes it a movie", () => {
		const draft = draftFor(episode, null)

		expect(draft).toMatchObject({ kind: "episode", series: "d:show", season: "1", episode: "1", episodeEnd: "", year: "" })
		expect(overrideFromDraft({ subject: episode, draft: { ...draft, series: "d:other" }, raw: null })).toEqual({ mergeInto: "d:other" })
		expect(overrideFromDraft({ subject: episode, draft: { ...draft, episode: "3" }, raw: null })).toEqual({
			kind: "episode",
			season: 1,
			episode: 3
		})
		expect(overrideFromDraft({ subject: episode, draft: { ...draft, kind: "movie", year: "2001" }, raw: null })).toEqual({
			kind: "movie",
			year: 2001
		})
	})

	it("merges, splits, hides and unhides through the configuration, carrying unknown fields", () => {
		const stamp = { t: 1, d: "w" }
		let doc: LibraryConfigDoc = withLibraryOverride({
			doc: emptyLibraryConfig(),
			key: "d:b",
			override: { title: "B!", future: [1] },
			stamp,
			at: 1
		})

		doc = mergeEdit("b", "show")(doc, { t: 2, d: "w" })
		doc = mergeEdit("c", "show")(doc, { t: 3, d: "w" })

		expect(rawLibraryOverride(doc, "d:b")).toEqual({ title: "B!", future: [1], mergeInto: "d:show" })
		expect(canSplit({ doc, subject: { ...series, autoMergedRoots: 1 } })).toBe(true)
		expect(canSplit({ doc: emptyLibraryConfig(), subject: { ...series, autoMergedRoots: 1 } })).toBe(false)
		// Series that only met through a manual merge are taken apart without a split being stored.
		expect(activeLibraryOverrides(splitEdit({ ...series, autoMergedRoots: 1 })(doc, { t: 4, d: "w" }))).toEqual({
			"d:b": { title: "B!" }
		})

		doc = splitEdit(series)(doc, { t: 4, d: "w" })

		// The split is stored by merge key, not by whichever root's id the merge took.
		expect(activeLibraryOverrides(doc)).toEqual({ "d:b": { title: "B!" }, [splitOverrideKey("show|2020")]: { split: true } })

		doc = withLibraryOverride({ doc, key: "s:m", override: { kind: "movie", title: "M", next: true }, stamp: { t: 5, d: "w" }, at: 5 })
		doc = hideEdit("s:m", true)(doc, { t: 6, d: "w" })

		expect(rawLibraryOverride(doc, "s:m")).toEqual({ kind: "movie", title: "M", next: true, hidden: true })

		doc = unhideEdit("m")(doc, { t: 7, d: "w" })

		expect(rawLibraryOverride(doc, "s:m")).toEqual({ kind: "movie", title: "M", next: true })
	})

	it("tells a re-save that changes nothing apart from a real change", () => {
		expect(sameOverride({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true)
		expect(sameOverride({ a: 1 }, null)).toBe(false)
	})
})

describe("corrections in the library index", () => {
	let drive: FakeDrive
	let titles: Map<string, VideoTitleView>

	const store: SnapshotStore = {
		readSlot: () => Promise.resolve(null),
		readGenerations: () => Promise.resolve([null, null]),
		write: () => Promise.resolve(),
		readWatermark: () => Promise.resolve(null),
		writeWatermark: () => Promise.resolve(),
		remove: () => Promise.resolve()
	}

	function engineFor(): VideoIndexEngine {
		const engine = new VideoIndexEngine({
			walkRoot: uuid => {
				const raw: DirsAndFiles = drive.walk(uuid)
				const meta = drive.dirs.get(uuid)?.meta

				return Promise.resolve({ type: "ok", name: meta?.type === "decoded" ? meta.data.name : "", raw, ancestors: [] })
			},
			walkMark: () => 0,
			walkDir: uuid => Promise.resolve(drive.walk(uuid)),
			lastDriveEventId: () => Promise.resolve(50n),
			driveRoot: () => null,
			getFile: uuid => Promise.resolve(drive.files.get(uuid)),
			store,
			catalogStore: memoryCatalogStore(),
			now: () => Date.now(),
			yieldSlice: () => Promise.resolve()
		})

		engine.onSocketEvent({ type: "authSuccess" })
		trackCatalogTitles(engine, titles)

		return engine
	}

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		drive = new FakeDrive()
		titles = new Map()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("reclassifies, retitles and hides as the corrections say, and undoes it when they go", async () => {
		const root = drive.addDir(hexUuid(), "Library")
		const heatDir = drive.addDir(root, "Heat (1995)")
		const heat = drive.addFile(heatDir, "Heat (1995).mkv")
		const clip = drive.addFile(root, "clip.mp4")
		const engine = engineFor()

		await engine.configure([{ uuid: root, type: "auto", enabled: true }])
		await engine.check(50n)
		await vi.advanceTimersByTimeAsync(6_000)

		expect([...titles.values()].map(item => `${item.kind}:${item.title}`).sort()).toEqual(["movie:Heat", "other:clip"])

		const clipId = clip.stableUUID ?? clip.uuid

		engine.setOverrides({
			[`d:${heatDir}`]: { kind: "episode", season: 1, episode: 3, title: "Pilot" },
			[`s:${clipId}`]: { kind: "movie", title: "A Clip", year: 2001, hidden: true }
		})
		await vi.advanceTimersByTimeAsync(100)

		const shown = [...titles.values()]

		expect(shown.map(item => `${item.kind}:${item.title}:${item.hidden === true ? "hidden" : "shown"}`).sort()).toEqual([
			"movie:A Clip:hidden",
			"series:Heat:shown"
		])
		const series = shown.find(item => item.kind === "series")
		const hidden = shown.find(item => item.hidden === true)
		const episode = (await engine.catalogSearch("pilot")).groups.find(group => group.kind === "episodes")?.cards[0]?.item

		// Hidden titles stay out of the home rows, grids and search; the new series' episode is there.
		expect(await engine.catalogMarkTargets(hidden?.id ?? "", null)).toEqual([])
		expect(await engine.catalogMarkTargets(series?.id ?? "", null)).toHaveLength(1)
		expect(episode).toMatchObject({ itemClass: "episode", season: 1, episode: 3 })

		const detail = series === undefined ? null : await engine.titleDetail(series.id)

		// The episode remembers where its correction lives (its directory's key, not its file's).
		expect(detail?.kind === "series" ? detail.seasons[0]?.episodes[0]?.overrideKey : null).toBe(`d:${heatDir}`)
		expect(heat.uuid.length).toBeGreaterThan(0)

		engine.setOverrides({})
		await vi.advanceTimersByTimeAsync(100)

		expect([...titles.values()].map(item => `${item.kind}:${item.title}`).sort()).toEqual(["movie:Heat", "other:clip"])
	})
})

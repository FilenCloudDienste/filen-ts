import { describe, expect, it } from "vitest"
import {
	activeLibraryOverrides,
	applyLibraryOverrides,
	classifyVideoLibrary,
	emptyLibraryConfig,
	newSeriesId,
	parseLibraryConfig,
	splitMergeKeysOf,
	splitOverrideKey,
	rawLibraryOverride,
	titleOverrideKey,
	withLibraryOverride,
	type LibraryOverride,
	type LibraryScanInput
} from "@filen/shared/videos"
import { fixtureInput, summarize, type FixtureRoot } from "./libraryFixture"

function corrected(
	roots: readonly FixtureRoot[],
	overrides: Record<string, LibraryOverride>,
	order?: (input: LibraryScanInput) => LibraryScanInput
) {
	const built: LibraryScanInput = fixtureInput(roots)
	const input = order === undefined ? built : order(built)
	const scan = { ...input, splitMergeKeys: splitMergeKeysOf(overrides) }
	const result = applyLibraryOverrides({
		library: classifyVideoLibrary(scan),
		overrides,
		stableUuidOf: file => input.files[file]?.uuid
	})

	return { ...result, summary: summarize(result.library, input) }
}

const MOVIES: FixtureRoot = {
	name: "M",
	type: "movies",
	paths: ["Heat (1995)/Heat (1995).mkv", "Loose Clip.mp4", "Arrival (2016).mkv"]
}

const SHOWS: FixtureRoot = {
	name: "S",
	type: "shows",
	paths: ["Andor/Season 1/Andor S01E01.mkv", "Andor/Season 1/Andor S01E02.mkv", "Andor/Season 2/Andor S02E01.mkv"]
}

describe("applyLibraryOverrides", () => {
	it("returns the classification untouched without corrections", () => {
		const input = fixtureInput([MOVIES])
		const library = classifyVideoLibrary(input)
		const result = applyLibraryOverrides({ library, overrides: {}, stableUuidOf: file => input.files[file]?.uuid })

		expect(result.library).toBe(library)
		expect(result.hidden.size).toBe(0)
	})

	it("renames a directory's movie and a single-file movie by their keys, with sort names", () => {
		const { library } = corrected([MOVIES], {
			"d:M/Heat (1995)": { title: "Heat: Director's Cut", year: 1996 },
			"s:M/Arrival (2016).mkv": { title: "The Arrival" }
		})
		const heat = library.movies.find(movie => movie.id === "M/Heat (1995)")
		const arrival = library.movies.find(movie => movie.id === "M/Arrival (2016).mkv")

		expect(heat).toMatchObject({ title: "Heat: Director's Cut", year: 1996 })
		expect(arrival).toMatchObject({ title: "The Arrival", sortName: "Arrival", year: 2016 })
	})

	it("keys a title by `s:` only when its id is one of its files", () => {
		expect(titleOverrideKey({ id: "f1", stableUuids: ["f0", "f1"] })).toBe("s:f1")
		expect(titleOverrideKey({ id: "dir", stableUuids: ["f0"] })).toBe("d:dir")
	})

	it("shows a movie as another video and another video as a movie, keeping ids", () => {
		const { library } = corrected([MOVIES], {
			"d:M/Heat (1995)": { kind: "other" },
			"s:M/Loose Clip.mp4": { kind: "movie", title: "Loose", year: 2001 }
		})

		expect(library.movies.map(movie => movie.id).sort()).toEqual(["M/Arrival (2016).mkv", "M/Loose Clip.mp4"])
		expect(library.movies.find(movie => movie.id === "M/Loose Clip.mp4")).toMatchObject({ title: "Loose", year: 2001 })
		expect(library.others.map(other => other.id)).toEqual(["M/Heat (1995)"])
	})

	it("makes a movie an episode of an existing series, keeping its title, or of a new series of its own", () => {
		const into = corrected([MOVIES, SHOWS], {
			"s:M/Arrival (2016).mkv": { kind: "episode", season: 2, episode: 5, mergeInto: "d:S/Andor" }
		})

		expect(into.library.movies.map(movie => movie.id)).not.toContain("M/Arrival (2016).mkv")
		expect(into.summary.series[0]?.seasons[2]).toEqual(["E1  = S/Andor/Season 2/Andor S02E01.mkv", "E5 Arrival = M/Arrival (2016).mkv"])

		const own = corrected([MOVIES], { "d:M/Heat (1995)": { kind: "episode", season: 1, episode: 1, title: "Pilot" } })

		expect(own.library.series).toHaveLength(1)
		expect(own.library.series[0]).toMatchObject({ id: newSeriesId("M/Heat (1995)"), title: "Heat" })
		expect(own.summary.series[0]?.seasons[1]).toEqual(["E1 Pilot = M/Heat (1995)/Heat (1995).mkv"])
		// Stored under the directory's key, not the file's: the episode carries it.
		expect(own.episodeKeys.get("M/Heat (1995)/Heat (1995).mkv")).toBe("d:M/Heat (1995)")
	})

	it("takes an episode out of its series as a movie or other video, dropping an emptied season", () => {
		const { library, summary } = corrected([SHOWS], {
			"s:S/Andor/Season 2/Andor S02E01.mkv": { kind: "movie", title: "Andor: The Movie", year: 2025 },
			"s:S/Andor/Season 1/Andor S01E02.mkv": { kind: "other" }
		})

		expect(library.movies).toHaveLength(1)
		expect(library.movies[0]).toMatchObject({ id: "S/Andor/Season 2/Andor S02E01.mkv", title: "Andor: The Movie", year: 2025 })
		expect(library.others.map(other => other.id)).toEqual(["S/Andor/Season 1/Andor S01E02.mkv"])
		expect(Object.keys(summary.series[0]?.seasons ?? {})).toEqual(["1", "2"])
		expect(summary.series[0]?.seasons[1]).toHaveLength(1)
	})

	it("renumbers an episode within its series", () => {
		const { summary } = corrected([SHOWS], {
			"s:S/Andor/Season 1/Andor S01E02.mkv": { kind: "episode", season: 1, episode: 7, title: "Moved" }
		})

		expect(summary.series[0]?.seasons[1]).toEqual([
			"E1  = S/Andor/Season 1/Andor S01E01.mkv",
			"E7 Moved = S/Andor/Season 1/Andor S01E02.mkv"
		])
	})

	it("merges a series into another (following a chain, ignoring loops)", () => {
		const roots: FixtureRoot[] = [
			{ name: "A", type: "shows", paths: ["Show/Season 1/Show S01E01.mkv"] },
			{ name: "B", type: "shows", paths: ["Show (US)/Season 1/Show (US) S01E02.mkv", "Other/Season 1/Other S01E01.mkv"] }
		]
		const merged = corrected(roots, { "d:B/Show (US)": { mergeInto: "d:A/Show" } })

		expect(merged.library.series.map(series => series.id).sort()).toEqual(["A/Show", "B/Other"])
		expect(merged.library.series.find(series => series.id === "A/Show")?.roots).toEqual([0, 1])
		expect(merged.summary.series.find(series => series.title === "Show")?.seasons[1]).toHaveLength(2)

		const loop = corrected(roots, { "d:B/Show (US)": { mergeInto: "d:A/Show" }, "d:A/Show": { mergeInto: "d:B/Show (US)" } })

		expect(loop.library.series).toHaveLength(3)
	})

	it("keeps a split series apart from its same-titled series in another root", () => {
		const roots: FixtureRoot[] = [
			{ name: "A", type: "shows", paths: ["Show (2020)/Season 1/Show (2020) S01E01.mkv"] },
			{ name: "B", type: "shows", paths: ["Show (2020)/Season 1/Show (2020) S01E02.mkv"] }
		]

		const merged = corrected(roots, {})
		const mergeKey = merged.library.series[0]?.mergeKey ?? ""

		expect(merged.library.series).toHaveLength(1)
		expect(merged.autoMerged.get("A/Show (2020)")).toBe(2)

		// Stored by merge key: the same whichever root comes first.
		const split = corrected(roots, { [splitOverrideKey(mergeKey)]: { split: true } })
		const reversed = corrected(roots, { [splitOverrideKey(mergeKey)]: { split: true } }, input => ({
			...input,
			roots: [...input.roots].reverse()
		}))

		expect(split.library.series.map(series => series.id).sort()).toEqual(["A/Show (2020)", "B/Show (2020)"])
		expect(reversed.library.series.map(series => series.id).sort()).toEqual(["A/Show (2020)", "B/Show (2020)"])
	})

	it("reports hidden titles of every kind, after reclassification too", () => {
		const { hidden } = corrected([MOVIES, SHOWS], {
			"d:M/Heat (1995)": { hidden: true, kind: "other" },
			"s:M/Arrival (2016).mkv": { hidden: true },
			"d:S/Andor": { hidden: true }
		})

		expect([...hidden].sort()).toEqual(["M/Arrival (2016).mkv", "M/Heat (1995)", "S/Andor"])
	})

	it("lets a correction win over the names, wherever the classifier put the file", () => {
		const { library } = corrected([{ name: "X", type: "movies", paths: ["Show S01E01.mkv"] }], {
			"s:X/Show S01E01.mkv": { kind: "movie", title: "Not an episode" }
		})

		expect(library.series).toHaveLength(0)
		expect(library.movies[0]?.title).toBe("Not an episode")
	})
})

describe("applyLibraryOverrides: corrections against the classification", () => {
	it("records what the classifier made of every corrected item, by key", () => {
		const { originals } = corrected([MOVIES, SHOWS], {
			"d:M/Heat (1995)": { title: "Heat!" },
			"s:S/Andor/Season 1/Andor S01E02.mkv": { kind: "movie" },
			"d:S/Andor": { year: 2022 }
		})

		expect(originals.get("d:M/Heat (1995)")).toEqual({
			kind: "movie",
			title: "Heat",
			year: 1995,
			season: 0,
			episode: 0,
			episodeEnd: 0,
			seriesKey: ""
		})
		expect(originals.get("s:S/Andor/Season 1/Andor S01E02.mkv")).toMatchObject({
			kind: "episode",
			season: 1,
			episode: 2,
			episodeEnd: 2,
			seriesKey: "d:S/Andor"
		})
		expect(originals.get("d:S/Andor")).toMatchObject({ kind: "series", title: "Andor" })
	})

	it("governs every part of a multi-part title shown as other videos by the title's own key", () => {
		const roots: FixtureRoot[] = [
			{ name: "M", type: "movies", paths: ["Film (2003)/Film (2003) cd1.mp4", "Film (2003)/Film (2003) cd2.mp4"] }
		]
		const { library, hidden, titleKeys } = corrected(roots, { "d:M/Film (2003)": { kind: "other", hidden: true, title: "Film parts" } })

		expect(library.others.map(other => other.title)).toEqual(["Film parts", "Film parts"])
		expect([...hidden].sort()).toEqual(["M/Film (2003)", "M/Film (2003)/Film (2003) cd2.mp4"])
		expect(titleKeys.get("M/Film (2003)/Film (2003) cd2.mp4")).toBe("d:M/Film (2003)")
	})

	it("keeps a renumbered multi-episode file's span unless the correction sets its end", () => {
		const roots: FixtureRoot[] = [{ name: "S", type: "shows", paths: ["Show/Season 1/Show S01E01-E02.mkv"] }]

		expect(
			corrected(roots, { "s:S/Show/Season 1/Show S01E01-E02.mkv": { kind: "episode", season: 1, episode: 5 } }).summary.series[0]
				?.seasons[1]
		).toEqual(["E5-6  = S/Show/Season 1/Show S01E01-E02.mkv"])
		expect(
			corrected(roots, { "s:S/Show/Season 1/Show S01E01-E02.mkv": { kind: "episode", season: 1, episode: 5, episodeEnd: 7 } }).summary
				.series[0]?.seasons[1]
		).toEqual(["E5-7  = S/Show/Season 1/Show S01E01-E02.mkv"])
	})

	it("supports new series fully: as targets, with their own corrections, and merged into others", () => {
		const roots: FixtureRoot[] = [MOVIES, SHOWS]
		const arrival = "s:M/Arrival (2016).mkv"
		const own = newSeriesId("M/Arrival (2016).mkv")
		const into = corrected(roots, {
			"s:M/Loose Clip.mp4": { kind: "episode", season: 1, episode: 2, mergeInto: `d:${own}` },
			[arrival]: { kind: "episode", season: 1, episode: 1 },
			[`d:${own}`]: { title: "Arrival Shorts", hidden: true }
		})
		const series = into.library.series.find(item => item.id === own)

		expect(series?.title).toBe("Arrival Shorts")
		expect(into.hidden.has(own)).toBe(true)
		// Made episodes keep their own titles: a movie's and an other video's.
		expect(into.summary.series.find(item => item.title === "Arrival Shorts")?.seasons[1]).toEqual([
			"E1 Arrival = M/Arrival (2016).mkv",
			"E2 Loose Clip = M/Loose Clip.mp4"
		])

		const merged = corrected(roots, { [arrival]: { kind: "episode", season: 3, episode: 1 }, [`d:${own}`]: { mergeInto: "d:S/Andor" } })

		expect(merged.library.series.map(item => item.id)).toEqual(["S/Andor"])
		expect(merged.summary.series[0]?.seasons[3]).toEqual(["E1 Arrival = M/Arrival (2016).mkv"])
	})

	it("groups the same way whatever order the files were listed in", () => {
		const roots: FixtureRoot[] = [
			MOVIES,
			SHOWS,
			{ name: "T", type: "shows", paths: ["Other/Season 1/Other S01E01.mkv", "Other/Season 1/Other S01E02.mkv"] }
		]
		const own = newSeriesId("M/Arrival (2016).mkv")
		const overrides: Record<string, LibraryOverride> = {
			"s:M/Loose Clip.mp4": { kind: "episode", season: 1, episode: 9, mergeInto: `d:${own}` },
			"s:M/Arrival (2016).mkv": { kind: "episode", season: 1, episode: 1 },
			[`d:${own}`]: { mergeInto: "d:T/Other" },
			"d:T/Other": { mergeInto: "d:S/Andor" },
			"s:S/Andor/Season 2/Andor S02E01.mkv": { mergeInto: `d:${own}` }
		}
		const grouping = (order?: (input: LibraryScanInput) => LibraryScanInput) => {
			const { library, summary } = corrected(roots, overrides, order)

			return library.series
				.map(
					(series, index) =>
						`${series.id}=${JSON.stringify(
							Object.values(summary.series[index]?.seasons ?? {})
								.flat()
								.map(line => line.split(" = ")[1])
								.sort()
						)}`
				)
				.sort()
		}
		const expected = grouping()
		let seed = 7

		for (let round = 0; round < 12; round++) {
			const shuffled = (input: LibraryScanInput): LibraryScanInput => {
				const files = [...input.files]
				const dirs = [...input.dirs]

				for (const list of [files, dirs] as unknown[][]) {
					for (let i = list.length - 1; i > 0; i--) {
						seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
						const j = seed % (i + 1)
						const swap = list[i]

						list[i] = list[j]
						list[j] = swap
					}
				}

				return { ...input, files, dirs }
			}

			expect(grouping(shuffled)).toEqual(expected)
		}

		expect(expected).toHaveLength(1)
	})
})

describe("rawLibraryOverride", () => {
	it("returns a stored correction as written, unknown fields included, without its stamp", () => {
		const doc = withLibraryOverride({
			doc: emptyLibraryConfig(),
			key: "s:x",
			override: { title: "T", future: { a: 1 } },
			stamp: { t: 1, d: "a" },
			at: 1
		})

		expect(rawLibraryOverride(doc, "s:x")).toEqual({ title: "T", future: { a: 1 } })
		expect(rawLibraryOverride(doc, "s:y")).toBeNull()
	})
})

describe("activeLibraryOverrides", () => {
	it("reads only live corrections, with checked fields", () => {
		const stamp = { t: 1, d: "a" }
		let doc = withLibraryOverride({
			doc: emptyLibraryConfig(),
			key: "s:x",
			override: { title: " Fixed ", kind: "episode", season: 1, episode: 2 },
			stamp,
			at: 1
		})

		doc = withLibraryOverride({ doc, key: "d:y", override: { hidden: true }, stamp, at: 1 })
		doc = withLibraryOverride({ doc, key: "d:y", override: null, stamp: { t: 2, d: "a" }, at: 2 })

		const parsed = parseLibraryConfig({
			...JSON.parse(JSON.stringify(doc)),
			overrides: { ...doc.overrides, "d:z": { o: { t: 3, d: "b", year: 99999, kind: "film", season: -1, split: true, extra: 1 } } }
		})

		expect(parsed).not.toBeNull()
		expect(activeLibraryOverrides(parsed ?? doc)).toEqual({
			"s:x": { title: "Fixed", kind: "episode", season: 1, episode: 2 },
			"d:z": { split: true }
		})
	})
})

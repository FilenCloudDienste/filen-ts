import { describe, expect, it } from "vitest"
import { type } from "arktype"
import {
	DEFAULT_GRID_PREFS,
	gridKeyAction,
	gridPrefsKey,
	gridPrefsSchema,
	gridView,
	needsProbeFacts,
	withActiveRow,
	qualityOf,
	inGridSource,
	type GridPrefs,
	type ProbeFacts
} from "@/features/videos/lib/videoGrid.logic"
import {
	buildVideoSearchIndex,
	filterTitlesByQuery,
	normalizeSearchText,
	searchVideos,
	titleSearchTokens
} from "@/features/videos/lib/search.logic"
import { episodeItem, homeCatalog, movieItem, progress, title, watched } from "@/tests/support/videoHome"
import type { GridQuery } from "@/workers/videoIndex/catalog.logic"

const NOW = Date.UTC(2026, 9, 1)
const NO_FACTS: ReadonlyMap<string, ProbeFacts> = new Map()
const UNWATCHED = () => ({ category: "unwatched" as const, lastPlayedMs: 0 })

function ids(titles: readonly { id: string }[]): string[] {
	return titles.map(item => item.id)
}

function prefs(patch: Partial<GridPrefs>): GridPrefs {
	return { ...DEFAULT_GRID_PREFS, ...patch }
}

describe("library grid sort and filters", () => {
	const alien = title("Alien", { sortName: "Alien", year: 1979, dateAdded: 3, height: 1080, roots: ["r1"] })
	const arrival = title("Arrival", { sortName: "Arrival", year: 2016, dateAdded: 1, roots: ["r2"] })
	const matrix = title("The Matrix", { sortName: "Matrix", year: 1999, dateAdded: 2, height: 2160, roots: ["r1"] })
	const lost = title("Lost", { kind: "series", primary: null, roots: ["r1"] })
	const titles = [matrix, arrival, alien, lost]

	it("selects a view's titles by kind or directory", () => {
		expect(ids(titles.filter(item => inGridSource(item, { kind: "movies" })))).toEqual(["The Matrix", "Arrival", "Alien"])
		expect(ids(titles.filter(item => inGridSource(item, { kind: "shows" })))).toEqual(["Lost"])
		expect(ids(titles.filter(item => inGridSource(item, { kind: "root", uuid: "r2" })))).toEqual(["Arrival"])
		expect(gridPrefsKey({ kind: "root", uuid: "r2" })).toBe("videos.v1.grid.root:r2")
		expect(gridPrefsKey({ kind: "movies" })).toBe("videos.v1.grid.movies")
	})

	it("sorts by title without articles, date added, year, and by a stable random order", () => {
		const movies = [matrix, arrival, alien]
		const view = (patch: Partial<GridPrefs>, seed = 1) =>
			ids(gridView({ titles: movies, prefs: prefs(patch), watchOf: UNWATCHED, facts: NO_FACTS, seed }).titles)

		expect(view({ sort: "title" })).toEqual(["Alien", "Arrival", "The Matrix"])
		expect(view({ sort: "added" })).toEqual(["Alien", "The Matrix", "Arrival"])
		expect(view({ sort: "year" })).toEqual(["Arrival", "The Matrix", "Alien"])
		expect(view({ sort: "random" }, 7)).toEqual(view({ sort: "random" }, 7))
		expect(view({ sort: "random" }, 7).sort()).toEqual(["Alien", "Arrival", "The Matrix"])
	})

	it("sorts by runtime with unknown values last and reports coverage", () => {
		const facts = new Map<string, ProbeFacts>([
			[alien.primary?.uuid ?? "", { durationSec: 7000, height: 0 }],
			[arrival.primary?.uuid ?? "", { durationSec: 6900, height: 0 }]
		])
		const view = gridView({ titles: [matrix, arrival, alien], prefs: prefs({ sort: "runtime" }), watchOf: UNWATCHED, facts, seed: 1 })

		expect(ids(view.titles)).toEqual(["Alien", "Arrival", "The Matrix"])
		expect(view.coverage).toEqual({ kind: "runtime", known: 2, total: 3 })
		expect(needsProbeFacts(prefs({ sort: "runtime" }))).toBe(true)
		expect(needsProbeFacts(prefs({}))).toBe(false)
	})

	it("filters by resolution from the name, else a probe, leaving unknown out", () => {
		const facts = new Map<string, ProbeFacts>([[arrival.primary?.uuid ?? "", { durationSec: null, height: 720 }]])
		const view = (quality: GridPrefs["quality"]) =>
			gridView({ titles: [matrix, arrival, alien], prefs: prefs({ quality }), watchOf: UNWATCHED, facts, seed: 1 })

		expect(ids(view("2160").titles)).toEqual(["The Matrix"])
		expect(ids(view("1080").titles)).toEqual(["Alien"])
		expect(ids(view("720").titles)).toEqual(["Arrival"])
		expect(view("sd").coverage).toEqual({ kind: "quality", known: 3, total: 3 })
		expect(qualityOf(576)).toBe("sd")
	})

	it("filters by watch state and directory", () => {
		const alienItem = movieItem("Alien")
		const arrivalItem = movieItem("Arrival")
		const catalog = homeCatalog({
			titles: [matrix, arrival, alien],
			items: [alienItem, arrivalItem, movieItem("The Matrix")],
			records: [watched(alienItem, NOW - 1000), progress(arrivalItem, { pos: 600, dur: 6000, at: NOW })]
		})
		const view = (patch: Partial<GridPrefs>) => {
			const query: GridQuery = { source: { kind: "movies" }, prefs: prefs(patch), query: "", seed: 1 }

			return catalog.grid(query, 0, 100).cards.map(card => card.title.id)
		}

		expect(view({ watch: "watched" })).toEqual(["Alien"])
		expect(view({ watch: "inProgress" })).toEqual(["Arrival"])
		expect(view({ watch: "unwatched" })).toEqual(["The Matrix"])
		expect(view({ root: "r1" })).toEqual(["Alien", "The Matrix"])
		expect(view({ sort: "played" })).toEqual(["Arrival", "Alien", "The Matrix"])
	})

	it("validates remembered prefs", () => {
		expect(gridPrefsSchema(DEFAULT_GRID_PREFS)).toEqual(DEFAULT_GRID_PREFS)
		expect(gridPrefsSchema({ ...DEFAULT_GRID_PREFS, sort: "rating" }) instanceof type.errors).toBe(true)
	})
})

describe("gridKeyAction", () => {
	const at = (key: string, index: number) => gridKeyAction({ key, index, count: 10, columns: 4, pageRows: 2 })

	it("moves by cell, row and page, clamped", () => {
		expect(at("ArrowRight", 3)).toEqual({ kind: "move", index: 4 })
		expect(at("ArrowLeft", 0)).toEqual({ kind: "move", index: 0 })
		expect(at("ArrowDown", 1)).toEqual({ kind: "move", index: 5 })
		expect(at("ArrowDown", 7)).toEqual({ kind: "move", index: 9 })
		expect(at("ArrowDown", 9)).toEqual({ kind: "none" })
		expect(at("ArrowUp", 2)).toEqual({ kind: "none" })
		expect(at("ArrowUp", 6)).toEqual({ kind: "move", index: 2 })
		expect(at("PageDown", 0)).toEqual({ kind: "move", index: 8 })
		expect(at("PageUp", 9)).toEqual({ kind: "move", index: 1 })
		expect(at("Home", 5)).toEqual({ kind: "move", index: 0 })
		expect(at("End", 0)).toEqual({ kind: "move", index: 9 })
		expect(at("Enter", 4)).toEqual({ kind: "open" })
		// The card commands are registered actions (cardKeys.ts); Escape never leaves the page.
		expect(at("P", 0)).toEqual({ kind: "none" })
		expect(at("Escape", 4)).toEqual({ kind: "none" })
		expect(gridKeyAction({ key: "ArrowRight", index: 0, count: 0, columns: 4, pageRows: 1 })).toEqual({ kind: "none" })
	})
})

describe("withActiveRow", () => {
	it("keeps the cursor's row rendered when it scrolled out of range", () => {
		expect(withActiveRow([4, 5, 6], 1, 10)).toEqual([1, 4, 5, 6])
		expect(withActiveRow([4, 5, 6], 5, 10)).toEqual([4, 5, 6])
		expect(withActiveRow([4, 5, 6], 12, 10)).toEqual([4, 5, 6])
	})
})

describe("library search", () => {
	const amelie = title("Amélie", { year: 2001 })
	const lost = title("Lost", { kind: "series", primary: null })
	const holiday = title("VID_0001", { kind: "other" })
	const items = [
		movieItem("Amélie", { folder: "Films" }),
		movieItem("Amélie", { stableUuid: "amelie-4k", label: "4K", folder: "Films" }),
		episodeItem("Lost", 1, 1, { episodeTitle: "Pilot" }),
		episodeItem("Lost", 1, 2, { episodeTitle: "Tabula Rasa" }),
		episodeItem("Lost", 1, 2, { episodeTitle: "Tabula Rasa", stableUuid: "lost-v2" }),
		movieItem("VID_0001", { itemClass: "other", folder: "Holiday Lisbon 2023" })
	]
	const index = buildVideoSearchIndex({ titles: [amelie, lost, holiday], items })
	const search = (query: string) =>
		searchVideos({ index, query }).map(group => [group.kind, group.results.map(result => result.item?.episodeTitle ?? result.title.id)])

	it("folds case and diacritics", () => {
		expect(normalizeSearchText("AMÉLIE")).toBe("amelie")
		expect(search("amel")).toEqual([["movies", ["Amélie"]]])
		expect(search("AMELIE 2001")).toEqual([["movies", ["Amélie"]]])
	})

	it("matches directory names and token prefixes, grouped Movies, Shows, Episodes, Other", () => {
		expect(search("lisbon")).toEqual([["other", ["VID_0001"]]])
		expect(search("films")).toEqual([["movies", ["Amélie"]]])
		expect(search("lo")).toEqual([["shows", ["Lost"]]])
		expect(search("rasa")).toEqual([["episodes", ["Tabula Rasa"]]])
		expect(search("pi")).toEqual([["episodes", ["Pilot"]]])
	})

	it("folds letters NFKD keeps whole, and ranks a whole-query match against the name's tokens first", () => {
		expect(normalizeSearchText("Søren Ærø Straße Łódź")).toBe("soren aero strasse lodz")

		const titles = [title("Spider Mania"), title("Spider-Man", { year: 2002 }), title("Søren")]
		const index = buildVideoSearchIndex({ titles, items: [] })

		expect(searchVideos({ index, query: "spider man" })[0]?.results.map(result => result.title.id)).toEqual([
			"Spider-Man",
			"Spider Mania"
		])
		expect(searchVideos({ index, query: "soren" })[0]?.results.map(result => result.title.id)).toEqual(["Søren"])
	})

	it("needs every token and finds nothing for an empty query", () => {
		expect(search("lost pilot")).toEqual([])
		expect(search("  ")).toEqual([])
	})

	it("counts past the group limit", () => {
		const many = Array.from({ length: 5 }, (_, i) => title(`Star ${String(i)}`))
		const groups = searchVideos({ index: buildVideoSearchIndex({ titles: many, items: [] }), query: "star", limit: 2 })

		expect(groups[0]?.results).toHaveLength(2)
		expect(groups[0]?.total).toBe(5)
	})

	it("filters a grid by its own search box", () => {
		const titles = [amelie, lost, holiday]

		expect(ids(filterTitlesByQuery({ titles, query: "ame 20", tokens: titleSearchTokens(titles) }))).toEqual(["Amélie"])
		expect(ids(filterTitlesByQuery({ titles, query: "", tokens: titleSearchTokens(titles) }))).toEqual(["Amélie", "Lost", "VID_0001"])
	})
})

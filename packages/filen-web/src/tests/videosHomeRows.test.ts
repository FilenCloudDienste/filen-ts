import { describe, expect, it } from "vitest"
import {
	HOME_ROOT_ROW_CARDS,
	HOME_ROW_MAX_CARDS,
	cardsInView,
	heroCandidates,
	peekCardWidth,
	pickHero,
	rowLiftPadding,
	rowShape,
	seeAllTarget,
	titleCard
} from "@/features/videos/lib/homeRows.logic"
import { cardBadge, titleWatchOf } from "@/features/videos/lib/titleWatch.logic"
import { cardLabel, episodeCode, neutralTone, sublineText } from "@/features/videos/lib/videoCard.logic"
import { qualityLabel, rowsKeyAction } from "@/features/videos/lib/videoGrid.logic"
import { recallScroll, rememberScroll } from "@/features/videos/lib/scrollMemory"
import { episodeItem, homeCatalog, homeRows, movieItem, progress, title, watchData, watched } from "@/tests/support/videoHome"
import { i18n } from "@/lib/i18n"

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 1)

describe("buildHomeRows", () => {
	it("orders the rows and leaves empty ones out", () => {
		const alien = title("alien", { year: 1979, dateAdded: 1 })
		const lost = title("lost", { kind: "series", primary: null })
		const clip = title("clip", { kind: "other" })
		const e1 = episodeItem("lost", 1, 1, { dateAdded: 5 })
		const e2 = episodeItem("lost", 1, 2, { dateAdded: 5 })
		const rows = homeRows({
			titles: [alien, lost, clip],
			items: [movieItem("alien", { dateAdded: 1 }), e1, e2, movieItem("clip", { itemClass: "other" })],
			records: [progress(e1, { pos: 600, dur: 2400, at: NOW - DAY })],
			now: NOW
		})

		expect(rows.map(row => row.id)).toEqual(["continue", "latestMovies", "latestEpisodes", "movies", "shows", "root:root", "other"])
	})

	it("renders no Continue Watching or episode rows for a movie-only library that was never played", () => {
		expect(homeRows({ titles: [title("a")], items: [movieItem("a")] }).map(row => row.kind)).toEqual(["latestMovies", "movies", "root"])
	})

	it("merges resume points and next episodes into one landscape row, newest play first", () => {
		const heat = title("heat", { year: 1995 })
		const lost = title("lost", { kind: "series", primary: null })
		const heatItem = movieItem("heat")
		const e1 = episodeItem("lost", 1, 1, { episodeTitle: "Pilot" })
		const e2 = episodeItem("lost", 1, 2, { episodeTitle: "Tabula Rasa" })
		const row = homeRows({
			titles: [heat, lost],
			items: [heatItem, e1, e2],
			records: [progress(heatItem, { pos: 1200, dur: 6000, at: NOW - 2 * DAY }), watched(e1, NOW - DAY)],
			now: NOW
		}).find(candidate => candidate.kind === "continue")

		expect(row?.shape).toBe("landscape")
		expect(row?.cards.map(card => [card.item?.stableUuid, card.sublines.map(line => line.kind)])).toEqual([
			[e2.stableUuid, ["episode", "upNext"]],
			[heatItem.stableUuid, ["remaining"]]
		])
		expect(row?.cards[1]?.progress).toBeCloseTo(0.2)
		expect(row?.cards[1]?.hideable).toBe(true)
		expect(row?.cards[1]?.resumeSec).toBe(1200)
		expect(row?.cards[0]?.hideable).toBe(false)
	})

	it("caps rows at 40 cards and root rows at 20", () => {
		const titles = Array.from({ length: 60 }, (_, i) => title(`m${String(i).padStart(2, "0")}`, { dateAdded: i }))
		const rows = homeRows({ titles, items: titles.map(item => movieItem(item.id, { dateAdded: item.dateAdded })) })
		const movies = rows.find(row => row.kind === "movies")
		const root = rows.find(row => row.kind === "root")

		expect(movies?.cards).toHaveLength(HOME_ROW_MAX_CARDS)
		expect(movies?.cards[0]?.title.id).toBe("m00")
		expect(root?.cards).toHaveLength(HOME_ROOT_ROW_CARDS)
		expect(root?.cards[0]?.title.id).toBe("m59")
		expect(rows.find(row => row.kind === "latestMovies")?.cards[0]?.title.id).toBe("m59")
	})

	it("leads every row but Continue Watching to its library view", () => {
		expect(seeAllTarget({ kind: "continue" })).toBeNull()
		expect(seeAllTarget({ kind: "latestMovies" })).toBe("/videos/movies")
		expect(seeAllTarget({ kind: "latestEpisodes" })).toBe("/videos/shows")
		expect(seeAllTarget({ kind: "root" })).toBe("/videos/library/$uuid")
		expect(seeAllTarget({ kind: "other" })).toBe("/videos/other")
	})

	it("one row per enabled root, holding the titles found in it", () => {
		const a = title("a", { roots: ["r1"] })
		const b = title("b", { roots: ["r2"] })
		const rows = homeRows({ titles: [a, b], items: [movieItem("a"), movieItem("b")], roots: ["r1", "r2", "r3"] })

		expect(rows.filter(row => row.kind === "root").map(row => [row.rootUuid, row.cards.map(card => card.title.id)])).toEqual([
			["r1", ["a"]],
			["r2", ["b"]]
		])
	})

	it("shows a season card for a batch of new episodes", () => {
		const lost = title("lost", { kind: "series", primary: null })
		const items = [1, 2, 3].map(n => episodeItem("lost", 2, n, { dateAdded: NOW - n * 1000 }))
		const rows = homeRows({ titles: [lost], items: [episodeItem("lost", 1, 1, { dateAdded: 0 }), ...items] })
		const card = rows.find(row => row.kind === "latestEpisodes")?.cards[0]

		expect(card?.sublines).toEqual([{ kind: "season", season: 2, count: 3 }])
		expect(card?.shape).toBe("landscape")
	})
})

describe("row shape and peek", () => {
	it("snaps the median aspect: posters for movies and series, landscape for other videos", () => {
		expect(rowShape([title("a"), title("b", { kind: "other" })])).toBe("poster")
		expect(rowShape([title("a", { kind: "other" }), title("b", { kind: "other" }), title("c")])).toBe("landscape")
		expect(rowShape([])).toBe("poster")
	})

	it("keeps the last card cut: 6.3 posters on desktop, 2.3 on a phone", () => {
		expect(cardsInView(1200, "poster")).toBe(6.3)
		expect(cardsInView(800, "poster")).toBe(4.3)
		expect(cardsInView(374, "poster")).toBe(2.3)

		const width = peekCardWidth({ rowWidth: 1200, shape: "poster", gap: 12 })

		expect(width * 6.3 + 12 * 6).toBeCloseTo(1200)
		expect(peekCardWidth({ rowWidth: 374, shape: "landscape", gap: 12 }) * 1.3 + 12).toBeCloseTo(374)
	})

	it("leaves room above and below a row for the lifted, ringed card", () => {
		expect(rowLiftPadding(300)).toBe(12)
		expect(rowLiftPadding(130)).toBe(8)
	})
})

describe("pickHero", () => {
	const withBackdrop = (id: string) => title(id, { backdrop: { stableUuid: `${id}-b`, uuid: `${id}-bu`, name: "fanart.jpg", size: 1 } })

	it("takes the top Continue Watching card", () => {
		const heat = title("heat")
		const item = movieItem("heat")
		const titles = [heat, withBackdrop("dune")]
		const rows = homeRows({ titles, items: [item], records: [progress(item, { pos: 600, dur: 6000, at: NOW })] })
		const hero = pickHero({ rows, candidates: heroCandidates(titles), previousId: null, seed: 0.5 })

		expect(hero?.title.id).toBe("heat")
		expect(hero?.card?.resumeSec).toBe(600)
	})

	it("otherwise a title with a backdrop of its own, kept for the session", () => {
		const titles = [title("plain"), withBackdrop("a"), withBackdrop("b")]
		const rows = homeRows({ titles, items: titles.map(item => movieItem(item.id)) })
		const candidates = heroCandidates(titles)

		expect(pickHero({ rows, candidates, previousId: null, seed: 0 })?.title.id).toBe("a")
		expect(pickHero({ rows, candidates, previousId: null, seed: 0.99 })?.title.id).toBe("b")
		expect(pickHero({ rows, candidates, previousId: "b", seed: 0 })?.title.id).toBe("b")
		expect(pickHero({ rows, candidates, previousId: "plain", seed: 0 })?.title.id).toBe("a")
		expect(pickHero({ rows, candidates: heroCandidates([title("plain")]), previousId: null, seed: 0 })).toBeNull()
	})

	it("keeps the session's pick while it stays eligible, with its Continue Watching card refreshed", () => {
		const heat = movieItem("heat")
		const dune = movieItem("dune")
		const titles = [title("heat"), title("dune")]
		const candidates = heroCandidates(titles)
		const first = homeRows({ titles, items: [heat, dune], records: [progress(heat, { pos: 600, dur: 6000, at: NOW - DAY })] })
		const picked = pickHero({ rows: first, candidates, previousId: null, seed: 0 })

		expect(picked?.title.id).toBe("heat")

		// Dune played since: the top of Continue Watching changed, the hero didn't; its resume point did.
		const later = homeRows({
			titles,
			items: [heat, dune],
			records: [progress(heat, { pos: 900, dur: 6000, at: NOW - DAY }), progress(dune, { pos: 600, dur: 6000, at: NOW })]
		})
		const kept = pickHero({ rows: later, candidates, previousId: picked?.title.id ?? null, seed: 0 })

		expect(kept?.title.id).toBe("heat")
		expect(kept?.card?.resumeSec).toBe(900)

		// Finished: no longer eligible, so the next one takes its place.
		const finished = homeRows({
			titles,
			items: [heat, dune],
			records: [watched(heat, NOW), progress(dune, { pos: 600, dur: 6000, at: NOW })]
		})

		expect(pickHero({ rows: finished, candidates, previousId: "heat", seed: 0 })?.title.id).toBe("dune")
	})
})

describe("card state", () => {
	it("derives watched, in-progress and unwatched counts", () => {
		const e1 = episodeItem("lost", 1, 1)
		const e2 = episodeItem("lost", 1, 2)
		const special = episodeItem("lost", 0, 1)
		const heat = movieItem("heat")
		const { watch } = watchData({ items: [e1, e2, special, heat], records: [watched(e1, NOW), watched(heat, NOW)] })

		expect(titleWatchOf(watch, "lost")).toMatchObject({ category: "inProgress", unwatched: 1 })
		expect(cardBadge("series", titleWatchOf(watch, "lost"))).toEqual({ kind: "unwatched", count: 1 })
		expect(cardBadge("movie", titleWatchOf(watch, "heat"))).toEqual({ kind: "watched" })
		expect(titleWatchOf(watch, "nothing").category).toBe("unwatched")

		const all = watchData({ items: [e1, e2], records: [watched(e1, NOW), watched(e2, NOW)] })

		expect(cardBadge("series", titleWatchOf(all.watch, "lost"))).toEqual({ kind: "watched" })
	})

	it("plays a series' next episode and resumes a started movie", () => {
		const lost = title("lost", { kind: "series", primary: null })
		const e1 = episodeItem("lost", 1, 1)
		const e2 = episodeItem("lost", 1, 2)
		const heat = movieItem("heat")
		const data = watchData({ items: [e1, e2, heat], records: [watched(e1, NOW), progress(heat, { pos: 900, dur: 6000, at: NOW })] })

		expect(titleCard({ data, title: lost, shape: "poster" }).play).toBe(e2.stableUuid)
		expect(titleCard({ data, title: title("heat"), shape: "poster" })).toMatchObject({ play: heat.stableUuid, resumeSec: 900 })
		expect(titleCard({ data, title: title("old", { unsupported: true, container: "avi" }), shape: "poster" })).toMatchObject({
			play: null,
			unsupported: true,
			sublines: [{ kind: "unsupported", container: "avi" }]
		})
	})

	it("names the card with its title, year, progress, badge and playability", () => {
		const t = i18n.getFixedT<"videos">("en", "videos")
		const data = watchData({ items: [] })
		const heat = titleCard({ data, title: title("Heat", { year: 1995 }), shape: "poster" })
		const old = titleCard({ data, title: title("old.avi", { unsupported: true, container: "avi" }), shape: "poster" })

		expect(cardLabel({ ...heat, progress: 0.45 }, t)).toBe("Heat, 1995, 45% watched")
		expect(cardLabel({ ...heat, progress: 0.456 }, t)).toBe("Heat, 1995, 46% watched")
		expect(cardLabel({ ...heat, badge: { kind: "unwatched", count: 3 } }, t)).toBe("Heat, 1995, 3 unwatched episodes")
		expect(cardLabel(old, t)).toBe("old.avi, AVI · Download to watch, not playable here")
	})

	it("marks every version of a movie and every episode of a series", () => {
		const items = [movieItem("m"), movieItem("m", { stableUuid: "m-v2" }), episodeItem("s", 1, 1), episodeItem("s", 1, 2)]
		const catalog = homeCatalog({ titles: [title("m"), title("s", { kind: "series", primary: null })], items })

		expect(catalog.markTargets("m", null)).toEqual(["m-v", "m-v2"])
		expect(catalog.markTargets("s", null)).toHaveLength(2)
		expect(catalog.markTargets("s", episodeItem("s", 1, 2).group)).toEqual(["s-s1e2-v"])
	})

	it("says what was added, not what is new to the viewer", () => {
		const t = i18n.getFixedT<"videos">("en", "videos")

		expect(sublineText({ kind: "newEpisodes", count: 3 }, t)).toBe("3 episodes added")
		expect(sublineText({ kind: "season", season: 2, count: 1 }, t)).toBe("Season 2 · 1 episode added")
	})

	it("labels resolutions with the filter's own buckets", () => {
		expect([2160, 1440, 1080, 1000, 720, 576, 0].map(qualityLabel)).toEqual(["4K", "4K", "1080p", "1080p", "720p", "", ""])
	})

	it("remembers scroll positions per history entry, the most recent ones only", () => {
		rememberScroll("entry:home", 420)

		expect(recallScroll("entry:home")).toBe(420)
		expect(recallScroll("other:home")).toBeUndefined()

		for (let i = 0; i < 250; i++) {
			rememberScroll(`flood:${String(i)}`, i)
		}

		expect(recallScroll("entry:home")).toBeUndefined()
		expect(recallScroll("flood:249")).toBe(249)
	})

	it("formats episode codes and picks a stable neutral tone", () => {
		expect(episodeCode({ season: 2, episode: 5, episodeEnd: 5 })).toBe("S2E5")
		expect(episodeCode({ season: 1, episode: 1, episodeEnd: 2 })).toBe("S1E1-E2")
		expect(episodeCode({ season: 1, episode: 0, episodeEnd: 0 })).toBe("")
		expect(neutralTone("Blade Runner")).toBe(neutralTone("Blade Runner"))
		expect(neutralTone("x")).toMatch(/^oklch\(0\.\d+ 0 0\)$/)
	})
})

describe("rowsKeyAction", () => {
	const lengths = [5, 2, 0, 4]

	it("moves within a row and between rows keeping the column", () => {
		expect(rowsKeyAction({ key: "ArrowRight", row: 0, column: 4, rowLengths: lengths })).toEqual({ kind: "none" })
		expect(rowsKeyAction({ key: "ArrowRight", row: 0, column: 1, rowLengths: lengths })).toEqual({ kind: "move", row: 0, column: 2 })
		expect(rowsKeyAction({ key: "ArrowDown", row: 0, column: 4, rowLengths: lengths })).toEqual({ kind: "move", row: 1, column: 1 })
		expect(rowsKeyAction({ key: "ArrowUp", row: 1, column: 1, rowLengths: lengths })).toEqual({ kind: "move", row: 0, column: 1 })
		expect(rowsKeyAction({ key: "ArrowUp", row: 0, column: 1, rowLengths: lengths })).toEqual({ kind: "none" })
		expect(rowsKeyAction({ key: "End", row: 3, column: 0, rowLengths: lengths })).toEqual({ kind: "move", row: 3, column: 3 })
		expect(rowsKeyAction({ key: "Home", row: 3, column: 3, rowLengths: lengths })).toEqual({ kind: "move", row: 3, column: 0 })
	})

	it("plays on Space and P, leaves Enter to the link", () => {
		expect(rowsKeyAction({ key: " ", row: 0, column: 0, rowLengths: lengths })).toEqual({ kind: "play" })
		expect(rowsKeyAction({ key: "p", row: 0, column: 0, rowLengths: lengths })).toEqual({ kind: "play" })
		expect(rowsKeyAction({ key: "Enter", row: 0, column: 0, rowLengths: lengths })).toEqual({ kind: "open" })
		expect(rowsKeyAction({ key: "Escape", row: 0, column: 0, rowLengths: lengths })).toEqual({ kind: "back" })
	})
})

import { describe, expect, it } from "vitest"
import {
	activeLibraryOverrides,
	emptyLibraryConfig,
	newSeriesId,
	rawLibraryOverride,
	withLibraryOverride,
	type LibraryConfigDoc
} from "@filen/shared/videos"
import { hideManyEdit, type CorrectionSubject } from "@/features/videos/lib/corrections.logic"
import {
	guessSeriesName,
	planEpisodes,
	setAsSources,
	setKindEdit,
	setShowEdit,
	showDestination,
	type SetAsSource
} from "@/features/videos/lib/setAs.logic"
import {
	NO_SELECTION,
	cardClickIntent,
	rangeBounds,
	selectAll,
	toggleSelection,
	withRange
} from "@/features/videos/lib/gridSelection.logic"
import type { VideoCorrectionTarget, VideoTitleView } from "@/workers/videoIndex/view.logic"

const STAMP = { t: 10, d: "w" }

function subject(key: string, kind: "movie" | "other" | "series", title: string): CorrectionSubject {
	return {
		key,
		original: { kind, title, year: 0, season: 0, episode: 0, episodeEnd: 0, seriesKey: "" },
		seriesId: kind === "series" ? key.slice(2) : "",
		mergeKey: "",
		autoMergedRoots: 1
	}
}

function source(id: string, fileName: string, kind: "movie" | "other" = "movie"): SetAsSource {
	return { id, title: id, fileName, subject: subject(`s:${id}`, kind, id) }
}

// Applies one ConfigEdit: a bulk change is one edit of the document, so it is one library configuration write.
function apply(edit: (doc: LibraryConfigDoc, stamp: typeof STAMP) => LibraryConfigDoc, doc = emptyLibraryConfig()): LibraryConfigDoc {
	return edit(doc, STAMP)
}

describe("Set as movie / other video", () => {
	it("stores every selected title's kind in one edit, and leaves series alone", () => {
		const edit = setKindEdit([subject("s:a", "movie", "A"), subject("d:b", "movie", "B"), subject("d:show", "series", "Show")], "other")
		const doc = apply(edit)
		const overrides = activeLibraryOverrides(doc)

		expect(overrides["s:a"]).toEqual({ kind: "other" })
		expect(overrides["d:b"]).toEqual({ kind: "other" })
		expect(overrides["d:show"]).toBeUndefined()
	})

	it("removes the kind again when it is the classifier's, keeping the other fields", () => {
		const start = withLibraryOverride({
			doc: emptyLibraryConfig(),
			key: "s:a",
			override: { kind: "other", title: "Renamed", future: 1 },
			stamp: { t: 1, d: "w" },
			at: 1
		})
		const doc = apply(setKindEdit([subject("s:a", "movie", "A")], "movie"), start)

		expect(rawLibraryOverride(doc, "s:a")).toEqual({ title: "Renamed", future: 1 })
	})

	it("writes nothing for a title already of that kind", () => {
		const start = emptyLibraryConfig()

		expect(apply(setKindEdit([subject("s:a", "movie", "A")], "movie"), start)).toBe(start)
	})

	it("hides every key in one edit, each once", () => {
		const doc = apply(hideManyEdit(["s:a", "d:b", "s:a"], true))

		expect(activeLibraryOverrides(doc)).toEqual({ "s:a": { hidden: true }, "d:b": { hidden: true } })
	})

	it("splits worker targets into sources and skipped series", () => {
		const view = (id: string, kind: VideoTitleView["kind"], name: string | null): VideoTitleView =>
			({ id, kind, title: id, year: 0, mergeKey: "", primary: name === null ? null : { name } }) as VideoTitleView
		const targets: VideoCorrectionTarget[] = [
			{ title: view("m", "movie", "m.mkv"), overrideKey: "d:m", autoMergedRoots: 1 },
			{ title: view("show", "series", null), overrideKey: "d:show", autoMergedRoots: 1 }
		]
		const { sources, skipped } = setAsSources(targets)

		expect(skipped).toBe(1)
		expect(sources).toEqual([{ id: "m", title: "m", fileName: "m.mkv", subject: expect.objectContaining({ key: "d:m" }) as unknown }])
	})
})

describe("Set as show", () => {
	it("reads numbers from file names and gives the rest the next free ones, in file name order", () => {
		const plan = planEpisodes({
			sources: [
				source("a", "The Show S02E03.mkv"),
				source("b", "bonus 2.mkv"),
				source("c", "The.Show.S02E04-E05.1080p.mkv"),
				source("d", "abc.mkv"),
				source("e", "The Show S02E01.mkv")
			],
			taken: [{ season: 2, episode: 7, episodeEnd: 7 }]
		})

		expect(plan.map(entry => [entry.source.id, entry.season, entry.episode, entry.episodeEnd, entry.derived])).toEqual([
			["a", 2, 3, 3, true],
			// "bonus 2" reads as episode 2 in a series.
			["b", 1, 2, 2, true],
			["c", 2, 4, 5, true],
			["d", 2, 8, 8, false],
			["e", 2, 1, 1, true]
		])
	})

	it("numbers files without markers from 1 in season 1", () => {
		const plan = planEpisodes({ sources: [source("b", "Zulu.mp4"), source("a", "Alpha.mp4")], taken: [] })

		expect(plan.map(entry => [entry.source.id, entry.season, entry.episode])).toEqual([
			["b", 1, 2],
			["a", 1, 1]
		])
	})

	it("guesses the series name the file names share", () => {
		expect(guessSeriesName([source("a", "The.Show.S01E01.mkv"), source("b", "The.Show.S01E02.mkv"), source("c", "x.mkv")])).toBe(
			"The Show"
		)
		expect(guessSeriesName([source("Holiday", "clip.mp4")])).toBe("Holiday")
	})

	it("joins an existing series in one edit, as the corrections dialog saves each episode", () => {
		const plan = planEpisodes({ sources: [source("a", "S01E01.mkv"), source("b", "S01E02-E03.mkv", "other")], taken: [] })
		const target = { kind: "existing", key: "d:show" } as const
		const doc = apply(setShowEdit({ plan, target }))

		expect(activeLibraryOverrides(doc)).toEqual({
			"s:a": { kind: "episode", season: 1, episode: 1, mergeInto: "d:show" },
			"s:b": { kind: "episode", season: 1, episode: 2, episodeEnd: 3, mergeInto: "d:show" }
		})
		expect(showDestination({ plan, target })).toBe("show")
	})

	it("starts a new series from the first title, the rest join it, and stores its name", () => {
		const plan = planEpisodes({ sources: [source("a", "S01E01.mkv"), source("b", "S01E02.mkv")], taken: [] })
		const target = { kind: "new", name: "My Show" } as const
		const seriesKey = `d:${newSeriesId("a")}`
		const doc = apply(setShowEdit({ plan, target }))

		expect(activeLibraryOverrides(doc)).toEqual({
			"s:a": { kind: "episode", season: 1, episode: 1 },
			"s:b": { kind: "episode", season: 1, episode: 2, mergeInto: seriesKey },
			[seriesKey]: { title: "My Show" }
		})
		expect(showDestination({ plan, target })).toBe(newSeriesId("a"))
	})

	it("stores no series name when it is the first title's own", () => {
		const plan = planEpisodes({ sources: [source("a", "S01E01.mkv")], taken: [] })
		const doc = apply(setShowEdit({ plan, target: { kind: "new", name: " a " } }))

		expect(Object.keys(activeLibraryOverrides(doc))).toEqual(["s:a"])
	})
})

describe("grid selection", () => {
	const plain = { shiftKey: false, metaKey: false, ctrlKey: false }

	it("opens on a plain click until something is selected, then toggles", () => {
		expect(cardClickIntent(plain, false)).toBeNull()
		expect(cardClickIntent(plain, true)).toBe("toggle")
		expect(cardClickIntent({ ...plain, metaKey: true }, false)).toBe("toggle")
		expect(cardClickIntent({ ...plain, ctrlKey: true }, false)).toBe("toggle")
		expect(cardClickIntent({ ...plain, shiftKey: true }, false)).toBe("range")
	})

	it("toggles ids and anchors on the last toggled card", () => {
		const one = toggleSelection(NO_SELECTION, "a", 3)
		const two = toggleSelection(one, "b", 5)

		expect([...two.ids]).toEqual(["a", "b"])
		expect(two.anchor).toBe(5)
		expect([...toggleSelection(two, "a", 3).ids]).toEqual(["b"])
	})

	it("extends a range from the anchor either way, replacing the selection", () => {
		const anchored = toggleSelection(NO_SELECTION, "c", 4)

		expect(rangeBounds(anchored, 1)).toEqual({ start: 1, end: 5 })
		expect(rangeBounds(anchored, 7)).toEqual({ start: 4, end: 8 })
		expect(rangeBounds(NO_SELECTION, 2)).toEqual({ start: 2, end: 3 })

		const range = withRange(anchored, ["x", "y"], 7)

		expect([...range.ids]).toEqual(["x", "y"])
		expect(range.anchor).toBe(4)
	})

	it("selects all without an anchor", () => {
		expect(selectAll(["a", "b"])).toEqual({ ids: new Set(["a", "b"]), anchor: null })
	})
})

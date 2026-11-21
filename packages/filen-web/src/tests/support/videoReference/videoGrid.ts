// Frozen copy of the page-side logic from when the page held the whole library: an independent reference the
// worker's catalog must match. Never edited to follow the product code.

import { type } from "arktype"
import { compareIds, compareNames } from "@filen/shared"
import type { VideoTitleView } from "@/workers/videoIndex/view.logic"
import { titleWatchOf, type TitleWatch, type WatchCategory } from "@/features/videos/lib/titleWatch.logic"

// A library view's grid: its remembered sort and filters, and the titles they leave in order. Plain and DOM-free.

export const GRID_SORTS = ["title", "added", "year", "runtime", "played", "random"] as const
export type GridSort = (typeof GRID_SORTS)[number]

export const GRID_QUALITIES = ["all", "2160", "1080", "720", "sd"] as const
export type GridQuality = (typeof GRID_QUALITIES)[number]

export type GridWatchFilter = "all" | WatchCategory

export const gridPrefsSchema = type({
	sort: type.enumerated(...GRID_SORTS),
	watch: "'all' | 'unwatched' | 'inProgress' | 'watched'",
	quality: type.enumerated(...GRID_QUALITIES),
	// A library directory's uuid, empty for all of them.
	root: "string"
})

export type GridPrefs = typeof gridPrefsSchema.infer

export const DEFAULT_GRID_PREFS: GridPrefs = {
	sort: "title",
	watch: "all",
	quality: "all",
	root: ""
}

export const GRID_PREFS_KV_PREFIX = "videos.v1.grid."

// What a grid lists: one kind of title, or one library directory's titles.
export type GridSource = { kind: "movies" | "shows" | "other" } | { kind: "root"; uuid: string }

export function gridPrefsKey(source: GridSource): string {
	return `${GRID_PREFS_KV_PREFIX}${source.kind === "root" ? `root:${source.uuid}` : source.kind}`
}

export function sourceTitles(titles: readonly VideoTitleView[], source: GridSource): VideoTitleView[] {
	switch (source.kind) {
		case "movies":
			return titles.filter(title => title.kind === "movie")
		case "shows":
			return titles.filter(title => title.kind === "series")
		case "other":
			return titles.filter(title => title.kind === "other")
		case "root":
			return titles.filter(title => title.roots.includes(source.uuid))
	}
}

// What a probe told of a file, where the name said nothing.
export interface ProbeFacts {
	durationSec: number | null
	height: number
}

// Sorts and filters whose values only a probe knows (runtime, a resolution the name doesn't give).
export function needsProbeFacts(prefs: GridPrefs): boolean {
	return prefs.sort === "runtime" || prefs.quality !== "all"
}

function primaryFacts(title: VideoTitleView, facts: ReadonlyMap<string, ProbeFacts>): ProbeFacts | undefined {
	return title.primary === null ? undefined : facts.get(title.primary.uuid)
}

export function titleRuntime(title: VideoTitleView, facts: ReadonlyMap<string, ProbeFacts>): number | null {
	const duration = primaryFacts(title, facts)?.durationSec ?? null

	return duration !== null && duration > 0 ? duration : null
}

// Picture height from the name, else from a probe; null when neither knows. Series have none.
export function titleHeight(title: VideoTitleView, facts: ReadonlyMap<string, ProbeFacts>): number | null {
	if (title.kind === "series") {
		return null
	}

	if (title.height > 0) {
		return title.height
	}

	const probed = primaryFacts(title, facts)?.height ?? 0

	return probed > 0 ? probed : null
}

export function qualityOf(height: number): Exclude<GridQuality, "all"> {
	return height >= 1440 ? "2160" : height >= 1000 ? "1080" : height >= 700 ? "720" : "sd"
}

// What a card or the hero shows of a picture height: the resolution filter's own buckets, nothing below 720p or
// when unknown (0).
export function qualityLabel(height: number): string {
	if (height <= 0) {
		return ""
	}

	switch (qualityOf(height)) {
		case "2160":
			return "4K"
		case "1080":
			return "1080p"
		case "720":
			return "720p"
		case "sd":
			return ""
	}
}

// FNV-1a over the id and the session's seed: a stable shuffle per session.
function shuffleKey(id: string, seed: number): number {
	let hash = 2_166_136_261 ^ seed

	for (let i = 0; i < id.length; i++) {
		hash = Math.imul(hash ^ id.charCodeAt(i), 16_777_619)
	}

	return hash >>> 0
}

function byName(a: VideoTitleView, b: VideoTitleView): number {
	return compareNames(a.sortName, b.sortName) || a.year - b.year || compareIds(a.id, b.id)
}

// Unknown values (null) last, whatever the direction.
function unknownLast(a: number | null, b: number | null): number {
	if (a === null || b === null) {
		return a === b ? 0 : a === null ? 1 : -1
	}

	return b - a
}

export interface GridView {
	titles: VideoTitleView[]
	// For a sort or filter only a probe can answer: how many of the listed titles it knows the value for.
	coverage: { kind: "runtime" | "quality"; known: number; total: number } | null
}

export function gridView({
	titles,
	prefs,
	watch,
	facts,
	seed
}: {
	titles: readonly VideoTitleView[]
	prefs: GridPrefs
	watch: ReadonlyMap<string, TitleWatch>
	facts: ReadonlyMap<string, ProbeFacts>
	seed: number
}): GridView {
	let qualityKnown = 0
	let qualityTotal = 0
	const out: VideoTitleView[] = []

	for (const title of titles) {
		if (prefs.root !== "" && !title.roots.includes(prefs.root)) {
			continue
		}

		if (prefs.watch !== "all" && titleWatchOf(watch, title.id).category !== prefs.watch) {
			continue
		}

		if (prefs.quality !== "all") {
			const height = titleHeight(title, facts)

			if (title.kind !== "series") {
				qualityTotal++
			}

			if (height === null) {
				continue
			}

			qualityKnown++

			if (qualityOf(height) !== prefs.quality) {
				continue
			}
		}

		out.push(title)
	}

	let compare: (a: VideoTitleView, b: VideoTitleView) => number

	switch (prefs.sort) {
		case "title":
			compare = byName
			break
		case "added":
			compare = (a, b) => b.dateAdded - a.dateAdded || byName(a, b)
			break
		case "year":
			compare = (a, b) => unknownLast(a.year > 0 ? a.year : null, b.year > 0 ? b.year : null) || byName(a, b)
			break
		case "runtime":
			compare = (a, b) => unknownLast(titleRuntime(a, facts), titleRuntime(b, facts)) || byName(a, b)
			break
		case "played":
			compare = (a, b) => {
				const playedA = titleWatchOf(watch, a.id).lastPlayedMs
				const playedB = titleWatchOf(watch, b.id).lastPlayedMs

				return unknownLast(playedA > 0 ? playedA : null, playedB > 0 ? playedB : null) || byName(a, b)
			}
			break
		case "random":
			compare = (a, b) => shuffleKey(a.id, seed) - shuffleKey(b.id, seed) || byName(a, b)
			break
	}

	out.sort(compare)

	let coverage: GridView["coverage"] = null

	if (prefs.sort === "runtime") {
		const candidates = out.filter(title => title.kind !== "series")

		coverage = {
			kind: "runtime",
			known: candidates.filter(title => titleRuntime(title, facts) !== null).length,
			total: candidates.length
		}
	} else if (prefs.quality !== "all") {
		coverage = { kind: "quality", known: qualityKnown, total: qualityTotal }
	}

	return {
		titles: out,
		coverage
	}
}

// ── Keyboard ─────────────────────────────────────────────────────────────────

export type GridKeyAction = { kind: "none" } | { kind: "move"; index: number } | { kind: "open" } | { kind: "play" } | { kind: "back" }

// Roving focus over a grid of `count` cards in `columns` columns: arrows, Home/End, PageUp/Down by `pageRows` rows,
// Enter opens and Space or P plays the focused card, Esc goes back.
export function gridKeyAction({
	key,
	index,
	count,
	columns,
	pageRows
}: {
	key: string
	index: number
	count: number
	columns: number
	pageRows: number
}): GridKeyAction {
	if (key === "Escape") {
		return { kind: "back" }
	}

	if (count === 0) {
		return { kind: "none" }
	}

	const clamp = (next: number): GridKeyAction => ({ kind: "move", index: Math.min(count - 1, Math.max(0, next)) })
	const page = Math.max(1, pageRows) * columns

	switch (key) {
		case "ArrowLeft":
			return clamp(index - 1)
		case "ArrowRight":
			return clamp(index + 1)
		case "ArrowUp":
			return index - columns < 0 ? { kind: "none" } : clamp(index - columns)
		case "ArrowDown":
			// From the row above a shorter last row, Down lands on its last card.
			return Math.floor(index / columns) >= Math.floor((count - 1) / columns) ? { kind: "none" } : clamp(index + columns)
		case "Home":
			return clamp(0)
		case "End":
			return clamp(count - 1)
		case "PageUp":
			return clamp(index - page)
		case "PageDown":
			return clamp(index + page)
		case "Enter":
			return { kind: "open" }
		case " ":
		case "p":
		case "P":
			return { kind: "play" }
		default:
			return { kind: "none" }
	}
}

export type RowsKeyAction =
	{ kind: "none" } | { kind: "move"; row: number; column: number } | { kind: "open" } | { kind: "play" } | { kind: "back" }

// Roving focus over the home rows: Left/Right within a row, Up/Down to the neighbouring row keeping the column
// (clamped to its length), Home/End to a row's ends, Esc back.
export function rowsKeyAction({
	key,
	row,
	column,
	rowLengths
}: {
	key: string
	row: number
	column: number
	rowLengths: readonly number[]
}): RowsKeyAction {
	if (key === "Escape") {
		return { kind: "back" }
	}

	const length = rowLengths[row] ?? 0

	if (length === 0) {
		return { kind: "none" }
	}

	const at = (nextRow: number, nextColumn: number): RowsKeyAction => {
		const nextLength = rowLengths[nextRow] ?? 0

		return nextLength === 0
			? { kind: "none" }
			: { kind: "move", row: nextRow, column: Math.min(nextLength - 1, Math.max(0, nextColumn)) }
	}

	switch (key) {
		case "ArrowLeft":
			return column === 0 ? { kind: "none" } : at(row, column - 1)
		case "ArrowRight":
			return column >= length - 1 ? { kind: "none" } : at(row, column + 1)
		case "ArrowUp":
			return row === 0 ? { kind: "none" } : at(row - 1, column)
		case "ArrowDown":
			return row >= rowLengths.length - 1 ? { kind: "none" } : at(row + 1, column)
		case "Home":
			return at(row, 0)
		case "End":
			return at(row, length - 1)
		case "Enter":
			return { kind: "open" }
		case " ":
		case "p":
		case "P":
			return { kind: "play" }
		default:
			return { kind: "none" }
	}
}

// The rows a virtualizer renders, plus the one holding the cursor when it scrolled out of range: focus never lands on
// an unmounted card.
export function withActiveRow(indexes: number[], activeRow: number, count: number): number[] {
	if (activeRow < 0 || activeRow >= count || indexes.includes(activeRow)) {
		return indexes
	}

	return [...indexes, activeRow].sort((a, b) => a - b)
}

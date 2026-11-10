import { type } from "arktype"
import type { VideoTitleView } from "@/workers/videoIndex/view.logic"
import type { TitleWatch, WatchCategory } from "@/features/videos/lib/titleWatch.logic"
import { byTitleName } from "@/features/videos/lib/homeRows.logic"

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

export function inGridSource(title: VideoTitleView, source: GridSource): boolean {
	switch (source.kind) {
		case "movies":
			return title.kind === "movie"
		case "shows":
			return title.kind === "series"
		case "other":
			return title.kind === "other"
		case "root":
			return title.roots.includes(source.uuid)
	}
}

// What a probe told of a file, where the name said nothing.
export interface ProbeFacts {
	durationSec: number | null
	height: number
}

// Sorts and filters whose values only a probe knows (runtime, a resolution the name doesn't give).
// Whether a grid's order reads the watch state.
export function gridReadsWatch(prefs: GridPrefs): boolean {
	return prefs.watch !== "all" || prefs.sort === "played"
}

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

export interface GridInput {
	prefs: GridPrefs
	// Read for its category and last play only.
	watchOf: (titleId: string) => Pick<TitleWatch, "category" | "lastPlayedMs">
	facts: ReadonlyMap<string, ProbeFacts>
	seed: number
}

// The titles the filters leave, in their order, with what the resolution filter knew.
export function gridFilter(titles: readonly VideoTitleView[], { prefs, watchOf, facts }: GridInput) {
	let qualityKnown = 0
	let qualityTotal = 0
	const out: VideoTitleView[] = []

	for (const title of titles) {
		if (prefs.root !== "" && !title.roots.includes(prefs.root)) {
			continue
		}

		if (prefs.watch !== "all" && watchOf(title.id).category !== prefs.watch) {
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

	return { titles: out, qualityKnown, qualityTotal }
}

// The sort's order (total: ties end on byTitleName, which ends on the id).
export function gridCompare({ prefs, watchOf, facts, seed }: GridInput): (a: VideoTitleView, b: VideoTitleView) => number {
	switch (prefs.sort) {
		case "title":
			return byTitleName
		case "added":
			return (a, b) => b.dateAdded - a.dateAdded || byTitleName(a, b)
		case "year":
			return (a, b) => unknownLast(a.year > 0 ? a.year : null, b.year > 0 ? b.year : null) || byTitleName(a, b)
		case "runtime":
			return (a, b) => unknownLast(titleRuntime(a, facts), titleRuntime(b, facts)) || byTitleName(a, b)
		case "played":
			return (a, b) => {
				const playedA = watchOf(a.id).lastPlayedMs
				const playedB = watchOf(b.id).lastPlayedMs

				return unknownLast(playedA > 0 ? playedA : null, playedB > 0 ? playedB : null) || byTitleName(a, b)
			}
		case "random":
			return (a, b) => shuffleKey(a.id, seed) - shuffleKey(b.id, seed) || byTitleName(a, b)
	}
}

// For a sort or filter only a probe can answer: how many of the listed titles it knows the value for.
export function gridCoverage(
	sorted: readonly VideoTitleView[],
	filtered: { qualityKnown: number; qualityTotal: number },
	{ prefs, facts }: GridInput
): GridView["coverage"] {
	if (prefs.sort === "runtime") {
		const candidates = sorted.filter(title => title.kind !== "series")

		return {
			kind: "runtime",
			known: candidates.filter(title => titleRuntime(title, facts) !== null).length,
			total: candidates.length
		}
	}

	return prefs.quality !== "all" ? { kind: "quality", known: filtered.qualityKnown, total: filtered.qualityTotal } : null
}

// `titles` already in name order makes the title sort a single pass.
export function gridView({ titles, ...input }: GridInput & { titles: readonly VideoTitleView[] }): GridView {
	const filtered = gridFilter(titles, input)
	const sorted = filtered.titles.sort(gridCompare(input))

	return {
		titles: sorted,
		coverage: gridCoverage(sorted, filtered, input)
	}
}

// ── Keyboard ─────────────────────────────────────────────────────────────────

export type GridKeyAction = { kind: "none" } | { kind: "move"; index: number } | { kind: "open" }

// Roving focus over a grid of `count` cards in `columns` columns: arrows, Home/End, PageUp/Down by `pageRows` rows,
// Enter opens the focused card. The card commands (play, mark watched) are registered actions (cardKeys.ts). Escape
// is not a listing's: it never leaves the page, as nowhere else in the app.
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
		default:
			return { kind: "none" }
	}
}

export type RowsKeyAction = { kind: "none" } | { kind: "move"; row: number; column: number } | { kind: "open" }

// Roving focus over the home rows: Left/Right within a row, Up/Down to the neighbouring row keeping the column
// (clamped to its length), Home/End to a row's ends.
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

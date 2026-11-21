// Home rows and series state derived from the library and the watch-state records, following the rules common media
// servers use for Continue Watching, Next Up and Latest. Everything works off one index built in a single pass.

import { deriveWatchState, itemKey, type DerivedWatchState, type ItemRec, type WatchItemClass } from "./watchState"
import { compareVideoIds } from "./versions"

export interface HomeVideo {
	// Stable uuid: the watch-state key
	id: string
	// Current file uuid and size (watch-state fingerprint)
	uuid: string
	size: number
	itemClass: WatchItemClass
	// Episodes: the series directory, season (0 = specials) and episode numbers; a multi-episode file ends at episodeEnd
	seriesId?: string | null
	season?: number | null
	episode?: number | null
	episodeEnd?: number | null
	// Episodes numbered across the whole series; season is ignored
	absolute?: boolean
	// Files that are versions of one title share a group
	versionGroup?: string | null
	versionLabel?: string | null
	dateAdded: number
	durationSec?: number | null
}

export interface HomeEntry {
	video: HomeVideo
	state: DerivedWatchState
	// versionGroup, else id
	group: string
}

// One episode slot of a series: all versions of it.
export interface EpisodeUnit {
	group: string
	// null for absolute numbering or an unknown season
	season: number | null
	episode: number | null
	episodeEnd: number | null
	versions: HomeEntry[]
	played: boolean
	// The most recently played version
	latest: HomeEntry | null
	// `latest` when it has a resume point (hidden or not)
	resume: HomeEntry | null
	addedMs: number
	lastPlayedMs: number
}

export interface HomeSeries {
	id: string
	// Ordered by season, then episode; unnumbered episodes last within their season
	units: EpisodeUnit[]
	// Unit count per season
	seasons: Map<number | null, number>
	newestAddedMs: number
	lastPlayedMs: number
	// Version label of the most recently played file
	lastPlayedLabel: string | null
}

export interface HomeIndex {
	entries: HomeEntry[]
	series: Map<string, HomeSeries>
}

const DAY_MS = 86_400_000

function orderSeason(unit: EpisodeUnit): number {
	return unit.season ?? 1
}

function compareUnits(a: EpisodeUnit, b: EpisodeUnit): number {
	return (
		orderSeason(a) - orderSeason(b) ||
		(a.episode ?? Infinity) - (b.episode ?? Infinity) ||
		(a.group < b.group ? -1 : a.group > b.group ? 1 : 0)
	)
}

// Specials and unnumbered episodes have no place in the watch order.
function isOrdered(unit: EpisodeUnit): unit is EpisodeUnit & { episode: number } {
	return unit.season !== 0 && unit.episode !== null
}

function wasPlayed(entry: HomeEntry): boolean {
	return entry.state.lastPlayedMs > 0 || entry.state.inProgress || entry.state.played
}

interface SeriesBuild {
	series: HomeSeries
	units: Map<string, EpisodeUnit>
	lastPlayedEntry: HomeEntry | null
}

// `items` is the watch-state document's items map; `lastPlayedCeilingMs` caps play times from fast clocks.
export function buildHomeIndex({
	videos,
	items,
	lastPlayedCeilingMs
}: {
	videos: readonly HomeVideo[]
	items: Readonly<Record<string, ItemRec>>
	lastPlayedCeilingMs?: number | undefined
}): HomeIndex {
	const entries: HomeEntry[] = []
	const builds = new Map<string, SeriesBuild>()

	for (const video of videos) {
		const entry: HomeEntry = {
			video,
			state: deriveWatchState({
				rec: items[itemKey(video.id)],
				file: video,
				lastPlayedCeilingMs
			}),
			group: video.versionGroup ?? video.id
		}

		entries.push(entry)

		const seriesId = video.seriesId

		if (video.itemClass !== "episode" || seriesId === null || seriesId === undefined) {
			continue
		}

		let build = builds.get(seriesId)

		if (build === undefined) {
			build = {
				series: {
					id: seriesId,
					units: [],
					seasons: new Map(),
					newestAddedMs: 0,
					lastPlayedMs: 0,
					lastPlayedLabel: null
				},
				units: new Map(),
				lastPlayedEntry: null
			}

			builds.set(seriesId, build)
		}

		let unit = build.units.get(entry.group)

		if (unit === undefined) {
			const episode = video.episode ?? null

			unit = {
				group: entry.group,
				season: video.absolute === true ? null : (video.season ?? null),
				episode,
				episodeEnd: episode === null ? null : Math.max(episode, video.episodeEnd ?? episode),
				versions: [],
				played: false,
				latest: null,
				resume: null,
				addedMs: 0,
				lastPlayedMs: 0
			}

			build.units.set(entry.group, unit)
		}

		const { state } = entry

		unit.versions.push(entry)
		unit.played ||= state.played
		unit.addedMs = Math.max(unit.addedMs, video.dateAdded)
		unit.lastPlayedMs = Math.max(unit.lastPlayedMs, state.lastPlayedMs)

		if (wasPlayed(entry) && (unit.latest === null || newestPlayedFirst(entry, unit.latest) < 0)) {
			unit.latest = entry
		}

		if (state.lastPlayedMs > 0 && (build.lastPlayedEntry === null || state.lastPlayedMs > build.lastPlayedEntry.state.lastPlayedMs)) {
			build.lastPlayedEntry = entry
		}
	}

	const series = new Map<string, HomeSeries>()

	for (const [id, build] of builds) {
		const result = build.series

		for (const unit of build.units.values()) {
			unit.resume = unit.latest?.state.inProgress === true ? unit.latest : null
			result.units.push(unit)
			result.seasons.set(unit.season, (result.seasons.get(unit.season) ?? 0) + 1)
			result.newestAddedMs = Math.max(result.newestAddedMs, unit.addedMs)
			result.lastPlayedMs = Math.max(result.lastPlayedMs, unit.lastPlayedMs)
		}

		result.units.sort(compareUnits)
		result.lastPlayedLabel = build.lastPlayedEntry?.video.versionLabel ?? null
		series.set(id, result)
	}

	return {
		entries,
		series
	}
}

// The best `limit` values in rank order: a binary-insertion window when limited, a sort otherwise.
function ranked<T>(values: Iterable<T>, limit: number | undefined, compare: (a: T, b: T) => number): T[] {
	if (limit === undefined) {
		return Array.from(values).sort(compare)
	}

	const out: T[] = []

	if (limit <= 0) {
		return out
	}

	for (const value of values) {
		const last = out[out.length - 1]

		if (out.length >= limit && last !== undefined && compare(value, last) >= 0) {
			continue
		}

		let low = 0
		let high = out.length

		while (low < high) {
			const middle = (low + high) >>> 1
			const item = out[middle]

			if (item !== undefined && compare(item, value) <= 0) {
				low = middle + 1
			} else {
				high = middle
			}
		}

		out.splice(low, 0, value)

		if (out.length > limit) {
			out.pop()
		}
	}

	return out
}

function newestPlayedFirst(a: HomeEntry, b: HomeEntry): number {
	return b.state.lastPlayedMs - a.state.lastPlayedMs || compareVideoIds(a.video.id, b.video.id)
}

// ── Continue Watching ────────────────────────────────────────────────────────

// Most recently played first, one per version group: its most recently played version, when that one is resumable.
export function selectContinueWatching({ index, limit }: { index: HomeIndex; limit?: number }): HomeEntry[] {
	const groups = new Map<string, HomeEntry>()

	for (const entry of index.entries) {
		if (!wasPlayed(entry)) {
			continue
		}

		const current = groups.get(entry.group)

		if (current === undefined || newestPlayedFirst(entry, current) < 0) {
			groups.set(entry.group, entry)
		}
	}

	const resumable: HomeEntry[] = []

	for (const entry of groups.values()) {
		if (entry.state.resumable) {
			resumable.push(entry)
		}
	}

	return ranked(resumable, limit, newestPlayedFirst)
}

// ── Next Up ──────────────────────────────────────────────────────────────────

export const NEXT_UP_CUTOFF_DAYS = 365

function compareKey(seasonA: number, episodeA: number, seasonB: number, episodeB: number): number {
	return seasonA - seasonB || episodeA - episodeB
}

interface SeriesProgress {
	anyPlayed: boolean
	// Lowest unplayed ordered unit past the highest played one (from the start when nothing is played)
	next: EpisodeUnit | null
}

function seriesProgress(series: HomeSeries): SeriesProgress {
	let anyPlayed = false
	let lastSeason = -Infinity
	let lastEpisode = -Infinity

	for (const unit of series.units) {
		if (unit.played && isOrdered(unit) && compareKey(orderSeason(unit), unit.episodeEnd ?? unit.episode, lastSeason, lastEpisode) > 0) {
			anyPlayed = true
			lastSeason = orderSeason(unit)
			lastEpisode = unit.episodeEnd ?? unit.episode
		}
	}

	for (const unit of series.units) {
		if (!unit.played && isOrdered(unit) && compareKey(orderSeason(unit), unit.episode, lastSeason, lastEpisode) > 0) {
			return {
				anyPlayed,
				next: unit
			}
		}
	}

	return {
		anyPlayed,
		next: null
	}
}

// The version matching the label played last, else the first.
function pickVersion(unit: EpisodeUnit, label: string | null): HomeEntry {
	const match = label === null ? undefined : unit.versions.find(entry => entry.video.versionLabel === label)

	return match ?? (unit.versions[0] as HomeEntry)
}

export interface NextUpEntry {
	seriesId: string
	entry: HomeEntry
	// The series' most recent play
	lastPlayedMs: number
}

function newestSeriesFirst(a: NextUpEntry, b: NextUpEntry): number {
	return b.lastPlayedMs - a.lastPlayedMs || compareVideoIds(a.seriesId, b.seriesId)
}

// For each series played within `cutoffDays` (null = no cutoff), newest first: the episode after the highest played
// one. A series whose next episode has a resume point is left to Continue Watching, even while hidden there (until a
// new play clears that); specials are skipped.
export function selectNextUp({
	index,
	now,
	cutoffDays = NEXT_UP_CUTOFF_DAYS,
	limit
}: {
	index: HomeIndex
	now: number
	cutoffDays?: number | null
	limit?: number
}): NextUpEntry[] {
	const since = cutoffDays === null ? -Infinity : now - cutoffDays * DAY_MS
	const out: NextUpEntry[] = []

	for (const series of index.series.values()) {
		if (series.lastPlayedMs === 0 || series.lastPlayedMs < since) {
			continue
		}

		const { anyPlayed, next } = seriesProgress(series)

		if (!anyPlayed || next === null || next.resume !== null) {
			continue
		}

		out.push({
			seriesId: series.id,
			entry: pickVersion(next, series.lastPlayedLabel),
			lastPlayedMs: series.lastPlayedMs
		})
	}

	return ranked(out, limit, newestSeriesFirst)
}

// ── Merged Continue Watching row ─────────────────────────────────────────────

export type ContinueWatchingCard =
	| {
			type: "resume"
			entry: HomeEntry
			lastPlayedMs: number
	  }
	| {
			type: "next"
			entry: HomeEntry
			seriesId: string
			lastPlayedMs: number
	  }

// Interleaves both selector outputs (each newest first) by last play. One card per series and per version group:
// the newer wins, a resume card on a tie.
export function buildContinueWatchingRow({
	resume,
	nextUp,
	limit = Infinity
}: {
	resume: readonly HomeEntry[]
	nextUp: readonly NextUpEntry[]
	limit?: number
}): ContinueWatchingCard[] {
	const out: ContinueWatchingCard[] = []
	const seenSeries = new Set<string>()
	const seenGroups = new Set<string>()
	let i = 0
	let j = 0

	while (out.length < limit && (i < resume.length || j < nextUp.length)) {
		const entry = resume[i]
		const next = nextUp[j]
		let card: ContinueWatchingCard
		let seriesId: string | null | undefined

		if (entry !== undefined && (next === undefined || entry.state.lastPlayedMs >= next.lastPlayedMs)) {
			i++
			card = {
				type: "resume",
				entry,
				lastPlayedMs: entry.state.lastPlayedMs
			}
			seriesId = entry.video.itemClass === "episode" ? entry.video.seriesId : null
		} else if (next !== undefined) {
			j++
			card = {
				type: "next",
				entry: next.entry,
				seriesId: next.seriesId,
				lastPlayedMs: next.lastPlayedMs
			}
			seriesId = next.seriesId
		} else {
			break
		}

		if (seenGroups.has(card.entry.group) || (seriesId !== null && seriesId !== undefined && seenSeries.has(seriesId))) {
			continue
		}

		seenGroups.add(card.entry.group)

		if (seriesId !== null && seriesId !== undefined) {
			seenSeries.add(seriesId)
		}

		out.push(card)
	}

	return out
}

// ── Latest ───────────────────────────────────────────────────────────────────

function newestAddedFirst(a: HomeEntry, b: HomeEntry): number {
	return b.video.dateAdded - a.video.dateAdded || compareVideoIds(a.video.id, b.video.id)
}

// Movies, newest first, one per version group (its newest version).
export function selectLatestMovies({ index, limit }: { index: HomeIndex; limit?: number }): HomeEntry[] {
	const groups = new Map<string, HomeEntry>()

	for (const entry of index.entries) {
		if (entry.video.itemClass !== "movie") {
			continue
		}

		const current = groups.get(entry.group)

		if (current === undefined || newestAddedFirst(entry, current) < 0) {
			groups.set(entry.group, entry)
		}
	}

	return ranked(groups.values(), limit, newestAddedFirst)
}

// Episodes added within this span before a series' newest one are shown together.
export const LATEST_GROUP_WINDOW_MS = DAY_MS

export type LatestEpisodeCard =
	| {
			type: "episode"
			seriesId: string
			entry: HomeEntry
			addedMs: number
	  }
	| {
			type: "season"
			seriesId: string
			season: number | null
			count: number
			addedMs: number
	  }
	| {
			type: "series"
			seriesId: string
			count: number
			addedMs: number
	  }

function newestSeriesAddedFirst(a: HomeSeries, b: HomeSeries): number {
	return b.newestAddedMs - a.newestAddedMs || compareVideoIds(a.id, b.id)
}

function newestVersion(unit: EpisodeUnit): HomeEntry {
	let best = unit.versions[0] as HomeEntry

	for (const entry of unit.versions) {
		if (newestAddedFirst(entry, best) < 0) {
			best = entry
		}
	}

	return best
}

// The `limit` series with the newest episodes, one card each for what arrived in the window before that series'
// newest episode: a single episode, a season (several episodes, or all of it), or the series (several seasons, or
// a single-season series).
export function selectLatestEpisodes({ index, limit }: { index: HomeIndex; limit?: number }): LatestEpisodeCard[] {
	const top = ranked(index.series.values(), limit, newestSeriesAddedFirst)
	const out: LatestEpisodeCard[] = []

	for (const series of top) {
		const from = series.newestAddedMs - LATEST_GROUP_WINDOW_MS
		let count = 0
		let season: number | null = null
		let multiSeason = false
		let single: EpisodeUnit | null = null

		for (const unit of series.units) {
			if (unit.addedMs < from) {
				continue
			}

			if (single === null) {
				season = unit.season
			} else if (unit.season !== season) {
				multiSeason = true
			}

			count++
			single = unit
		}

		if (single === null) {
			continue
		}

		if (multiSeason) {
			out.push({
				type: "series",
				seriesId: series.id,
				count,
				addedMs: series.newestAddedMs
			})

			continue
		}

		if (count > 1 || count === series.seasons.get(season)) {
			let regularSeasons = 0

			for (const key of series.seasons.keys()) {
				if (key !== 0) {
					regularSeasons++
				}
			}

			out.push(
				regularSeasons <= 1 && season !== 0
					? {
							type: "series",
							seriesId: series.id,
							count,
							addedMs: series.newestAddedMs
						}
					: {
							type: "season",
							seriesId: series.id,
							season,
							count,
							addedMs: series.newestAddedMs
						}
			)

			continue
		}

		out.push({
			type: "episode",
			seriesId: series.id,
			entry: newestVersion(single),
			addedMs: series.newestAddedMs
		})
	}

	return out
}

// ── Series page ──────────────────────────────────────────────────────────────

export type SeriesPrimaryAction =
	| {
			type: "resume"
			entry: HomeEntry
	  }
	| {
			type: "play"
			entry: HomeEntry
	  }
	| {
			type: "playFirst"
			entry: HomeEntry
	  }

// "Resume SxEy" when the next episode is in progress, "Play SxEy" for the next one, otherwise play from the first
// episode (nothing watched yet, or everything watched).
export function selectSeriesPrimaryAction({ index, seriesId }: { index: HomeIndex; seriesId: string }): SeriesPrimaryAction | null {
	const series = index.series.get(seriesId)

	if (series === undefined) {
		return null
	}

	const { anyPlayed, next } = seriesProgress(series)

	if (next !== null && next.resume !== null) {
		return {
			type: "resume",
			entry: next.resume
		}
	}

	if (next !== null && anyPlayed) {
		return {
			type: "play",
			entry: pickVersion(next, series.lastPlayedLabel)
		}
	}

	const first = series.units.find(isOrdered) ?? series.units[0]

	return first === undefined
		? null
		: {
				type: "playFirst",
				entry: pickVersion(first, series.lastPlayedLabel)
			}
}

export interface UnwatchedCount {
	// Excludes specials
	total: number
	seasons: Map<number | null, number>
}

// Unplayed episode slots per series and season (in-progress ones count as unplayed).
export function selectUnwatchedCounts(index: HomeIndex): Map<string, UnwatchedCount> {
	const out = new Map<string, UnwatchedCount>()

	for (const series of index.series.values()) {
		const count: UnwatchedCount = {
			total: 0,
			seasons: new Map()
		}

		for (const unit of series.units) {
			const current = count.seasons.get(unit.season) ?? 0

			if (unit.played) {
				count.seasons.set(unit.season, current)

				continue
			}

			count.seasons.set(unit.season, current + 1)

			if (unit.season !== 0) {
				count.total++
			}
		}

		out.set(series.id, count)
	}

	return out
}

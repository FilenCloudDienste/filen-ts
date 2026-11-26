// Manual corrections applied to a classified library: renamed titles, items shown as another kind (a movie as an
// episode, an episode as a movie or other video, ...), series merged into another, hidden titles. Corrections always
// win over what the names say. Keys follow the library configuration: `d:<id>` for a series or a title with its own
// directory, `s:<stable uuid>` for a single-file title or an episode (by its first file), `m:<merge key>` for keeping
// same-titled series of different roots apart.

import {
	NO_FILE,
	compareEpisodes,
	type LibraryArt,
	type LibraryEpisode,
	type LibraryExtra,
	type LibraryMovie,
	type LibraryOther,
	type LibrarySeason,
	type LibrarySeries,
	type LibraryVersion,
	type VideoLibrary
} from "./classify"
import type { LibraryOverride } from "./libraryConfig"
import { compareVideoIds } from "./versions"
import { videoSortName } from "./sortName"

// What the classifier made of a corrected item: the values a correction is compared with.
export interface CorrectionOriginal {
	kind: "movie" | "series" | "other" | "episode"
	title: string
	// 0 when unknown, and for episodes and other videos.
	year: number
	// Episodes only (0 otherwise).
	season: number
	episode: number
	episodeEnd: number
	// The series an episode was classified into (`d:` key); empty otherwise.
	seriesKey: string
}

export interface OverriddenLibrary {
	library: VideoLibrary
	// Ids of the titles a correction hides.
	hidden: ReadonlySet<string>
	// Titles whose correction is stored under another key than titleOverrideKey gives them (the later parts of a
	// title shown as other videos), by title id.
	titleKeys: ReadonlyMap<string, string>
	// Episodes whose correction is stored under another key than their own (a directory's movie made an episode),
	// by the stable uuid of their first file.
	episodeKeys: ReadonlyMap<string, string>
	// What the classifier made of every corrected item, by the correction's key.
	originals: ReadonlyMap<string, CorrectionOriginal>
	// Series the classifier itself merged from same-titled series of several roots: id → their root count.
	autoMerged: ReadonlyMap<string, number>
}

// Key prefixes. Override keys are persisted and shared across clients: these never change.
const DIRECTORY_KEY_PREFIX = "d:"
const STABLE_UUID_KEY_PREFIX = "s:"
const MERGE_KEY_PREFIX = "m:"

export function seriesOverrideKey(id: string): string {
	return `${DIRECTORY_KEY_PREFIX}${id}`
}

export function episodeOverrideKey(stableUuid: string): string {
	return `${STABLE_UUID_KEY_PREFIX}${stableUuid}`
}

// Where "keep same-titled series apart" is stored: by the series' merge key, the same whichever root came first.
export function splitOverrideKey(mergeKey: string): string {
	return `${MERGE_KEY_PREFIX}${mergeKey}`
}

// What a key holds after its prefix, or null when it has another one.
function stripPrefix(key: string, prefix: string): string | null {
	return key.startsWith(prefix) ? key.slice(prefix.length) : null
}

// The id of the series a title made an episode of no existing series starts: its own, so the title's key (which
// may be `d:` + the same id) and the new series' key never meet.
export function newSeriesId(sourceId: string): string {
	return `series-${sourceId}`
}

// A movie's or other video's key: `s:` when its id is one of its files' stable uuids (no directory of its own), else
// `d:`. Ids survive a reclassification, so the key does too.
export function titleOverrideKey({ id, stableUuids }: { id: string; stableUuids: Iterable<string> }): string {
	for (const stableUuid of stableUuids) {
		if (stableUuid === id) {
			return episodeOverrideKey(id)
		}
	}

	return seriesOverrideKey(id)
}

// The merge keys a correction keeps apart, for the classifier.
export function splitMergeKeysOf(overrides: Readonly<Record<string, LibraryOverride>>): Set<string> {
	const out = new Set<string>()

	for (const key in overrides) {
		const mergeKey = stripPrefix(key, MERGE_KEY_PREFIX)

		if (mergeKey !== null && overrides[key]?.split === true) {
			out.add(mergeKey)
		}
	}

	return out
}

function emptyArt(): LibraryArt {
	return {
		poster: NO_FILE,
		backdrop: NO_FILE,
		logo: NO_FILE
	}
}

interface MovedEpisode {
	episode: LibraryEpisode
	// Key of the series it goes to; null for a new series of its own.
	target: string | null
	// The series it came from (back there when the target is gone); null for a title made an episode.
	fromSeries: string | null
	source: { id: string; title: string; year: number; roots: number[]; dateAdded: number }
	// A movie's extras go with it, to the series.
	extras: readonly LibraryExtra[]
}

interface Context {
	library: VideoLibrary
	overrides: Readonly<Record<string, LibraryOverride>>
	stableUuidOf: (file: number) => string | undefined
	movies: LibraryMovie[]
	others: LibraryOther[]
	moved: MovedEpisode[]
	titleKeys: Map<string, string>
	episodeKeys: Map<string, string>
	originals: Map<string, CorrectionOriginal>
}

function original(fields: Partial<CorrectionOriginal> & Pick<CorrectionOriginal, "kind" | "title">): CorrectionOriginal {
	return { year: 0, season: 0, episode: 0, episodeEnd: 0, seriesKey: "", ...fields }
}

function partStableUuids(ctx: Context, versions: readonly LibraryVersion[]): string[] {
	const out: string[] = []

	for (const version of versions) {
		for (const video of version.parts) {
			const entry = ctx.library.videos[video]
			const stableUuid = entry === undefined ? undefined : ctx.stableUuidOf(entry.file)

			if (stableUuid !== undefined) {
				out.push(stableUuid)
			}
		}
	}

	return out
}

// compareEpisodes, then the first file's stable uuid: a moved episode can share its season and number with one
// already there, and the walk's order must not decide between them.
function compareEpisodesById(ctx: Context): (a: LibraryEpisode, b: LibraryEpisode) => number {
	return (a, b) =>
		compareEpisodes(a, b) || compareVideoIds(firstStableUuid(ctx, a.versions) ?? "", firstStableUuid(ctx, b.versions) ?? "")
}

function firstStableUuid(ctx: Context, versions: readonly LibraryVersion[]): string | undefined {
	const video = versions[0]?.parts[0]
	const entry = video === undefined ? undefined : ctx.library.videos[video]

	return entry === undefined ? undefined : ctx.stableUuidOf(entry.file)
}

function isEpisodeKind(override: LibraryOverride | undefined): override is LibraryOverride & { season: number; episode: number } {
	return override?.kind === "episode" && override.season !== undefined && override.episode !== undefined
}

// The last episode of a placed episode: the correction's, else the span the file had, from the new first number.
function spanEnd(override: LibraryOverride & { episode: number }, span: number): number {
	return Math.max(override.episode, override.episodeEnd ?? override.episode + span)
}

function named<T extends { title: string; sortName: string }>(item: T, override: LibraryOverride | undefined): T {
	return override?.title === undefined
		? item
		: {
				...item,
				title: override.title,
				sortName: videoSortName(override.title)
			}
}

// One other video per part of the versions (and per extra), all governed by `key`: the first keeps `id`, the rest
// their own file's id, and a correction saved from any of them applies to all.
function pushOthers({
	ctx,
	key,
	id,
	title,
	root,
	videos,
	dateAdded
}: {
	ctx: Context
	key: string
	id: string
	title: string
	root: number
	videos: readonly number[]
	dateAdded: number
}): void {
	videos.forEach((video, index) => {
		const entry = ctx.library.videos[video]
		const stableUuid = entry === undefined ? undefined : ctx.stableUuidOf(entry.file)
		const otherId = index === 0 ? id : stableUuid

		if (otherId === undefined) {
			return
		}

		if (titleOverrideKey({ id: otherId, stableUuids: stableUuid === undefined ? [] : [stableUuid] }) !== key) {
			ctx.titleKeys.set(otherId, key)
		}

		ctx.others.push({
			id: otherId,
			title,
			sortName: videoSortName(title),
			root,
			video,
			dateAdded
		})
	})
}

function movieFrom({
	id,
	title,
	year,
	roots,
	versions,
	dateAdded
}: {
	id: string
	title: string
	year: number
	roots: number[]
	versions: LibraryVersion[]
	dateAdded: number
}): LibraryMovie {
	return {
		id,
		title,
		sortName: videoSortName(title),
		year,
		mergeKey: "",
		roots,
		nfo: NO_FILE,
		art: emptyArt(),
		versions,
		extras: [],
		dateAdded,
		disc: false
	}
}

function allParts(versions: readonly LibraryVersion[]): number[] {
	return versions.flatMap(version => version.parts)
}

function applyToMovies(ctx: Context): void {
	for (const movie of ctx.library.movies) {
		const key = titleOverrideKey({ id: movie.id, stableUuids: partStableUuids(ctx, movie.versions) })
		const override = ctx.overrides[key]

		if (override !== undefined) {
			ctx.originals.set(key, original({ kind: "movie", title: movie.title, year: movie.year }))
		}

		if (override?.kind === "other") {
			pushOthers({
				ctx,
				key,
				id: movie.id,
				title: override.title ?? movie.title,
				root: movie.roots[0] ?? 0,
				videos: [...allParts(movie.versions), ...movie.extras.map(extra => extra.video)],
				dateAdded: movie.dateAdded
			})

			continue
		}

		if (isEpisodeKind(override)) {
			const first = firstStableUuid(ctx, movie.versions)

			if (first !== undefined && key !== episodeOverrideKey(first)) {
				ctx.episodeKeys.set(first, key)
			}

			ctx.moved.push({
				episode: {
					season: override.season,
					episode: override.episode,
					episodeEnd: spanEnd(override, 0),
					date: 0,
					// Its own name, unless the correction gives another: the series it joins shows it beside the code.
					title: override.title ?? movie.title,
					versions: movie.versions,
					dateAdded: movie.dateAdded
				},
				target: override.mergeInto ?? null,
				fromSeries: null,
				source: movie,
				extras: movie.extras
			})

			continue
		}

		ctx.movies.push(
			override?.year === undefined
				? named(movie, override)
				: {
						...named(movie, override),
						year: override.year
					}
		)
	}
}

function applyToOthers(ctx: Context): void {
	for (const other of ctx.library.others) {
		const key = episodeOverrideKey(other.id)
		const override = ctx.overrides[key]
		const versions = [{ label: "", parts: [other.video] }]

		if (override !== undefined) {
			ctx.originals.set(key, original({ kind: "other", title: other.title }))
		}

		if (override?.kind === "movie") {
			ctx.movies.push(
				movieFrom({
					id: other.id,
					title: override.title ?? other.title,
					year: override.year ?? 0,
					roots: [other.root],
					versions,
					dateAdded: other.dateAdded
				})
			)

			continue
		}

		if (isEpisodeKind(override)) {
			ctx.moved.push({
				episode: {
					season: override.season,
					episode: override.episode,
					episodeEnd: spanEnd(override, 0),
					date: 0,
					title: override.title ?? other.title,
					versions,
					dateAdded: other.dateAdded
				},
				target: override.mergeInto ?? null,
				fromSeries: null,
				source: {
					id: other.id,
					title: other.title,
					year: 0,
					roots: [other.root],
					dateAdded: other.dateAdded
				},
				extras: []
			})

			continue
		}

		ctx.others.push(named(other, override))
	}
}

// A series' episodes with the corrected ones taken out (to a movie, other videos, or another place) or retitled.
function applyToEpisodes(ctx: Context, series: LibrarySeries): LibrarySeries {
	let changed = false
	const seasons: LibrarySeason[] = []

	for (const season of series.seasons) {
		const episodes: LibraryEpisode[] = []
		let seasonChanged = false

		for (const episode of season.episodes) {
			const first = firstStableUuid(ctx, episode.versions)
			const key = first === undefined ? null : episodeOverrideKey(first)
			const override = key === null ? undefined : ctx.overrides[key]

			if (first === undefined || key === null || override === undefined) {
				episodes.push(episode)

				continue
			}

			changed = true
			seasonChanged = true
			ctx.originals.set(
				key,
				original({
					kind: "episode",
					title: episode.title,
					season: episode.season,
					episode: episode.episode,
					episodeEnd: episode.episodeEnd,
					seriesKey: seriesOverrideKey(series.id)
				})
			)

			const title = override.title ?? (episode.title.length > 0 ? episode.title : series.title)

			if (override.kind === "movie") {
				ctx.movies.push(
					movieFrom({
						id: first,
						title,
						year: override.year ?? 0,
						roots: series.roots,
						versions: episode.versions,
						dateAdded: episode.dateAdded
					})
				)

				continue
			}

			if (override.kind === "other") {
				pushOthers({
					ctx,
					key,
					id: first,
					title,
					root: series.roots[0] ?? 0,
					videos: allParts(episode.versions),
					dateAdded: episode.dateAdded
				})

				continue
			}

			const renamed = override.title === undefined ? episode : { ...episode, title: override.title }
			// A renumbered file keeps its span (a multi-episode file) and its air date.
			const placed = isEpisodeKind(override)
				? {
						...renamed,
						season: override.season,
						episode: override.episode,
						episodeEnd: spanEnd(override, Math.max(0, episode.episodeEnd - episode.episode))
					}
				: renamed
			const target = override.mergeInto ?? seriesOverrideKey(series.id)

			if (target === seriesOverrideKey(series.id) && placed.season === season.number) {
				episodes.push(placed)

				continue
			}

			ctx.moved.push({
				episode: placed,
				target,
				fromSeries: series.id,
				source: series,
				extras: []
			})
		}

		seasons.push(
			!seasonChanged
				? season
				: {
						...season,
						episodes: episodes.sort(compareEpisodesById(ctx))
					}
		)
	}

	return changed
		? {
				...series,
				seasons
			}
		: series
}

interface SeriesBuild {
	series: LibrarySeries
	seasons: Map<number, LibrarySeason>
	touched: boolean
}

function newSeriesBuild(series: LibrarySeries, touched: boolean): SeriesBuild {
	return {
		series,
		seasons: new Map(series.seasons.map(season => [season.number, season])),
		touched
	}
}

function seasonOf(build: SeriesBuild, number: number): LibrarySeason {
	let season = build.seasons.get(number)

	if (season === undefined) {
		season = {
			number,
			dirUuid: "",
			nfo: NO_FILE,
			art: emptyArt(),
			episodes: []
		}
		build.seasons.set(number, season)
	}

	return season
}

function addEpisode(build: SeriesBuild, moved: MovedEpisode): void {
	const season = seasonOf(build, moved.episode.season)

	build.seasons.set(moved.episode.season, {
		...season,
		episodes: [...season.episodes, moved.episode]
	})

	if (moved.extras.length > 0) {
		build.series = {
			...build.series,
			extras: [...build.series.extras, ...moved.extras]
		}
	}

	build.touched = true
}

function foldInto(into: SeriesBuild, from: SeriesBuild): void {
	for (const season of from.seasons.values()) {
		const target = seasonOf(into, season.number)

		into.seasons.set(season.number, {
			...target,
			dirUuid: target.dirUuid.length > 0 ? target.dirUuid : season.dirUuid,
			nfo: target.nfo === NO_FILE ? season.nfo : target.nfo,
			art: target.art.poster === NO_FILE ? season.art : target.art,
			episodes: [...target.episodes, ...season.episodes]
		})
	}

	const a = into.series
	const b = from.series

	into.series = {
		...a,
		roots: [...a.roots, ...b.roots.filter(root => !a.roots.includes(root))],
		extras: [...a.extras, ...b.extras],
		art: {
			poster: a.art.poster === NO_FILE ? b.art.poster : a.art.poster,
			backdrop: a.art.backdrop === NO_FILE ? b.art.backdrop : a.art.backdrop,
			logo: a.art.logo === NO_FILE ? b.art.logo : a.art.logo
		},
		nfo: a.nfo === NO_FILE ? b.nfo : a.nfo
	}
	into.touched = true
}

function finishSeries(ctx: Context, build: SeriesBuild): LibrarySeries | null {
	const override = ctx.overrides[seriesOverrideKey(build.series.id)]
	let series = build.series

	if (build.touched) {
		const seasons = [...build.seasons.values()]
			.filter(season => season.episodes.length > 0 || season.dirUuid.length > 0)
			.map(season => ({
				...season,
				episodes: [...season.episodes].sort(compareEpisodesById(ctx))
			}))
			.sort((a, b) => a.number - b.number)
		let dateAdded = 0

		for (const season of seasons) {
			for (const episode of season.episodes) {
				dateAdded = Math.max(dateAdded, episode.dateAdded)
			}
		}

		if (seasons.every(season => season.episodes.length === 0)) {
			return null
		}

		series = {
			...series,
			seasons,
			dateAdded
		}
	}

	return override?.year === undefined ? named(series, override) : { ...named(series, override), year: override.year }
}

function idOfSeriesKey(key: string | null): string | null {
	return key === null ? null : stripPrefix(key, DIRECTORY_KEY_PREFIX)
}

// The series a series' merge chain ends at: itself when it isn't merged, when the chain leaves the known series, or
// when it loops.
function mergeTarget(ctx: Context, id: string, ids: ReadonlySet<string>): string {
	const seen = new Set<string>([id])
	let current = id

	for (;;) {
		const next = idOfSeriesKey(ctx.overrides[seriesOverrideKey(current)]?.mergeInto ?? null)

		if (next === null || !ids.has(next)) {
			return current
		}

		if (seen.has(next)) {
			return id
		}

		seen.add(next)
		current = next
	}
}

// In phases, so the result doesn't depend on the order titles were classified in: every series that will exist is
// built first (the classified ones, then a new one per title made an episode that some move lands in), then moves
// land in them, then merges fold whole series along their chains.
function applyToSeries(ctx: Context): LibrarySeries[] {
	const builds = new Map<string, SeriesBuild>()

	for (const series of ctx.library.series) {
		const corrected = applyToEpisodes(ctx, series)

		builds.set(corrected.id, newSeriesBuild(corrected, corrected !== series))
	}

	// A title made an episode can start a series of its own; another title may name that one as its series.
	const starters = new Map<string, MovedEpisode["source"]>()

	for (const moved of ctx.moved) {
		if (moved.fromSeries === null) {
			starters.set(newSeriesId(moved.source.id), moved.source)
		}
	}

	const known = (id: string | null): id is string => id !== null && (builds.has(id) || starters.has(id))
	const destinations = ctx.moved.map(moved => {
		const target = idOfSeriesKey(moved.target)

		if (known(target)) {
			return target
		}

		return moved.fromSeries ?? newSeriesId(moved.source.id)
	})

	for (const id of [...new Set(destinations)].filter(id => !builds.has(id)).sort()) {
		const source = starters.get(id)

		if (source !== undefined) {
			builds.set(
				id,
				newSeriesBuild(
					{
						id,
						title: source.title,
						sortName: videoSortName(source.title),
						year: source.year,
						mergeKey: "",
						roots: [...source.roots],
						nfo: NO_FILE,
						art: emptyArt(),
						seasons: [],
						extras: [],
						dateAdded: source.dateAdded
					},
					true
				)
			)
		}
	}

	ctx.moved.forEach((moved, index) => {
		const build = builds.get(destinations[index] ?? "")

		if (build !== undefined) {
			addEpisode(build, moved)
		}
	})

	const ids = new Set(builds.keys())

	for (const [id, build] of [...builds]) {
		const into = mergeTarget(ctx, id, ids)

		if (into !== id) {
			const target = builds.get(into)

			if (target !== undefined) {
				foldInto(target, build)
				builds.delete(id)
			}
		}
	}

	const out: LibrarySeries[] = []

	for (const build of builds.values()) {
		const series = finishSeries(ctx, build)

		if (series !== null) {
			out.push(series)
		}
	}

	return out
}

// The library as the corrections have it. Pure; returns the input untouched when there are none. Videos keep their
// indices, so file and video references from the classification stay valid.
export function applyLibraryOverrides({
	library,
	overrides,
	stableUuidOf
}: {
	library: VideoLibrary
	overrides: Readonly<Record<string, LibraryOverride>>
	// The stable uuid of a file index of the classified listing.
	stableUuidOf: (file: number) => string | undefined
}): OverriddenLibrary {
	const autoMerged = new Map<string, number>()

	for (const series of library.series) {
		if (series.roots.length > 1) {
			autoMerged.set(series.id, series.roots.length)
		}
	}

	let any = false

	for (const key in overrides) {
		if (key.length > 0) {
			any = true

			break
		}
	}

	if (!any) {
		return {
			library,
			hidden: new Set(),
			titleKeys: new Map(),
			episodeKeys: new Map(),
			originals: new Map(),
			autoMerged
		}
	}

	const ctx: Context = {
		library,
		overrides,
		stableUuidOf,
		movies: [],
		others: [],
		moved: [],
		titleKeys: new Map(),
		episodeKeys: new Map(),
		originals: new Map()
	}

	applyToMovies(ctx)
	applyToOthers(ctx)

	for (const series of library.series) {
		const key = seriesOverrideKey(series.id)

		if (overrides[key] !== undefined) {
			ctx.originals.set(key, original({ kind: "series", title: series.title, year: series.year }))
		}
	}

	const series = applyToSeries(ctx)
	const hidden = new Set<string>()
	const hides = (key: string): boolean => ctx.overrides[key]?.hidden === true

	for (const movie of ctx.movies) {
		if (hides(ctx.titleKeys.get(movie.id) ?? titleOverrideKey({ id: movie.id, stableUuids: partStableUuids(ctx, movie.versions) }))) {
			hidden.add(movie.id)
		}
	}

	for (const item of series) {
		if (hides(seriesOverrideKey(item.id))) {
			hidden.add(item.id)
		}
	}

	for (const other of ctx.others) {
		const entry = library.videos[other.video]
		const stableUuid = entry === undefined ? undefined : stableUuidOf(entry.file)
		const key =
			ctx.titleKeys.get(other.id) ?? titleOverrideKey({ id: other.id, stableUuids: stableUuid === undefined ? [] : [stableUuid] })

		if (hides(key)) {
			hidden.add(other.id)
		}
	}

	return {
		library: {
			...library,
			movies: ctx.movies,
			series,
			others: ctx.others
		},
		hidden,
		titleKeys: ctx.titleKeys,
		episodeKeys: ctx.episodeKeys,
		originals: ctx.originals,
		autoMerged
	}
}

import {
	NO_FILE,
	episodeOverrideKey,
	seriesOverrideKey,
	titleOverrideKey,
	type ExtraType,
	type LibraryArt,
	type LibraryEpisode,
	type LibraryExtra,
	type LibraryMovie,
	type LibraryOther,
	type LibraryRootType,
	type LibrarySeries,
	type LibrarySubtitle,
	type LibraryVersion,
	type SidecarSubtitleFormat,
	type VideoLibrary,
	type CorrectionOriginal
} from "@filen/shared/videos"
import type { IndexFile } from "@/workers/videoIndex/rootIndex.logic"
import { FNV1A_OFFSET_BASIS, fnv1a } from "@/lib/fnv1a"
import type { CatalogSummary } from "@/workers/videoIndex/catalog.logic"
import { artCandidates, type ArtCandidate, type ArtSubject } from "@/features/videos/lib/artwork.logic"
import type { ArtSlotCode } from "@/features/videos/lib/artStore.logic"

// What the main thread gets of the library: plain, keyless records, a screen's worth at a time (the catalog's rows,
// pages and results); a title's versions, seasons and episodes only when asked for. A file is named by its stable
// uuid; the worker rebuilds the playable file from it on demand.

export interface VideoFileRef {
	stableUuid: string
	uuid: string
	name: string
	size: number
}

export interface VideoTitleView {
	id: string
	kind: "movie" | "series" | "other"
	title: string
	sortName: string
	// 0 when unknown.
	year: number
	// Normalized title + year; empty without a year.
	mergeKey: string
	// Root directory uuids the title was found in.
	roots: string[]
	dateAdded: number
	poster: VideoFileRef | null
	backdrop: VideoFileRef | null
	logo: VideoFileRef | null
	// What the play button plays: a movie's primary version, a series' first episode, the other video itself.
	primary: VideoFileRef | null
	container: string
	// Picture height the name advertises, 0 when it says nothing.
	height: number
	// Every version is in a container that is listed but never played.
	unsupported: boolean
	disc: boolean
	versionCount: number
	extraCount: number
	seasonCount: number
	episodeCount: number
	// A manual correction hides it: left out of home rows, grids and search, still reachable to unhide.
	hidden?: true
	// Changes with everything its detail holds that this view doesn't: versions, extras, seasons (and their art and nfo),
	// episodes, each part's sidecar subtitles, nfo, thumb and edl (files by stable uuid: a new version of a file isn't
	// a change), and its card art's candidates, so a change only they see still refreshes it (set by buildTitlesSteps).
	detailHash?: number
}

export interface VideoSubtitleView {
	file: VideoFileRef
	format: SidecarSubtitleFormat
	language: string | null
	forced: boolean
	sdh: boolean
	isDefault: boolean
	title: string
}

export interface VideoPartView {
	file: VideoFileRef
	container: string
	unsupported: boolean
	height: number
	subtitles: VideoSubtitleView[]
	nfo: VideoFileRef | null
	thumb: VideoFileRef | null
	edl: VideoFileRef | null
}

export interface VideoVersionView {
	label: string
	parts: VideoPartView[]
}

export interface VideoExtraView {
	type: ExtraType
	title: string
	part: VideoPartView
}

export interface VideoEpisodeView {
	season: number
	episode: number
	episodeEnd: number
	date: number
	title: string
	dateAdded: number
	versions: VideoVersionView[]
	// Where its manual correction is stored when that isn't its own key (`s:` + its first file's stable uuid).
	overrideKey?: string
	// What the classifier made of it, when a correction applies.
	original?: CorrectionOriginal
}

// A title detail's correction context: where its correction is stored (always set by buildTitleDetail) and, when one
// applies, what the classifier made of the title.
export interface DetailCorrection {
	overrideKey?: string
	original?: CorrectionOriginal
}

export interface VideoSeasonView {
	number: number
	dirUuid: string
	poster: VideoFileRef | null
	backdrop: VideoFileRef | null
	nfo: VideoFileRef | null
	episodes: VideoEpisodeView[]
}

export type VideoTitleDetail =
	| ({
			kind: "movie"
			title: VideoTitleView
			versions: VideoVersionView[]
			extras: VideoExtraView[]
			nfo: VideoFileRef | null
	  } & DetailCorrection)
	| ({
			kind: "series"
			title: VideoTitleView
			seasons: VideoSeasonView[]
			extras: VideoExtraView[]
			nfo: VideoFileRef | null
			// Roots the classifier itself merged this series from (same title and year); 1 when it didn't.
			autoMergedRoots?: number
	  } & DetailCorrection)
	| ({ kind: "other"; title: VideoTitleView; part: VideoPartView | null } & DetailCorrection)

export type VideoRootSize = "normal" | "large" | "huge"

export interface VideoRootStatus {
	uuid: string
	name: string
	type: LibraryRootType
	// missing: the directory was trashed, deleted or can't be resolved; its last index is kept.
	state: "loading" | "ready" | "missing" | "error"
	walking: boolean
	// Known current against the drive's event stream.
	current: boolean
	completeAt: number
	walkedEntries: number
	size: VideoRootSize
	// Video files indexed.
	videos: number
	// The directory was moved since the roots were last validated.
	moved: boolean
	// The index doesn't reflect a complete walk (the latest failed, came back partial or was stopped); what it
	// shows is the last complete one, or nothing before the first.
	incomplete: boolean
}

// One playable video of the library, as the home rows, watch filters and search need it: what the watch state is
// keyed by (the stable uuid), the title it belongs to and, for an episode, its place in the series. One per version
// (its first part); extras are left out.
export interface VideoHomeItem {
	titleId: string
	stableUuid: string
	uuid: string
	size: number
	itemClass: "movie" | "episode" | "other"
	// Episodes: 0 is specials (season) or unnumbered (episode).
	season: number
	episode: number
	episodeEnd: number
	// The episode's title from its name; empty for movies, other videos and names without one.
	episodeTitle: string
	// Versions of one movie or episode share it.
	group: string
	label: string
	dateAdded: number
	unsupported: boolean
	// The directory the file sits in.
	folder: string
}

export type VideoIndexUpdate =
	| { type: "roots"; roots: VideoRootStatus[] }
	// The catalog changed (or became available): what the screens show is fetched again. `titles` names the titles
	// whose own view changed, null for all of them.
	| { type: "catalog"; version: number; titles: string[] | null; summary: CatalogSummary }

// The classifier's file indices resolved against the files it was given.
export class LibraryFiles {
	public readonly library: VideoLibrary
	// Titles a manual correction hides, and episodes whose correction lives under another key (applyLibraryOverrides).
	public readonly hidden: ReadonlySet<string>
	public readonly titleKeys: ReadonlyMap<string, string>
	public readonly episodeKeys: ReadonlyMap<string, string>
	public readonly originals: ReadonlyMap<string, CorrectionOriginal>
	public readonly autoMerged: ReadonlyMap<string, number>
	private readonly files: readonly IndexFile[]
	private readonly rootUuids: readonly string[]
	private movieIndex: Map<string, LibraryMovie> | null = null
	private seriesIndex: Map<string, LibrarySeries> | null = null
	private otherIndex: Map<string, LibraryOther> | null = null

	public constructor({
		library,
		files,
		rootUuids,
		hidden = new Set(),
		titleKeys = new Map(),
		episodeKeys = new Map(),
		originals = new Map(),
		autoMerged = new Map()
	}: {
		library: VideoLibrary
		files: readonly IndexFile[]
		rootUuids: readonly string[]
		hidden?: ReadonlySet<string>
		titleKeys?: ReadonlyMap<string, string>
		episodeKeys?: ReadonlyMap<string, string>
		originals?: ReadonlyMap<string, CorrectionOriginal>
		autoMerged?: ReadonlyMap<string, number>
	}) {
		this.library = library
		this.files = files
		this.rootUuids = rootUuids
		this.hidden = hidden
		this.titleKeys = titleKeys
		this.episodeKeys = episodeKeys
		this.originals = originals
		this.autoMerged = autoMerged
	}

	// A title's classifier entry by id (indexed on first use).
	public movie(id: string): LibraryMovie | undefined {
		this.movieIndex ??= new Map(this.library.movies.map(movie => [movie.id, movie]))

		return this.movieIndex.get(id)
	}

	public seriesById(id: string): LibrarySeries | undefined {
		this.seriesIndex ??= new Map(this.library.series.map(series => [series.id, series]))

		return this.seriesIndex.get(id)
	}

	public other(id: string): LibraryOther | undefined {
		this.otherIndex ??= new Map(this.library.others.map(other => [other.id, other]))

		return this.otherIndex.get(id)
	}

	public file(index: number): IndexFile | undefined {
		return index === NO_FILE ? undefined : this.files[index]
	}

	public ref(index: number): VideoFileRef | null {
		const file = this.file(index)

		return file === undefined
			? null
			: {
					stableUuid: file.stableUuid,
					uuid: file.uuid,
					name: file.name,
					size: file.size
				}
	}

	public roots(indices: readonly number[]): string[] {
		const out: string[] = []

		for (const index of indices) {
			const uuid = this.rootUuids[index]

			if (uuid !== undefined) {
				out.push(uuid)
			}
		}

		return out
	}

	public part(video: number): VideoPartView | null {
		const entry = this.library.videos[video]
		const file = entry === undefined ? null : this.ref(entry.file)

		if (entry === undefined || file === null) {
			return null
		}

		return {
			file,
			container: entry.container,
			unsupported: entry.unsupported,
			height: entry.height,
			subtitles: entry.subtitles.flatMap(subtitle => this.subtitle(subtitle)),
			nfo: this.ref(entry.nfo),
			thumb: this.ref(entry.thumb),
			edl: this.ref(entry.edl)
		}
	}

	private subtitle(subtitle: LibrarySubtitle): VideoSubtitleView[] {
		const file = this.ref(subtitle.file)

		return file === null
			? []
			: [
					{
						file,
						format: subtitle.format,
						language: subtitle.language,
						forced: subtitle.forced,
						sdh: subtitle.sdh,
						isDefault: subtitle.isDefault,
						title: subtitle.title
					}
				]
	}

	public versions(versions: readonly LibraryVersion[]): VideoVersionView[] {
		return versions.map(version => ({
			label: version.label,
			parts: version.parts.flatMap(video => this.part(video) ?? [])
		}))
	}

	public extras(extras: readonly LibraryExtra[]): VideoExtraView[] {
		return extras.flatMap(extra => {
			const part = this.part(extra.video)

			return part === null
				? []
				: [
						{
							type: extra.type,
							title: extra.title,
							part
						}
					]
		})
	}

	public firstPart(versions: readonly LibraryVersion[]): { video: number; file: number } | null {
		const video = versions[0]?.parts[0]
		const entry = video === undefined ? undefined : this.library.videos[video]

		return video === undefined || entry === undefined ? null : { video, file: entry.file }
	}

	public allUnsupported(versions: readonly LibraryVersion[]): boolean {
		return (
			versions.length > 0 && versions.every(version => version.parts.every(video => this.library.videos[video]?.unsupported === true))
		)
	}
}

// The first episode of the first regular season (specials only when there is nothing else).
function firstEpisode(series: LibrarySeries): LibraryEpisode | null {
	const season =
		series.seasons.find(item => item.number > 0 && item.episodes.length > 0) ?? series.seasons.find(item => item.episodes.length > 0)

	return season?.episodes[0] ?? null
}

function artRefs(files: LibraryFiles, art: LibraryArt): Pick<VideoTitleView, "poster" | "backdrop" | "logo"> {
	return {
		poster: files.ref(art.poster),
		backdrop: files.ref(art.backdrop),
		logo: files.ref(art.logo)
	}
}

function playable(files: LibraryFiles, versions: readonly LibraryVersion[]): Pick<VideoTitleView, "primary" | "container" | "height"> {
	const first = files.firstPart(versions)
	const entry = first === null ? undefined : files.library.videos[first.video]

	return {
		primary: first === null ? null : files.ref(first.file),
		container: entry?.container ?? "",
		height: entry?.height ?? 0
	}
}

// Titles (and videos) built between yields of the steps below.
const BUILD_STEP = 256

// Every title of the library, in classifier order, in steps (yields between them).
export function* buildTitlesSteps(files: LibraryFiles): Generator<void, VideoTitleView[]> {
	const library = files.library
	const hashes = new Map<string, number>()
	let built = 0

	for (const movie of library.movies) {
		hashes.set(movie.id, fold(versionsHash(files, movie.versions, movie.extras, FNV1A_OFFSET_BASIS), fileKey(files, movie.nfo)))

		if (++built % BUILD_STEP === 0) {
			yield
		}
	}

	for (const series of library.series) {
		let hash = fold(versionsHash(files, [], series.extras, FNV1A_OFFSET_BASIS), fileKey(files, series.nfo))

		for (const season of series.seasons) {
			hash = fold(hash, String(season.number))
			hash = fold(hash, season.dirUuid)
			hash = fold(hash, fileKey(files, season.art.poster))
			hash = fold(hash, fileKey(files, season.art.backdrop))
			hash = fold(hash, fileKey(files, season.nfo))
			hash = fold(hash, String(season.episodes.length))

			for (const episode of season.episodes) {
				hash = versionsHash(files, episode.versions, [], hash)
				hash = fold(hash, String(episode.season))
				hash = fold(hash, String(episode.episode))
				hash = fold(hash, String(episode.episodeEnd))
				hash = fold(hash, String(episode.date))
				hash = fold(hash, episode.title)
			}
		}

		hashes.set(series.id, hash)

		if (++built % BUILD_STEP === 0) {
			yield
		}
	}

	for (const other of library.others) {
		hashes.set(other.id, partHash(files, other.video, FNV1A_OFFSET_BASIS))

		if (++built % BUILD_STEP === 0) {
			yield
		}
	}

	const out: VideoTitleView[] = []

	for (const title of visibleTitles(files)) {
		const withHash = { ...title, detailHash: hashes.get(title.id) ?? FNV1A_OFFSET_BASIS }

		out.push(files.hidden.has(title.id) ? { ...withHash, hidden: true } : withHash)

		if (out.length % BUILD_STEP === 0) {
			yield
		}
	}

	return out
}

// Ends every folded field, so adjacent values can't alias ("ab" + "c" vs "a" + "bc").
const FIELD_END = "\u0000"

// `hash` continued over one field.
function fold(hash: number, field: string): number {
	return fnv1a(FIELD_END, fnv1a(field, hash))
}

function flag(value: boolean): string {
	return value ? "1" : "0"
}

// A file by its stable uuid (a new version of it isn't a change), empty for none.
function fileKey(files: LibraryFiles, index: number): string {
	return files.file(index)?.stableUuid ?? ""
}

// Everything LibraryFiles.part emits of a video: its file, sidecar subtitles, nfo, thumb and edl.
function partHash(files: LibraryFiles, video: number, seed: number): number {
	const entry = files.library.videos[video]

	if (entry === undefined) {
		return fold(seed, "")
	}

	let hash = fold(seed, fileKey(files, entry.file))

	hash = fold(hash, String(entry.subtitles.length))

	for (const subtitle of entry.subtitles) {
		hash = fold(hash, fileKey(files, subtitle.file))
		hash = fold(hash, subtitle.format)
		hash = fold(hash, subtitle.language ?? "")
		hash = fold(hash, flag(subtitle.forced))
		hash = fold(hash, flag(subtitle.sdh))
		hash = fold(hash, flag(subtitle.isDefault))
		hash = fold(hash, subtitle.title)
	}

	hash = fold(hash, fileKey(files, entry.nfo))
	hash = fold(hash, fileKey(files, entry.thumb))

	return fold(hash, fileKey(files, entry.edl))
}

function versionsHash(files: LibraryFiles, versions: readonly LibraryVersion[], extras: readonly LibraryExtra[], seed: number): number {
	let hash = fold(seed, String(versions.length))

	for (const version of versions) {
		hash = fold(hash, version.label)
		hash = fold(hash, String(version.parts.length))

		for (const video of version.parts) {
			hash = partHash(files, video, hash)
		}
	}

	hash = fold(hash, String(extras.length))

	for (const extra of extras) {
		hash = fold(hash, extra.type)
		hash = fold(hash, extra.title)
		hash = partHash(files, extra.video, hash)
	}

	return hash
}

function* visibleTitles(files: LibraryFiles): Generator<VideoTitleView> {
	const library = files.library

	for (const movie of library.movies) {
		yield {
			id: movie.id,
			kind: "movie",
			title: movie.title,
			sortName: movie.sortName,
			year: movie.year,
			mergeKey: movie.mergeKey,
			roots: files.roots(movie.roots),
			dateAdded: movie.dateAdded,
			...artRefs(files, movie.art),
			...playable(files, movie.versions),
			unsupported: files.allUnsupported(movie.versions),
			disc: movie.disc,
			versionCount: movie.versions.length,
			extraCount: movie.extras.length,
			seasonCount: 0,
			episodeCount: 0
		}
	}

	for (const series of library.series) {
		const episode = firstEpisode(series)
		let episodeCount = 0
		// Stays true until a playable episode turns up; a series without episodes isn't unsupported.
		let allUnsupported = true

		for (const season of series.seasons) {
			episodeCount += season.episodes.length

			if (allUnsupported) {
				allUnsupported = season.episodes.every(item => files.allUnsupported(item.versions))
			}
		}

		yield {
			id: series.id,
			kind: "series",
			title: series.title,
			sortName: series.sortName,
			year: series.year,
			mergeKey: series.mergeKey,
			roots: files.roots(series.roots),
			dateAdded: series.dateAdded,
			...artRefs(files, series.art),
			...playable(files, episode?.versions ?? []),
			unsupported: episodeCount > 0 && allUnsupported,
			disc: false,
			versionCount: 1,
			extraCount: series.extras.length,
			seasonCount: series.seasons.length,
			episodeCount
		}
	}

	for (const other of library.others) {
		const entry = library.videos[other.video]

		yield {
			id: other.id,
			kind: "other",
			title: other.title,
			sortName: other.sortName,
			year: 0,
			mergeKey: "",
			roots: files.roots([other.root]),
			dateAdded: other.dateAdded,
			poster: null,
			backdrop: null,
			logo: null,
			primary: entry === undefined ? null : files.ref(entry.file),
			container: entry?.container ?? "",
			height: entry?.height ?? 0,
			unsupported: entry?.unsupported ?? false,
			disc: false,
			versionCount: 1,
			extraCount: 0,
			seasonCount: 0,
			episodeCount: 0
		}
	}
}

function episodeView(files: LibraryFiles, episode: LibraryEpisode): VideoEpisodeView {
	const versions = files.versions(episode.versions)
	const first = versions[0]?.parts[0]?.file.stableUuid
	const overrideKey = first === undefined ? undefined : files.episodeKeys.get(first)
	const original = first === undefined ? undefined : files.originals.get(overrideKey ?? episodeOverrideKey(first))

	return {
		season: episode.season,
		episode: episode.episode,
		episodeEnd: episode.episodeEnd,
		date: episode.date,
		title: episode.title,
		dateAdded: episode.dateAdded,
		versions,
		...(overrideKey === undefined ? {} : { overrideKey }),
		...(original === undefined ? {} : { original })
	}
}

// Where a title's correction is stored, and what the classifier made of it when one applies.
function detailCorrection(files: LibraryFiles, title: VideoTitleView, stableUuids: readonly string[]): DetailCorrection {
	const overrideKey =
		title.kind === "series"
			? seriesOverrideKey(title.id)
			: (files.titleKeys.get(title.id) ?? titleOverrideKey({ id: title.id, stableUuids }))
	const original = files.originals.get(overrideKey)

	return original === undefined ? { overrideKey } : { overrideKey, original }
}

function partStableUuids(versions: readonly VideoVersionView[]): string[] {
	return versions.flatMap(version => version.parts.map(part => part.file.stableUuid))
}

export function buildTitleDetail(files: LibraryFiles, title: VideoTitleView): VideoTitleDetail | null {
	switch (title.kind) {
		case "movie": {
			const movie = files.movie(title.id)

			if (movie === undefined) {
				return null
			}

			const versions = files.versions(movie.versions)

			return {
				kind: "movie",
				title,
				versions,
				extras: files.extras(movie.extras),
				nfo: files.ref(movie.nfo),
				...detailCorrection(files, title, partStableUuids(versions))
			}
		}

		case "series": {
			const series = files.seriesById(title.id)

			return series === undefined
				? null
				: {
						kind: "series",
						title,
						seasons: series.seasons.map(season => ({
							number: season.number,
							dirUuid: season.dirUuid,
							poster: files.ref(season.art.poster),
							backdrop: files.ref(season.art.backdrop),
							nfo: files.ref(season.nfo),
							episodes: season.episodes.map(episode => episodeView(files, episode))
						})),
						extras: files.extras(series.extras),
						nfo: files.ref(series.nfo),
						autoMergedRoots: files.autoMerged.get(series.id) ?? 1,
						...detailCorrection(files, title, [])
					}
		}

		case "other": {
			const other = files.other(title.id)

			if (other === undefined) {
				return null
			}

			const part = files.part(other.video)

			return {
				kind: "other",
				title,
				part,
				...detailCorrection(files, title, part === null ? [] : [part.file.stableUuid])
			}
		}
	}
}

// What Set as reads of a title: its correction context, without the versions, seasons and episodes a detail holds.
export interface VideoCorrectionTarget {
	title: VideoTitleView
	overrideKey: string
	original?: CorrectionOriginal
	// A series': roots the classifier itself merged it from; 1 otherwise.
	autoMergedRoots: number
}

export function buildCorrectionTarget(files: LibraryFiles, title: VideoTitleView): VideoCorrectionTarget | null {
	if (title.kind === "series") {
		const { original } = detailCorrection(files, title, [])

		return {
			title,
			overrideKey: seriesOverrideKey(title.id),
			...(original === undefined ? {} : { original }),
			autoMergedRoots: files.autoMerged.get(title.id) ?? 1
		}
	}

	const detail = buildTitleDetail(files, title)

	if (detail?.overrideKey === undefined) {
		return null
	}

	return {
		title,
		overrideKey: detail.overrideKey,
		...(detail.original === undefined ? {} : { original: detail.original }),
		autoMergedRoots: 1
	}
}

function pushHomeItems({
	out,
	files,
	versions,
	base,
	folder
}: {
	out: VideoHomeItem[]
	files: LibraryFiles
	versions: readonly LibraryVersion[]
	base: Omit<VideoHomeItem, "stableUuid" | "uuid" | "size" | "label" | "unsupported" | "folder">
	folder: (parent: string) => string
}): void {
	for (const version of versions) {
		const video = version.parts[0] === undefined ? undefined : files.library.videos[version.parts[0]]
		const file = video === undefined ? undefined : files.file(video.file)

		if (video === undefined || file === undefined) {
			continue
		}

		out.push({
			...base,
			stableUuid: file.stableUuid,
			uuid: file.uuid,
			size: file.size,
			label: version.label,
			unsupported: video.unsupported,
			folder: folder(file.parent)
		})
	}
}

// Every playable video of the library, in classifier order, hidden titles left out; `folder` names a directory by
// uuid. In steps (yields between them).
export function* buildHomeItemsSteps(files: LibraryFiles, folder: (parent: string) => string): Generator<void, VideoHomeItem[]> {
	const library = files.library
	const out: VideoHomeItem[] = []
	let built = 0

	for (const movie of library.movies) {
		if (++built % BUILD_STEP === 0) {
			yield
		}

		if (files.hidden.has(movie.id)) {
			continue
		}

		pushHomeItems({
			out,
			files,
			versions: movie.versions,
			base: {
				titleId: movie.id,
				itemClass: "movie",
				season: 0,
				episode: 0,
				episodeEnd: 0,
				episodeTitle: "",
				group: movie.id,
				dateAdded: movie.dateAdded
			},
			folder
		})
	}

	for (const series of library.series) {
		for (const season of series.seasons) {
			built += season.episodes.length
		}

		if (built >= BUILD_STEP) {
			built = 0

			yield
		}

		if (files.hidden.has(series.id)) {
			continue
		}

		series.seasons.forEach((season, seasonIndex) => {
			season.episodes.forEach((episode, episodeIndex) => {
				pushHomeItems({
					out,
					files,
					versions: episode.versions,
					base: {
						titleId: series.id,
						itemClass: "episode",
						season: episode.season,
						episode: episode.episode,
						episodeEnd: episode.episodeEnd,
						episodeTitle: episode.title,
						group: `${series.id}/${String(seasonIndex)}/${String(episodeIndex)}`,
						dateAdded: episode.dateAdded
					},
					folder
				})
			})
		})
	}

	for (const other of library.others) {
		if (++built % BUILD_STEP === 0) {
			yield
		}

		if (files.hidden.has(other.id)) {
			continue
		}

		pushHomeItems({
			out,
			files,
			versions: [{ label: "", parts: [other.video] }],
			base: {
				titleId: other.id,
				itemClass: "other",
				season: 0,
				episode: 0,
				episodeEnd: 0,
				episodeTitle: "",
				group: other.id,
				dateAdded: other.dateAdded
			},
			folder
		})
	}

	return out
}

// A slot's art candidates for a title, with the files they name as keyless refs: candidate `file` indexes `files`.
export interface TitleArtCandidates {
	candidates: ArtCandidate[]
	files: VideoFileRef[]
}

function artSubject(files: LibraryFiles, title: VideoTitleView): ArtSubject | null {
	switch (title.kind) {
		case "movie": {
			const movie = files.movie(title.id)

			return movie === undefined ? null : { kind: "movie", movie }
		}

		case "series": {
			const series = files.seriesById(title.id)

			return series === undefined ? null : { kind: "series", series }
		}

		case "other": {
			const other = files.other(title.id)

			// Another video's art is a still of itself, as an episode's is.
			return other === undefined
				? null
				: {
						kind: "episode",
						episode: {
							season: 0,
							episode: 0,
							episodeEnd: 0,
							date: 0,
							title: other.title,
							versions: [
								{
									label: "",
									parts: [other.video]
								}
							],
							dateAdded: other.dateAdded
						}
					}
		}
	}
}

export function titleArtCandidates(files: LibraryFiles, title: VideoTitleView, slot: ArtSlotCode): TitleArtCandidates | null {
	const subject = artSubject(files, title)

	return subject === null ? null : subjectArtCandidates(files, subject, slot)
}

function subjectArtCandidates(files: LibraryFiles, subject: ArtSubject, slot: ArtSlotCode): TitleArtCandidates {
	const refs: VideoFileRef[] = []
	const local = new Map<number, number>()
	const candidates: ArtCandidate[] = []

	for (const candidate of artCandidates(files.library, subject, slot)) {
		if (candidate.source === "typographic" || candidate.source === "gradient") {
			candidates.push(candidate)

			continue
		}

		let index = local.get(candidate.file)

		if (index === undefined) {
			const ref = files.ref(candidate.file)

			if (ref === null) {
				continue
			}

			index = refs.length
			refs.push(ref)
			local.set(candidate.file, index)
		}

		candidates.push({
			source: candidate.source,
			file: index
		})
	}

	return {
		candidates,
		files: refs
	}
}

function hasVideoFile(files: LibraryFiles, versions: readonly LibraryVersion[], stableUuid: string): boolean {
	return versions.some(version =>
		version.parts.some(video => {
			const entry = files.library.videos[video]

			return entry !== undefined && files.file(entry.file)?.stableUuid === stableUuid
		})
	)
}

// A still of an extra itself (it has no art of its own).
function extraSubject(files: LibraryFiles, extras: readonly LibraryExtra[], stableUuid: string): ArtSubject | null {
	const extra = extras.find(item => hasVideoFile(files, [{ label: "", parts: [item.video] }], stableUuid))

	return extra === undefined
		? null
		: {
				kind: "episode",
				episode: {
					season: 0,
					episode: 0,
					episodeEnd: 0,
					date: 0,
					title: extra.title,
					versions: [{ label: "", parts: [extra.video] }],
					dateAdded: 0
				}
			}
}

// The art of one video of a title: an episode's or an extra's own still, the title's art otherwise.
export function itemArtCandidates(
	files: LibraryFiles,
	title: VideoTitleView,
	stableUuid: string,
	slot: ArtSlotCode
): TitleArtCandidates | null {
	const extras =
		title.kind === "movie" ? files.movie(title.id)?.extras : title.kind === "series" ? files.seriesById(title.id)?.extras : undefined
	const extra = extras === undefined ? null : extraSubject(files, extras, stableUuid)

	if (extra !== null) {
		return subjectArtCandidates(files, extra, slot)
	}

	if (title.kind !== "series") {
		return titleArtCandidates(files, title, slot)
	}

	const series = files.seriesById(title.id)

	for (const season of series?.seasons ?? []) {
		const episode = season.episodes.find(item => hasVideoFile(files, item.versions, stableUuid))

		if (episode !== undefined) {
			return subjectArtCandidates(files, { kind: "episode", episode }, slot)
		}
	}

	return titleArtCandidates(files, title, slot)
}

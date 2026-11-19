// Turns a flat drive listing of one or more library roots into movies, series and other videos, by names alone.
//
// Output records reference files by their index in the input `files` array and videos by their index in
// `VideoLibrary.videos`, so the result is flat, acyclic and cheap to structured-clone.

import { EXTRA_TYPE_ORDER, extraTypeForDirName, isAmbiguousExtraType, parseExtraName, type ExtraName, type ExtraType } from "./extras"
import {
	displayTitle,
	episodeSeriesKey,
	episodeTitleText,
	extensionDot,
	identityKey,
	isCameraStem,
	isIgnoredDirName,
	isIgnoredFileName,
	mergeKey,
	parseEpisode,
	parseResolution,
	parseSeasonDirName,
	parseSeasonPackName,
	splitTitleYear,
	stripNameTags,
	trimTrailingSeparators,
	videoFileKind,
	type EpisodeMatch,
	type SeasonPackName,
	type VideoFileKind
} from "./naming"
import {
	directoryArtName,
	parseSubtitleTokens,
	parseUnmatchedSubtitleName,
	seasonArtName,
	sidecarDirKind,
	STEM_IMAGE_ART,
	stemArtName,
	subtitleFormat,
	type ArtName,
	type SidecarSubtitleFormat,
	type SubtitleNameInfo
} from "./sidecars"
import { videoSortName } from "./sortName"
import { groupStacks } from "./stacks"
import { commonStemPrefix, compareVersionCandidates, compareVideoNames, versionLabel, versionSuffix } from "./versions"

// Bumped whenever a rule change can classify the same listing differently, so persisted results get rebuilt.
export const CLASSIFIER_VERSION = 2

// "No file" in any file-index slot.
export const NO_FILE = -1

export type LibraryRootType = "auto" | "movies" | "shows" | "other"

export interface LibraryScanRoot {
	uuid: string
	name: string
	type: LibraryRootType
}

export interface LibraryScanDir {
	uuid: string
	parent: string
	name: string
}

export interface LibraryScanFile {
	uuid: string
	stableUuid?: string | undefined
	parent: string
	name: string
	size: number
	timestamp: number
	// When the file joined the library; `timestamp` when absent.
	dateAdded?: number | undefined
}

export interface LibraryScanInput {
	roots: readonly LibraryScanRoot[]
	// Every directory below the roots, in any order. Directories whose parent is missing are skipped.
	dirs: readonly LibraryScanDir[]
	files: readonly LibraryScanFile[]
	// Merge keys a manual correction keeps apart: same-titled series in different roots stay separate series.
	splitMergeKeys?: ReadonlySet<string> | undefined
	// Uuids of `.ts`/`.mts` files a read of their content found to be no transport stream.
	notTransportStream?: ReadonlySet<string> | undefined
}

export interface LibraryArt {
	poster: number
	backdrop: number
	logo: number
}

export interface LibrarySubtitle {
	file: number
	format: SidecarSubtitleFormat
	language: string | null
	forced: boolean
	sdh: boolean
	isDefault: boolean
	title: string
}

export interface LibraryVideo {
	file: number
	// Lowercase extension.
	container: string
	// Listed but never probed or played (AVI, WMV, MPEG-PS…).
	unsupported: boolean
	// Picture height the name advertises, 0 when it says nothing.
	height: number
	subtitles: LibrarySubtitle[]
	nfo: number
	thumb: number
	edl: number
}

export interface LibraryVersion {
	// Empty when nothing in the names tells versions apart.
	label: string
	// Indices into `VideoLibrary.videos`; more than one for a multi-part (stacked) title, in part order.
	parts: number[]
}

export interface LibraryExtra {
	type: ExtraType
	video: number
	title: string
}

export interface LibraryMovie {
	// Directory uuid for a movie with its own directory, else the primary file's stable uuid.
	id: string
	title: string
	sortName: string
	year: number
	// Normalized title + year; empty without a year. Equal keys from different roots are one movie.
	mergeKey: string
	// Indices into the input roots this movie was found in.
	roots: number[]
	nfo: number
	art: LibraryArt
	// Primary version first.
	versions: LibraryVersion[]
	extras: LibraryExtra[]
	dateAdded: number
	// The directory holds a DVD/Blu-ray folder structure, which cannot be played.
	disc: boolean
}

export interface LibraryEpisode {
	season: number
	// 0 for date-based and unnumbered episodes.
	episode: number
	episodeEnd: number
	// yyyymmdd for date-based episodes, else 0.
	date: number
	// From the file name; empty when the name has no title part.
	title: string
	versions: LibraryVersion[]
	dateAdded: number
}

export interface LibrarySeason {
	// 0 is specials.
	number: number
	// Uuid of the season directory, empty when the season only exists through episode names.
	dirUuid: string
	nfo: number
	art: LibraryArt
	episodes: LibraryEpisode[]
}

export interface LibrarySeries {
	// Series directory uuid (the root's uuid when the root itself is the series).
	id: string
	title: string
	sortName: string
	year: number
	mergeKey: string
	roots: number[]
	nfo: number
	art: LibraryArt
	// Ascending by number.
	seasons: LibrarySeason[]
	extras: LibraryExtra[]
	dateAdded: number
}

export interface LibraryOther {
	id: string
	title: string
	sortName: string
	root: number
	video: number
	dateAdded: number
}

export interface VideoLibrary {
	classifierVersion: number
	videos: LibraryVideo[]
	movies: LibraryMovie[]
	series: LibrarySeries[]
	others: LibraryOther[]
}

// ── Internal builders ────────────────────────────────────────────────────────

const KIND_VIDEO = 1
const KIND_UNSUPPORTED = 2
const KIND_SUBTITLE = 3
const KIND_IMAGE = 4
const KIND_NFO = 5
const KIND_EDL = 6

const KIND_CODES: Record<VideoFileKind, number> = {
	video: KIND_VIDEO,
	unsupportedVideo: KIND_UNSUPPORTED,
	subtitle: KIND_SUBTITLE,
	image: KIND_IMAGE,
	nfo: KIND_NFO,
	edl: KIND_EDL
}

// ownerOf[node]: which single title a directory belongs to, for attaching extras directories below it.
const OWNER_NONE = -1
const OWNER_MIXED = -2

class ArtBuild {
	public poster = NO_FILE
	public backdrop = NO_FILE
	public logo = NO_FILE
	public thumb = NO_FILE
	private posterRank = Infinity
	private backdropRank = Infinity
	private logoRank = Infinity
	private thumbRank = Infinity

	public offer(name: ArtName, file: number): void {
		switch (name.slot) {
			case "poster": {
				if (name.rank < this.posterRank) {
					this.poster = file
					this.posterRank = name.rank
				}

				break
			}

			case "backdrop": {
				if (name.rank < this.backdropRank) {
					this.backdrop = file
					this.backdropRank = name.rank
				}

				break
			}

			case "logo": {
				if (name.rank < this.logoRank) {
					this.logo = file
					this.logoRank = name.rank
				}

				break
			}

			case "thumb": {
				if (name.rank < this.thumbRank) {
					this.thumb = file
					this.thumbRank = name.rank
				}

				break
			}
		}
	}
}

function emptyArt(): LibraryArt {
	return {
		poster: NO_FILE,
		backdrop: NO_FILE,
		logo: NO_FILE
	}
}

// Fills the slots `into` lacks from `from`.
function fillArt(into: LibraryArt, from: { poster: number; backdrop: number; logo: number } | undefined): void {
	if (from === undefined) {
		return
	}

	if (into.poster === NO_FILE) {
		into.poster = from.poster
	}

	if (into.backdrop === NO_FILE) {
		into.backdrop = from.backdrop
	}

	if (into.logo === NO_FILE) {
		into.logo = from.logo
	}
}

interface DirListing {
	videos: number[]
	subtitles: number[]
	images: number[]
	nfos: number[]
	edls: number[]
	dirs: number[]
}

interface DirSidecars {
	movieNfo: number
	tvshowNfo: number
	seasonNfo: number
	art: ArtBuild
	seasonArt: Map<number, ArtBuild> | null
	// Sidecars named after no video in the directory; a title may claim them by its shared name.
	unmatched: number[]
	// Positions in `unmatched` by every name a title could claim them under, built on first use.
	unmatchedByKey: Map<string, number[]> | null
}

// Titles a slice of loose titles in one directory covers before the walk yields.
const LOOSE_TITLES_PER_STEP = 256
// Entries (directories, files, titles) handled between yields in the classifier's other long passes.
const WORK_PER_STEP = 512

interface VersionGroup {
	files: number[]
	stem: string
	stacked: boolean
}

interface VideoCandidate {
	video: number
	// File stem.
	name: string
	height: number
}

interface MovieBuild {
	id: string
	title: string
	year: number
	mergeKey: string
	roots: number[]
	nfo: number
	art: LibraryArt
	versions: LibraryVersion[]
	extras: LibraryExtra[]
	dateAdded: number
	disc: boolean
}

interface EpisodeBuild {
	season: number
	episode: number
	episodeEnd: number
	date: number
	title: string
	candidates: VideoCandidate[]
}

interface SeasonBuild {
	number: number
	dirUuid: string
	nfo: number
	art: ArtBuild | null
}

interface SeriesBuild {
	id: string
	title: string
	year: number
	mergeKey: string
	roots: number[]
	nfo: number
	art: LibraryArt
	seasonArt: Map<number, ArtBuild>
	seasons: Map<number, SeasonBuild>
	episodes: Map<string, EpisodeBuild>
	extras: LibraryExtra[]
}

interface PendingExtrasDir {
	node: number
	type: ExtraType
	// Directory whose owner (or nearest owned ancestor) receives the extras.
	from: number
}

interface SeriesEvidence {
	isSeries: boolean
	// Raw series name from the episode files when they, not the directory layout, made the case.
	nameFromFiles: string
	// Set when only episode files made the case: just these join the series, and the rest of the directory is
	// walked as usual.
	episodeFiles: number[] | null
}

const NOT_SERIES: SeriesEvidence = {
	isSeries: false,
	nameFromFiles: "",
	episodeFiles: null
}

// tvshow.nfo, season directories, or a shows root's top-level directory.
const LAYOUT_SERIES: SeriesEvidence = {
	isSeries: true,
	nameFromFiles: "",
	episodeFiles: null
}

const DISC_DIRS = new Set(["video_ts", "bdmv"])

// metadata/<stem>.jpg ranks after <stem>-thumb.jpg and a bare <stem>.jpg beside the video.
const METADATA_THUMB_ART: ArtName = {
	slot: "thumb",
	rank: 2
}
const STEM_IMAGE_THUMB_ART: ArtName = {
	slot: "thumb",
	rank: 1
}

class LibraryClassifier {
	private readonly input: LibraryScanInput
	private readonly rootCount: number
	private readonly nodeName: string[] = []
	private readonly nodeUuid: string[] = []
	// The input's tree and file facts, filled by indexSteps before the walk.
	private nodeParent: Int32Array = new Int32Array(0)
	private nodeIgnored: Uint8Array = new Uint8Array(0)
	private ownerOf: Int32Array = new Int32Array(0)
	private subtreeVideos: Int32Array = new Int32Array(0)
	// Like subtreeVideos, without anything below extras and sidecar directories.
	private subtreeMainVideos: Int32Array = new Int32Array(0)
	private childDirStart: Int32Array = new Int32Array(0)
	private childDirs: Int32Array = new Int32Array(0)
	private childFileStart: Int32Array = new Int32Array(0)
	private childFiles: Int32Array = new Int32Array(0)
	private fileKind: Uint8Array = new Uint8Array(0)
	private fileStem: string[] = []
	private fileLowerStem: string[] = []
	private fileExtension: string[] = []
	private videoOfFile: Int32Array = new Int32Array(0)
	private readonly videos: LibraryVideo[] = []
	private readonly videoArt = new Map<number, ArtBuild>()
	private readonly movies: MovieBuild[] = []
	private readonly series: SeriesBuild[] = []
	private readonly others: LibraryOther[] = []
	private pendingExtras: PendingExtrasDir[] = []
	private readonly seasonPacks = new Map<string, { series: SeriesBuild; code: number }>()
	// Work done since the last yield, in entries (directories, files, titles) handled.
	private work = 0

	public constructor(input: LibraryScanInput) {
		this.input = input
		this.rootCount = input.roots.length
	}

	// True once about a slice's worth of entries was handled since the last yield (the caller then yields).
	private tick(entries = 1): boolean {
		this.work += entries

		if (this.work < WORK_PER_STEP) {
			return false
		}

		this.work = 0

		return true
	}

	// Indexes the input: the directory tree, each file's kind and name parts, video counts per subtree.
	private *indexSteps(): Generator<void, void> {
		const input = this.input
		const nodeCount = input.roots.length + input.dirs.length
		const byUuid = new Map<string, number>()

		for (const root of input.roots) {
			byUuid.set(root.uuid, this.nodeName.length)
			this.nodeName.push(root.name)
			this.nodeUuid.push(root.uuid)
		}

		// A directory that is itself a root stays out of the tree: its subtree belongs to its own root.
		const dirNode = new Int32Array(input.dirs.length).fill(-1)

		for (let d = 0; d < input.dirs.length; d++) {
			const dir = input.dirs[d]

			if (this.tick()) {
				yield
			}

			if (dir === undefined || byUuid.has(dir.uuid)) {
				continue
			}

			dirNode[d] = this.nodeName.length
			byUuid.set(dir.uuid, this.nodeName.length)
			this.nodeName.push(dir.name)
			this.nodeUuid.push(dir.uuid)
		}

		this.nodeParent = new Int32Array(nodeCount).fill(-1)
		this.nodeIgnored = new Uint8Array(nodeCount)
		this.ownerOf = new Int32Array(nodeCount).fill(OWNER_NONE)
		this.subtreeVideos = new Int32Array(nodeCount)
		this.subtreeMainVideos = new Int32Array(nodeCount)

		const dirCounts = new Int32Array(nodeCount + 1)

		for (let d = 0; d < input.dirs.length; d++) {
			const node = dirNode[d] ?? -1
			const dir = input.dirs[d]

			if (this.tick()) {
				yield
			}

			if (node < 0 || dir === undefined) {
				continue
			}

			const parent = byUuid.get(dir.parent) ?? -1

			this.nodeParent[node] = parent

			if (parent >= 0) {
				dirCounts[parent + 1] = (dirCounts[parent + 1] ?? 0) + 1
			}

			if (isIgnoredDirName(dir.name)) {
				this.nodeIgnored[node] = 1
			}
		}

		this.childDirStart = prefixSums(dirCounts)
		this.childDirs = new Int32Array(this.childDirStart[nodeCount] ?? 0)

		const dirFill = this.childDirStart.slice(0, nodeCount)

		for (let node = this.rootCount; node < nodeCount; node++) {
			const parent = this.nodeParent[node] ?? -1

			if (parent >= 0) {
				this.childDirs[dirFill[parent] ?? 0] = node
				dirFill[parent] = (dirFill[parent] ?? 0) + 1
			}
		}

		const fileCount = input.files.length
		const fileNode = new Int32Array(fileCount).fill(-1)
		const fileCounts = new Int32Array(nodeCount + 1)

		this.fileKind = new Uint8Array(fileCount)
		this.fileStem = new Array<string>(fileCount)
		this.fileLowerStem = new Array<string>(fileCount)
		this.fileExtension = new Array<string>(fileCount)
		this.videoOfFile = new Int32Array(fileCount).fill(-1)

		for (let f = 0; f < fileCount; f++) {
			const file = input.files[f]

			if (this.tick()) {
				yield
			}

			if (file === undefined) {
				continue
			}

			const node = byUuid.get(file.parent) ?? -1

			if (node < 0) {
				continue
			}

			if (file.name === ".ignore") {
				this.nodeIgnored[node] = 1

				continue
			}

			const dot = extensionDot(file.name)

			if (dot < 0) {
				continue
			}

			const stem = file.name.slice(0, dot)
			const lowerStem = stem.toLowerCase()
			const kind = videoFileKind(
				file.name.slice(dot + 1).toLowerCase(),
				file.size,
				lowerStem,
				input.notTransportStream?.has(file.uuid) === true
			)

			if (kind === null) {
				continue
			}

			if (isIgnoredFileName(file.name, lowerStem)) {
				continue
			}

			this.fileKind[f] = KIND_CODES[kind]
			this.fileStem[f] = stem
			this.fileLowerStem[f] = lowerStem
			this.fileExtension[f] = file.name.slice(dot + 1).toLowerCase()
			fileNode[f] = node
			fileCounts[node + 1] = (fileCounts[node + 1] ?? 0) + 1
		}

		this.childFileStart = prefixSums(fileCounts)
		this.childFiles = new Int32Array(this.childFileStart[nodeCount] ?? 0)

		const fileFill = this.childFileStart.slice(0, nodeCount)

		for (let f = 0; f < fileCount; f++) {
			const node = fileNode[f] ?? -1

			if (node >= 0) {
				this.childFiles[fileFill[node] ?? 0] = f
				fileFill[node] = (fileFill[node] ?? 0) + 1
			}
		}

		yield* this.countSubtreeVideosSteps()
	}

	private *countSubtreeVideosSteps(): Generator<void, void> {
		const order: number[] = []

		for (let root = 0; root < this.rootCount; root++) {
			if (this.nodeIgnored[root] === 1) {
				continue
			}

			const stack = [root]

			while (stack.length > 0) {
				const node = stack.pop() ?? 0

				order.push(node)

				if (this.tick()) {
					yield
				}

				for (let i = this.childDirStart[node] ?? 0, end = this.childDirStart[node + 1] ?? 0; i < end; i++) {
					const child = this.childDirs[i] ?? 0

					if (this.nodeIgnored[child] !== 1) {
						stack.push(child)
					}
				}
			}
		}

		for (let o = order.length - 1; o >= 0; o--) {
			const node = order[o] ?? 0
			let own = 0

			if (this.tick()) {
				yield
			}

			for (let i = this.childFileStart[node] ?? 0, end = this.childFileStart[node + 1] ?? 0; i < end; i++) {
				const kind = this.fileKind[this.childFiles[i] ?? 0]

				if (kind === KIND_VIDEO || kind === KIND_UNSUPPORTED) {
					own++
				}
			}

			// Children were folded in before their parent (post-order), so only the directory's own files remain.
			const count = (this.subtreeVideos[node] ?? 0) + own
			const main = (this.subtreeMainVideos[node] ?? 0) + own

			this.subtreeVideos[node] = count
			this.subtreeMainVideos[node] = main

			const parent = this.nodeParent[node] ?? -1

			if (parent >= 0 && node >= this.rootCount) {
				const name = this.nodeName[node] ?? ""

				this.subtreeVideos[parent] = (this.subtreeVideos[parent] ?? 0) + count

				if (extraTypeForDirName(name) === null && sidecarDirKind(name) === null) {
					this.subtreeMainVideos[parent] = (this.subtreeMainVideos[parent] ?? 0) + main
				}
			}
		}
	}

	// Yields after each directory, so a caller can spread one run over several tasks.
	public *steps(): Generator<void, VideoLibrary> {
		yield* this.indexSteps()

		for (let root = 0; root < this.rootCount; root++) {
			const scanRoot = this.input.roots[root]

			if (scanRoot === undefined || this.nodeIgnored[root] === 1 || (this.subtreeVideos[root] ?? 0) === 0) {
				continue
			}

			this.pendingExtras = []
			yield* this.walkFree(root, root, 0, scanRoot.type)
			this.resolvePendingExtras()

			yield
		}

		return yield* this.finishSteps()
	}

	// ── Tree access ──

	private listing(node: number): DirListing {
		const listing: DirListing = {
			videos: [],
			subtitles: [],
			images: [],
			nfos: [],
			edls: [],
			dirs: []
		}

		for (let i = this.childFileStart[node] ?? 0, end = this.childFileStart[node + 1] ?? 0; i < end; i++) {
			const file = this.childFiles[i] ?? 0

			switch (this.fileKind[file]) {
				case KIND_VIDEO:
				case KIND_UNSUPPORTED: {
					listing.videos.push(file)

					break
				}

				case KIND_SUBTITLE: {
					listing.subtitles.push(file)

					break
				}

				case KIND_IMAGE: {
					listing.images.push(file)

					break
				}

				case KIND_NFO: {
					listing.nfos.push(file)

					break
				}

				case KIND_EDL: {
					listing.edls.push(file)

					break
				}
			}
		}

		for (let i = this.childDirStart[node] ?? 0, end = this.childDirStart[node + 1] ?? 0; i < end; i++) {
			const child = this.childDirs[i] ?? 0

			if (this.nodeIgnored[child] !== 1) {
				listing.dirs.push(child)
			}
		}

		return listing
	}

	private stem(file: number): string {
		return this.fileStem[file] ?? ""
	}

	private lowerStem(file: number): string {
		return this.fileLowerStem[file] ?? ""
	}

	private dateAdded(file: number): number {
		const entry = this.input.files[file]

		return entry === undefined ? 0 : (entry.dateAdded ?? entry.timestamp)
	}

	private fileId(file: number): string {
		const entry = this.input.files[file]

		return entry === undefined ? "" : (entry.stableUuid ?? entry.uuid)
	}

	private videoFor(file: number): number {
		const existing = this.videoOfFile[file] ?? -1

		if (existing >= 0) {
			return existing
		}

		const index = this.videos.length

		this.videos.push({
			file,
			container: this.fileExtension[file] ?? "",
			unsupported: this.fileKind[file] === KIND_UNSUPPORTED,
			height: parseResolution(this.stem(file)),
			subtitles: [],
			nfo: NO_FILE,
			thumb: NO_FILE,
			edl: NO_FILE
		})
		this.videoOfFile[file] = index

		return index
	}

	private videoAt(index: number): LibraryVideo {
		const video = this.videos[index]

		if (video === undefined) {
			throw new Error(`Unknown video ${index}`)
		}

		return video
	}

	private stemArt(video: number): ArtBuild {
		let art = this.videoArt.get(video)

		if (art === undefined) {
			art = new ArtBuild()
			this.videoArt.set(video, art)
		}

		return art
	}

	// Video files anywhere below `node`, ignored directories excluded.
	private subtreeVideoFiles(node: number, into: number[]): void {
		const listing = this.listing(node)

		into.push(...listing.videos)

		for (const child of listing.dirs) {
			this.subtreeVideoFiles(child, into)
		}
	}

	// ── Sidecars ──

	// Matches the sidecars of a directory (and of its Subs/ and metadata/ directories) to the videos in it.
	private attachSidecars(listing: DirListing): DirSidecars {
		const result: DirSidecars = {
			movieNfo: NO_FILE,
			tvshowNfo: NO_FILE,
			seasonNfo: NO_FILE,
			art: new ArtBuild(),
			seasonArt: null,
			unmatched: [],
			unmatchedByKey: null
		}
		const byStem = new Map<string, number>()

		for (const file of listing.videos) {
			byStem.set(this.lowerStem(file), this.videoFor(file))
		}

		for (const file of listing.nfos) {
			const lower = this.lowerStem(file)

			if (lower === "movie") {
				result.movieNfo = file
			} else if (lower === "tvshow") {
				result.tvshowNfo = file
			} else if (lower === "season") {
				result.seasonNfo = file
			} else {
				const video = byStem.get(lower)

				if (video === undefined) {
					result.unmatched.push(file)
				} else {
					this.videoAt(video).nfo = file
				}
			}
		}

		for (const file of listing.edls) {
			const video = byStem.get(this.lowerStem(file))

			if (video === undefined) {
				result.unmatched.push(file)
			} else {
				this.videoAt(video).edl = file
			}
		}

		for (const file of listing.images) {
			this.attachImage(file, byStem, result)
		}

		const soleVideo = listing.videos.length === 1 ? (byStem.values().next().value ?? -1) : -1

		if (listing.subtitles.length > 0) {
			this.attachSubtitles(listing.subtitles, byStem, soleVideo, false, result.unmatched)
		}

		for (const child of listing.dirs) {
			const kind = sidecarDirKind(this.nodeName[child] ?? "")

			if (kind === "subtitles") {
				this.attachSubtitleDir(child, byStem, soleVideo, result.unmatched)
			} else if (kind === "metadata") {
				const metadata = this.listing(child)

				for (const file of metadata.images) {
					const lower = this.lowerStem(file)
					const owned = stemArtName(lower)
					const video = byStem.get(owned?.art.slot === "thumb" ? owned.owner : lower)

					if (video !== undefined) {
						this.stemArt(video).offer(METADATA_THUMB_ART, file)
					}
				}
			}
		}

		return result
	}

	private attachImage(file: number, byStem: Map<string, number>, result: DirSidecars): void {
		const lower = this.lowerStem(file)
		const ownVideo = byStem.get(lower)

		if (ownVideo !== undefined) {
			const art = this.stemArt(ownVideo)

			art.offer(STEM_IMAGE_ART, file)
			art.offer(STEM_IMAGE_THUMB_ART, file)

			return
		}

		const directory = directoryArtName(lower)

		if (directory !== null) {
			result.art.offer(directory, file)

			return
		}

		const season = seasonArtName(lower)

		if (season !== null) {
			result.seasonArt ??= new Map()

			let art = result.seasonArt.get(season.season)

			if (art === undefined) {
				art = new ArtBuild()
				result.seasonArt.set(season.season, art)
			}

			art.offer(season.art, file)

			return
		}

		const owned = stemArtName(lower)
		const video = owned === null ? undefined : byStem.get(owned.owner)

		if (owned !== null && video !== undefined) {
			this.stemArt(video).offer(owned.art, file)
		} else {
			result.unmatched.push(file)
		}
	}

	// `soleVideo` takes subtitles that name no video when the directory holds exactly one; otherwise they go to
	// `unmatched`.
	private attachSubtitles(
		files: readonly number[],
		byStem: Map<string, number>,
		soleVideo: number,
		wholeStemIsTokens: boolean,
		unmatched: number[]
	): void {
		let idxStems: Set<string> | null = null

		for (const file of files) {
			if (this.fileExtension[file] === "idx") {
				idxStems ??= new Set()
				idxStems.add(this.lowerStem(file))
			}
		}

		for (const file of files) {
			const extension = this.fileExtension[file] ?? ""
			const lower = this.lowerStem(file)
			const format = subtitleFormat(extension, idxStems?.has(lower) === true)

			if (format === null) {
				continue
			}

			let video = -1
			let key = ""

			if (!wholeStemIsTokens) {
				// Longest video stem the subtitle stem equals or continues with ".": "Movie.en.forced" → "Movie".
				for (let candidate = lower; ;) {
					const found = byStem.get(candidate)

					if (found !== undefined) {
						video = found
						key = candidate

						break
					}

					const dot = candidate.lastIndexOf(".")

					if (dot <= 0) {
						break
					}

					candidate = candidate.slice(0, dot)
				}
			}

			const stem = this.stem(file)
			let info: SubtitleNameInfo

			if (video >= 0) {
				info = parseSubtitleTokens(tokensAfterKey(stem, key))
			} else if (soleVideo >= 0) {
				video = soleVideo
				info = parseUnmatchedSubtitleName(stem)
			} else {
				unmatched.push(file)

				continue
			}

			this.videoAt(video).subtitles.push(subtitleEntry(file, format, info))
		}
	}

	// Subs/<video stem>/*.srt and loose Subs/*.srt.
	private attachSubtitleDir(node: number, byStem: Map<string, number>, soleVideo: number, unmatched: number[]): void {
		const listing = this.listing(node)

		this.attachSubtitles(listing.subtitles, byStem, soleVideo, false, unmatched)

		for (const child of listing.dirs) {
			const video = byStem.get((this.nodeName[child] ?? "").toLowerCase())

			if (video !== undefined) {
				this.attachSubtitles(this.listing(child).subtitles, byStem, video, true, unmatched)
			}
		}
	}

	// The unmatched sidecars any of `keys` could claim, in their original order: those whose lowercase stem is a key
	// or continues one with ".", and images whose stem-art owner is a key. Indexed once per directory, so a directory
	// of thousands of titles doesn't test every sidecar against every title.
	private claimable(sidecars: DirSidecars, keys: readonly string[]): number[] {
		let index = sidecars.unmatchedByKey

		if (index === null) {
			index = new Map()

			const add = (key: string, position: number): void => {
				const list = index?.get(key)

				if (list === undefined) {
					index?.set(key, [position])
				} else if (list[list.length - 1] !== position) {
					list.push(position)
				}
			}

			for (let position = 0; position < sidecars.unmatched.length; position++) {
				const lower = this.lowerStem(sidecars.unmatched[position] ?? 0)

				add(lower, position)

				for (let dot = lower.indexOf("."); dot > 0; dot = lower.indexOf(".", dot + 1)) {
					add(lower.slice(0, dot), position)
				}

				const owned = stemArtName(lower)

				if (owned !== null) {
					add(owned.owner, position)
				}
			}

			sidecars.unmatchedByKey = index
		}

		const positions = new Set<number>()

		for (const key of keys) {
			for (const position of index.get(key) ?? []) {
				positions.add(position)
			}
		}

		return [...positions].sort((a, b) => a - b).map(position => sidecars.unmatched[position] ?? NO_FILE)
	}

	// Sidecars named after a title rather than one file ("Up (2009).en.srt", "Up (2009)-poster.jpg" beside
	// "Up (2009) - 1080p.mkv" and "Up (2009) - 4K.mkv") apply to every version. `keys` are lowercase names.
	private attachSharedSidecars(
		sidecars: DirSidecars,
		keys: readonly string[],
		versions: readonly LibraryVersion[]
	): { art: ArtBuild; nfo: number } {
		const art = new ArtBuild()
		let nfo = NO_FILE

		if (sidecars.unmatched.length === 0 || keys.length === 0) {
			return {
				art,
				nfo
			}
		}

		const unmatched = this.claimable(sidecars, keys)

		const targets: LibraryVideo[] = []

		for (const version of versions) {
			const part = version.parts[0]

			if (part !== undefined) {
				targets.push(this.videoAt(part))
			}
		}

		for (const file of unmatched) {
			const lower = this.lowerStem(file)

			switch (this.fileKind[file]) {
				case KIND_SUBTITLE: {
					const key = keys.find(candidate => lower === candidate || lower.startsWith(`${candidate}.`))
					const format = subtitleFormat(this.fileExtension[file] ?? "", false)

					if (key === undefined || format === null) {
						break
					}

					const info = parseSubtitleTokens(tokensAfterKey(this.stem(file), key))

					for (const target of targets) {
						target.subtitles.push(subtitleEntry(file, format, info))
					}

					break
				}

				case KIND_IMAGE: {
					const owned = stemArtName(lower)

					if (owned !== null && keys.includes(owned.owner)) {
						art.offer(owned.art, file)
					} else if (keys.includes(lower)) {
						art.offer(STEM_IMAGE_ART, file)
					}

					break
				}

				case KIND_NFO: {
					if (nfo === NO_FILE && keys.includes(lower)) {
						nfo = file
					}

					break
				}

				case KIND_EDL: {
					if (keys.includes(lower)) {
						for (const target of targets) {
							if (target.edl === NO_FILE) {
								target.edl = file
							}
						}
					}

					break
				}
			}
		}

		return {
			art,
			nfo
		}
	}

	// ── Free directories (not inside a series) ──

	private *walkFree(node: number, root: number, depth: number, rootType: LibraryRootType): Generator<void, void> {
		const listing = this.listing(node)
		let evidence = NOT_SERIES

		if (rootType === "auto" || rootType === "shows") {
			const pack = parseSeasonPackName(this.nodeName[node] ?? "")

			if (pack !== null && this.holdsEpisodes(listing)) {
				this.addSeasonPack(node, root, listing, pack)

				return
			}

			evidence = rootType === "shows" && depth === 1 ? LAYOUT_SERIES : yield* this.seriesEvidence(node, listing)

			if (evidence.isSeries && evidence.episodeFiles === null) {
				this.buildSeries(node, root, listing)

				return
			}
		}

		// A directory of thousands of titles is spread over several steps.
		const large = listing.videos.length + listing.subtitles.length + listing.images.length > LOOSE_TITLES_PER_STEP
		const sidecars = this.attachSidecars(listing)

		if (large) {
			yield
		}

		let videos = listing.videos
		let seriesOwner = OWNER_NONE

		if (evidence.episodeFiles !== null) {
			const { series, code } = this.newSeries(node, root, evidence.nameFromFiles)
			const joined = new Set(evidence.episodeFiles)

			for (const file of evidence.episodeFiles) {
				this.addEpisode(series, file, this.stem(file), -1)
			}

			videos = listing.videos.filter(file => !joined.has(file))
			seriesOwner = code
		}

		if (rootType === "other") {
			for (const file of videos) {
				this.addOther(file, root)
			}

			this.ownerOf[node] = videos.length > 0 ? OWNER_MIXED : OWNER_NONE
			yield* this.walkChildren(node, listing, root, depth, rootType, false)

			return
		}

		const mains: number[] = []
		const extras: { file: number; type: ExtraType; owner: string }[] = []

		for (const file of videos) {
			const extra = parseExtraName(this.stem(file))

			if (extra === null) {
				mains.push(file)
			} else {
				extras.push({
					file,
					type: extra.type,
					owner: extra.owner
				})
			}
		}

		const isRoot = depth === 0
		let disc = false
		let contentDirs = 0

		for (const child of listing.dirs) {
			const name = this.nodeName[child] ?? ""

			if (this.tick()) {
				yield
			}

			if (DISC_DIRS.has(name.toLowerCase())) {
				disc = !isRoot

				continue
			}

			if (sidecarDirKind(name) !== null || (!isRoot && extraTypeForDirName(name) !== null)) {
				continue
			}

			if ((this.subtreeMainVideos[child] ?? 0) > 0) {
				contentDirs++
			}
		}

		if (large) {
			yield
		}

		const groups = groupStacks(mains.map(file => this.stem(file)))

		if (large) {
			yield
		}

		const movieAllowed = rootType !== "shows"
		let folderMovie: MovieBuild | null = null

		if (movieAllowed && !isRoot && seriesOwner === OWNER_NONE && contentDirs === 0 && (groups.length > 0 || disc)) {
			const single = groups.length === 1 ? groups[0] : undefined
			const cameraClip =
				rootType === "auto" &&
				single !== undefined &&
				single.members.length === 1 &&
				isCameraStem(this.stem(mains[single.members[0] ?? 0] ?? 0))

			if (disc || (single !== undefined && !cameraClip) || (groups.length > 1 && this.groupsAreVersions(node, mains, groups))) {
				folderMovie = this.buildFolderMovie(node, root, mains, groups, sidecars, disc)
			}
		}

		if (folderMovie !== null) {
			for (const extra of extras) {
				folderMovie.extras.push(this.extraEntry(extra.file, extra.type))
			}

			this.ownerOf[node] = (this.movies.length - 1) * 2
		} else {
			yield* this.addLooseTitles(root, rootType, mains, groups, extras, sidecars)
			this.ownerOf[node] = mains.length > 0 ? OWNER_MIXED : seriesOwner
		}

		yield* this.walkChildren(node, listing, root, depth, rootType, !isRoot)
	}

	private *walkChildren(
		node: number,
		listing: DirListing,
		root: number,
		depth: number,
		rootType: LibraryRootType,
		extrasDirs: boolean
	): Generator<void, void> {
		for (const child of listing.dirs) {
			const name = this.nodeName[child] ?? ""

			if (this.tick()) {
				yield
			}

			if (sidecarDirKind(name) !== null || DISC_DIRS.has(name.toLowerCase()) || (this.subtreeVideos[child] ?? 0) === 0) {
				continue
			}

			const extraType = extrasDirs && rootType !== "other" ? extraTypeForDirName(name) : null

			if (extraType !== null) {
				this.pendingExtras.push({
					node: child,
					type: extraType,
					from: node
				})

				continue
			}

			yield* this.walkFree(child, root, depth + 1, rootType)

			yield
		}
	}

	// Several titles in one directory are versions of one movie when every one names the directory followed by a
	// separator or label, or when all share the same title and year.
	private groupsAreVersions(
		node: number,
		mains: readonly number[],
		groups: readonly { members: number[]; prefix: string | null }[]
	): boolean {
		const directory = this.nodeName[node] ?? ""
		let byDirectory = true
		let sharedKey: string | null = null
		let year = -1

		for (const group of groups) {
			const stem = group.prefix ?? this.stem(mains[group.members[0] ?? 0] ?? 0)

			if (byDirectory && versionSuffix(directory, stem) === null) {
				byDirectory = false
			}

			const key = mergeKey(stem)

			if (sharedKey === null) {
				sharedKey = key
			} else if (sharedKey !== key) {
				sharedKey = ""
			}

			const stemYear = splitTitleYear(stem).year

			if (year === -1) {
				year = stemYear
			} else if (year !== stemYear) {
				byDirectory = false
			}
		}

		return byDirectory || (sharedKey !== null && sharedKey.length > 0)
	}

	private versionGroup(mains: readonly number[], group: { members: number[]; prefix: string | null }): VersionGroup {
		const files = group.members.map(member => mains[member] ?? 0)

		return {
			files,
			stem: group.prefix ?? this.stem(files[0] ?? 0),
			stacked: group.prefix !== null
		}
	}

	private buildFolderMovie(
		node: number,
		root: number,
		mains: readonly number[],
		groups: readonly { members: number[]; prefix: string | null }[],
		sidecars: DirSidecars,
		disc: boolean
	): MovieBuild {
		const directory = this.nodeName[node] ?? ""

		return this.buildMovie({
			id: this.nodeUuid[node] ?? "",
			root,
			groups: groups.map(group => this.versionGroup(mains, group)),
			directory,
			sidecars,
			ownDirectory: true,
			disc
		})
	}

	// One movie from version groups. `directory` names the title when the movie has its own directory (empty for
	// titles sharing one); otherwise the primary version's name does.
	private buildMovie(options: {
		id: string | null
		root: number
		groups: readonly VersionGroup[]
		directory: string
		sidecars: DirSidecars
		ownDirectory: boolean
		disc: boolean
	}): MovieBuild {
		const { versions, primaryStem } = this.orderedVersions(options.groups, options.directory)
		let titleName = options.ownDirectory ? options.directory : primaryStem
		let shown = displayTitle(titleName)

		// "Old/Nosferatu (1922).avi": a year-less directory name is a grouping, the dated file names the movie.
		if (shown.year === 0 && titleName !== primaryStem && primaryStem.length > 0) {
			const fromFile = displayTitle(primaryStem)

			if (fromFile.year > 0) {
				shown = fromFile
				titleName = primaryStem
			}
		}

		const keys = new Set<string>()

		for (const key of [
			options.directory,
			primaryStem,
			trimTrailingSeparators(primaryStem.slice(0, commonStemPrefix(options.groups.map(group => group.stem))))
		]) {
			if (key.length > 1) {
				keys.add(key.toLowerCase())
			}
		}

		const shared = this.attachSharedSidecars(options.sidecars, [...keys], versions)
		const art = emptyArt()

		fillArt(art, shared.art)
		fillArt(art, this.versionsArt(versions))

		if (options.ownDirectory) {
			fillArt(art, options.sidecars.art)
		}

		const primaryPart = versions[0]?.parts[0]
		const primary = primaryPart === undefined ? undefined : this.videoAt(primaryPart)
		let nfo = options.ownDirectory ? options.sidecars.movieNfo : NO_FILE

		if (nfo === NO_FILE) {
			nfo = shared.nfo !== NO_FILE ? shared.nfo : (primary?.nfo ?? NO_FILE)
		}

		const movie: MovieBuild = {
			id: options.id ?? (primary === undefined ? "" : this.fileId(primary.file)),
			title: shown.title,
			year: shown.year,
			mergeKey: mergeKey(titleName),
			roots: [options.root],
			nfo,
			art,
			versions,
			extras: [],
			dateAdded: this.versionsDateAdded(versions),
			disc: options.disc
		}

		this.movies.push(movie)

		return movie
	}

	// Primary first: the file named exactly like the directory, else a multi-part one, else the first in picker order.
	private orderedVersions(groups: readonly VersionGroup[], directory: string): { versions: LibraryVersion[]; primaryStem: string } {
		const entries = groups.map(group => ({
			...group,
			name: group.stem,
			height: parseResolution(group.stem),
			suffix: versionSuffix(directory, group.stem)
		}))
		const byDirectory = entries.every(entry => entry.suffix !== null)
		const prefix = byDirectory ? 0 : commonStemPrefix(entries.map(entry => entry.stem))

		entries.sort(compareVersionCandidates)

		let primary = entries.findIndex(entry => entry.suffix === "")

		if (primary < 0) {
			primary = entries.findIndex(entry => entry.stacked)
		}

		if (primary > 0) {
			const [first] = entries.splice(primary, 1)

			if (first !== undefined) {
				entries.unshift(first)
			}
		}

		return {
			versions: entries.map(entry => ({
				label: entries.length > 1 ? versionLabel(entry.suffix ?? entry.stem.slice(prefix), entry.stem) : "",
				parts: entry.files.map(file => this.videoFor(file))
			})),
			primaryStem: entries[0]?.stem ?? ""
		}
	}

	private versionsArt(versions: readonly LibraryVersion[]): LibraryArt {
		const art = emptyArt()

		for (const version of versions) {
			for (const part of version.parts) {
				fillArt(art, this.videoArt.get(part))
			}
		}

		return art
	}

	private versionsDateAdded(versions: readonly LibraryVersion[]): number {
		let earliest = Infinity

		for (const version of versions) {
			for (const part of version.parts) {
				earliest = Math.min(earliest, this.dateAdded(this.videoAt(part).file))
			}
		}

		return Number.isFinite(earliest) ? earliest : 0
	}

	private extraEntry(file: number, type: ExtraType): LibraryExtra {
		return {
			type,
			video: this.videoFor(file),
			title: displayTitle(this.stem(file)).title
		}
	}

	private addOther(file: number, root: number): void {
		const title = displayTitle(this.stem(file)).title

		this.others.push({
			id: this.fileId(file),
			title,
			sortName: videoSortName(title),
			root,
			video: this.videoFor(file),
			dateAdded: this.dateAdded(file)
		})
	}

	// Titles of a directory that is no single movie. Files or stacks sharing a title and year ("Alien (1979)",
	// "Alien (1979) - Director's Cut") are versions of one movie; any other stands alone, as a movie when something
	// marks it as one (year, own .nfo, poster, multiple parts, a movies root), else as another video.
	private *addLooseTitles(
		root: number,
		rootType: LibraryRootType,
		mains: readonly number[],
		groups: readonly { members: number[]; prefix: string | null }[],
		extras: readonly { file: number; type: ExtraType; owner: string }[],
		sidecars: DirSidecars
	): Generator<void, void> {
		const movieByStem = new Map<string, MovieBuild>()
		// Movies by title and year, for unowned common-word extras ("Alien (1979)-clip" beside only
		// "Alien (1979) - Director's Cut"), which join that title the way a version-suffixed name would.
		const movieByTitle = new Map<string, MovieBuild>()
		const entries: VersionGroup[] = []
		const titleKeys: string[] = []

		for (const group of groups) {
			if (entries.length > 0 && entries.length % LOOSE_TITLES_PER_STEP === 0) {
				yield
			}

			const entry = this.versionGroup(mains, group)

			entries.push(entry)
			titleKeys.push(rootType === "shows" ? "" : mergeKey(entry.stem))
		}

		const byTitle = new Map<string, number[]>()

		for (let g = 0; g < titleKeys.length; g++) {
			const key = titleKeys[g] ?? ""

			if (key.length > 0) {
				const members = byTitle.get(key)

				if (members === undefined) {
					byTitle.set(key, [g])
				} else {
					members.push(g)
				}
			}
		}

		for (let g = 0; g < entries.length; g++) {
			if (g > 0 && g % LOOSE_TITLES_PER_STEP === 0) {
				yield
			}

			const entry = entries[g]
			const sameTitle = byTitle.get(titleKeys[g] ?? "")

			if (entry === undefined || (sameTitle !== undefined && sameTitle[0] !== g)) {
				continue
			}

			if (sameTitle === undefined || sameTitle.length === 1) {
				const video = this.videoFor(entry.files[0] ?? 0)
				const isMovie =
					rootType === "movies" ||
					(rootType === "auto" &&
						!isCameraStem(entry.stem) &&
						(entry.stacked ||
							displayTitle(entry.stem).year > 0 ||
							this.videoAt(video).nfo !== NO_FILE ||
							(this.videoArt.get(video)?.poster ?? NO_FILE) !== NO_FILE))

				if (!isMovie) {
					for (const file of entry.files) {
						this.addOther(file, root)
					}

					continue
				}
			}

			const titleEntries = (sameTitle ?? [g]).map(member => entries[member]).filter(member => member !== undefined)
			let base = entry.stem

			for (const member of titleEntries) {
				if (member.stem.length < base.length) {
					base = member.stem
				}
			}

			const movie = this.buildMovie({
				id: null,
				root,
				groups: titleEntries,
				directory: titleEntries.every(member => versionSuffix(base, member.stem) !== null) ? base : "",
				sidecars,
				ownDirectory: false,
				disc: false
			})

			for (const member of titleEntries) {
				movieByStem.set(identityKey(member.stem), movie)
			}

			const titleKey = titleKeys[g] ?? ""

			if (titleKey.length > 0) {
				movieByTitle.set(titleKey, movie)
			}
		}

		// Suffix extras belong to the title whose name precedes the suffix. Without one, a common suffix word ("-clip")
		// joins a movie of the same title and year, else is a title of its own; any other orphan is dropped.
		let orphans: number[] | null = null

		for (const extra of extras) {
			let owner = extra.owner.length > 0 ? movieByStem.get(identityKey(extra.owner)) : undefined

			if (owner === undefined && !isAmbiguousExtraType(extra.type)) {
				continue
			}

			if (owner === undefined && movieByTitle.size > 0 && extra.owner.length > 0) {
				owner = movieByTitle.get(mergeKey(extra.owner))
			}

			if (owner !== undefined) {
				owner.extras.push(this.extraEntry(extra.file, extra.type))
			} else {
				orphans ??= []
				orphans.push(extra.file)
			}
		}

		if (orphans !== null) {
			yield* this.addLooseTitles(root, rootType, orphans, groupStacks(orphans.map(file => this.stem(file))), [], sidecars)
		}
	}

	private resolvePendingExtras(): void {
		for (const pending of this.pendingExtras) {
			let owner = OWNER_NONE

			for (let node = pending.from; node >= 0; node = node < this.rootCount ? -1 : (this.nodeParent[node] ?? -1)) {
				owner = this.ownerOf[node] ?? OWNER_NONE

				if (owner !== OWNER_NONE) {
					break
				}
			}

			if (owner < 0) {
				continue
			}

			const target = owner % 2 === 0 ? this.movies[owner / 2] : this.series[(owner - 1) / 2]

			if (target === undefined) {
				continue
			}

			const files: number[] = []

			this.subtreeVideoFiles(pending.node, files)

			for (const file of files) {
				target.extras.push(this.extraEntry(file, pending.type))
			}
		}
	}

	// ── Series ──

	private *seriesEvidence(node: number, listing: DirListing): Generator<void, SeriesEvidence> {
		if (listing.nfos.some(file => this.lowerStem(file) === "tvshow")) {
			return LAYOUT_SERIES
		}

		const folderKey = identityKey(splitTitleYear(stripNameTags(this.nodeName[node] ?? "")).title)

		for (const child of listing.dirs) {
			if (this.tick()) {
				yield
			}

			if ((this.subtreeVideos[child] ?? 0) === 0) {
				continue
			}

			const name = this.nodeName[child] ?? ""

			if (parseSeasonDirName(name, false) > 0) {
				return LAYOUT_SERIES
			}

			// "Show/Show.S01.1080p.WEB/": a season pack named after this directory.
			const pack = folderKey.length > 0 ? parseSeasonPackName(name) : null

			if (pack !== null && identityKey(splitTitleYear(stripNameTags(pack.series)).title) === folderKey) {
				return LAYOUT_SERIES
			}
		}

		let key: string | null = null
		let consistent = true
		const episodeFiles: number[] = []
		let first: { stem: string; match: EpisodeMatch } | null = null

		for (const file of listing.videos) {
			const stem = this.stem(file)
			const match = parseEpisode(stem, false)

			if (this.tick()) {
				yield
			}

			if (match === null) {
				continue
			}

			episodeFiles.push(file)
			first ??= {
				stem,
				match
			}

			const seriesKey = episodeSeriesKey(stem, match)

			if (seriesKey.length > 0) {
				if (key === null) {
					key = seriesKey
				} else if (key !== seriesKey) {
					consistent = false
				}
			}
		}

		if (first === null) {
			return NOT_SERIES
		}

		if (episodeFiles.length >= 2 && consistent) {
			return {
				isSeries: true,
				nameFromFiles: stripNameTags(first.stem.slice(0, first.match.start)),
				episodeFiles
			}
		}

		if (episodeFiles.length === 1 && first.match.explicit && folderKey.length > 0 && identityKey(first.stem).startsWith(folderKey)) {
			return {
				isSeries: true,
				nameFromFiles: "",
				episodeFiles
			}
		}

		return NOT_SERIES
	}

	// A season pack's name only counts when the directory holds episodes ("Open Season 2 (2008)" holds a movie).
	private holdsEpisodes(listing: DirListing): boolean {
		if (listing.videos.some(file => parseEpisode(this.stem(file), false) !== null)) {
			return true
		}

		return listing.videos.length >= 2 && listing.videos.every(file => parseEpisode(this.stem(file), true) !== null)
	}

	// Season packs of one show in one root ("Show.S01.1080p", "Show.S02.720p") form one series.
	private addSeasonPack(node: number, root: number, listing: DirListing, pack: SeasonPackName): void {
		const { title, year } = splitTitleYear(stripNameTags(pack.series))
		const key = `${root}\u0000${identityKey(title)}\u0000${year}`
		let entry = this.seasonPacks.get(key)

		if (entry === undefined) {
			entry = this.createSeries(this.nodeUuid[node] ?? "", root, pack.series)
			this.seasonPacks.set(key, entry)
		}

		this.walkSeasonDir(node, listing, entry.series, entry.code, pack.season)
	}

	private buildSeries(node: number, root: number, listing: DirListing): void {
		const { series, code } = this.newSeries(node, root, "")

		this.walkSeries(node, listing, series, code, -1, true)
	}

	private newSeries(node: number, root: number, nameFromFiles: string): { series: SeriesBuild; code: number } {
		let name = this.nodeName[node] ?? ""

		// Episodes of one show dropped into a general directory ("Downloads/Show.S01E01…"): the files name the show.
		if (nameFromFiles.length > 0) {
			const fromFiles = identityKey(splitTitleYear(nameFromFiles).title)

			if (fromFiles.length > 0 && !identityKey(name).startsWith(fromFiles)) {
				name = nameFromFiles
			}
		}

		return this.createSeries(this.nodeUuid[node] ?? "", root, name)
	}

	private createSeries(id: string, root: number, name: string): { series: SeriesBuild; code: number } {
		const shown = displayTitle(name)
		const series: SeriesBuild = {
			id,
			title: shown.title,
			year: shown.year,
			mergeKey: mergeKey(name),
			roots: [root],
			nfo: NO_FILE,
			art: emptyArt(),
			seasonArt: new Map(),
			seasons: new Map(),
			episodes: new Map(),
			extras: []
		}
		const code = this.series.length * 2 + 1

		this.series.push(series)

		return {
			series,
			code
		}
	}

	private walkSeasonDir(node: number, listing: DirListing, series: SeriesBuild, code: number, season: number): void {
		const build = this.seasonBuild(series, season)
		const sidecars = this.walkSeries(node, listing, series, code, season, false)

		// Two directories for one season: the first keeps the season's identity and artwork.
		if (build.dirUuid.length === 0) {
			build.dirUuid = this.nodeUuid[node] ?? ""
			build.nfo = sidecars.seasonNfo
			build.art = sidecars.art
		}
	}

	private seasonBuild(series: SeriesBuild, number: number): SeasonBuild {
		let season = series.seasons.get(number)

		if (season === undefined) {
			season = {
				number,
				dirUuid: "",
				nfo: NO_FILE,
				art: null
			}
			series.seasons.set(number, season)
		}

		return season
	}

	private walkSeries(
		node: number,
		listing: DirListing,
		series: SeriesBuild,
		code: number,
		folderSeason: number,
		isSeriesDir: boolean
	): DirSidecars {
		const sidecars = this.attachSidecars(listing)

		this.ownerOf[node] = code

		if (isSeriesDir) {
			series.nfo = sidecars.tvshowNfo
			fillArt(series.art, sidecars.art)

			if (sidecars.seasonArt !== null) {
				for (const [number, art] of sidecars.seasonArt) {
					series.seasonArt.set(number, art)
				}
			}
		}

		for (const file of listing.videos) {
			const stem = this.stem(file)
			const extra = this.seriesExtra(stem)

			if (extra !== null) {
				series.extras.push(this.extraEntry(file, extra.type))

				continue
			}

			this.addEpisode(series, file, stem, folderSeason)
		}

		for (const child of listing.dirs) {
			const name = this.nodeName[child] ?? ""

			if (sidecarDirKind(name) !== null || (this.subtreeVideos[child] ?? 0) === 0) {
				continue
			}

			const childListing = this.listing(child)
			const extraType = extraTypeForDirName(name)

			// "Extras" holding SxxEyy files is a specials directory, not bonus material.
			if (extraType !== null && !(extraType === "unknown" && this.hasExplicitEpisodes(childListing))) {
				const files: number[] = []

				this.subtreeVideoFiles(child, files)

				for (const file of files) {
					series.extras.push(this.extraEntry(file, extraType))
				}

				continue
			}

			const season = extraType !== null ? 0 : parseSeasonDirName(name, true)

			if (season >= 0) {
				this.walkSeasonDir(child, childListing, series, code, season)

				continue
			}

			this.walkSeries(child, childListing, series, code, folderSeason, false)
		}

		return sidecars
	}

	// "Show - S01E04 - Interview" is an episode titled Interview; an extra suffix on an episode name only counts
	// glued to it, as in "Show S01E04-trailer".
	private seriesExtra(stem: string): ExtraName | null {
		const extra = parseExtraName(stem)

		if (extra === null || parseEpisode(stem, false) === null) {
			return extra
		}

		const after = stem.charAt(extra.owner.length + 1)

		return stem.charAt(extra.owner.length) === "-" && after !== " " && after !== "\t" ? extra : null
	}

	private hasExplicitEpisodes(listing: DirListing): boolean {
		return listing.videos.some(file => parseEpisode(this.stem(file), false)?.explicit === true)
	}

	private addEpisode(series: SeriesBuild, file: number, stem: string, folderSeason: number): void {
		const match = parseEpisode(stem, true)
		let season = folderSeason >= 0 ? folderSeason : 1
		let key: string

		if (match === null) {
			key = `${season}:u:${this.lowerStem(file)}`
		} else {
			if (match.season >= 0) {
				season = match.season
			} else if (match.date > 0 && folderSeason < 0) {
				season = Math.floor(match.date / 10000)
			}

			key = match.date > 0 ? `${season}:d${match.date}` : `${season}:${match.episode}-${match.episodeEnd}`
		}

		this.seasonBuild(series, season)

		const candidate: VideoCandidate = {
			video: this.videoFor(file),
			name: stem,
			height: parseResolution(stem)
		}
		const existing = series.episodes.get(key)

		if (existing !== undefined) {
			existing.candidates.push(candidate)

			return
		}

		series.episodes.set(key, {
			season,
			episode: match?.episode ?? 0,
			episodeEnd: match?.episodeEnd ?? 0,
			date: match?.date ?? 0,
			title: match === null ? displayTitle(stem).title : episodeTitleText(stem.slice(match.end)),
			candidates: [candidate]
		})
	}

	// ── Output ──

	// Assembles the result: titles merged across roots, every video renumbered in the order titles use them.
	private *finishSteps(): Generator<void, VideoLibrary> {
		const merged = this.mergeMovies()
		const mergedSeries = this.mergeSeries()
		const remap = new Int32Array(this.videos.length).fill(-1)
		const videos: LibraryVideo[] = []
		const use = (video: number): number => {
			const mapped = remap[video] ?? -1

			if (mapped >= 0) {
				return mapped
			}

			const source = this.videoAt(video)
			const art = this.videoArt.get(video)

			remap[video] = videos.length
			videos.push({
				...source,
				thumb: art?.thumb ?? NO_FILE
			})

			return videos.length - 1
		}
		const useVersions = (versions: readonly LibraryVersion[]): LibraryVersion[] =>
			versions.map(version => ({
				label: version.label,
				parts: version.parts.map(use)
			}))
		const useExtras = (extras: readonly LibraryExtra[]): LibraryExtra[] =>
			extras
				.map(extra => ({
					...extra,
					video: use(extra.video)
				}))
				.sort((a, b) => EXTRA_TYPE_ORDER.indexOf(a.type) - EXTRA_TYPE_ORDER.indexOf(b.type) || compareVideoNames(a.title, b.title))
		const movies: LibraryMovie[] = []

		yield

		for (const movie of merged) {
			movies.push({
				id: movie.id,
				title: movie.title,
				sortName: videoSortName(movie.title),
				year: movie.year,
				mergeKey: movie.mergeKey,
				roots: movie.roots,
				nfo: movie.nfo,
				art: movie.art,
				versions: useVersions(movie.versions),
				extras: useExtras(movie.extras),
				dateAdded: movie.dateAdded,
				disc: movie.disc
			})

			if (this.tick()) {
				yield
			}
		}

		const series: LibrarySeries[] = []

		for (const entry of mergedSeries) {
			series.push(this.finishSeries(entry, useVersions, useExtras))

			if (this.tick(entry.episodes.size)) {
				yield
			}
		}

		const others: LibraryOther[] = []

		for (const other of this.others) {
			others.push({
				...other,
				video: use(other.video)
			})

			if (this.tick()) {
				yield
			}
		}

		return {
			classifierVersion: CLASSIFIER_VERSION,
			movies,
			series,
			others,
			videos
		}
	}

	private finishSeries(
		series: SeriesBuild,
		useVersions: (versions: readonly LibraryVersion[]) => LibraryVersion[],
		useExtras: (extras: readonly LibraryExtra[]) => LibraryExtra[]
	): LibrarySeries {
		const episodesBySeason = new Map<number, LibraryEpisode[]>()
		let dateAdded = 0

		for (const episode of series.episodes.values()) {
			const candidates = [...episode.candidates].sort(compareVersionCandidates)
			const prefix = commonStemPrefix(candidates.map(candidate => candidate.name))
			const versions = useVersions(
				candidates.map(candidate => ({
					label: candidates.length > 1 ? versionLabel(candidate.name.slice(prefix), candidate.name) : "",
					parts: [candidate.video]
				}))
			)
			let added = Infinity

			for (const candidate of candidates) {
				added = Math.min(added, this.dateAdded(this.videoAt(candidate.video).file))
			}

			const list = episodesBySeason.get(episode.season) ?? []

			list.push({
				season: episode.season,
				episode: episode.episode,
				episodeEnd: episode.episodeEnd,
				date: episode.date,
				title: episode.title,
				versions,
				dateAdded: Number.isFinite(added) ? added : 0
			})
			episodesBySeason.set(episode.season, list)
			dateAdded = Math.max(dateAdded, Number.isFinite(added) ? added : 0)
		}

		const seasons: LibrarySeason[] = []

		for (const season of series.seasons.values()) {
			const episodes = episodesBySeason.get(season.number) ?? []

			if (episodes.length === 0 && season.dirUuid.length === 0) {
				continue
			}

			episodes.sort(compareEpisodes)

			const art = emptyArt()

			fillArt(art, season.art ?? undefined)
			fillArt(art, series.seasonArt.get(season.number))

			seasons.push({
				number: season.number,
				dirUuid: season.dirUuid,
				nfo: season.nfo,
				art,
				episodes
			})
		}

		seasons.sort((a, b) => a.number - b.number)

		return {
			id: series.id,
			title: series.title,
			sortName: videoSortName(series.title),
			year: series.year,
			mergeKey: series.mergeKey,
			roots: series.roots,
			nfo: series.nfo,
			art: series.art,
			seasons,
			extras: useExtras(series.extras),
			dateAdded
		}
	}

	// One movie per title + year across roots. Titles without a year, and duplicates within one root, stay apart.
	private mergeMovies(): MovieBuild[] {
		const out: MovieBuild[] = []
		const byKey = new Map<string, MovieBuild>()

		for (const movie of this.movies) {
			const into = movie.mergeKey.length > 0 ? byKey.get(movie.mergeKey) : undefined
			const root = movie.roots[0] ?? -1

			if (into === undefined || into.roots.includes(root)) {
				out.push(movie)

				if (movie.mergeKey.length > 0 && into === undefined) {
					byKey.set(movie.mergeKey, movie)
				}

				continue
			}

			into.roots.push(root)
			into.versions.push(...movie.versions)
			into.extras.push(...movie.extras)
			fillArt(into.art, movie.art)
			into.nfo = into.nfo === NO_FILE ? movie.nfo : into.nfo
			into.dateAdded = Math.min(into.dateAdded, movie.dateAdded)
			into.disc = into.disc && movie.disc
		}

		return out
	}

	private mergeSeries(): SeriesBuild[] {
		const out: SeriesBuild[] = []
		const byKey = new Map<string, SeriesBuild>()

		for (const series of this.series) {
			const into = series.mergeKey.length > 0 ? byKey.get(series.mergeKey) : undefined
			const root = series.roots[0] ?? -1

			if (into === undefined || into.roots.includes(root) || this.input.splitMergeKeys?.has(series.mergeKey) === true) {
				out.push(series)

				if (series.mergeKey.length > 0 && into === undefined) {
					byKey.set(series.mergeKey, series)
				}

				continue
			}

			into.roots.push(root)
			into.extras.push(...series.extras)
			fillArt(into.art, series.art)
			into.nfo = into.nfo === NO_FILE ? series.nfo : into.nfo

			for (const [number, art] of series.seasonArt) {
				if (!into.seasonArt.has(number)) {
					into.seasonArt.set(number, art)
				}
			}

			for (const [number, season] of series.seasons) {
				const target = into.seasons.get(number)

				if (target === undefined) {
					into.seasons.set(number, season)
				} else if (target.dirUuid.length === 0) {
					target.dirUuid = season.dirUuid
					target.nfo = target.nfo === NO_FILE ? season.nfo : target.nfo
					target.art ??= season.art
				}
			}

			// The same episode in two roots becomes two versions of it.
			for (const [key, episode] of series.episodes) {
				const target = into.episodes.get(key)

				if (target === undefined) {
					into.episodes.set(key, episode)
				} else {
					target.candidates.push(...episode.candidates)
				}
			}
		}

		return out
	}
}

// The "."-separated tokens of `stem` after `key`, its lowercase prefix. Positions come from counting dots: lowercasing
// keeps every "." but can change length ("İ" → "i̇"), so `key.length` is no offset into `stem`.
function tokensAfterKey(stem: string, key: string): string[] {
	let dots = 0

	for (let dot = key.indexOf("."); dot >= 0; dot = key.indexOf(".", dot + 1)) {
		dots++
	}

	let separator = stem.indexOf(".")

	for (; dots > 0 && separator >= 0; dots--) {
		separator = stem.indexOf(".", separator + 1)
	}

	return separator < 0 ? [] : stem.slice(separator + 1).split(".")
}

function subtitleEntry(file: number, format: SidecarSubtitleFormat, info: SubtitleNameInfo): LibrarySubtitle {
	return {
		file,
		format,
		language: info.language,
		forced: info.forced,
		sdh: info.sdh,
		isDefault: info.isDefault,
		title: info.title
	}
}

// Numbered and dated episodes first, by date then number; unnumbered ones last, by title.
export function compareEpisodes(a: LibraryEpisode, b: LibraryEpisode): number {
	const aNumbered = a.date > 0 || a.episode > 0
	const bNumbered = b.date > 0 || b.episode > 0

	if (aNumbered !== bNumbered) {
		return aNumbered ? -1 : 1
	}

	return a.date - b.date || a.episode - b.episode || a.episodeEnd - b.episodeEnd || compareVideoNames(a.title, b.title)
}

function prefixSums(counts: Int32Array): Int32Array {
	for (let i = 1; i < counts.length; i++) {
		counts[i] = (counts[i] ?? 0) + (counts[i - 1] ?? 0)
	}

	return counts
}

// Classifies every root of a library. Pure and synchronous; O(files + directories) with a handful of pattern runs
// per video file.
export function classifyVideoLibrary(input: LibraryScanInput): VideoLibrary {
	const steps = classifyVideoLibrarySteps(input)

	for (;;) {
		const step = steps.next()

		if (step.done === true) {
			return step.value
		}
	}
}

// classifyVideoLibrary in steps: each `next()` runs a bounded share of the work (a few hundred input records
// indexed, one directory classified, or a part of the result assembled), so a caller can yield between slices.
export function* classifyVideoLibrarySteps(input: LibraryScanInput): Generator<void, VideoLibrary> {
	const classifier = new LibraryClassifier(input)

	yield

	return yield* classifier.steps()
}

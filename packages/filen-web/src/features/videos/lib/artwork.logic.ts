import { type } from "arktype"
import {
	NO_FILE,
	type LibraryEpisode,
	type LibraryMovie,
	type LibrarySeason,
	type LibrarySeries,
	type LibraryVersion,
	type VideoLibrary,
	type ProbeCover,
	type VideoProbe
} from "@filen/shared/videos"
import type { Rgb, Size } from "@/lib/media/framePick.logic"
import { fnv1a } from "@/lib/fnv1a"
import type { ArtSlotCode } from "@/features/videos/lib/artStore.logic"

// Which image fills a title's poster, backdrop or still: an ordered list of candidate sources per slot,
// decided from the library listing alone (zero bytes read); a loader then tries them in order and the
// first that decodes wins. Plain and DOM-free.

// Stored sizes per slot; nothing is ever upscaled to reach them.
export const ART_BOXES: Readonly<Record<ArtSlotCode, Size>> = {
	p: { width: 342, height: 513 },
	b: { width: 1280, height: 720 },
	s: { width: 480, height: 270 }
}

// The still for 2x displays: one stored variant per slot, sized for the screen it is made on.
export const STILL_BOX_2X: Size = { width: 640, height: 360 }

export function artBox(slot: ArtSlotCode, devicePixelRatio: number): Size {
	return slot === "s" && devicePixelRatio >= 2 ? STILL_BOX_2X : ART_BOXES[slot]
}

// Sidecar images and embedded covers past this are skipped: the decoder buffers the source whole, and a
// 342 px poster is not worth that download.
export const ART_SOURCE_MAX_BYTES = 20 * 1_048_576

// Sidecar and embedded images made at once, so artwork never takes every shared range-read permit.
export const ART_CONCURRENCY = 2

// WebP quality of stored art: where artefacts stop showing at card size.
export const ART_LOSSY_QUALITY = 80

// Every source an image can come from. `file` is an index into the scan's files: the image for a
// sidecar, the video for the rest.
export type ArtCandidate =
	| { source: "sidecar"; file: number }
	| { source: "embedded"; file: number }
	| { source: "driveThumb"; file: number }
	| { source: "frame"; file: number }
	| { source: "typographic" }
	| { source: "gradient" }

export type ArtSource = ArtCandidate["source"]

// Images a title's NFO names that resolved to files beside it (looked up on the detail page).
export interface NfoArt {
	poster?: number
	backdrop?: number
	thumb?: number
}

export type ArtSubject =
	| { kind: "movie"; movie: LibraryMovie; nfo?: NfoArt }
	| { kind: "series"; series: LibrarySeries; nfo?: NfoArt }
	| { kind: "season"; series: LibrarySeries; season: LibrarySeason }
	| { kind: "episode"; episode: LibraryEpisode; nfo?: NfoArt }

// The file index of a title's playable video: the first part of its first version.
function primaryVideoFile(library: VideoLibrary, versions: readonly LibraryVersion[]): number {
	const video = versions[0]?.parts[0]

	return video === undefined ? NO_FILE : (library.videos[video]?.file ?? NO_FILE)
}

function primaryVideo(library: VideoLibrary, versions: readonly LibraryVersion[]): VideoLibrary["videos"][number] | null {
	const video = versions[0]?.parts[0]

	return video === undefined ? null : (library.videos[video] ?? null)
}

// The first episode of the first regular season (specials only when there is nothing else).
function firstEpisode(series: LibrarySeries): LibraryEpisode | null {
	const season =
		series.seasons.find(item => item.number > 0 && item.episodes.length > 0) ?? series.seasons.find(item => item.episodes.length > 0)

	return season?.episodes[0] ?? null
}

function firstSeasonPoster(series: LibrarySeries): number {
	return series.seasons.find(season => season.number > 0 && season.art.poster !== NO_FILE)?.art.poster ?? NO_FILE
}

class CandidateList {
	public readonly items: ArtCandidate[] = []
	private readonly seen = new Set<string>()

	public file(source: "sidecar" | "embedded" | "driveThumb" | "frame", file: number | undefined): this {
		if (file !== undefined && file !== NO_FILE && !this.seen.has(`${source}:${String(file)}`)) {
			this.seen.add(`${source}:${String(file)}`)
			this.items.push({ source, file })
		}

		return this
	}

	public synthetic(source: "typographic" | "gradient"): this {
		if (!this.seen.has(source)) {
			this.seen.add(source)
			this.items.push({ source })
		}

		return this
	}
}

function seriesPoster(list: CandidateList, library: VideoLibrary, series: LibrarySeries, nfo: NfoArt | undefined): CandidateList {
	const episode = firstEpisode(series)

	return list
		.file("sidecar", nfo?.poster)
		.file("sidecar", series.art.poster)
		.file("sidecar", firstSeasonPoster(series))
		.file("frame", episode === null ? NO_FILE : primaryVideoFile(library, episode.versions))
		.synthetic("typographic")
}

function seriesBackdrop(list: CandidateList, library: VideoLibrary, series: LibrarySeries, nfo: NfoArt | undefined): CandidateList {
	const episode = firstEpisode(series)

	return list
		.file("sidecar", nfo?.backdrop)
		.file("sidecar", series.art.backdrop)
		.file("frame", episode === null ? NO_FILE : primaryVideoFile(library, episode.versions))
		.synthetic("gradient")
}

// An episode's (or a movie's) still: its own -thumb image, the NFO's, its embedded cover, the drive's
// thumbnail, then a generated frame.
function videoStill(
	list: CandidateList,
	library: VideoLibrary,
	versions: readonly LibraryVersion[],
	nfo: NfoArt | undefined
): CandidateList {
	const video = primaryVideo(library, versions)

	return list
		.file("sidecar", video?.thumb)
		.file("sidecar", nfo?.thumb)
		.file("embedded", video?.file)
		.file("driveThumb", video?.file)
		.file("frame", video?.file)
}

// The candidates for one slot of a subject, best first. Every list ends in a synthetic source that
// always renders, so a loader trying them in order always has an answer.
//
// Movie poster: NFO image, sidecar poster (stem form before directory form, as the classifier ranked
// them), embedded cover, drive thumbnail, typographic card; a generated frame only past it.
// Backdrop: NFO fanart, sidecar backdrop, generated frame, dominant-colour gradient.
// Series poster: its own poster, the first season's, the first episode's frame. Season poster: its own,
// then the series'. Still: see videoStill; a movie's falls back to its backdrop image before the drive
// thumbnail's often-black opening frame.
export function artCandidates(library: VideoLibrary, subject: ArtSubject, slot: ArtSlotCode): ArtCandidate[] {
	const list = new CandidateList()

	switch (subject.kind) {
		case "movie": {
			const { movie, nfo } = subject
			const video = primaryVideoFile(library, movie.versions)

			if (slot === "p") {
				return list
					.file("sidecar", nfo?.poster)
					.file("sidecar", movie.art.poster)
					.file("embedded", video)
					.file("driveThumb", video)
					.synthetic("typographic")
					.file("frame", video).items
			}

			if (slot === "b") {
				// A Matroska file may carry a landscape cover (`cover_land.*`), read once its probe locates it.
				const landscape = primaryVideo(library, movie.versions)?.container === "mkv" ? video : NO_FILE

				return list
					.file("sidecar", nfo?.backdrop)
					.file("sidecar", movie.art.backdrop)
					.file("embedded", landscape)
					.file("frame", video)
					.synthetic("gradient").items
			}

			const own = primaryVideo(library, movie.versions)

			return list
				.file("sidecar", own?.thumb)
				.file("sidecar", nfo?.thumb)
				.file("sidecar", movie.art.backdrop)
				.file("driveThumb", video)
				.file("frame", video)
				.synthetic("gradient").items
		}

		case "series":
			return slot === "p"
				? seriesPoster(list, library, subject.series, subject.nfo).items
				: slot === "b"
					? seriesBackdrop(list, library, subject.series, subject.nfo).items
					: videoStill(list, library, firstEpisode(subject.series)?.versions ?? [], undefined).synthetic("gradient").items

		case "season": {
			const { series, season } = subject

			if (slot === "p") {
				return seriesPoster(list.file("sidecar", season.art.poster), library, series, undefined).items
			}

			if (slot === "b") {
				return seriesBackdrop(list.file("sidecar", season.art.backdrop), library, series, undefined).items
			}

			return videoStill(list, library, season.episodes[0]?.versions ?? [], undefined).synthetic("gradient").items
		}

		case "episode":
			return videoStill(list, library, subject.episode.versions, subject.nfo).synthetic("gradient").items
	}
}

export const ART_KV_PREFIX = "videos.v1.art."
export const ART_MAX_RECORDS = 20_000

// Per stored image (artKey): what it was made from and how to show it. `fit` says whether
// it fills the slot's box once cropped (cover) or is shown whole (contain); `dom` is its dominant colour.
export const artRecordSchema = type({
	slot: "'p' | 'b' | 's'",
	source: "'sidecar' | 'embedded' | 'driveThumb' | 'frame' | 'capture'",
	fit: "'cover' | 'contain'",
	w: "number",
	h: "number",
	dom: ["number", "number", "number"],
	// The source answered for good that it has no image (not an image, a format the decoder refuses):
	// nothing was stored, and it is never read again.
	"miss?": "boolean",
	// On an embedded miss, the probe revision that found no cover: a newer one reads the covers again, so the
	// miss stops counting then. Absent on a decoder's verdict, which lasts.
	"rev?": "number",
	at: "number"
})

export type ArtRecord = typeof artRecordSchema.infer

// The typographic card's colour: stable per title, dark enough for white text.
export function titleColour(title: string): Rgb {
	const hue = (fnv1a(title) % 360) / 360
	const saturation = 0.45
	const lightness = 0.3
	const q = lightness + saturation - lightness * saturation
	const p = 2 * lightness - q
	const channel = (offset: number): number => {
		let t = hue + offset

		t -= Math.floor(t)

		const value = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p

		return Math.round(value * 255)
	}

	return [channel(1 / 3), channel(0), channel(-1 / 3)]
}

function isCoverSpan(value: unknown): value is ProbeCover {
	if (typeof value !== "object" || value === null) {
		return false
	}

	const span: Partial<Record<keyof ProbeCover, unknown>> = value

	return typeof span.offset === "number" && typeof span.size === "number" && typeof span.mime === "string" && span.size > 0
}

// Where a file's landscape cover (Matroska `cover_land.*`, by name) sits, as its probe recorded it: the backdrop an
// embedded source yields. Null until the probe records one (`coverLand`).
export function probeLandscapeCover(probe: VideoProbe | null | undefined): ProbeCover | null {
	if (probe === null || probe === undefined || !("coverLand" in probe)) {
		return null
	}

	return isCoverSpan(probe.coverLand) ? probe.coverLand : null
}

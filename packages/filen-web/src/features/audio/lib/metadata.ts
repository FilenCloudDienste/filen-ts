import type { IAudioMetadata, IPicture } from "music-metadata"
import { log } from "@/lib/log"
import type { QueueTrack } from "@/features/audio/store/audioQueue"

// Tag + embedded-cover extraction for the audio module. Runs only for the CURRENT and one-ahead
// PREFETCHED track (the engine is the only caller, and it never fans this out over a whole queue) and
// never blocks playback — every path here degrades silently to filename-only tags on any failure
// (unsupported container, a mid-read network hiccup, a corrupt embedded picture). `music-metadata` and
// its `strtok3` random-access tokenizer are dynamically imported on first use so their parser tables
// never load into the app's main bundle — most sessions play audio without ever needing this chunk,
// same lazy-chunk idiom as pdfViewer.tsx/docxViewer.tsx's own heavy-lib imports.

export interface TrackPicture {
	data: Uint8Array
	format: string
}

export interface TrackTags {
	title: string | null
	artist: string | null
	album: string | null
	picture: TrackPicture | null
}

export const EMPTY_TRACK_TAGS: TrackTags = { title: null, artist: null, album: null, picture: null }

// Restated structurally rather than imported from engine.ts's TrackSource: this module has no static
// dependency on the engine (only the reverse — the engine depends on THIS module's types), and a
// TrackSource value is passed in here without any conversion since the shapes are identical.
export type MetadataSource = { kind: "stream"; url: string } | { kind: "blob"; url: string }

export interface MetadataExtractors {
	extractRanged: (track: QueueTrack, url: string, sizeBytes: number) => Promise<TrackTags>
	extractBuffered: (track: QueueTrack, blobUrl: string) => Promise<TrackTags>
}

function tagsFromParsed(parsed: IAudioMetadata, selectCover: (pictures?: IPicture[]) => IPicture | null): TrackTags {
	const cover = selectCover(parsed.common.picture)

	return {
		title: parsed.common.title ?? null,
		artist: parsed.common.artist ?? null,
		album: parsed.common.album ?? null,
		picture: cover ? { data: cover.data, format: cover.format } : null
	}
}

// Ranged extraction over the SW's Range/206-capable inline stream route — the founder-decided primary
// path (Q5 of the study). Tried unconditionally for every stream-sourced track, no container allowlist:
// a container that places its tags at the end (M4A `moov`, some FLAC/APE trailers) simply costs a
// couple of extra Range round trips here instead of a whole-file download; one that genuinely has none
// just resolves with empty common tags, handled the same as any other "no tags" result.
async function extractRanged(track: QueueTrack, url: string, sizeBytes: number): Promise<TrackTags> {
	const [{ RangeFetchTokenizer }, musicMetadata] = await Promise.all([
		import("@/features/audio/lib/rangeTokenizer"),
		import("music-metadata")
	])

	const tokenizer = new RangeFetchTokenizer(url, sizeBytes, track.mime || undefined)

	try {
		const parsed = await musicMetadata.parseFromTokenizer(tokenizer, { duration: false })

		return tagsFromParsed(parsed, musicMetadata.selectCover)
	} finally {
		await tokenizer.close().catch(() => undefined)
	}
}

// The whole-buffer fallback: reads the bytes already resident behind a blob: URL — the engine's own
// blob-fallback playback source (dev / SW absent / a failed stream registration) — via a same-origin,
// no-network `fetch`. This is a second READ of an already-materialized Blob, never a second download.
async function extractBuffered(_track: QueueTrack, blobUrl: string): Promise<TrackTags> {
	const musicMetadata = await import("music-metadata")
	const response = await fetch(blobUrl)
	const blob = await response.blob()
	const parsed = await musicMetadata.parseBlob(blob, { duration: false })

	return tagsFromParsed(parsed, musicMetadata.selectCover)
}

export const defaultMetadataExtractors: MetadataExtractors = { extractRanged, extractBuffered }

// The pure dispatch: which source to read tags from, given the SAME source the engine already resolved
// for playback (never a separate byte fetch of its own) — stream-sourced tracks go through the ranged
// tokenizer, blob-sourced tracks re-read the resident buffer. Failures anywhere in the chosen path
// degrade silently to EMPTY_TRACK_TAGS (filename-only) — this must never throw into the engine or block
// playback. `extractors` is injectable so this dispatcher is unit-testable without real fetch/parsing.
export async function resolveTrackTags(
	track: QueueTrack,
	source: MetadataSource,
	sizeBytes: number,
	extractors: MetadataExtractors = defaultMetadataExtractors
): Promise<TrackTags> {
	try {
		return source.kind === "stream"
			? await extractors.extractRanged(track, source.url, sizeBytes)
			: await extractors.extractBuffered(track, source.url)
	} catch (error) {
		log.warn("audio", "metadata extraction failed, degrading to filename-only", error)

		return EMPTY_TRACK_TAGS
	}
}

import {
	CouldNotDetermineFileTypeError,
	parseBlob,
	parseFromTokenizer,
	selectCover,
	type IAudioMetadata,
	type IOptions
} from "music-metadata"
import { normalizeTrackTags } from "@filen/shared"
import { log } from "@/lib/log"
import { BlockTokenizer } from "@/features/audio/lib/blockTokenizer"
import { BlockSource, type ReadRange } from "@/lib/media/blockSource"

// Tag + cover extraction for one audio file, run inside the sdk worker so the parser's many small reads
// go straight to the SDK (no page round trip per read) and the embedded cover never leaves the worker at
// full size: only the normalized tags and a small thumbnail cross back.

export interface AudioTrackTags {
	title: string | null
	artist: string | null
	album: string | null
	durationSec: number | null
}

// "unparseable" is final for the file (unsupported container, garbage bytes, a parse that wanted more
// than tags ever need). "readFailed" says nothing about the file: the bytes did not arrive this time.
export type AudioMetadataResult =
	{ type: "parsed"; tags: AudioTrackTags; thumbnail: Uint8Array | null } | { type: "unparseable" } | { type: "readFailed" }

export interface AudioMetadataDeps {
	signal: AbortSignal
	// Downscales an embedded cover; null when the image cannot be thumbnailed.
	makeThumbnail: (cover: Uint8Array) => Promise<Uint8Array | null>
	storeThumbnail: (bytes: Uint8Array) => Promise<void>
}

// Tags need the head and the tail of a file, never an exact duration: a duration that would take a
// whole-file scan (Ogg, headerless VBR) is left out rather than paid for.
const PARSE_OPTIONS: IOptions = { duration: false }

async function toResult(parsed: IAudioMetadata, deps: AudioMetadataDeps): Promise<AudioMetadataResult> {
	const { title, artist, album, durationSec } = normalizeTrackTags(parsed)
	const cover = selectCover(parsed.common.picture)
	let thumbnail: Uint8Array | null = null

	if (cover !== null && cover.data.length > 0) {
		try {
			thumbnail = await deps.makeThumbnail(cover.data)
		} catch (error) {
			log.warn("audio-metadata", "cover thumbnail failed", error)
		}
	}

	deps.signal.throwIfAborted()

	if (thumbnail !== null) {
		await deps.storeThumbnail(thumbnail).catch((error: unknown) => {
			log.warn("audio-metadata", "cover thumbnail persist failed", error)
		})
	}

	return { type: "parsed", tags: { title, artist, album, durationSec }, thumbnail }
}

async function parseTokenizer(tokenizer: BlockTokenizer): Promise<IAudioMetadata> {
	try {
		return await parseFromTokenizer(tokenizer, PARSE_OPTIONS)
	} finally {
		await tokenizer.close().catch(() => undefined)
	}
}

// Parser selection sniffs the content first, since a stored mime is only as good as the uploader's
// extension; a sniff that finds nothing retries with the mime hint, over bytes already read.
async function sniffThenHint(hasHint: boolean, parse: (hinted: boolean) => Promise<IAudioMetadata>): Promise<IAudioMetadata> {
	try {
		return await parse(false)
	} catch (error) {
		if (!hasHint || !(error instanceof CouldNotDetermineFileTypeError)) {
			throw error
		}

		return await parse(true)
	}
}

// A drive file, read by range through the shared block cache.
export async function readAudioMetadata(
	size: number,
	mime: string,
	readRange: ReadRange,
	deps: AudioMetadataDeps
): Promise<AudioMetadataResult> {
	const source = new BlockSource(size, readRange)
	let parsed: IAudioMetadata

	try {
		parsed = await sniffThenHint(mime !== "", hinted => parseTokenizer(new BlockTokenizer(source, hinted ? mime : undefined)))
	} catch (error) {
		deps.signal.throwIfAborted()

		if (source.readError !== null) {
			return { type: "readFailed" }
		}

		log.info("audio-metadata", "unparseable audio file", error)

		return { type: "unparseable" }
	}

	deps.signal.throwIfAborted()

	// Some parsers (MP4) downgrade a mid-read failure to a warning and resolve partial tags, which must not
	// pass for the file's final answer.
	if (source.readError !== null) {
		return { type: "readFailed" }
	}

	return toResult(parsed, deps)
}

// Bytes already resident in the page (the player's whole-file fallback source), so no network at all.
export async function readAudioMetadataFromBlob(blob: Blob, deps: AudioMetadataDeps): Promise<AudioMetadataResult> {
	let parsed: IAudioMetadata

	try {
		// A Blob's type doubles as parseBlob's mime hint, so the sniff pass reads an untyped slice of it.
		parsed = await sniffThenHint(blob.type !== "", hinted => parseBlob(hinted ? blob : blob.slice(0, blob.size, ""), PARSE_OPTIONS))
	} catch (error) {
		deps.signal.throwIfAborted()

		log.info("audio-metadata", "unparseable audio blob", error)

		return { type: "unparseable" }
	}

	deps.signal.throwIfAborted()

	return toResult(parsed, deps)
}

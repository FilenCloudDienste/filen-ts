import { ADTS, CustomSource, FLAC, Input, MATROSKA, MP3, MP4, MPEG_TS, OGG, QTFF, WAVE, WEBM } from "mediabunny"
import { BLOCK_BYTES } from "@filen/shared/videos"
import { BlockCache, MAX_RUN_BLOCKS, type BlockCacheOptions } from "@/lib/media/blockCache"
import { rangePortReader, type RangePortReader } from "@/lib/media/rangePort"
import { SourceReadError } from "@/lib/media/remuxTypes"

// Containers a worker may read. Not every format the demuxer knows: each one parsed is attack surface. The
// audio-only ones come last, so a file any of the others recognises is read exactly as it would be without them.
export const BLOCK_INPUT_FORMATS = [MATROSKA, WEBM, MP4, QTFF, MPEG_TS, WAVE, OGG, FLAC, MP3, ADTS]

// Reads longer than this reach the demuxer as a stream of blocks rather than one assembled buffer.
const STREAM_READ_BYTES = 2 * BLOCK_BYTES

// How the block cache under an input holds and fetches a file, by what reads it:
// - playback: seeks back and forth; headroom for header blocks revisited between clusters.
// - audio: one track read in order at a low bitrate; a few blocks are plenty.
// - export: one pass start to end; long runs and a deep read-ahead keep the encoder fed, and nothing behind
//   the reader is read again, so little more than the read-ahead stays resident.
export type BlockInputProfile = "playback" | "audio" | "export"

export const BLOCK_INPUT_PROFILES: Record<
	BlockInputProfile,
	Required<Pick<BlockCacheOptions, "capacity" | "readAhead" | "maxRunBlocks">>
> = {
	playback: { capacity: 12, readAhead: 3, maxRunBlocks: MAX_RUN_BLOCKS },
	audio: { capacity: 4, readAhead: 2, maxRunBlocks: MAX_RUN_BLOCKS },
	export: { capacity: 10, readAhead: 8, maxRunBlocks: 8 }
}

export interface BlockInput {
	readonly reader: RangePortReader
	readonly cache: BlockCache
	readonly input: Input
	// Calls off downloads, disposes the demuxer and the cache, closes the port. Idempotent.
	close(): void
}

export interface BlockInputOptions {
	// Sees every block as it lands, before any reader gets it (a subtitle tap, a progressive waveform). Never reads.
	onBlock?: (index: number, bytes: Uint8Array) => void
}

// One mediabunny Input over the file a range port serves, read through a block cache (the only cache: the
// demuxer's own would hold a second copy). A failed read rejects with SourceReadError; an aborted one as aborted.
export function openBlockInput(port: MessagePort, size: number, profile: BlockInputProfile, options: BlockInputOptions = {}): BlockInput {
	const reader = rangePortReader(port)
	const cache = new BlockCache(
		size,
		(start, end, signal) =>
			reader.readRange(start, end, signal).catch((error: unknown) => {
				throw signal.aborted ? error : new SourceReadError(error)
			}),
		{ ...BLOCK_INPUT_PROFILES[profile], ...(options.onBlock === undefined ? {} : { onBlock: options.onBlock }) }
	)
	const input = new Input({
		formats: BLOCK_INPUT_FORMATS,
		source: new CustomSource({
			getSize: () => size,
			read: (start, end) => (end - start > STREAM_READ_BYTES ? cache.stream(start, end) : cache.read(start, end)),
			prefetchProfile: "none",
			maxCacheSize: 0
		})
	})

	let closed = false

	return {
		reader,
		cache,
		input,
		close: () => {
			if (closed) {
				return
			}

			closed = true
			cache.abort()
			input.dispose()
			cache.dispose()
			reader.close()
		}
	}
}

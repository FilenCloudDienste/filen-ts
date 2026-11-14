import { ADTS, CustomSource, FLAC, Input, MP3, type AudioSample, type InputFormat } from "mediabunny"
import { BlockAbortError, type BlockCache } from "@/lib/media/blockCache"
import { emptyRemuxStats, isSourceReadError, type EdgeAnalysis, type WindowPermits } from "@/lib/media/remuxTypes"
import { log } from "@/lib/log"
import { openAudioInput, streamStart, type AudioInput } from "@/workers/remux/audioInput"
import { sampleReader, type SampleReader } from "@/workers/remux/audioTranscode"
import {
	accumulateEnvelope,
	createEnvelope,
	EDGE_WINDOWS,
	findBoundaryLevels,
	findEdges,
	finishEnvelope,
	windowsFor,
	type EdgeWindows
} from "@/workers/remux/edges.logic"
import {
	audioEndOf,
	edgeWindowBytes,
	flacMetadataBlock,
	flacStreamInfo,
	flacVirtualHeader,
	isFlacMagic,
	isStreamInfoBlock,
	METADATA_HEADER_BYTES,
	RESYNC_BYTES,
	STREAMINFO_BYTES,
	syncFlacFrame,
	syncFrameStream,
	tailWindowOffset,
	TRAILER_PROBE_BYTES,
	type FlacStreamInfo,
	type TailStream
} from "@/workers/remux/tailWindow.logic"

// Reads an audio file's head and tail windows and measures its smart edges (edges.logic). One decoder is alive at a
// time: the head reader is closed before the tail one opens. An MP3, ADTS or FLAC tail is reached by byte offset
// (tailWindow.logic), everything else through its container's seek. Each window's reads run in a background
// range-read permit of its own, so the page's other background reads go between them.

const FAILED: EdgeAnalysis = {
	status: "failed",
	durationSec: null,
	inStartMs: null,
	outEndFromEndMs: null,
	fadeOutFromEndMs: null,
	boundary: null
}

// No permits to wait for: a caller outside the page's budget.
export const FREE_PERMITS: WindowPermits = { acquire: () => Promise.resolve(), release: () => undefined }

// The permit of the window being read: taken before its first read, given back once it is done.
export class WindowPermit {
	private readonly permits: WindowPermits
	private held = false

	public constructor(permits: WindowPermits = FREE_PERMITS) {
		this.permits = permits
	}

	public async take(): Promise<void> {
		if (this.held) {
			return
		}

		await this.permits.acquire()
		this.held = true
	}

	public give(): void {
		if (!this.held) {
			return
		}

		this.held = false
		void Promise.resolve(this.permits.release()).catch(() => undefined)
	}

	public async window<T>(read: () => Promise<T>): Promise<T> {
		await this.take()

		try {
			return await read()
		} finally {
			this.give()
		}
	}
}

// Metadata blocks walked to find a FLAC stream's frames at most.
const MAX_FLAC_BLOCKS = 64

// Where a byte-seekable stream's audio lies: its first frame, and what a frame header of it must match.
type StreamLayout =
	| { stream: "mp3" | "adts"; audioStart: number; shape: number | null }
	| { stream: "flac"; audioStart: number; streamInfo: Uint8Array; info: FlacStreamInfo }

// One pass over decoded audio: each sample's planes copied into one scratch buffer, folded into the envelope and
// closed at once.
class EnvelopeReader {
	private scratch = new Float32Array(0)

	public async read(reader: SampleReader, from: number, until: number, capacity: number): Promise<Float32Array> {
		const envelope = createEnvelope(capacity)
		let rate = 0

		try {
			for (let item = await reader.first(from); item !== null; item = await reader.next(item)) {
				const { sample } = item

				if (sample.timestamp >= until) {
					sample.close()
					break
				}

				rate = sample.sampleRate
				this.add(envelope, sample)
				sample.close()
			}
		} finally {
			await reader.close()
		}

		return finishEnvelope(envelope, rate)
	}

	private add(envelope: ReturnType<typeof createEnvelope>, sample: AudioSample): void {
		const frames = sample.numberOfFrames

		if (this.scratch.length < frames) {
			this.scratch = new Float32Array(frames)
		}

		const scratch = this.scratch.subarray(0, frames)

		accumulateEnvelope(envelope, sample.numberOfChannels, frames, sample.sampleRate, channel => {
			sample.copyTo(scratch, { planeIndex: channel, format: "f32-planar" })

			return scratch
		})
	}
}

// The last `windows` windows of an envelope.
function lastWindows(envelope: Float32Array, windows: number): Float32Array {
	return envelope.subarray(Math.max(0, envelope.length - windows))
}

const NOT_CANCELLED = (): boolean => false

async function streamLayout(input: AudioInput): Promise<StreamLayout | null> {
	const stream = input.info.tailStream

	if (stream === undefined) {
		return null
	}

	const { cache } = input
	const start = await streamStart(cache)

	if (stream !== "flac") {
		const head = await cache.read(start, Math.min(cache.size, start + RESYNC_BYTES))
		const synced = syncFrameStream(head, 0, stream, null, start + head.length === cache.size)

		return { stream, audioStart: start + (synced?.at ?? 0), shape: synced?.shape ?? null }
	}

	if (start + METADATA_HEADER_BYTES > cache.size || !isFlacMagic(await cache.read(start, start + METADATA_HEADER_BYTES))) {
		return null
	}

	let at = start + METADATA_HEADER_BYTES
	let streamInfo: Uint8Array | null = null

	for (let i = 0; i < MAX_FLAC_BLOCKS && at + METADATA_HEADER_BYTES <= cache.size; i++) {
		const block = flacMetadataBlock(await cache.read(at, at + METADATA_HEADER_BYTES))

		if (block === null) {
			return null
		}

		if (isStreamInfoBlock(block) && at + METADATA_HEADER_BYTES + STREAMINFO_BYTES <= cache.size) {
			streamInfo = (await cache.read(at + METADATA_HEADER_BYTES, at + METADATA_HEADER_BYTES + STREAMINFO_BYTES)).slice()
		}

		at += METADATA_HEADER_BYTES + block.size

		if (block.last) {
			break
		}
	}

	const info = streamInfo === null ? null : flacStreamInfo(streamInfo)

	return streamInfo === null || info === null ? null : { stream: "flac", audioStart: at, streamInfo, info }
}

// An Input over the file from `from` to `to` (where its audio ends), behind `prefix`: the tail window as a file of
// its own. The block the window ends in, read first for the tags appended to the file, is kept resident while the
// window decodes toward it, so it is never downloaded twice.
function windowInput(cache: BlockCache, prefix: Uint8Array, from: number, to: number, format: InputFormat): Input {
	const head = prefix.length
	const size = head + to - from
	const last = to - 1

	const keepLast = (): void => {
		if (cache.isResident(last)) {
			void cache.read(last, to)
		}
	}

	const read = async (start: number, end: number): Promise<Uint8Array> => {
		if (end <= head) {
			return prefix.subarray(start, end)
		}

		if (start >= head) {
			const bytes = await cache.read(from + start - head, from + end - head)

			keepLast()

			return bytes
		}

		const out = new Uint8Array(end - start)

		out.set(prefix.subarray(start))
		out.set(await cache.read(from, from + end - head), head - start)
		keepLast()

		return out
	}

	return new Input({
		formats: [format],
		source: new CustomSource({ getSize: () => size, read, prefetchProfile: "none", maxCacheSize: 0 })
	})
}

const TAIL_FORMATS: Record<TailStream, InputFormat> = { mp3: MP3, adts: ADTS, flac: FLAC }

// The envelope of the last `seconds`, ending where the audio does; null when no frame could be found to start a
// byte-offset window at.
async function tailEnvelope(
	input: AudioInput,
	layout: StreamLayout | null,
	seconds: number,
	envelopes: EnvelopeReader
): Promise<Float32Array | null> {
	const { cache, info } = input
	const windows = windowsFor(seconds)

	if (layout === null) {
		const reader = input.reader(emptyRemuxStats(), NOT_CANCELLED)

		return lastWindows(await envelopes.read(reader, Math.max(0, info.duration - seconds), Number.POSITIVE_INFINITY, windows), windows)
	}

	const probeFrom = Math.max(layout.audioStart, cache.size - TRAILER_PROBE_BYTES)
	const audioEnd = audioEndOf(await cache.read(probeFrom, cache.size), cache.size, layout.audioStart)
	const offset = tailWindowOffset({ audioEnd, audioStart: layout.audioStart, duration: info.duration, seconds })
	const end = Math.min(audioEnd, offset + RESYNC_BYTES)
	const bytes = await cache.read(offset, end)
	const at =
		layout.stream === "flac"
			? syncFlacFrame(bytes, 0, layout.info)
			: (syncFrameStream(bytes, 0, layout.stream, layout.shape, end === audioEnd)?.at ?? null)

	if (at === null) {
		return null
	}

	const prefix = layout.stream === "flac" ? flacVirtualHeader(layout.streamInfo) : new Uint8Array(0)
	const window = windowInput(cache, prefix, offset + at, audioEnd, TAIL_FORMATS[layout.stream])

	try {
		const track = await window.getPrimaryAudioTrack()

		if (track === null) {
			return null
		}

		const reader = sampleReader(track, emptyRemuxStats(), NOT_CANCELLED)

		return lastWindows(await envelopes.read(reader, 0, Number.POSITIVE_INFINITY, windows), windows)
	} finally {
		window.dispose()
	}
}

// The analysis of an opened file; the caller closes `input`. Rejects only for a read that failed or was
// aborted; whatever else goes wrong in decoding is a `failed` answer. The head window (with the file's layout)
// and the tail window each read in a permit of their own; `permit` may already hold the first.
export async function analyzeInput(
	input: AudioInput,
	windows: EdgeWindows = EDGE_WINDOWS,
	permit: WindowPermit = new WindowPermit()
): Promise<EdgeAnalysis> {
	const { duration } = input.info
	const envelopes = new EnvelopeReader()

	try {
		await permit.take()

		const layout = await streamLayout(input)
		// Tags appended to the file count toward the estimate: the tail window finds them, after this decision.
		const bytes = edgeWindowBytes({
			audioEnd: input.cache.size,
			audioStart: layout?.audioStart ?? 0,
			duration,
			headSeconds: windows.headSeconds,
			tailSeconds: windows.tailSeconds
		})

		const headOf = async (seconds: number): Promise<Float32Array> =>
			await envelopes.read(input.reader(emptyRemuxStats(), NOT_CANCELLED), 0, seconds, windowsFor(Math.min(seconds, duration)) + 1)

		// Past the budget: the boundary seconds alone, which an album's track boundary still needs.
		if (bytes > windows.maxWindowBytes) {
			const head = await headOf(windows.boundarySeconds)

			permit.give()

			const tail = await permit.window(() => tailEnvelope(input, layout, windows.boundarySeconds, envelopes))

			return {
				...FAILED,
				status: "skipped",
				durationSec: duration,
				boundary: findBoundaryLevels(head, tail, windows.boundarySeconds)
			}
		}

		let head: Float32Array
		let tail: Float32Array | null

		if (duration <= windows.headSeconds + windows.tailSeconds) {
			// Both windows cover the whole track: one pass.
			const whole = await headOf(Number.POSITIVE_INFINITY)

			head = whole.subarray(0, windowsFor(windows.headSeconds))
			tail = lastWindows(whole, windowsFor(windows.tailSeconds))
		} else {
			head = await headOf(windows.headSeconds)
			permit.give()
			tail = await permit.window(() => tailEnvelope(input, layout, windows.tailSeconds, envelopes))
		}

		return {
			status: "ok",
			durationSec: duration,
			...findEdges(head, tail),
			boundary: findBoundaryLevels(head, tail, windows.boundarySeconds)
		}
	} catch (error) {
		return undecodable(error)
	} finally {
		permit.give()
	}
}

// A read that failed or was aborted says nothing about the file: it rejects. Anything else is the file's answer.
function undecodable(error: unknown): EdgeAnalysis {
	if (isSourceReadError(error) || error instanceof BlockAbortError) {
		throw error
	}

	log.info("audio-edges", "edge analysis could not decode the file", error)

	return FAILED
}

// Opens the file a range port serves and analyses it, the open in the head window's permit.
export async function analyzeEdges(port: MessagePort, size: number, permits: WindowPermits = FREE_PERMITS): Promise<EdgeAnalysis> {
	const permit = new WindowPermit(permits)

	try {
		await permit.take()

		let input: AudioInput

		try {
			input = await openAudioInput(port, size, "analysis")
		} catch (error) {
			return undecodable(error)
		}

		try {
			return await analyzeInput(input, EDGE_WINDOWS, permit)
		} finally {
			await input.close()
		}
	} finally {
		permit.give()
	}
}

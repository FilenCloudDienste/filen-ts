import {
	ADTS,
	EncodedPacketSink,
	FLAC,
	MATROSKA,
	MP3,
	WEBM,
	type Input,
	type AudioCodec,
	type EncodedPacket,
	type InputAudioTrack,
	type InputFormat,
	type InputVideoTrack,
	type Rotation,
	type VideoCodec
} from "mediabunny"
import { BlockSource, probeVideo, walkContainer } from "@filen/shared/videos"
import { BlockAbortError, type BlockCache } from "@/lib/media/blockCache"
import { openBlockInput, type BlockInput } from "@/lib/media/blockInput"
import { isInitSegment } from "@/lib/media/fmp4Split"
import {
	IdrUnreachableError,
	SourceReadError,
	SupersededError,
	type RemuxAudioInfo,
	type RemuxAudioStart,
	type RemuxAudioStartParams,
	type RemuxEvent,
	type RemuxMediaInfo,
	type RemuxOpenParams,
	type RemuxSeekParams,
	type RemuxSeekResult,
	type RemuxStartParams,
	type RemuxStats,
	type RemuxVideoInfo,
	type RemuxVideoStart,
	type TrackKind
} from "@/lib/media/remuxTypes"
import {
	pickEncoderTarget,
	TRANSCODE_BITRATE,
	TRANSCODE_CHANNELS,
	TRANSCODE_SAMPLE_RATE,
	type EncoderTarget
} from "@/workers/remux/audioMix.logic"
import { sampleReader, TranscodeWriter, type SampleReader } from "@/workers/remux/audioTranscode"
import {
	containerPackets,
	estimatedStreamDuration,
	ffmpegSampleReader,
	probedCodecs,
	rawPackets,
	rawStreamOf
} from "@/workers/remux/audioInput"
import type { RawStreamInfo } from "@/workers/remux/rawAudio.logic"
import type { FfmpegCodec } from "@/workers/remux/ffmpegDecoder"
import { ac3Layout, dtsLayout, layoutFor, type Speaker } from "@/workers/remux/channelLayout.logic"
import {
	copyCodecString,
	isCopyableAudio,
	isFfmpegReaderAudio,
	isTranscodableAudio,
	outputVideoCodecString
} from "@/workers/remux/codecs.logic"
import { hevcKeyIsIdr, hevcLengthSize, IDR_REACH_KEYS, idrReachSeconds } from "@/workers/remux/hevc.logic"
import { KeyIndex, seekReach } from "@/workers/remux/keyIndex"
import { FragmentedTrackOutput, FragmentTooLargeError } from "@/workers/remux/output"
import { PumpGate, runPump, type PumpReader, type PumpResult, type PumpWriter } from "@/workers/remux/pump"
import { TextTap, isTapTextCodec, type TextTapTrack } from "@/workers/remux/textTap"

// Formats whose demuxer has no index: it finds a far position (the file's end too, for its duration) only by
// reading every cluster or frame before it.
const SCANNING_FORMATS = new Set<InputFormat>([MATROSKA, WEBM, FLAC, MP3, ADTS])

// How far audio may read past the video pump's position. Both read the same interleaved clusters; an
// audio pump that ran ahead or fell behind by more than the block cache holds would download them twice.
const AUDIO_LEAD_SECONDS = 0.5

// Less than any frame's duration: asking for the key packet at or before a key packet's timestamp minus this
// finds the one before it.
const KEY_STEP_SECONDS = 0.001

// How long close() waits for the pumps' own teardown (a decoder, the muxer) before letting go anyway.
const CLOSE_TIMEOUT_MS = 2_000

type Emit = (event: RemuxEvent) => void

// Retries a read once when it failed only because a seek aborted the download it was riding on: the
// demuxer can merge a new read into an older one that the seek called off.
async function surviveAbort<T>(read: () => Promise<T>, gate: PumpGate): Promise<T> {
	try {
		return await read()
	} catch (error) {
		if (!(error instanceof BlockAbortError) || gate.isCancelled()) {
			throw error
		}

		return await read()
	}
}

interface Run {
	generation: number
	gate: PumpGate
	done: Promise<void>
	close: () => Promise<void>
}

interface VideoSource {
	track: InputVideoTrack
	codec: VideoCodec
	config: VideoDecoderConfig
	rotation: Rotation
	// Set when a start must be an IDR picture: the NAL length field size of its packets (null: Annex B).
	idrOnly: { lengthSize: number | null } | null
}

function bytesOf(source: AllowSharedBufferSource | undefined): Uint8Array | null {
	if (source === undefined) {
		return null
	}

	return ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source)
}

// A track the demuxer reads, with FFmpeg's decoder where mediabunny has none for its codec (TrueHD, ALAC);
// or a bare AC-3/E-AC-3/DTS stream, which no demuxer reads.
type AudioSource =
	| { kind: "track"; track: InputAudioTrack; codec: AudioCodec | null; ffmpeg: { codec: FfmpegCodec; extradata?: Uint8Array } | null }
	| { kind: "raw"; info: RawStreamInfo }

// The one track id a bare stream is opened under.
const RAW_TRACK_ID = 1

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// One open file: the shared block cache, the demuxer over it and at most one pump per track kind. A
// seek or track switch cancels the kind's pump and starts a new one under a new generation; every
// segment carries its generation so the page drops anything a superseded pump still emits.
export class RemuxEngine {
	public readonly stats: RemuxStats = {
		blockReads: 0,
		bytesRead: 0,
		rangeReads: 0,
		readAheadBlocks: 0,
		segmentsOut: 0,
		bytesOut: 0,
		transcodeSeconds: 0,
		decodeWaitSeconds: 0,
		transcodedMediaSeconds: 0
	}

	private readonly source: BlockInput
	private readonly cache: BlockCache
	private readonly input: Input
	private readonly emit: Emit
	private readonly transcodeTargets: RemuxOpenParams["transcodeTargets"]
	private readonly idrOnlyStart: boolean
	private video: VideoSource | null = null
	private readonly audio = new Map<number, AudioSource>()
	private seekScansFile = false
	// The furthest presentation time any pump has read, which a file without an index can seek within
	// without scanning further.
	private scannedUntil = 0
	private readonly keys = new KeyIndex()
	private readonly size: number
	private duration = 0
	private readonly runs = new Map<TrackKind, Run>()
	// The presentation time the video pump has read up to; audio follows it.
	private videoReadUntil = Number.NEGATIVE_INFINITY
	private readonly maxFragmentBytes: RemuxOpenParams["maxFragmentBytes"]
	private encoderTarget: Promise<EncoderTarget | null> | null = null
	// Bumped by every audio start and stop: a start that awaited past a newer one gives up.
	private audioEpoch = 0
	private readonly layouts = new Map<number, Promise<Speaker[] | null>>()
	// Embedded text subtitles, taken from the blocks playback reads (Matroska only).
	private tap: TextTap | null = null
	// The IDR picture the last start resolved to: a seek asks canStartAt first and then starts at the same
	// time, and the walk back to it is one read per key packet looked at.
	private lastIdr: { at: number; timestamp: number } | null = null

	public constructor(params: RemuxOpenParams, emit: Emit) {
		this.source = openBlockInput(params.port, params.size, "playback", {
			onBlock: (index, bytes) => {
				this.tap?.addBlock(index, bytes)
			}
		})
		this.cache = this.source.cache
		this.input = this.source.input
		this.emit = emit
		// The file's server went away: say so now, not at the next read a paused player may never make.
		this.source.reader.onLost(() => {
			for (const [kind, run] of this.runs) {
				this.emit({
					type: "error",
					kind,
					generation: run.generation,
					message: "the file's byte source closed",
					fragmentTooLarge: false,
					sourceLost: true
				})
			}
		})
		this.transcodeTargets = params.transcodeTargets
		this.idrOnlyStart = params.idrOnlyStart === true
		this.maxFragmentBytes = params.maxFragmentBytes
		this.size = params.size
	}

	public async open(params: RemuxOpenParams): Promise<RemuxMediaInfo> {
		const raw = await rawStreamOf(this.cache, this.input)

		if (raw !== null) {
			return this.openRaw(raw, params.size)
		}

		const [video, audio] = await Promise.all([this.input.getPrimaryVideoTrack(), this.input.getAudioTracks()])
		const format = await this.input.getFormat()
		const matroska = format === MATROSKA || format === WEBM
		const scanning = SCANNING_FORMATS.has(format)
		const index = params.index ?? (await this.probeIndex(params.size))
		// Computing the duration of a file without an index, absent the header's own, reads all of it: a raw
		// audio stream's is estimated from its first frames instead, and 0 leaves the MediaSource duration open.
		const duration =
			(await this.input.getDurationFromMetadata()) ??
			(scanning ? ((await estimatedStreamDuration(this.cache, format)) ?? 0) : await this.input.computeDuration())

		this.seekScansFile = matroska && index === "none"
		this.duration = duration

		if (matroska) {
			await this.openTextTap(params.size)
		}

		return {
			duration,
			bitrate: duration > 0 ? (params.size * 8) / duration : 0,
			index,
			// Audio-only formats without an index start far positions by scanning too, unclamped: their frames are
			// small and read in order.
			seekScansFile: this.seekScansFile || (scanning && !matroska),
			hasVideoTrack: video !== null,
			video: video === null ? null : await this.openVideo(video),
			audio: await Promise.all(audio.map(track => this.openAudio(track)))
		}
	}

	// A bare AC-3, E-AC-3 or DTS stream: one audio track, always re-encoded.
	private openRaw(raw: { info: RawStreamInfo; header: Speaker[] | null }, size: number): RemuxMediaInfo {
		const { info } = raw

		this.audio.set(RAW_TRACK_ID, { kind: "raw", info })
		this.duration = info.duration
		this.layouts.set(RAW_TRACK_ID, Promise.resolve(raw.header))

		return {
			duration: info.duration,
			bitrate: (size * 8) / info.duration,
			index: null,
			seekScansFile: false,
			hasVideoTrack: false,
			video: null,
			audio: [
				{
					id: RAW_TRACK_ID,
					codec: info.codec,
					copyCodec: null,
					channels: info.channels,
					sampleRate: info.sampleRate,
					language: "und",
					name: null,
					isDefault: true
				}
			]
		}
	}

	private async openVideo(track: InputVideoTrack): Promise<RemuxVideoInfo | null> {
		const [codec, config, rotation, width, height] = await Promise.all([
			track.getCodec(),
			track.getDecoderConfig(),
			track.getRotation(),
			track.getDisplayWidth(),
			track.getDisplayHeight()
		])

		if (codec === null || config === null) {
			return null
		}

		this.video = {
			track,
			codec,
			config,
			rotation,
			idrOnly: this.idrOnlyStart && codec === "hevc" ? { lengthSize: hevcLengthSize(bytesOf(config.description)) } : null
		}

		return { id: track.id, codec, mime: `video/mp4; codecs="${outputVideoCodecString(codec, config)}"`, width, height }
	}

	private async openAudio(track: InputAudioTrack): Promise<RemuxAudioInfo> {
		const [codec, config, channels, sampleRate, language, name, disposition] = await Promise.all([
			track.getCodec(),
			track.getDecoderConfig(),
			track.getNumberOfChannels(),
			track.getSampleRate(),
			track.getLanguageCode(),
			track.getName(),
			track.getDisposition()
		])

		// A codec mediabunny does not know (or TrueHD) may be one FFmpeg decodes, which the container walk names.
		const ffmpeg = isFfmpegReaderAudio(codec) ? ((await this.probedCodecs()).get(track.id) ?? null) : null

		this.audio.set(track.id, { kind: "track", track, codec, ffmpeg })

		return {
			id: track.id,
			codec: codec ?? ffmpeg?.codec ?? null,
			copyCodec: isCopyableAudio(codec) && config !== null ? config.codec : null,
			channels,
			sampleRate,
			language,
			name,
			isDefault: disposition.default
		}
	}

	private probed: ReturnType<typeof probedCodecs> | null = null

	private probedCodecs(): ReturnType<typeof probedCodecs> {
		this.probed ??= probedCodecs(this.cache)

		return this.probed
	}

	// Restarts both tracks from the key packet at or before `time`; audio starts where video does. Audio alone
	// starts at the packet covering `time`.
	public async seek(params: RemuxSeekParams): Promise<RemuxSeekResult> {
		const closing = [this.detach("video"), this.detach("audio")]

		// Downloads for positions the old pumps were heading to are no longer wanted.
		this.cache.abort()

		try {
			if (!params.video) {
				if (params.audio === null) {
					throw new Error("nothing to play: no video and no audio track")
				}

				return {
					video: null,
					audio: await this.startAudio({
						generation: params.generation,
						time: params.time,
						horizon: params.horizon,
						...params.audio
					})
				}
			}

			const video = await this.startVideo(params)
			const audio =
				params.audio === null
					? null
					: await this.startAudio({
							generation: params.generation,
							time: video.keyTime,
							horizon: params.horizon,
							...params.audio
						})

			return { video, audio }
		} finally {
			await Promise.all(closing.map(close => (close === null ? Promise.resolve() : close())))
		}
	}

	// Restarts audio alone (a track switch); video keeps playing from what it has.
	public async switchAudio(params: RemuxAudioStartParams): Promise<RemuxAudioStart> {
		const closing = this.detach("audio")

		try {
			return await this.startAudio(params)
		} finally {
			await closing?.()
		}
	}

	public setHorizon(kind: TrackKind, generation: number, horizon: number): void {
		const run = this.runs.get(kind)

		// With video playing, audio's horizon is the video pump's position (followVideo).
		if (run?.generation === generation && (kind === "video" || !this.runs.has("video"))) {
			run.gate.setHorizon(horizon)
		}
	}

	public snapshotStats(): RemuxStats {
		const cache = this.cache.stats

		return {
			...this.stats,
			blockReads: cache.blockReads,
			bytesRead: cache.bytesRead,
			rangeReads: cache.rangeReads,
			readAheadBlocks: cache.readAheadBlocks
		}
	}

	// Stops the audio pump; video plays on without it.
	public async stopAudio(): Promise<void> {
		this.audioEpoch++
		await this.cancel("audio")
	}

	public async close(): Promise<void> {
		// Downloads first: a pump waiting on a read from a dead range port would otherwise hold the close.
		this.cache.abort()

		const closing = [this.detach("video"), this.detach("audio")].map(close => (close === null ? Promise.resolve() : close()))

		this.audioEpoch++
		await Promise.race([Promise.all(closing), new Promise(resolve => setTimeout(resolve, CLOSE_TIMEOUT_MS))])
		this.tap?.close()
		this.tap = null
		this.source.close()
	}

	// The text tracks and the timestamp scale, from the head the demuxer has just read (served by the block cache).
	private async openTextTap(size: number): Promise<void> {
		try {
			const source = new BlockSource(size, (start, end) => Promise.resolve(this.cache.read(start, end)), { maxBlockReads: 4 })
			const parsed = await walkContainer(source, "card")
			const tracks: TextTapTrack[] = []

			for (const track of parsed?.tracks ?? []) {
				if (track.kind === "subtitle" && track.enabled && isTapTextCodec(track.sub.codecId)) {
					tracks.push({ number: track.sub.id, codecId: track.sub.codecId, compression: track.frames ?? null })
				}
			}

			if (parsed === null || tracks.length === 0) {
				return
			}

			const tap = new TextTap({
				tracks,
				timestampScale: parsed.timestampScale ?? 1_000_000,
				emit: cues => {
					this.emit({ type: "textCues", cues })
				}
			})

			this.tap = tap
			this.cache.forEachResident((index, bytes) => {
				tap.addBlock(index, bytes)
			})
		} catch {
			// No subtitles from the file; playback goes on.
		}
	}

	private async probeIndex(size: number): Promise<RemuxMediaInfo["index"]> {
		// The demuxer has just read the head; these reads are served from the block cache.
		const source = new BlockSource(size, (start, end) => Promise.resolve(this.cache.read(start, end)))

		try {
			return (await probeVideo(source, "card"))?.index ?? null
		} catch {
			return null
		}
	}

	private followVideo(timestamp: number): void {
		this.videoReadUntil = Math.max(this.videoReadUntil, timestamp)
		this.runs.get("audio")?.gate.setHorizon(this.videoReadUntil + AUDIO_LEAD_SECONDS)
	}

	private audioHorizon(requested: number): number {
		return this.runs.has("video") ? this.videoReadUntil + AUDIO_LEAD_SECONDS : requested
	}

	private async cancel(kind: TrackKind): Promise<void> {
		await this.detach(kind)?.()
	}

	// Stops a kind's pump at once and hands back its teardown. A restart runs that only once the new pump
	// has started, so a decoder shared through a refcounted codec worker is never torn down in between.
	private detach(kind: TrackKind): (() => Promise<void>) | null {
		const run = this.runs.get(kind)

		if (run === undefined) {
			return null
		}

		if (kind === "video") {
			this.videoReadUntil = Number.NEGATIVE_INFINITY
		} else {
			this.audioEpoch++
		}

		this.runs.delete(kind)
		run.gate.cancel()

		return async () => {
			await run.close()
			await run.done.catch(() => undefined)
		}
	}

	private async startVideo(params: RemuxStartParams): Promise<RemuxVideoStart> {
		const video = this.video

		if (video === null) {
			throw new Error("no playable video track")
		}

		const { time, clamped } = this.seekScansFile
			? seekReach({ time: params.time, scannedUntil: this.scannedUntil, size: this.size, duration: this.duration })
			: { time: params.time, clamped: false }
		const sink = new EncodedPacketSink(video.track)
		// The window the caller asked for, moved along with a clamped start.
		const gate = new PumpGate(params.horizon - params.time + time)
		const output = new FragmentedTrackOutput({
			track: { kind: "video", codec: video.codec, decoderConfig: video.config, rotation: video.rotation },
			gate,
			maxFragmentBytes: this.maxFragmentBytes.video,
			onSegment: bytes => {
				this.segment("video", params.generation, bytes)
			}
		})
		let keyTime = time
		const started = Promise.withResolvers<number>()
		const reader: PumpReader<EncodedPacket> = {
			// Verified: a container's key flag can be wrong, and a pump started on a delta packet decodes garbage.
			first: async at => {
				const key = await this.startKey(sink, at, video, gate)

				if (key !== null) {
					this.keys.add(key.timestamp)
				}

				this.followVideo(key?.timestamp ?? Number.POSITIVE_INFINITY)

				return key
			},
			next: async packet => {
				const next = await surviveAbort(() => sink.getNextPacket(packet), gate)

				if (next !== null) {
					this.scannedUntil = Math.max(this.scannedUntil, next.timestamp)

					if (next.type === "key") {
						this.keys.add(next.timestamp)
					}
				}

				this.followVideo(next?.timestamp ?? Number.POSITIVE_INFINITY)

				return next
			}
		}
		const writer: PumpWriter<EncodedPacket> = {
			write: packet => output.write(packet),
			end: () => output.end()
		}
		const done = runPump(reader, writer, gate, time, {
			floor: Number.NEGATIVE_INFINITY,
			onStart: startTimestamp => {
				keyTime = startTimestamp
				started.resolve(startTimestamp)
			}
		})
			.then(result => {
				if (result.type === "ended") {
					started.resolve(keyTime)
					this.ended("video", params.generation)
				} else {
					// Cancelled before it started: whoever awaits the start learns it was replaced.
					started.reject(new SupersededError())
				}
			})
			.catch((error: unknown) => {
				started.reject(gate.isCancelled() ? new SupersededError() : error)
				this.failed("video", params.generation, gate, error)
			})

		started.promise.catch(() => undefined)
		this.runs.set("video", { generation: params.generation, gate, done, close: () => output.cancel() })
		await started.promise

		return { keyTime, clamped }
	}

	// The key packet playback of `video` from `at` starts with: the one at or before it (for a file without
	// an index, one already seen), moved back to an IDR picture where only those can start.
	private async startKey(sink: EncodedPacketSink, at: number, video: VideoSource, gate: PumpGate): Promise<EncodedPacket | null> {
		const idrOnly = video.idrOnly
		const last = this.lastIdr

		if (idrOnly !== null && last?.at === at) {
			const idr = await surviveAbort(() => sink.getKeyPacket(last.timestamp, { verifyKeyPackets: true }), gate)

			if (idr?.timestamp === last.timestamp && hevcKeyIsIdr(idr.data, idrOnly.lengthSize)) {
				return idr
			}
		}

		const known = this.seekScansFile ? this.keys.atOrBefore(at) : null
		const found = await surviveAbort(
			async () =>
				(await sink.getKeyPacket(known ?? at, { verifyKeyPackets: true })) ??
				(await sink.getFirstKeyPacket({ verifyKeyPackets: true })),
			gate
		)

		if (found === null || idrOnly === null) {
			return found
		}

		const idr = await this.idrAtOrBefore(sink, found, at, idrOnly, gate)

		this.lastIdr = { at, timestamp: idr.timestamp }

		return idr
	}

	// Whether video can start at `time` without disturbing what plays now: false only where starts must be
	// IDR pictures and none lies within reach. Reads only key packets, through the block cache.
	public async canStartAt(time: number): Promise<boolean> {
		const video = this.video

		if (video === null || !this.idrOnlyStart) {
			return true
		}

		try {
			await this.startKey(new EncodedPacketSink(video.track), time, video, new PumpGate(0))

			return true
		} catch (error) {
			if (error instanceof IdrUnreachableError) {
				return false
			}

			throw error
		}
	}

	// The IDR picture playback from `at` can start with: `key` itself, or one of the key packets before it
	// within reach (idrReachSeconds, IDR_REACH_KEYS); each looked at costs one read where it sits.
	private async idrAtOrBefore(
		sink: EncodedPacketSink,
		key: EncodedPacket,
		at: number,
		idrOnly: { lengthSize: number | null },
		gate: PumpGate
	): Promise<EncodedPacket> {
		const reach = idrReachSeconds(this.duration > 0 ? (this.size * 8) / this.duration : 0)
		let candidate = key

		for (let looked = 1; !hevcKeyIsIdr(candidate.data, idrOnly.lengthSize); looked++) {
			if (looked >= IDR_REACH_KEYS || at - candidate.timestamp > reach) {
				throw new IdrUnreachableError(at)
			}

			const before = candidate.timestamp
			const previous = await surviveAbort(() => sink.getKeyPacket(before - KEY_STEP_SECONDS, { verifyKeyPackets: true }), gate)

			if (previous === null || previous.timestamp >= before || at - previous.timestamp > reach) {
				throw new IdrUnreachableError(at)
			}

			candidate = previous
		}

		return candidate
	}

	private async startAudio(params: RemuxAudioStartParams): Promise<RemuxAudioStart> {
		const source = this.audio.get(params.trackId)

		if (source === undefined || params.mode === "none") {
			throw new Error("no such audio track")
		}

		const epoch = ++this.audioEpoch
		// Every await below can let a newer start or a stop in; this one then leaves without a trace.
		const current = () => {
			if (epoch !== this.audioEpoch) {
				throw new SupersededError()
			}
		}
		const gate = new PumpGate(this.audioHorizon(params.horizon))
		const onSegment = (bytes: Uint8Array<ArrayBuffer>) => {
			this.segment("audio", params.generation, bytes)
		}
		const started = Promise.withResolvers<number>()
		let startTime = params.time
		const onStart = (startTimestamp: number) => {
			startTime = startTimestamp
			started.resolve(startTimestamp)
		}
		let mime: string
		let done: Promise<PumpResult>
		let close: () => Promise<void>

		if (params.mode === "copy") {
			if (source.kind !== "track") {
				throw new Error("audio track cannot be copied")
			}

			const { track, codec } = source
			const config = await track.getDecoderConfig()

			current()

			if (config === null || !isCopyableAudio(codec)) {
				throw new Error("audio track cannot be copied")
			}

			const sink = new EncodedPacketSink(track)
			const output = new FragmentedTrackOutput({
				track: { kind: "audio", codec, decoderConfig: config },
				gate,
				maxFragmentBytes: this.maxFragmentBytes.audio,
				onSegment
			})

			mime = `audio/mp4; codecs="${copyCodecString(config.codec, params.copyCodec)}"`
			close = () => output.cancel()
			done = runPump(
				{
					first: at => surviveAbort(async () => (await sink.getPacket(at)) ?? (await sink.getFirstPacket()), gate),
					next: packet => surviveAbort(() => sink.getNextPacket(packet), gate)
				},
				{ write: packet => output.write(packet), end: () => output.end() },
				gate,
				params.time,
				{ floor: 0, onStart }
			)
		} else {
			const decode = this.decodedReader(source, gate)

			if (decode === null) {
				throw new Error("audio track cannot be decoded")
			}

			const target = await this.pickTarget()

			current()

			if (target === null) {
				throw new Error("no audio encoder for this browser")
			}

			const header =
				source.kind === "raw"
					? await (this.layouts.get(RAW_TRACK_ID) ?? Promise.resolve(null))
					: await this.headerLayout(source.track, source.codec, params.time)

			current()

			const output = new FragmentedTrackOutput({
				track: { kind: "audio", codec: target.target, decoderConfig: null },
				gate,
				maxFragmentBytes: this.maxFragmentBytes.audio,
				onSegment
			})
			const writer = new TranscodeWriter({
				target,
				output,
				stats: this.stats,
				layout: (channels, mask) => layoutFor(header, channels, mask)
			})
			const reader = decode

			mime = `audio/mp4; codecs="${target.codec}"`
			close = async () => {
				writer.close()
				await reader.close()
				await output.cancel()
			}
			done = runPump(reader, writer, gate, params.time, {
				floor: 0,
				onStart,
				discard: item => {
					item.sample.close()
				}
			}).finally(() => {
				writer.close()
			})
		}

		const run: Run = {
			generation: params.generation,
			gate,
			close,
			done: done
				.then(result => {
					if (result.type === "ended") {
						started.resolve(startTime)
						this.ended("audio", params.generation)
					} else {
						started.reject(new SupersededError())
					}
				})
				.catch((error: unknown) => {
					started.reject(gate.isCancelled() ? new SupersededError() : error)
					this.failed("audio", params.generation, gate, error)
				})
		}

		started.promise.catch(() => undefined)
		// No await since the epoch check: nothing newer can have registered a run meanwhile, but an older
		// one left behind is torn down rather than overwritten.
		void this.detach("audio")?.()
		this.audioEpoch = epoch
		this.runs.set("audio", run)
		// The video pump moved on while the decoder and encoder were being set up.
		gate.setHorizon(this.audioHorizon(params.horizon))
		await started.promise

		return { startTime, mime }
	}

	// Decoded samples of `source`: mediabunny's decoders (FFmpeg's registered among them), or FFmpeg's directly for
	// a codec mediabunny does not know and for a bare stream. Null when nothing decodes it.
	private decodedReader(source: AudioSource, gate: PumpGate): SampleReader | null {
		if (source.kind === "raw") {
			return ffmpegSampleReader({ codec: source.info.codec, packets: rawPackets(this.cache, source.info), stats: this.stats })
		}

		if (source.ffmpeg !== null) {
			return ffmpegSampleReader({
				codec: source.ffmpeg.codec,
				...(source.ffmpeg.extradata === undefined ? {} : { extradata: source.ffmpeg.extradata }),
				packets: containerPackets(source.track),
				stats: this.stats
			})
		}

		return isTranscodableAudio(source.codec) ? sampleReader(source.track, this.stats, () => gate.isCancelled()) : null
	}

	// The speakers an AC-3/E-AC-3/DTS track's frames declare, read from the packet playback starts at
	// (already in the block cache for the decode that follows); null for other codecs.
	private headerLayout(track: InputAudioTrack, codec: AudioCodec | null, time: number): Promise<Speaker[] | null> {
		const parse = codec === "ac3" || codec === "eac3" ? ac3Layout : codec === "dts" ? dtsLayout : null

		if (parse === null) {
			return Promise.resolve(null)
		}

		let layout = this.layouts.get(track.id)

		if (layout === undefined) {
			const sink = new EncodedPacketSink(track)

			layout = (async () => {
				const packet = (await sink.getPacket(time)) ?? (await sink.getFirstPacket())

				return packet === null ? null : parse(packet.data)
			})()
			// A failed read is not remembered: the next start reads again.
			layout.catch(() => {
				this.layouts.delete(track.id)
			})
			this.layouts.set(track.id, layout)
		}

		return layout.catch(() => null)
	}

	private pickTarget(): Promise<EncoderTarget | null> {
		this.encoderTarget ??= pickEncoderTarget(this.transcodeTargets, async codec => {
			const { supported } = await AudioEncoder.isConfigSupported({
				codec,
				sampleRate: TRANSCODE_SAMPLE_RATE,
				numberOfChannels: TRANSCODE_CHANNELS,
				bitrate: TRANSCODE_BITRATE
			})

			return supported === true
		})

		return this.encoderTarget
	}

	private segment(kind: TrackKind, generation: number, bytes: Uint8Array<ArrayBuffer>): void {
		if (this.runs.get(kind)?.generation !== generation) {
			return
		}

		this.stats.segmentsOut++
		this.stats.bytesOut += bytes.length
		this.emit({ type: "segment", kind, generation, bytes, init: isInitSegment(bytes) })
	}

	private ended(kind: TrackKind, generation: number): void {
		if (this.runs.get(kind)?.generation === generation) {
			this.emit({ type: "ended", kind, generation })
		}
	}

	private failed(kind: TrackKind, generation: number, gate: PumpGate, error: unknown): void {
		// A cancelled pump's reads were aborted on purpose.
		if (gate.isCancelled() || this.runs.get(kind)?.generation !== generation) {
			return
		}

		// The start that needed it rejects with it, which is where the page learns of it.
		if (error instanceof IdrUnreachableError) {
			void this.cancel(kind)

			return
		}

		this.emit({
			type: "error",
			kind,
			generation,
			message: errorMessage(error),
			fragmentTooLarge: error instanceof FragmentTooLargeError,
			sourceLost: error instanceof SourceReadError
		})
		// Whatever the muxer still holds (up to a whole oversized fragment) is freed now, not at close.
		void this.cancel(kind)
	}
}

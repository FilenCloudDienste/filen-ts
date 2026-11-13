import {
	AudioSampleSink,
	AudioSampleSource,
	EncodedAudioPacketSource,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	MovOutputFormat,
	Mp4OutputFormat,
	Output,
	Quality,
	VideoSampleSink,
	VideoSampleSource,
	type AudioSample,
	type Input,
	type InputAudioTrack,
	type InputVideoTrack,
	type Target
} from "mediabunny"
import type { EncodeCapabilities } from "@/lib/media/playback/capabilities.logic"
import { HEVC_MAIN10_CODEC_STRING } from "@/lib/media/playback/capabilities.logic"
import {
	aacBitrate,
	audioNeedsTranscode,
	exportBlockers,
	IOS_GOP_BYTE_CAP,
	keptAudioTracks,
	outputGeometry,
	planExport,
	plannedRanges,
	rangesDuration,
	transcodeBitrate,
	transcodeFrameRate,
	transcodeVideoCodec,
	type PlanContext
} from "@/features/preview/videoEdit/lib/plan"
import type { ExportPlan, TimeRange, VideoEditRecipe, VideoSourceInfo } from "@/features/preview/videoEdit/types"
import { RangeAudio, transcodeAudio, type TimeStretchLike } from "@/features/preview/videoEdit/worker/audio"
import { copyAudio, copyBounds, copyVideo } from "@/features/preview/videoEdit/worker/copy"
import { ExportCancelledError, ExportRefusedError } from "@/features/preview/videoEdit/worker/errors"
import { PROGRESS_INTERVAL_MS } from "@/features/preview/videoEdit/worker/exportApi"
import { InterleaveGate } from "@/features/preview/videoEdit/worker/gate"
import { editedTags } from "@/features/preview/videoEdit/worker/metadata"
import {
	createFrameStage,
	frameStageKind,
	transcodeVideo,
	type DecodedFrame,
	type FramePipelineLike
} from "@/features/preview/videoEdit/worker/transcode"

// One export: the plan for the recipe, a fragmented MP4/MOV output on `target`, and the tracks pumped into it side by
// side. Nothing here knows where the bytes go; export.worker.ts wires the source port, the save port and the GPU pass.

// How far (output seconds) one track may run ahead of the slowest: bounds what the muxer holds for interleaving.
const INTERLEAVE_SLACK_SECONDS = 1

// The output's key frame interval on the transcode path (seeking, and the size of one fragment in memory).
const KEY_FRAME_INTERVAL_SECONDS = 2

// AAC sample rates kept as they are; any other is resampled to 48 kHz by the encoder's transform.
const KEPT_SAMPLE_RATES: ReadonlySet<number> = new Set([44_100, 48_000])

export interface EngineDeps {
	// The GPU pass (gl/pipeline.ts), made only when the transcode needs it, for the source it reads.
	createPipeline: (source: VideoSourceInfo) => FramePipelineLike
	// The pitch-keeping time stretch (audio/timeStretch.ts).
	createTimeStretch: (sampleRate: number, channels: number, speed: number) => TimeStretchLike
	// Decoded audio for a track mediabunny cannot decode (a codec only FFmpeg reads, such as TrueHD or ALAC in
	// Matroska); null when nothing can.
	exoticAudio?: (track: InputAudioTrack, range: TimeRange) => Promise<AsyncIterable<AudioSample> | null>
	ios: boolean
}

export interface RunExportParams {
	input: Input
	info: VideoSourceInfo
	recipe: VideoEditRecipe
	caps: EncodeCapabilities
	context: PlanContext
	target: Target
	signal: AbortSignal
	fallbackCreationTime: number | null
	deps: EngineDeps
	onProgress?: (outputSeconds: number, outputDuration: number) => void
}

export interface ExportSummary {
	plan: ExportPlan
	outputDuration: number
}

type Pump = (signal: AbortSignal) => Promise<unknown>

interface TrackSetup {
	lane: string
	pump: Pump
}

function videoFrames(track: InputVideoTrack): (range: TimeRange) => AsyncIterable<DecodedFrame> {
	const sink = new VideoSampleSink(track, { hardwareAcceleration: "no-preference" })

	return async function* (range) {
		for await (const sample of sink.samples(range.start, range.end)) {
			yield {
				timestamp: sample.timestamp,
				duration: sample.duration,
				take: () => {
					try {
						return sample.toVideoFrame()
					} finally {
						sample.close()
					}
				},
				close: () => {
					sample.close()
				}
			}
		}
	}
}

async function audioDecoder(track: InputAudioTrack, deps: EngineDeps): Promise<((range: TimeRange) => AsyncIterable<AudioSample>) | null> {
	if ((await track.getCodec()) !== null && (await track.canDecode())) {
		const sink = new AudioSampleSink(track)

		return range => sink.samples(range.start, range.end)
	}

	const exotic = deps.exoticAudio

	if (exotic === undefined || (await exotic(track, { start: 0, end: 0 })) === null) {
		return null
	}

	return async function* (range) {
		const samples = await exotic(track, range)

		if (samples !== null) {
			yield* samples
		}
	}
}

export async function runExport(params: RunExportParams): Promise<ExportSummary> {
	const { input, info, recipe, caps, deps, signal } = params
	const context = { ...params.context, ios: deps.ios }
	const plan = planExport(recipe, info, caps, context)
	const blockers = exportBlockers(recipe, info, caps, context)

	if (blockers.length > 0) {
		throw new ExportRefusedError("unavailable", `unavailable: ${blockers.join(", ")}`)
	}

	const video = await input.getPrimaryVideoTrack()

	if (video === null) {
		// Audio-only files are not edited (the editor shows video): refused with a reason, never exported as silence.
		throw new ExportRefusedError("noVideo", "the file has no video track (audio-only files are not edited)")
	}

	const videoCodec = await video.getCodec()

	if (videoCodec === null) {
		throw new ExportRefusedError("codec", "the video codec is not known")
	}

	const keptNumbers = keptAudioTracks(recipe, info)
	const audioTracks = (await input.getAudioTracks()).filter(track => keptNumbers.includes(track.number))
	const geometry = outputGeometry(recipe, info)
	const copying = plan.mode === "copy"
	const videoSink = new EncodedPacketSink(video)
	const ranges = plannedRanges(recipe, info, plan.mode)
	const bounds = copying ? await copyBounds(videoSink, ranges) : ranges

	if (bounds.length === 0) {
		throw new ExportRefusedError("noVideo", "nothing of the video is kept")
	}

	const outputDuration = rangesDuration(bounds) / recipe.speed
	const formatOptions = { fastStart: "fragmented", expectedDuration: outputDuration } as const
	const output = new Output({
		format: plan.container === "mov" ? new MovOutputFormat(formatOptions) : new Mp4OutputFormat(formatOptions),
		target: params.target
	})
	const tracks: TrackSetup[] = []
	const gate = new InterleaveGate(INTERLEAVE_SLACK_SECONDS)
	let pipeline: FramePipelineLike | null = null

	try {
		if (copying) {
			const decoderConfig = await video.getDecoderConfig()

			if (decoderConfig === null) {
				throw new ExportRefusedError("codec", "the video has no decoder configuration to copy")
			}

			const source = new EncodedVideoPacketSource(videoCodec)

			output.addVideoTrack(source, { rotation: geometry.rotation })
			tracks.push({
				lane: "video",
				pump: pumpSignal =>
					copyVideo({
						sink: videoSink,
						bounds,
						speed: recipe.speed,
						output: source,
						decoderConfig,
						gate,
						lane: "video",
						signal: pumpSignal,
						gopByteCap: deps.ios ? IOS_GOP_BYTE_CAP : null
					})
			})
		} else {
			const codec = transcodeVideoCodec(caps, plan.hdr)

			if (codec === null) {
				throw new ExportRefusedError("unavailable", "no video encoder")
			}

			const kind = frameStageKind({ recipe, geometry, hdr: plan.hdr })

			pipeline = kind === "gpu" ? deps.createPipeline(info) : null

			const stage = createFrameStage({ kind, recipe, geometry, hdr: plan.hdr, pipeline })
			const frameRate = transcodeFrameRate(info, recipe.speed)
			const source = new VideoSampleSource({
				codec,
				quality: new Quality({
					bitrate: transcodeBitrate({
						width: geometry.width,
						height: geometry.height,
						frameRate,
						quality: recipe.output.quality,
						codec,
						sourceVideoBitrate: info.duration > 0 ? (info.bytes * 8) / info.duration : null,
						sourcePixels: info.width * info.height
					})
				}),
				keyFrameInterval: KEY_FRAME_INTERVAL_SECONDS,
				hardwareAcceleration: "no-preference",
				...(plan.hdr === "hevc10" ? { fullCodecString: HEVC_MAIN10_CODEC_STRING } : {})
			})

			output.addVideoTrack(source, { rotation: kind === "gpu" ? 0 : geometry.rotation })

			const decode = videoFrames(video)

			tracks.push({
				lane: "video",
				pump: pumpSignal =>
					transcodeVideo({
						decode,
						ranges: bounds,
						speed: recipe.speed,
						maxFrameRate: frameRate,
						stage,
						output: source,
						gate,
						lane: "video",
						signal: pumpSignal
					})
			})
		}

		for (const track of audioTracks) {
			const lane = `audio${String(track.number)}`
			const codec = await track.getCodec()
			const languageCode = await track.getLanguageCode()
			const metadata = languageCode === "und" ? {} : { languageCode }

			// Audio packets are all key packets: a track left as it is is copied on either path, cut to the video's bounds.
			if (codec !== null && !audioNeedsTranscode(recipe, codec)) {
				const decoderConfig = await track.getDecoderConfig()

				if (decoderConfig === null) {
					throw new ExportRefusedError("codec", `audio track ${String(track.number)} has no decoder configuration`)
				}

				const source = new EncodedAudioPacketSource(codec)
				const sink = new EncodedPacketSink(track)

				output.addAudioTrack(source, metadata)
				tracks.push({
					lane,
					pump: pumpSignal => copyAudio({ sink, bounds, output: source, decoderConfig, gate, lane, signal: pumpSignal })
				})

				continue
			}

			const decode = await audioDecoder(track, deps)

			if (decode === null) {
				throw new ExportRefusedError("codec", `audio track ${String(track.number)} cannot be decoded`)
			}

			const sampleRate = await track.getSampleRate()
			const channels = await track.getNumberOfChannels()
			const outputChannels = Math.min(Math.max(channels, 1), 2)
			const outputRate = KEPT_SAMPLE_RATES.has(sampleRate) ? sampleRate : 48_000
			const source = new AudioSampleSource({
				codec: "aac",
				quality: new Quality({ bitrate: aacBitrate(outputChannels) }),
				transform: { numberOfChannels: outputChannels, sampleRate: outputRate }
			})
			const audio = new RangeAudio({
				sampleRate,
				channels,
				gainDb: recipe.audio.gainDb,
				speed: recipe.speed,
				createStretch: () => deps.createTimeStretch(sampleRate, channels, recipe.speed)
			})

			output.addAudioTrack(source, metadata)
			tracks.push({
				lane,
				pump: pumpSignal => transcodeAudio({ decode, bounds, audio, sampleRate, output: source, gate, lane, signal: pumpSignal })
			})
		}

		output.setMetadataTags(
			editedTags(await input.getMetadataTags(), {
				removeLocation: recipe.removeLocation,
				fallbackCreationTime: params.fallbackCreationTime
			})
		)
	} catch (error) {
		pipeline?.dispose()

		throw error
	}

	for (const track of tracks) {
		gate.addLane(track.lane)
	}

	// The first pump to fail stops the others (they would otherwise wait on its lane).
	const stop = new AbortController()
	const pumpSignal = AbortSignal.any([signal, stop.signal])
	const progress =
		params.onProgress === undefined
			? null
			: setInterval(() => {
					params.onProgress?.(Math.min(outputDuration, gate.progress), outputDuration)
				}, PROGRESS_INTERVAL_MS)

	try {
		await output.start()

		const results = await Promise.allSettled(
			tracks.map(track =>
				track.pump(pumpSignal).catch((error: unknown) => {
					stop.abort()
					gate.stop()

					throw error
				})
			)
		)
		const failure = firstFailure(results)

		if (failure !== undefined) {
			throw failure
		}

		if (signal.aborted) {
			throw new ExportCancelledError()
		}

		await output.finalize()
		params.onProgress?.(outputDuration, outputDuration)
	} catch (error) {
		gate.stop()
		await output.cancel().catch(() => undefined)

		throw signal.aborted ? new ExportCancelledError() : error
	} finally {
		if (progress !== null) {
			clearInterval(progress)
		}

		pipeline?.dispose()
	}

	return { plan, outputDuration }
}

// The failure that stopped the export, not the cancellations it caused in the other pumps.
function firstFailure(results: readonly PromiseSettledResult<unknown>[]): Error | undefined {
	let cancelled: Error | undefined

	for (const result of results) {
		if (result.status !== "rejected") {
			continue
		}

		const reason: unknown = result.reason
		const error = reason instanceof Error ? reason : new Error(String(reason))

		if (!(error instanceof ExportCancelledError)) {
			return error
		}

		cancelled ??= error
	}

	return cancelled
}

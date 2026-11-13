/// <reference lib="webworker" />
import * as Comlink from "comlink"
import { EncodedPacketSink, type EncodedPacket, type InputVideoTrack } from "mediabunny"
import { BlockSource, indexedKeyframeTimes, type VideoProbe } from "@filen/shared/videos"
import { openBlockInput, type BlockInput } from "@/lib/media/blockInput"
import { createFramePipeline, type FramePipeline } from "@/features/preview/videoEdit/gl/pipeline"
import { fitWidth } from "@/features/preview/videoEdit/gl/pipeline.logic"
import { outputGeometry, sourceToOutputTime } from "@/features/preview/videoEdit/lib/plan"
import { FRAME_BATCH_MAX_FRAMES } from "@/features/videos/lib/frameBatch.logic"
import { GopDecoder, SupersededError } from "@/features/preview/videoEdit/worker/gopDecoder"
import { WaveformTap } from "@/features/preview/videoEdit/worker/waveform"
import {
	PriorityLock,
	filmstripSize,
	planFilmstrip,
	sourceInfo,
	type DemuxedFacts
} from "@/features/preview/videoEdit/worker/preview.logic"
import type { TimeRange, VideoEditRecipe, VideoSourceAudioTrack, VideoSourceInfo } from "@/features/preview/videoEdit/types"

// The video editor's preview worker: one open source at a time, read through a block cache over the range port the
// page opened. It answers exact frames for the trim handles and the stage (decoded by ONE VideoDecoder kept positioned
// in its GOP, drawn by the same GPU pass the export uses), the filmstrip (keyframes through that same decoder, so
// there is never a second one, which iOS cannot afford, and its reads feed the waveform), and the waveform (peaks from
// blocks already fetched, never a read of its own). client.ts owns its lifecycle.

export interface PreviewOpenParams {
	port: MessagePort
	size: number
	probe: VideoProbe | null
}

export interface FilmstripFrame {
	time: number
	bitmap: ImageBitmap
}

// The page's callback as the worker holds it: a Comlink proxy, which can be released.
type WaveformCallback = ((peaks: Float32Array) => void | Promise<void>) & Partial<Comlink.ProxyMethods>

// Index reads the keyframe list may make (Cues or an mfra) beyond what the demuxer already read.
const KEYFRAME_INDEX_READS = 16

interface Session {
	block: BlockInput
	info: VideoSourceInfo
	track: InputVideoTrack | null
	decoder: GopDecoder<EncodedPacket> | null
	pipeline: FramePipeline | null
	canvas: OffscreenCanvas | null
	tap: WaveformTap | null
	lock: PriorityLock
	// Bumped by every frame request; a request whose number is no longer current stops.
	frameRequest: number
	filmstrips: Set<number>
	// Waveform subscriptions by id, each with what ends it.
	waveforms: Map<number, () => void>
	suspended: boolean
}

let session: Session | null = null

function current(): Session {
	if (session === null) {
		throw new Error("no video open")
	}

	return session
}

async function keyframeTimes(block: BlockInput, track: InputVideoTrack, probe: VideoProbe | null): Promise<Float64Array> {
	// A fragmented MP4 (mfra) or Matroska (Cues) lists its keyframes in an index; reading them through the demuxer
	// would walk every fragment or cluster of the file.
	if (probe?.index !== "moov") {
		const source = new BlockSource(block.cache.size, (start, end) => Promise.resolve(block.cache.read(start, end)), {
			maxBlockReads: KEYFRAME_INDEX_READS
		})
		const listed = await indexedKeyframeTimes(source).catch(() => null)

		if (listed !== null) {
			return listed
		}

		if (probe !== null) {
			return new Float64Array(0)
		}
	}

	// MP4 sample tables: the demuxer holds them; no packet data is read.
	const sink = new EncodedPacketSink(track)
	const times: number[] = []

	for (
		let packet = await sink.getFirstKeyPacket({ metadataOnly: true });
		packet !== null;
		packet = await sink.getNextKeyPacket(packet, { metadataOnly: true })
	) {
		times.push(packet.timestamp)
	}

	return Float64Array.from(times).sort()
}

async function demuxedFacts(block: BlockInput, probe: VideoProbe | null): Promise<{ facts: DemuxedFacts; track: InputVideoTrack | null }> {
	const { input } = block
	const [track, audioTracks, tracks, format, tags] = await Promise.all([
		input.getPrimaryVideoTrack(),
		input.getAudioTracks(),
		input.getTracks(),
		input.getFormat(),
		input.getMetadataTags().catch(() => undefined)
	])
	const audio: VideoSourceAudioTrack[] = await Promise.all(
		audioTracks.map(async audioTrack => {
			const language = await audioTrack.getLanguageCode()

			return {
				number: audioTrack.number,
				codec: await audioTrack.getCodec(),
				channels: await audioTrack.getNumberOfChannels(),
				language: language === "und" ? null : language
			}
		})
	)
	const hasSubtitleTracks = tracks.some(candidate => candidate.type === "subtitle")

	if (track === null) {
		return {
			track,
			facts: {
				duration: await input.computeDuration().catch(() => 0),
				displayWidth: 0,
				displayHeight: 0,
				rotation: 0,
				frameRate: 0,
				videoCodec: null,
				colorTransfer: null,
				keyframes: new Float64Array(0),
				audio,
				formatName: format.name,
				hasSubtitleTracks,
				metadataRaw: tags?.raw,
				previewable: false
			}
		}
	}

	const [displayWidth, displayHeight, rotation, codec, colorSpace, previewable] = await Promise.all([
		track.getDisplayWidth(),
		track.getDisplayHeight(),
		track.getRotation(),
		track.getCodecParameterString(),
		track.getColorSpace().catch(() => null),
		track.canDecode().catch(() => false)
	])
	const duration = probe?.durationSec ?? (await input.computeDuration().catch(() => 0))
	const frameRate = await track
		.computeFrameRateMetrics()
		.then(metrics => metrics.averageFrameRate)
		.catch(() => 0)

	return {
		track,
		facts: {
			duration,
			displayWidth,
			displayHeight,
			rotation,
			frameRate,
			videoCodec: codec,
			colorTransfer: colorSpace?.transfer ?? null,
			keyframes: await keyframeTimes(block, track, probe),
			audio,
			formatName: format.name,
			hasSubtitleTracks,
			metadataRaw: tags?.raw,
			previewable
		}
	}
}

function ensurePipeline(s: Session): FramePipeline {
	if (s.pipeline === null) {
		s.canvas = new OffscreenCanvas(1, 1)
		s.pipeline = createFramePipeline(s.canvas, {
			sourceRotation: s.info.rotation,
			...(s.info.transfer === "sdr" ? {} : { sourceTransfer: s.info.transfer })
		})
	}

	return s.pipeline
}

async function ensureDecoder(s: Session): Promise<GopDecoder<EncodedPacket>> {
	if (s.suspended) {
		throw new SupersededError()
	}

	if (s.decoder !== null) {
		return s.decoder
	}

	const track = s.track
	const config = track === null || !s.info.previewable ? null : await track.getDecoderConfig()

	if (track === null || config === null) {
		throw new Error("this video cannot be decoded here")
	}

	const sink = new EncodedPacketSink(track)

	s.decoder = new GopDecoder({ ...config, optimizeForLatency: true, hardwareAcceleration: "no-preference" }, sink)

	return s.decoder
}

// A filmstrip still in display orientation: the frame drawn turned by the source's rotation onto a small canvas.
let stillCanvas: OffscreenCanvas | null = null

function still(frame: VideoFrame, s: Session, height: number): ImageBitmap {
	const size = filmstripSize(s.info, height)

	stillCanvas ??= new OffscreenCanvas(size.width, size.height)
	stillCanvas.width = size.width
	stillCanvas.height = size.height

	const context = stillCanvas.getContext("2d")

	if (context === null) {
		throw new Error("no 2D context")
	}

	const turned = s.info.rotation % 180 !== 0
	const drawWidth = turned ? size.height : size.width
	const drawHeight = turned ? size.width : size.height

	context.translate(size.width / 2, size.height / 2)
	context.rotate((s.info.rotation * Math.PI) / 180)
	context.drawImage(frame, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)

	return stillCanvas.transferToImageBitmap()
}

function closeSession(s: Session): void {
	s.filmstrips.clear()

	for (const stop of s.waveforms.values()) {
		stop()
	}

	s.waveforms.clear()
	s.tap?.close()
	s.decoder?.close()
	s.pipeline?.dispose()
	s.block.close()
}

const api = {
	async open(params: PreviewOpenParams): Promise<VideoSourceInfo> {
		if (session !== null) {
			closeSession(session)
			session = null
		}

		let tap: WaveformTap | null = null
		const block = openBlockInput(params.port, params.size, "playback", {
			onBlock: index => {
				tap?.onBlock(index)
			}
		})

		try {
			const { facts, track } = await demuxedFacts(block, params.probe)
			const info = sourceInfo(params.probe, facts, params.size)

			session = {
				block,
				info,
				track,
				decoder: null,
				pipeline: null,
				canvas: null,
				tap: null,
				lock: new PriorityLock(),
				frameRequest: 0,
				filmstrips: new Set(),
				waveforms: new Map(),
				suspended: false
			}

			if (info.audio.length > 0 && info.duration > 0) {
				// Opened while the header blocks the demuxer just read are still resident.
				tap = new WaveformTap({ cache: block.cache, size: params.size, duration: info.duration })
				session.tap = tap
				tap.start()
			}

			return info
		} catch (error) {
			block.close()

			throw error
		}
	},

	// The frame at `time` (source seconds) with the recipe applied, fitted to `maxWidth`. A newer request supersedes
	// this one (it rejects with an AbortError).
	async frameAt(time: number, recipe: VideoEditRecipe, maxWidth: number): Promise<ImageBitmap> {
		const s = current()
		const request = ++s.frameRequest
		const isCurrent = (): boolean => session === s && s.frameRequest === request && !s.suspended
		const release = await s.lock.acquire("interactive")

		try {
			if (!isCurrent()) {
				throw new SupersededError()
			}

			const decoder = await ensureDecoder(s)
			const frame = await decoder.frameAt(time, isCurrent)

			try {
				const out = fitWidth(outputGeometry(recipe, s.info), maxWidth)
				const hdr = s.info.transfer === "sdr" ? null : "toSdr"
				const bitmap = await ensurePipeline(s).renderBitmap(
					frame,
					recipe,
					out.width,
					out.height,
					// A time that was cut shows no text.
					sourceToOutputTime(recipe.keep, recipe.speed, time) ?? Number.NaN,
					hdr
				)

				return Comlink.transfer(bitmap, [bitmap])
			} finally {
				frame.close()
			}
		} finally {
			release()
		}
	},

	// Keyframe stills at the given source times, `height` px high, in display orientation: at most
	// FRAME_BATCH_MAX_FRAMES distinct keyframes per call (the rest are left out; ask again). Yields the decoder to frame
	// requests between stills.
	async filmstrip(id: number, times: readonly number[], height: number): Promise<FilmstripFrame[]> {
		const s = current()
		const keys = s.info.keyframes
		const keyTimes = times.map(time => {
			// The last listed keyframe at or before the time, else the first.
			let low = 0
			let high = keys.length - 1
			let found: number | null = keys.length > 0 ? (keys[0] ?? null) : null

			while (low <= high) {
				const mid = (low + high) >> 1
				const value = keys[mid] ?? 0

				if (value <= time) {
					found = value
					low = mid + 1
				} else {
					high = mid - 1
				}
			}

			return found
		})
		const slots = planFilmstrip(keyTimes, FRAME_BATCH_MAX_FRAMES)
		const out: FilmstripFrame[] = []

		s.filmstrips.add(id)

		try {
			for (const slot of slots) {
				if (!s.filmstrips.has(id) || session !== s || s.suspended) {
					break
				}

				const release = await s.lock.acquire("background")

				try {
					const decoder = await ensureDecoder(s)
					// A hair past the listed time, so float rounding never lands on the keyframe before.
					const frame = await decoder.keyFrameAt(slot.keyTime + 1e-6)

					if (frame === null) {
						continue
					}

					try {
						// One still per keyframe, under the first time that asked for it; the other times it stands for are
						// left out (the caller shows its neighbour).
						out.push({ time: times[slot.positions[0] ?? 0] ?? slot.keyTime, bitmap: still(frame, s, height) })
					} finally {
						frame.close()
					}
				} catch (error) {
					if (error instanceof SupersededError) {
						break
					}

					throw error
				} finally {
					release()
				}
			}
		} catch (error) {
			for (const frame of out) {
				frame.bitmap.close()
			}

			throw error
		} finally {
			s.filmstrips.delete(id)
		}

		return Comlink.transfer(
			out,
			out.map(frame => frame.bitmap)
		)
	},

	cancelFilmstrip(id: number): void {
		session?.filmstrips.delete(id)
	},

	// `onUpdate` is the page's callback (a Comlink proxy), released by unwatchWaveform.
	watchWaveform(id: number, range: TimeRange, columns: number, onUpdate: WaveformCallback): void {
		const s = current()
		const send = (peaks: Float32Array): void => {
			void Promise.resolve(onUpdate(Comlink.transfer(peaks, [peaks.buffer]))).catch(() => undefined)
		}

		s.waveforms.get(id)?.()
		s.waveforms.set(id, () => {
			s.tap?.unsubscribe(id)
			onUpdate[Comlink.releaseProxy]?.()
		})

		if (s.tap === null) {
			send(new Float32Array(Math.max(0, Math.floor(columns))).fill(Number.NaN))

			return
		}

		s.tap.subscribe(id, range, columns, send)
	},

	unwatchWaveform(id: number): void {
		const stop = session?.waveforms.get(id)

		session?.waveforms.delete(id)
		stop?.()
	},

	// Another decoder needs the hardware (an export on iOS): the preview's is closed and frame requests fail until
	// resumeDecoding().
	suspendDecoding(): void {
		if (session !== null) {
			session.suspended = true
			session.decoder?.release()
		}
	},

	resumeDecoding(): void {
		if (session !== null) {
			session.suspended = false
		}
	},

	close(): void {
		if (session !== null) {
			closeSession(session)
			session = null
		}
	}
}

export type PreviewWorkerApi = typeof api

Comlink.expose(api)

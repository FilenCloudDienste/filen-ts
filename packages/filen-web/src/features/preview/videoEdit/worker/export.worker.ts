import * as Comlink from "comlink"
import { savePortWriter } from "@filen/shared/savePort"
import { registerAacEncoder } from "@mediabunny/aac-encoder"
import type { AudioSample, InputAudioTrack } from "mediabunny"
import { openBlockInput, type BlockInput } from "@/lib/media/blockInput"
import type { RemuxStats } from "@/lib/media/remuxTypes"
import { containerPackets, ffmpegSampleReader, probedCodecFor, probedCodecs, type ProbedCodec } from "@/workers/remux/audioInput"
import { createFramePipeline } from "@/features/preview/videoEdit/gl/pipeline"
import { createTimeStretch } from "@/features/preview/videoEdit/audio/timeStretch"
import { planExport, sourceFrame } from "@/features/preview/videoEdit/lib/plan"
import type { TimeRange } from "@/features/preview/videoEdit/types"
import { runExport, type EngineDeps } from "@/features/preview/videoEdit/worker/engine"
import { ExportCancelledError, ExportRefusedError } from "@/features/preview/videoEdit/worker/errors"
import {
	PROGRESS_INTERVAL_MS,
	type ExportWorkerApi,
	type ExportWorkerProgress,
	type ExportWorkerResult,
	type StartExportArgs
} from "@/features/preview/videoEdit/worker/exportApi"
import { appendOnlyTarget } from "@/features/preview/videoEdit/worker/sink"

// The video editor's export worker: reads the original through a range port (the block cache's export profile: long
// runs, a deep read-ahead, little kept behind), writes a fragmented MP4/MOV into a save port that the SDK worker
// uploads from as it reads, and commits the upload only once the muxer finished cleanly. Its own worker, so the
// demuxer's, the codecs' and the GPU pass's memory goes with it when the editor is idle.

// Exports running here, by id, for cancel().
const running = new Map<string, AbortController>()

// The wasm AAC encoder is registered once, only where the browser has none of its own (Firefox, Linux).
let aacRegistered = false

function newStats(): RemuxStats {
	return {
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
}

// Decoded samples of a range of a track only FFmpeg decodes inside its container (TrueHD, ALAC in Matroska).
function exoticAudio(block: BlockInput): NonNullable<EngineDeps["exoticAudio"]> {
	let probed: Promise<Map<number, ProbedCodec>> | null = null

	return async (track: InputAudioTrack, range: TimeRange) => {
		probed ??= probedCodecs(block.cache)

		const known = probedCodecFor(await probed, track.number, await track.getCodec())

		if (known === null) {
			return null
		}

		return (async function* (): AsyncGenerator<AudioSample> {
			if (range.end <= range.start) {
				return
			}

			const reader = ffmpegSampleReader({
				codec: known.codec,
				...(known.extradata === undefined ? {} : { extradata: known.extradata }),
				packets: containerPackets(track),
				stats: newStats()
			})

			try {
				let item = await reader.first(range.start)

				while (item !== null && item.timestamp < range.end) {
					yield item.sample

					item = await reader.next(item)
				}

				item?.sample.close()
			} finally {
				await reader.close()
			}
		})()
	}
}

function failure(error: unknown): ExportWorkerResult {
	if (error instanceof ExportRefusedError) {
		return { status: "error", message: error.message, refusal: error.refusal }
	}

	return { status: "error", message: error instanceof Error ? error.message : String(error), refusal: null }
}

const api: ExportWorkerApi = {
	plan: (recipe, source, caps, context) => planExport(recipe, source, caps, context),
	async startExport(args: StartExportArgs, onProgress: (progress: ExportWorkerProgress) => unknown): Promise<ExportWorkerResult> {
		const controller = new AbortController()
		const writer = savePortWriter(args.output)
		// The latest the engine reported; the heartbeat sends it on, from before the input is read until the upload
		// answered (a slow uplink, or a paused transfer, may take long after the muxer finished).
		const latest: ExportWorkerProgress = { outputSeconds: 0, outputDuration: 0, bytesWritten: 0, phase: "exporting" }
		const beat = (): void => {
			latest.bytesWritten = writer.sent

			void Promise.resolve(onProgress({ ...latest })).catch(() => undefined)
		}
		const heartbeat = setInterval(beat, PROGRESS_INTERVAL_MS)

		beat()

		const block = openBlockInput(args.source, args.size, "export")
		const target = appendOnlyTarget(writer)

		running.set(args.exportId, controller)
		// The upload cancelled or failed on its side: nothing more is read or encoded.
		void writer.aborted.then(() => {
			controller.abort()
		})
		writer.announce()

		if (!args.caps.audio.aac && !aacRegistered) {
			registerAacEncoder()
			aacRegistered = true
		}

		try {
			const summary = await runExport({
				input: block.input,
				info: args.info,
				recipe: args.recipe,
				caps: args.caps,
				context: args.context,
				target: target.target,
				signal: controller.signal,
				fallbackCreationTime: args.fallbackCreationTime,
				deps: {
					// Frames arrive coded (unrotated); an HDR source whose frames do not name their curve is tone-mapped by its own.
					createPipeline: source => {
						const frame = sourceFrame(source)

						return createFramePipeline(new OffscreenCanvas(1, 1), {
							naturalSize: { width: frame.squareWidth, height: frame.squareHeight },
							...(source.transfer === "sdr" ? {} : { sourceTransfer: source.transfer })
						})
					},
					createTimeStretch,
					exoticAudio: exoticAudio(block),
					ios: args.context.ios === true
				},
				onProgress: (outputSeconds, outputDuration) => {
					latest.outputSeconds = outputSeconds
					latest.outputDuration = outputDuration
				}
			})

			// Everything the muxer wrote is sent; only now may the upload finish the file.
			writer.commit()
			latest.phase = "committed"
			beat()

			return (await writer.uploaded)
				? { status: "done", bytes: writer.sent, outputDuration: summary.outputDuration, bounds: summary.bounds }
				: { status: "error", message: "the upload did not finish", refusal: null, cause: "upload" }
		} catch (error) {
			const cancelled = controller.signal.aborted || error instanceof ExportCancelledError

			writer.abort(cancelled ? "cancelled" : "failed")

			return cancelled ? { status: "cancelled" } : failure(error)
		} finally {
			clearInterval(heartbeat)
			running.delete(args.exportId)
			block.close()
			;(onProgress as Partial<Comlink.ProxyMethods>)[Comlink.releaseProxy]?.()
		}
	},
	cancel(exportId) {
		running.get(exportId)?.abort()
	}
}

Comlink.expose(api)

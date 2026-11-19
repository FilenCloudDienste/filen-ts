import * as Comlink from "comlink"
import type { AnyFile } from "@filen/sdk-rs"
import FrameWorker from "@/features/videos/workers/frame.worker.ts?worker"
import type { FrameCaptureParams, FrameCaptureResult, FrameWorkerApi } from "@/features/videos/workers/frame.worker"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"
import { idleResource } from "@/lib/idleResource"
import { recoverIfNewerBuild } from "@/lib/appUpdate"
import { RankedGate } from "@/features/drive/lib/rankedGate"
import { encodeCanvasThumb } from "@/features/drive/lib/thumbGenerators.logic"
import { rangeReads, type RangeReadBudget } from "@/lib/media/rangeReads"
import { onAbort } from "@/lib/abort"
import { SharedWork } from "@/lib/sharedWork"
import { SAMPLE_HEIGHT, SAMPLE_WIDTH, fitInBox, isDark, sampleOf, type Rgb, type Size } from "@/lib/media/framePick.logic"
import type { VideoProbe } from "@filen/shared/videos"
import type { RecordStore } from "@/features/videos/lib/recordStore.logic"
import type { ArtSlotCode } from "@/features/videos/lib/artStore.logic"
import { artBox } from "@/features/videos/lib/artwork.logic"
import { frameHints } from "@/features/videos/lib/records"
import {
	FRAME_DWELL_MS,
	FRAME_FAILURE_LIMIT,
	FRAME_RECIPE_VERSION,
	FrameSessionBudget,
	base64ToBytes,
	bytesToBase64,
	frameEligible,
	isSettledMiss,
	missIsSettled,
	usableKey,
	type FrameHint
} from "@/features/videos/lib/frames.logic"

// Generated frames for artwork, made only where nothing better exists and tightly capped: one at a time,
// after the requester has stayed interested for a moment, never while playback runs, within a session's
// frame and byte budget. A frame made once leaves a hint, so the next one reads only its keyframe.

const FRAME_WORKER_IDLE_MS = 30_000

// A capture that has not answered by now has a stuck decoder or a dead worker; the worker is replaced.
const FRAME_CAPTURE_TIMEOUT_MS = 20_000

export interface FrameTarget {
	uuid: string
	file: AnyFile
	size: number
}

export interface FrameRequest {
	target: FrameTarget
	probe: VideoProbe
	box: Size
	signal?: AbortSignal
	rank?: () => number
}

export interface GeneratedFrame {
	bytes: Uint8Array
	width: number
	height: number
	dominant: Rgb
}

export interface FrameGeneratorDeps {
	// Serves the file's ranges on a fresh port, cancelled through `token`; the returned end is the reader's.
	openPort: (file: AnyFile, token: string) => Promise<MessagePort>
	cancel: (token: string) => void
	capture: (params: FrameCaptureParams) => Promise<FrameCaptureResult>
	hints: RecordStore<FrameHint>
	reads: Pick<RangeReadBudget, "acquire" | "release" | "whenPlaybackIdle">
	sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>
	now: () => number
	// Whether this browser decodes video frames (WebCodecs' VideoDecoder): without it nothing is attempted and no
	// verdict is kept, so a browser that gains it later starts making frames.
	supported: () => boolean
}

// Whether this browser has WebCodecs' VideoDecoder, which the frame worker decodes keyframes with.
function webCodecsVideo(): boolean {
	return typeof VideoDecoder !== "undefined"
}

export class FrameGenerator {
	private readonly deps: FrameGeneratorDeps
	private readonly gate = new RankedGate(1, 0)
	private readonly budget = new FrameSessionBudget()
	private readonly shared = new SharedWork<GeneratedFrame | null>()
	// uuid → captures that failed without a verdict about the file this session.
	private readonly failures = new Map<string, number>()
	private epoch = 0

	public constructor(deps: FrameGeneratorDeps) {
		this.deps = deps
	}

	// Whether the file's hint says no frame can be made (a local read, no capture): a settled miss the artwork loader
	// passes over without waiting for a generation.
	public async settledMiss(uuid: string): Promise<boolean> {
		return isSettledMiss(await this.deps.hints.get(uuid))
	}

	// One frame of the file at `box`, or null: no frame decoding in this browser, not eligible, a known miss, past the file's failure limit,
	// the session's budget spent, dropped once every requester gave up, or a failed download. Requests for
	// the same file and size share one capture.
	public generate(request: FrameRequest): Promise<GeneratedFrame | null> {
		const { target, box } = request

		return this.shared.run(
			`${target.uuid}:${String(box.width)}x${String(box.height)}`,
			{ signal: request.signal, rank: request.rank },
			({ signal, rank }) => this.run(request, signal, rank)
		)
	}

	private async run(request: FrameRequest, signal: AbortSignal, rank: () => number): Promise<GeneratedFrame | null> {
		const { target, probe } = request
		const epoch = this.epoch
		// A function, so each check reads the signal and the epoch anew across the awaits.
		const dropped = (): boolean => signal.aborted || epoch !== this.epoch

		if (!this.deps.supported() || !frameEligible(probe) || (this.failures.get(target.uuid) ?? 0) >= FRAME_FAILURE_LIMIT) {
			return null
		}

		const hint = await this.deps.hints.get(target.uuid)

		if (dropped() || isSettledMiss(hint) || this.budget.readsAvailable() === 0) {
			return null
		}

		try {
			await this.deps.sleep(FRAME_DWELL_MS, signal)
			await this.deps.reads.whenPlaybackIdle(signal)
		} catch {
			return null
		}

		await this.gate.acquire(rank)

		try {
			// Playback may have started while this waited for the gate.
			await this.deps.reads.whenPlaybackIdle(signal).catch(() => undefined)

			if (dropped() || this.budget.readsAvailable() === 0) {
				return null
			}

			await this.deps.reads.acquire(rank)

			try {
				const maxReads = this.budget.readsAvailable()

				return dropped() || maxReads === 0 ? null : await this.capture(request, hint, maxReads, signal, epoch)
			} finally {
				this.deps.reads.release()
			}
		} finally {
			this.gate.release()
		}
	}

	private strike(uuid: string): void {
		this.failures.set(uuid, (this.failures.get(uuid) ?? 0) + 1)
	}

	private async capture(
		request: FrameRequest,
		hint: FrameHint | null,
		maxReads: number,
		signal: AbortSignal,
		epoch: number
	): Promise<GeneratedFrame | null> {
		const { target, probe, box } = request
		const token = crypto.randomUUID()
		const known = usableKey(hint)
		const unsubscribe = onAbort(signal, () => {
			this.deps.cancel(token)
		})

		try {
			const port = await this.deps.openPort(target.file, token)
			const result = await this.deps.capture({
				port,
				size: target.size,
				maxReads,
				known:
					known === null
						? null
						: {
								offset: known.offset,
								size: known.size,
								timeSec: known.timeSec,
								decoder: {
									codec: known.codec,
									codedWidth: known.codedWidth,
									codedHeight: known.codedHeight,
									description: known.description === null ? null : base64ToBytes(known.description)
								}
							},
				par: probe.video?.par ?? 1,
				rotation: probe.video?.rotation ?? 0,
				box
			})

			this.budget.spend(result.reads)

			if (epoch !== this.epoch) {
				return null
			}

			if (result.type === "miss") {
				// A good hint stays when its keyframe failed to decode this time.
				if (missIsSettled(result.reason, maxReads)) {
					this.deps.hints.put(target.uuid, { recipe: FRAME_RECIPE_VERSION, key: null, miss: result.reason, at: this.deps.now() })
				} else {
					this.strike(target.uuid)
				}

				return null
			}

			const { key } = result

			this.deps.hints.put(target.uuid, {
				recipe: FRAME_RECIPE_VERSION,
				key: {
					offset: key.offset,
					size: key.size,
					timeSec: key.timeSec,
					codec: key.decoder.codec,
					codedWidth: key.decoder.codedWidth,
					codedHeight: key.decoder.codedHeight,
					description: key.decoder.description === null ? null : bytesToBase64(key.decoder.description)
				},
				miss: null,
				at: this.deps.now()
			})

			return { bytes: result.bytes, width: result.width, height: result.height, dominant: result.dominant }
		} catch (error) {
			// The served port is released either way; what was read is unknown, so the whole allowance counts.
			this.deps.cancel(token)
			this.budget.spend(maxReads)

			if (!signal.aborted && epoch === this.epoch) {
				log.warn("videos", "frame capture failed", target.uuid, error)
				this.strike(target.uuid)
			}

			return null
		} finally {
			unsubscribe()
		}
	}

	// Logout: forget the session's spending, failures and any hint held in memory.
	public reset(): void {
		this.epoch++
		this.budget.reset()
		this.failures.clear()
		this.deps.hints.reset()
	}
}

interface FrameWorkerResource {
	worker: Worker
	remote: Comlink.Remote<FrameWorkerApi>
}

const frameWorker = idleResource<FrameWorkerResource>(
	() => {
		const worker = new FrameWorker()
		const resource: FrameWorkerResource = { worker, remote: Comlink.wrap<FrameWorkerApi>(worker) }

		worker.addEventListener("error", () => {
			// A deploy that changed this worker removes its old file (appUpdate.ts).
			recoverIfNewerBuild()
			frameWorker.invalidate(resource)
		})

		return resource
	},
	({ worker, remote }) => {
		remote[Comlink.releaseProxy]()
		worker.terminate()
	},
	FRAME_WORKER_IDLE_MS
)

// Logout: the worker's heap held this account's decoded frames.
export function releaseFrameWorker(): void {
	frameWorker.disposeIfIdle()
}

function captureInWorker(params: FrameCaptureParams): Promise<FrameCaptureResult> {
	return frameWorker.use(async resource => {
		let timer: ReturnType<typeof setTimeout> | undefined
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				frameWorker.invalidate(resource)
				reject(new Error("frame capture timed out"))
			}, FRAME_CAPTURE_TIMEOUT_MS)
		})

		try {
			return await Promise.race([resource.remote.capture(Comlink.transfer(params, [params.port])), deadline])
		} finally {
			clearTimeout(timer)
		}
	})
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = (): void => {
			clearTimeout(timer)
			reject(new DOMException("aborted", "AbortError"))
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort)
			resolve()
		}, ms)

		if (signal?.aborted === true) {
			onAbort()

			return
		}

		signal?.addEventListener("abort", onAbort, { once: true })
	})
}

export const frameGenerator = new FrameGenerator({
	openPort: async (file, token) => {
		const { port1, port2 } = new MessageChannel()

		await sdkApi.openRangePort(Comlink.transfer(port1, [port1]), file, token)

		return port2
	},
	cancel: token => {
		void sdkApi.cancelPreviewDownload(token)
	},
	capture: captureInWorker,
	hints: frameHints,
	reads: rangeReads,
	sleep,
	now: () => Date.now(),
	supported: webCodecsVideo
})

// Zero-read capture: the frame a paused or stopped player shows, drawn at the slot's size for Continue
// Watching and episode stills. Null when the element has no frame yet, the frame is black, or the
// canvas cannot be read.
export async function captureFrameFromVideo(video: HTMLVideoElement, slot: ArtSlotCode): Promise<GeneratedFrame | null> {
	const box = artBox(slot, window.devicePixelRatio)

	if (video.readyState < video.HAVE_CURRENT_DATA || video.videoWidth === 0 || video.videoHeight === 0) {
		return null
	}

	try {
		const sampleCanvas = new OffscreenCanvas(SAMPLE_WIDTH, SAMPLE_HEIGHT)
		const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true })

		if (sampleContext === null) {
			return null
		}

		sampleContext.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)

		const sample = sampleOf(sampleContext.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data)

		if (isDark(sample.luma)) {
			return null
		}

		const size = fitInBox({ width: video.videoWidth, height: video.videoHeight }, box)
		const canvas = new OffscreenCanvas(size.width, size.height)
		const context = canvas.getContext("2d")

		if (context === null) {
			return null
		}

		context.drawImage(video, 0, 0, size.width, size.height)

		const blob = await encodeCanvasThumb(canvas)

		return { bytes: new Uint8Array(await blob.arrayBuffer()), width: size.width, height: size.height, dominant: sample.dominant }
	} catch (error) {
		// A tainted canvas (SecurityError) or a context lost under memory pressure.
		log.warn("videos", "frame capture from the player failed", error)

		return null
	}
}

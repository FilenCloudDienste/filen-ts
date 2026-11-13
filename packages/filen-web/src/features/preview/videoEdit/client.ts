import * as Comlink from "comlink"
import type { AnyFile } from "@filen/sdk-rs"
import { driveItemName } from "@filen/shared"
import type { VideoProbe } from "@filen/shared/videos"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { probeService } from "@/features/videos/lib/probeService"
import { PROBE_RANK } from "@/features/videos/lib/probeService.logic"
import PreviewWorker from "@/features/preview/videoEdit/worker/preview.worker.ts?worker"
import type { PreviewWorkerApi } from "@/features/preview/videoEdit/worker/preview.worker"
import { planExport } from "@/features/preview/videoEdit/lib/plan"
import { startVideoSave, type VideoSaveDeps, type VideoSaveHandle } from "@/features/preview/videoEdit/save"
import { videoSaveDeps } from "@/features/preview/videoEdit/saveDeps"
import type { ExportPlan, TimeRange, VideoEditClient, VideoSaveOutcome, VideoSourceInfo } from "@/features/preview/videoEdit/types"
import { idleResource } from "@/lib/idleResource"
import { recoverIfNewerBuild } from "@/lib/appUpdate"
import { isAppleMobile } from "@/lib/appleMobile"
import { i18n } from "@/lib/i18n"
import { sdkApi } from "@/lib/sdk/client"

// The page side of the video editor. Its preview worker (exact frames, filmstrip, waveform) is spun up on the first
// request and held for as long as an editor is open on the file, then torn down once idle; it reads the file through
// one range port. A plan is answered here (the plan is pure); an export is a save (save.ts), which runs the export
// worker through exportClient.ts and lives on as a transfer row, so closing the editor never stops it.

// Kept a while after the last editor closed, so reopening it does not pay a worker start.
const PREVIEW_WORKER_IDLE_MS = 30_000

interface PreviewResource {
	worker: Worker
	remote: Comlink.Remote<PreviewWorkerApi>
}

const live = new Set<PreviewResource>()

// iOS gives a tab one hardware decoder at a time: while any export runs (from any editor, or none left open), every
// preview worker's decoder is let go, and a preview worker started meanwhile starts without one.
let exportsHoldingDecoder = 0
// The suspension posted to the live preview workers, which an export waits on before it decodes.
let suspending: Promise<unknown> = Promise.resolve()
const suspendListeners = new Set<(suspended: boolean) => void>()

function decodingSuspended(): boolean {
	return exportsHoldingDecoder > 0
}

function announceSuspended(suspended: boolean): void {
	for (const listener of [...suspendListeners]) {
		listener(suspended)
	}
}

// Takes the decoder from the previews for an export (iOS only); returns the give-back, which is idempotent.
async function handOverDecoder(ios: boolean): Promise<() => void> {
	if (!ios) {
		return () => undefined
	}

	exportsHoldingDecoder++

	if (exportsHoldingDecoder === 1) {
		suspending = Promise.all([...live].map(resource => resource.remote.suspendDecoding().catch(() => undefined)))
		announceSuspended(true)
	}

	await suspending

	let given = false

	return () => {
		if (given) {
			return
		}

		given = true
		exportsHoldingDecoder--

		if (exportsHoldingDecoder === 0) {
			for (const resource of live) {
				void resource.remote.resumeDecoding().catch(() => undefined)
			}

			announceSuspended(false)
		}
	}
}

// What a frame request answers while an export holds the decoder: an AbortError, as a superseded request.
export class DecodingSuspendedError extends Error {
	public constructor() {
		super("video decoding is suspended while an export runs")
		this.name = "AbortError"
	}
}

const previewWorker = idleResource<PreviewResource>(
	() => {
		const worker = new PreviewWorker({ name: "video-edit-preview" })
		const resource: PreviewResource = { worker, remote: Comlink.wrap<PreviewWorkerApi>(worker) }

		worker.addEventListener("error", () => {
			// A deploy that changed this worker removes its old file (appUpdate.ts).
			recoverIfNewerBuild()
			previewWorker.invalidate(resource)
		})
		live.add(resource)

		// Posted before anything else, so the source it opens starts suspended.
		if (decodingSuspended()) {
			void resource.remote.suspendDecoding().catch(() => undefined)
		}

		return resource
	},
	resource => {
		live.delete(resource)
		resource.remote[Comlink.releaseProxy]()
		resource.worker.terminate()
	},
	PREVIEW_WORKER_IDLE_MS
)

// Every open client's end, for logout.
const openClients = new Set<() => void>()

export interface VideoEditClientParams {
	// The drive file being edited.
	item: DriveItem
	// Its probe when the caller holds it already; otherwise asked of the probe service (stored per file, shared with
	// the preview's player). Without one the worker reads what it needs from the file.
	probe?: VideoProbe | null
}

export class ClientDisposedError extends Error {
	public constructor() {
		super("video edit client disposed")
		this.name = "AbortError"
	}
}

// A range port onto `file`, cancelled by close().
async function openPort(file: AnyFile): Promise<{ port: MessagePort; close: () => void }> {
	const token = crypto.randomUUID()
	const { port1, port2 } = new MessageChannel()

	await sdkApi.openRangePort(Comlink.transfer(port1, [port1]), file, token)

	return {
		port: port2,
		close: () => {
			void sdkApi.cancelPreviewDownload(token)
		}
	}
}

// The probe the preview's player reads too (stored per file); null when the file is no container it reads.
async function probeOf(file: AnyFile, given: VideoProbe | null | undefined): Promise<VideoProbe | null> {
	if (given !== undefined) {
		return given
	}

	const record = await probeService.request({ uuid: file.uuid, file }, "full", { rank: () => PROBE_RANK.explicit }).catch(() => null)

	return record?.probe ?? null
}

// A copy's name: "clip (edited).mp4", then "clip (edited 2).mp4", worded as the image editor's.
function copySuffix(number: number): string {
	return number <= 1 ? i18n.t("preview:previewImageSaveCopySuffix") : i18n.t("preview:previewImageSaveCopySuffixNumbered", { number })
}

export function createVideoEditClient(params: VideoEditClientParams): VideoEditClient {
	const { item } = params
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		throw new Error("a directory cannot be edited as a video")
	}

	// A structural superset of File, so an AnyFile (as narrowToAnyFile reasons).
	const file: AnyFile = base.data
	const size = Number(file.size)
	const ios = isAppleMobile()
	const hold = Promise.withResolvers<undefined>()
	const acquired = Promise.withResolvers<Comlink.Remote<PreviewWorkerApi>>()
	let disposed = false
	let held = false
	let source: Promise<VideoSourceInfo> | null = null
	let previewPort: { close: () => void } | null = null
	let saveDeps: VideoSaveDeps | null = null
	let nextId = 1
	const filmstrips = new Set<number>()
	// This client's suspension listeners, dropped on dispose.
	const listeners = new Set<(suspended: boolean) => void>()

	// The preview worker, held from the first use until dispose.
	const remote = (): Promise<Comlink.Remote<PreviewWorkerApi>> => {
		if (disposed) {
			return Promise.reject(new ClientDisposedError())
		}

		if (!held) {
			held = true
			previewWorker
				.use(async resource => {
					acquired.resolve(resource.remote)
					await hold.promise
				})
				// A worker that failed to start: nothing is held.
				.catch((error: unknown) => {
					acquired.reject(error)
				})
		}

		return acquired.promise
	}

	const deps = (): VideoSaveDeps => {
		saveDeps ??= videoSaveDeps()

		return saveDeps
	}

	const loadSource = (): Promise<VideoSourceInfo> => {
		source ??= (async () => {
			const [worker, probe] = await Promise.all([remote(), probeOf(file, params.probe)])
			const opened = await openPort(file)

			if (disposed) {
				opened.close()

				throw new ClientDisposedError()
			}

			previewPort = opened

			return await worker.open(Comlink.transfer({ port: opened.port, size, probe }, [opened.port]))
		})()
		// A failed open is asked again on the next call.
		source.catch(() => {
			source = null
		})

		return source
	}

	// Ends the preview; a running export is a save with its own transfer row and goes on.
	const dispose = (): void => {
		if (disposed) {
			return
		}

		disposed = true
		openClients.delete(dispose)

		for (const listener of listeners) {
			suspendListeners.delete(listener)
		}

		listeners.clear()

		if (!held) {
			hold.resolve(undefined)

			return
		}

		void acquired.promise.then(
			worker => {
				for (const id of filmstrips) {
					void worker.cancelFilmstrip(id).catch(() => undefined)
				}

				// Posted before the hold ends, so it runs before any idle teardown could.
				void worker.close().catch(() => undefined)
				previewPort?.close()
				hold.resolve(undefined)
			},
			() => {
				hold.resolve(undefined)
			}
		)
	}

	openClients.add(dispose)

	return {
		loadSource,

		// While an export holds the decoder (iOS), frame requests are answered here, never posted.
		frameAt: async (time, recipe, maxWidth) => {
			await loadSource()

			if (decodingSuspended()) {
				throw new DecodingSuspendedError()
			}

			return await (await remote()).frameAt(time, recipe, maxWidth)
		},

		filterThumbnails: async (time, recipe, filters, height) => {
			await loadSource()

			if (decodingSuspended()) {
				throw new DecodingSuspendedError()
			}

			return await (await remote()).filterThumbnails(time, recipe, filters, height)
		},

		isDecodingSuspended: decodingSuspended,

		onDecodingSuspendedChange: listener => {
			if (disposed) {
				return () => undefined
			}

			// Its own entry, so one listener added twice is removed once per subscription.
			const entry = (suspended: boolean): void => {
				listener(suspended)
			}

			listeners.add(entry)
			suspendListeners.add(entry)

			return () => {
				listeners.delete(entry)
				suspendListeners.delete(entry)
			}
		},

		// A newer filmstrip request supersedes the ones still running: they stop at their next still and resolve with
		// what they made. None while an export holds the decoder (iOS).
		filmstrip: async (times, height) => {
			await loadSource()

			if (decodingSuspended()) {
				return []
			}

			const id = nextId++
			const worker = await remote()

			for (const running of filmstrips) {
				void worker.cancelFilmstrip(running).catch(() => undefined)
			}

			filmstrips.add(id)

			try {
				return await worker.filmstrip(id, times, height)
			} finally {
				filmstrips.delete(id)
			}
		},

		waveform: (range: TimeRange, columns: number, onUpdate: (peaks: Float32Array) => void) => {
			const id = nextId++
			const watch = { stopped: false }

			void (async () => {
				await loadSource()

				const worker = await remote()

				if (!watch.stopped) {
					await worker.watchWaveform(id, range, columns, Comlink.proxy(onUpdate))
				}
			})().catch(() => undefined)

			return () => {
				if (watch.stopped) {
					return
				}

				watch.stopped = true

				if (held && !disposed) {
					void acquired.promise.then(worker => worker.unwatchWaveform(id)).catch(() => undefined)
				}
			}
		},

		plan: async (recipe): Promise<ExportPlan> => {
			const d = deps()
			const [info, capabilities] = await Promise.all([loadSource(), d.encodeCapabilities()])

			return planExport(recipe, info, capabilities, { name: driveItemName(base), versioning: d.versioning(), ios: d.ios() })
		},

		exportVideo: (recipe, target, onProgress) => {
			// Read across the awaits below: an object, so each read sees what cancel() and detachToTransfer() set.
			const run: { handle: VideoSaveHandle | null; cancelled: boolean; detached: boolean } = {
				handle: null,
				cancelled: false,
				detached: false
			}
			const cancelledNow = (): boolean => run.cancelled
			const done = (async (): Promise<VideoSaveOutcome> => {
				const info = await loadSource()

				if (run.cancelled) {
					return { status: "cancelled" }
				}

				const giveBack = await handOverDecoder(ios)

				try {
					// Cancelled while the decoder was handed over (read through a call: cancel() set it across the await).
					if (cancelledNow()) {
						return { status: "cancelled" }
					}

					const handle = startVideoSave(deps(), { item, recipe, info, target, copySuffix }, onProgress)

					run.handle = handle

					if (run.detached) {
						handle.detach()
					}

					return await handle.done
				} finally {
					giveBack()
				}
			})()

			return {
				done,
				cancel: () => {
					run.cancelled = true
					run.handle?.cancel()
				},
				// The editor is going away: the save goes on as its transfer row and stops reporting here.
				detachToTransfer: () => {
					run.detached = true
					run.handle?.detach()
				}
			}
		},

		dispose
	}
}

// Logout: every editor's hold ends and the preview worker goes now (it held this account's frames and file ranges).
// Running exports are transfers, which logout cancels on its own.
export function releaseVideoEditWorkers(): void {
	for (const end of [...openClients]) {
		end()
	}

	for (const resource of [...live]) {
		previewWorker.invalidate(resource)
	}
}

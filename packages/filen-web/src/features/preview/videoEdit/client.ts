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
import { sdkApi } from "@/lib/sdk/client"
import { settleGuard } from "@/lib/workers/settleGuard"
import { editedCopySuffix } from "@/features/preview/components/previewOverlay.logic"

// The page side of the video editor. Its preview worker (exact frames, filmstrip, waveform) is spun up on the first
// request and held for as long as an editor is open on the file, then torn down once idle; it reads the file through
// one range port. A plan is answered here (the plan is pure); an export is a save (save.ts), which runs the export
// worker through exportClient.ts and lives on as a transfer row, so closing the editor never stops it.

// Kept a while after the last editor closed, so reopening it does not pay a worker start.
const PREVIEW_WORKER_IDLE_MS = 30_000

interface PreviewResource {
	worker: Worker
	remote: Comlink.Remote<PreviewWorkerApi>
	// Set once the worker died or was torn down: its proxy is released and a call in flight would never answer.
	gone: boolean
	// Settles at that moment.
	lost: Promise<undefined>
	// The calls in flight on it, each rejected with PreviewWorkerLostError then.
	pending: Set<(error: Error) => void>
	markLost: () => void
}

// What a call answers when the preview worker died under it (a crash, an out-of-memory kill) or was torn down. The
// client's next call starts a fresh worker and reopens the source.
export class PreviewWorkerLostError extends Error {
	public constructor() {
		super("the video edit preview worker stopped")
		this.name = "PreviewWorkerLostError"
	}
}

// `run` on `resource`'s remote, rejected with PreviewWorkerLostError when the worker goes first. Each call registers
// itself only while in flight, so a long session of frame requests holds nothing per finished call.
async function callOn<T>(resource: PreviewResource, run: (remote: Comlink.Remote<PreviewWorkerApi>) => Promise<T>): Promise<T> {
	if (resource.gone) {
		throw new PreviewWorkerLostError()
	}

	const lost = Promise.withResolvers<never>()

	resource.pending.add(lost.reject)

	try {
		return await Promise.race([run(resource.remote), lost.promise])
	} finally {
		resource.pending.delete(lost.reject)
	}
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
		// Each through callOn: a worker lost meanwhile settles its part, or the export waiting here would never start.
		suspending = Promise.all([...live].map(resource => callOn(resource, remote => remote.suspendDecoding()).catch(() => undefined)))
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
				void callOn(resource, remote => remote.resumeDecoding()).catch(() => undefined)
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

// `post` unless an export holds the decoder (iOS), when a frame request is answered here, never posted.
function unlessSuspended<T>(post: () => Promise<T>): Promise<T> {
	return decodingSuspended() ? Promise.reject(new DecodingSuspendedError()) : post()
}

const previewWorker = idleResource<PreviewResource>(
	() => {
		const worker = new PreviewWorker({ name: "video-edit-preview" })
		const lost = Promise.withResolvers<undefined>()
		const resource: PreviewResource = {
			worker,
			remote: Comlink.wrap<PreviewWorkerApi>(worker),
			gone: false,
			lost: lost.promise,
			pending: new Set(),
			markLost: () => {
				if (resource.gone) {
					return
				}

				resource.gone = true

				for (const reject of [...resource.pending]) {
					reject(new PreviewWorkerLostError())
				}

				lost.resolve(undefined)
			}
		}

		worker.addEventListener("error", () => {
			// A deploy that changed this worker removes its old file (appUpdate.ts).
			recoverIfNewerBuild()
			resource.markLost()
			previewWorker.invalidate(resource)
		})
		live.add(resource)

		// Posted before anything else, so the source it opens starts suspended.
		if (decodingSuspended()) {
			void callOn(resource, remote => remote.suspendDecoding()).catch(() => undefined)
		}

		return resource
	},
	resource => {
		live.delete(resource)
		resource.markLost()
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

// One client's use of a preview worker, ended on dispose or when that worker is lost.
interface Hold {
	resource: Promise<PreviewResource>
	// The resource once acquired, so dispose can end the hold synchronously.
	value: PreviewResource | null
	// The source opened on this worker.
	source: Promise<VideoSourceInfo> | null
	// Its range port.
	port: { close: () => void } | null
	end: () => void
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
	let disposed = false
	// This client's use of the preview worker, from the first call until dispose or until that worker is lost.
	let hold: Hold | null = null
	let saveDeps: VideoSaveDeps | null = null
	let nextId = 1
	const filmstrips = new Set<number>()
	// This client's suspension listeners, dropped on dispose.
	const listeners = new Set<(suspended: boolean) => void>()

	// A lost worker drops the hold and the source opened on it, and its range port: the next call starts afresh.
	const drop = (current: Hold): void => {
		if (hold === current) {
			hold = null
		}

		current.port?.close()
		current.port = null
		current.end()
	}

	const acquire = (): Hold => {
		if (hold !== null) {
			return hold
		}

		const ended = Promise.withResolvers<undefined>()
		const acquired = Promise.withResolvers<PreviewResource>()
		const current: Hold = {
			resource: acquired.promise,
			value: null,
			source: null,
			port: null,
			end: () => {
				ended.resolve(undefined)
			}
		}

		hold = current
		previewWorker
			.use(async resource => {
				current.value = resource
				acquired.resolve(resource)
				void resource.lost.then(() => {
					drop(current)
				})
				await Promise.race([ended.promise, resource.lost])
			})
			// A worker that failed to start: nothing is held, and the next call tries again.
			.catch((error: unknown) => {
				acquired.reject(error)

				if (hold === current) {
					hold = null
				}
			})

		return current
	}

	// `run` on the held preview worker.
	const call = async <T>(run: (remote: Comlink.Remote<PreviewWorkerApi>) => Promise<T>): Promise<T> => {
		if (disposed) {
			throw new ClientDisposedError()
		}

		return await callOn(await acquire().resource, run)
	}

	const deps = (): VideoSaveDeps => {
		saveDeps ??= videoSaveDeps()

		return saveDeps
	}

	const loadSourceOn = (current: Hold): Promise<VideoSourceInfo> => {
		if (current.source !== null) {
			return current.source
		}

		const source = (async () => {
			const [resource, probe] = await Promise.all([current.resource, probeOf(file, params.probe)])
			const opened = await openPort(file)

			if (disposed || hold !== current) {
				opened.close()

				throw disposed ? new ClientDisposedError() : new PreviewWorkerLostError()
			}

			current.port = opened

			return await callOn(resource, remote => remote.open(Comlink.transfer({ port: opened.port, size, probe }, [opened.port])))
		})()

		current.source = source
		// A failed open is asked again on the next call.
		source.catch(() => {
			if (current.source === source) {
				current.source = null
			}
		})

		return source
	}

	const loadSource = (): Promise<VideoSourceInfo> => (disposed ? Promise.reject(new ClientDisposedError()) : loadSourceOn(acquire()))

	// `run` on the worker the source was opened on: one lost meanwhile rejects it rather than ask a fresh worker that
	// has no source yet.
	const callWithSource = async <T>(run: (remote: Comlink.Remote<PreviewWorkerApi>) => Promise<T>): Promise<T> => {
		if (disposed) {
			throw new ClientDisposedError()
		}

		const current = acquire()

		await loadSourceOn(current)

		return await callOn(await current.resource, run)
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

		const current = hold

		hold = null

		if (current === null) {
			return
		}

		// The port is closed and the hold ended whatever the worker answers: a worker already gone (its proxy
		// released) must not leave the range token open or the idle resource pinned.
		const end = (resource: PreviewResource): void => {
			try {
				if (!resource.gone) {
					for (const id of filmstrips) {
						void resource.remote.cancelFilmstrip(id).catch(() => undefined)
					}

					// Posted before the hold ends, so it runs before any idle teardown could.
					void resource.remote.close().catch(() => undefined)
				}
			} finally {
				current.port?.close()
				current.port = null
				current.end()
			}
		}

		// Ended at once when the worker is up, so logout's teardown right after finds the hold over.
		if (current.value !== null) {
			end(current.value)

			return
		}

		void current.resource.then(end, () => {
			current.end()
		})
	}

	openClients.add(dispose)

	return {
		loadSource,

		frameAt: (time, recipe, maxWidth) => callWithSource(remote => unlessSuspended(() => remote.frameAt(time, recipe, maxWidth))),

		stillAt: (time, recipe, maxWidth) => callWithSource(remote => unlessSuspended(() => remote.stillAt(time, recipe, maxWidth))),

		filterThumbnails: (time, recipe, filters, height) =>
			callWithSource(remote => unlessSuspended(() => remote.filterThumbnails(time, recipe, filters, height))),

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

			for (const running of filmstrips) {
				void call(remote => remote.cancelFilmstrip(running)).catch(() => undefined)
			}

			filmstrips.add(id)

			try {
				return await callWithSource(remote => remote.filmstrip(id, times, height))
			} finally {
				filmstrips.delete(id)
			}
		},

		waveform: (range: TimeRange, columns: number, onUpdate: (peaks: Float32Array) => void) => {
			const id = nextId++
			const watch = { stopped: false }
			// The worker stops only once it hears of the stop: peaks it sent meanwhile are another view's.
			const updates = settleGuard(onUpdate)

			void (async () => {
				await loadSource()

				if (!watch.stopped) {
					await callWithSource(remote => remote.watchWaveform(id, range, columns, Comlink.proxy(updates.callback)))
				}
			})().catch(() => undefined)

			return () => {
				if (watch.stopped) {
					return
				}

				watch.stopped = true
				updates.settle()

				// Only on the worker held now: a lost one took its watches with it.
				const current = hold

				if (current !== null && !disposed) {
					void current.resource.then(resource => callOn(resource, remote => remote.unwatchWaveform(id))).catch(() => undefined)
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

					const handle = startVideoSave(deps(), { item, recipe, info, target, copySuffix: editedCopySuffix }, onProgress)

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

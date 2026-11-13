import type { File as SdkFile } from "@filen/sdk-rs"
import { driveItemName, type QuotaVerdict } from "@filen/shared"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { editedCopyName } from "@/features/drive/lib/copyName"
import { editedSaveTimes, runPreviewSave, type PreviewSaveDeps } from "@/features/drive/lib/previewSave.logic"
import { settleTransferFailure } from "@/features/transfers/lib/settle"
import type { Transfer, TransfersStore } from "@/features/transfers/store/useTransfersStore"
import type { EncodeCapabilities } from "@/lib/media/playback/capabilities.logic"
import type { ActionOutcome } from "@/lib/actions/outcome"
import { log } from "@/lib/log"
import { exportBlockers, planExport, plannedRanges, sourceToOutputTime, type PlanContext } from "@/features/preview/videoEdit/lib/plan"
import { containerMime, videoSaveTargets } from "@/features/preview/videoEdit/lib/targets"
import type { Exporter } from "@/features/preview/videoEdit/exportClient"
import type { ExportWorkerProgress, ExportWorkerResult } from "@/features/preview/videoEdit/worker/exportApi"
import type {
	ExportProgress,
	TimeRange,
	VideoEditRecipe,
	VideoSaveErrorCode,
	VideoSaveOutcome,
	VideoSaveRefusal,
	VideoSaveTarget,
	VideoSourceInfo
} from "@/features/preview/videoEdit/types"

// A video export saved into the drive, end to end, from the page: the offline gate, the plan's own refusals, one new
// version of a file at a time, a re-check that the file was not changed elsewhere (an in-place save would otherwise
// make a version over someone else's), the copy's free name (resolved right before the upload, and held until the
// save ends so two copies never take the same one), then the export worker writing into the SDK worker's upload over
// a save port, as a transfer row (progress, ETA, cancel, pause; sign-out cancels it; a running row keeps the tab from
// closing unasked). The storage pre-flight runs on the estimate (+10 %), never handed to the upload as a size. The
// upload only finishes once the export committed: a cancel, a failure, a stalled or lost worker all end it without a
// version. After a new version, the watch state's resume point follows the edit as the worker wrote it.

// The quota pre-flight's margin over the plan's estimate.
const QUOTA_MARGIN = 1.1

// The worker beats every ~250 ms from the start of the export until the upload answered; none for this long means it
// is gone.
const HEARTBEAT_LOST_MS = 30_000

// No progress for this long (and the row not paused) is a stall: an export that will not finish. Progress is output
// written while exporting, then the upload's bytes once the export committed.
export const EXPORT_STALL_MS = 120_000

const WATCHDOG_INTERVAL_MS = 5_000

// ETA only once enough of the output exists to extrapolate from.
const ETA_MIN_FRACTION = 0.02

export interface VideoSaveRequest {
	// The file as the editor opened it.
	item: DriveItem
	recipe: VideoEditRecipe
	info: VideoSourceInfo
	target: VideoSaveTarget
	// Words a copy's name: "clip (edited).mp4", then "clip (edited 2).mp4"...
	copySuffix: (n: number) => string
}

export interface VideoSaveDeps {
	isOnline: () => boolean
	encodeCapabilities: () => Promise<EncodeCapabilities>
	// The account keeps versions; undefined when not known yet.
	versioning: () => boolean | undefined
	ios: () => boolean
	rootUuid: () => string
	getFileByStableUuid: (stableUuid: string) => Promise<SdkFile | undefined>
	// Names taken in a directory, lowercased as the server compares them.
	takenNames: (parent: string | null) => Promise<ReadonlySet<string>>
	// Serves `item`'s ranges on `port` under the abort `token`.
	openSourcePort: (port: MessagePort, item: DriveItem, token: string) => Promise<void>
	cancelSourceReads: (token: string) => void
	exporter: Exporter
	saveDeps: PreviewSaveDeps
	checkQuota: (neededBytes: bigint) => Promise<QuotaVerdict>
	transfers: Pick<TransfersStore, "add" | "settle" | "remove" | "setItem" | "setSize">
	isPaused: (transferId: string) => boolean
	// The bytes the transfer row's upload has sent so far.
	uploadedBytes: (transferId: string) => number
	cancelTransfer: (transferId: string) => void
	rebaseWatchState: (params: {
		stableUuid: string
		previous: { uuid: string; size: number }
		uuid: string
		size: number
		duration: number
		map: (seconds: number) => number | null
	}) => Promise<void>
	// Keeps the screen on; returns the release.
	keepAwake: () => () => void
	now: () => number
	setInterval: (run: () => void, ms: number) => unknown
	clearInterval: (handle: unknown) => void
}

export interface VideoSaveHandle {
	// The transfer row's id (also the export's).
	readonly id: string
	readonly done: Promise<VideoSaveOutcome>
	cancel(): void
	// Stops reporting progress to the editor; the save continues as its transfer row.
	detach(): void
}

// ── Running exports ─────────────────────────────────────────────────────────

interface RunningExport {
	// The file's stable uuid (its uuid when it has none): versions of one file share it.
	file: string
	target: VideoSaveTarget
	// A copy's name once resolved, lowercased, and the directory it goes into: no other copy takes it meanwhile.
	copy: { parent: string | null; name: string } | null
}

// Every save from start to settle, by save id.
const running = new Map<string, RunningExport>()
const runningListeners = new Set<() => void>()

function runningChanged(): void {
	for (const listener of [...runningListeners]) {
		listener()
	}
}

function fileKey(file: SdkFile): string {
	return file.stableUUID ?? file.uuid
}

// Whether a save of an edit of this file (a new version or a copy) is running, from any editor or none.
export function isVideoExportRunning(stableUuid: string): boolean {
	for (const entry of running.values()) {
		if (entry.file === stableUuid) {
			return true
		}
	}

	return false
}

// Calls `listener` whenever a save starts or ends; returns the unsubscribe (useSyncExternalStore's shape).
export function subscribeVideoExports(listener: () => void): () => void {
	runningListeners.add(listener)

	return () => {
		runningListeners.delete(listener)
	}
}

function refused(reason: VideoSaveRefusal, detail?: string): VideoSaveOutcome {
	if (detail !== undefined) {
		log.info("video-edit", `save refused (${reason})`, detail)
	}

	return { status: "refused", reason }
}

function failed(code: VideoSaveErrorCode, cause: unknown): VideoSaveOutcome {
	log.warn("video-edit", `save failed (${code})`, cause)

	return { status: "error", code }
}

export function exportProgressOf(progress: ExportWorkerProgress, elapsedMs: number): ExportProgress {
	const fraction = progress.outputDuration > 0 ? Math.min(1, Math.max(0, progress.outputSeconds / progress.outputDuration)) : 0

	return {
		fraction,
		bytesWritten: progress.bytesWritten,
		etaSeconds: fraction >= ETA_MIN_FRACTION && fraction < 1 ? Math.ceil(((elapsedMs / 1000) * (1 - fraction)) / fraction) : null
	}
}

export function startVideoSave(
	deps: VideoSaveDeps,
	request: VideoSaveRequest,
	onProgress?: (progress: ExportProgress) => void
): VideoSaveHandle {
	const id = crypto.randomUUID()
	const base = asDirectoryOrFile(request.item)
	let report = onProgress
	let cancelRequested = false
	let cancelRun: (() => void) | null = null

	const start = (): Promise<VideoSaveOutcome> => {
		if (base.type !== "file") {
			return Promise.resolve(refused("target", "not a file"))
		}

		const file = fileKey(base.data)

		// One new version of a file at a time: a second would stack on the first, made from the same original.
		if (request.target === "inPlace" && [...running.values()].some(entry => entry.file === file && entry.target === "inPlace")) {
			return Promise.resolve(refused("busy"))
		}

		const entry: RunningExport = { file, target: request.target, copy: null }

		running.set(id, entry)
		runningChanged()

		return runSave(deps, request, id, entry, {
			progress: progress => {
				report?.(progress)
			},
			cancelled: () => cancelRequested,
			onRun: cancel => {
				cancelRun = cancel
			}
		}).finally(() => {
			running.delete(id)
			runningChanged()
		})
	}

	return {
		id,
		done: start(),
		cancel: () => {
			cancelRequested = true
			cancelRun?.()
		},
		detach: () => {
			report = undefined
		}
	}
}

interface SaveHooks {
	progress: (progress: ExportProgress) => void
	cancelled: () => boolean
	onRun: (cancel: () => void) => void
}

// The copy's free name in `parent`, held by `entry` from here on: the directory's names and every name a running save
// holds there are taken.
async function reserveCopyName(
	deps: VideoSaveDeps,
	request: VideoSaveRequest,
	entry: RunningExport,
	name: string,
	parent: string | null
): Promise<string> {
	const taken = new Set(await deps.takenNames(parent))

	for (const other of running.values()) {
		if (other !== entry && other.copy !== null && other.copy.parent === parent) {
			taken.add(other.copy.name)
		}
	}

	const copyName = editedCopyName(
		name,
		videoSaveTargets({ name, container: request.info.container }).copyExtension,
		request.copySuffix,
		taken
	)

	entry.copy = { parent, name: copyName.toLowerCase() }

	return copyName
}

async function runSave(
	deps: VideoSaveDeps,
	request: VideoSaveRequest,
	id: string,
	entry: RunningExport,
	hooks: SaveHooks
): Promise<VideoSaveOutcome> {
	const { item, recipe, info, target } = request
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		return refused("target", "not a file")
	}

	if (!deps.isOnline()) {
		return refused("offline")
	}

	const name = driveItemName(base)
	const context: PlanContext = { name, versioning: deps.versioning(), ios: deps.ios() }
	const caps = await deps.encodeCapabilities()
	const plan = planExport(recipe, info, caps, context)
	const blockers = exportBlockers(recipe, info, caps, context)

	if (blockers.length > 0) {
		return refused("unavailable", blockers.join(", "))
	}

	if (!plan.targets.includes(target)) {
		return refused("target", `${target} is not offered for this file`)
	}

	const parent = base.data.parent === deps.rootUuid() ? null : base.data.parent

	// A new version must be of the version the edit was made on.
	if (target === "inPlace" && base.data.stableUUID !== undefined) {
		const head = await deps.getFileByStableUuid(base.data.stableUUID)

		if (head?.uuid !== base.data.uuid) {
			return { status: "remoteChanged", currentUuid: head?.uuid ?? null }
		}
	}

	if (hooks.cancelled()) {
		return { status: "cancelled" }
	}

	// Resolved now rather than when the editor asked: a copy saved meanwhile (here or elsewhere) has its name listed.
	const copyName = target === "copy" ? await reserveCopyName(deps, request, entry, name, parent) : null

	if (hooks.cancelled()) {
		return { status: "cancelled" }
	}

	const row: Omit<Transfer, "paused"> = {
		id,
		direction: "upload",
		name: copyName ?? name,
		size: plan.estimateBytes,
		bytesTransferred: 0,
		status: "uploading",
		parentUuid: parent,
		startedAt: deps.now()
	}

	deps.transfers.add(row)

	const releaseAwake = deps.keepAwake()
	const save = new MessageChannel()
	const source = new MessageChannel()
	const token = crypto.randomUUID()
	const started = deps.now()
	const liveness = { lastBeat: started, lastAdvance: started, written: -1, seconds: -1, uploaded: -1, committed: false }
	let stalled: VideoSaveErrorCode | null = null

	try {
		await deps.openSourcePort(source.port1, item, token)

		const run = deps.exporter.run(
			{
				exportId: id,
				source: source.port2,
				size: Number(base.data.size),
				recipe,
				info,
				caps,
				context,
				output: save.port1,
				fallbackCreationTime: Number(editedSaveTimes(item, deps.now()).created)
			},
			progress => {
				const now = deps.now()

				liveness.lastBeat = now

				if (progress.bytesWritten !== liveness.written || progress.outputSeconds !== liveness.seconds) {
					liveness.written = progress.bytesWritten
					liveness.seconds = progress.outputSeconds
					liveness.lastAdvance = now
				}

				if (progress.phase === "committed" && !liveness.committed) {
					liveness.committed = true
					liveness.lastAdvance = now
				}

				hooks.progress(exportProgressOf(progress, now - started))
			}
		)
		const stop = (): void => {
			run.cancel()
			deps.cancelTransfer(id)
		}

		hooks.onRun(stop)

		if (hooks.cancelled()) {
			stop()
		}

		const watchdog = deps.setInterval(() => {
			const now = deps.now()

			if (now - liveness.lastBeat > HEARTBEAT_LOST_MS) {
				stalled = "workerLost"
				stop()

				return
			}

			// A paused row makes no progress by design: its stall window starts over when it resumes.
			if (deps.isPaused(id)) {
				liveness.lastAdvance = now

				return
			}

			if (liveness.committed) {
				const uploaded = deps.uploadedBytes(id)

				// Every byte is up: the upload is finishing the file (bounded by the save port's own settle wait).
				if (uploaded >= liveness.written) {
					liveness.lastAdvance = now

					return
				}

				if (uploaded !== liveness.uploaded) {
					liveness.uploaded = uploaded
					liveness.lastAdvance = now

					return
				}
			}

			if (now - liveness.lastAdvance > EXPORT_STALL_MS) {
				stalled = "stalled"
				stop()
			}
		}, WATCHDOG_INTERVAL_MS)

		let uploaded: ActionOutcome<DriveItem>
		let exported: ExportWorkerResult

		try {
			const upload = runPreviewSave(
				{ ...deps.saveDeps, checkQuota: deps.checkQuota },
				{
					item,
					content: { port: save.port2, quotaBytes: plan.estimateBytes * QUOTA_MARGIN, transferId: id },
					...(copyName === null ? {} : { asNewFile: copyName }),
					times: editedSaveTimes(item, deps.now()),
					mime: containerMime(plan.container)
				}
			).then(outcome => {
				// Refused or failed before the export finished: it stops writing into a port nobody reads.
				if (outcome.status === "error") {
					run.cancel()
				}

				return outcome
			})

			;[uploaded, exported] = await Promise.all([upload, run.result])
		} finally {
			deps.clearInterval(watchdog)
		}

		return await settle(deps, request, { id, uploaded, exported, stalled, plan, copyName, cancelled: hooks.cancelled() })
	} catch (error) {
		// Ports never handed over (the source could not be opened) are closed here; handed-over ones are their holders'.
		save.port1.close()
		save.port2.close()
		source.port2.close()
		deps.transfers.settle(id, "error")

		return failed("unknown", error)
	} finally {
		deps.cancelSourceReads(token)
		source.port1.close()
		releaseAwake()
	}
}

async function settle(
	deps: VideoSaveDeps,
	request: VideoSaveRequest,
	result: {
		id: string
		uploaded: ActionOutcome<DriveItem>
		exported: ExportWorkerResult
		stalled: VideoSaveErrorCode | null
		plan: ReturnType<typeof planExport>
		copyName: string | null
		// The editor (or the row) asked for a cancel.
		cancelled: boolean
	}
): Promise<VideoSaveOutcome> {
	const { id, uploaded, exported, stalled, plan, copyName } = result
	const { transfers } = deps

	// The upload only finishes on the export's commit, so a made file is the export's whole output, whatever the
	// worker could still report after it (it may have died meanwhile).
	if (uploaded.status === "success") {
		const saved = asDirectoryOrFile(uploaded.item)

		transfers.settle(id, "done")
		transfers.setItem(id, uploaded.item)

		if (exported.status === "done") {
			transfers.setSize(id, exported.bytes)
		} else {
			log.warn("video-edit", "the upload made the file but the export worker did not report done", exported)
		}

		if (copyName === null && saved.type === "file") {
			// What the worker wrote; the plan's ranges (which may differ by a frame or two) only when it did not say.
			const written =
				exported.status === "done"
					? { bounds: exported.bounds, duration: exported.outputDuration }
					: { bounds: plannedRanges(request.recipe, request.info, plan.mode), duration: plan.outputDuration }

			await rebaseWatch(deps, request, saved.data, written.bounds, written.duration)
		}

		return { status: "done", item: uploaded.item }
	}

	if (stalled !== null) {
		transfers.settle(id, "error")

		return failed(stalled, exported)
	}

	if (exported.status === "error") {
		if (exported.refusal !== null) {
			transfers.settle(id, "error")

			return refused(exported.refusal, exported.message)
		}

		if (uploaded.dto.kind === "MaxStorageReached") {
			transfers.settle(id, "cancelled")
			transfers.remove(id)

			return refused("quota", uploaded.dto.message)
		}

		transfers.settle(id, "error")

		return failed(
			exported.cause === "workerLost" ? "workerLost" : exported.cause === "upload" ? "uploadFailed" : "unknown",
			exported.message
		)
	}

	if (uploaded.dto.kind === "MaxStorageReached") {
		transfers.settle(id, "cancelled")
		transfers.remove(id)

		return refused("quota", uploaded.dto.message)
	}

	// A cancel (the editor's, the row's, a sign-out) drops the row; anything else (the upload failed, which stopped the
	// export) stays as a failed row.
	if (result.cancelled) {
		transfers.settle(id, "cancelled")
		transfers.remove(id)

		return { status: "cancelled" }
	}

	return settleTransferFailure(transfers, id, uploaded.dto) ? { status: "cancelled" } : failed("uploadFailed", uploaded.dto.message)
}

async function rebaseWatch(
	deps: VideoSaveDeps,
	request: VideoSaveRequest,
	saved: SdkFile,
	bounds: readonly TimeRange[],
	duration: number
): Promise<void> {
	const original = asDirectoryOrFile(request.item)

	if (original.type !== "file" || saved.stableUUID === undefined) {
		return
	}

	await deps
		.rebaseWatchState({
			stableUuid: saved.stableUUID,
			previous: { uuid: original.data.uuid, size: Number(original.data.size) },
			uuid: saved.uuid,
			size: Number(saved.size),
			duration,
			map: seconds => sourceToOutputTime(bounds, request.recipe.speed, seconds)
		})
		.catch((error: unknown) => {
			log.warn("video-edit", "moving the watch state onto the edited version failed", error)
		})
}

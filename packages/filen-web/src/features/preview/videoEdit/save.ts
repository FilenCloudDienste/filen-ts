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
	VideoEditRecipe,
	VideoSaveOutcome,
	VideoSaveRefusal,
	VideoSaveTarget,
	VideoSourceInfo
} from "@/features/preview/videoEdit/types"

// A video export saved into the drive, end to end, from the page: the offline gate, the plan's own refusals, the
// copy's free name, a re-check that the file was not changed elsewhere (an in-place save would otherwise make a
// version over someone else's), then the export worker writing into the SDK worker's upload over a save port, as a
// transfer row (progress, ETA, cancel, pause; sign-out cancels it; a running row keeps the tab from closing unasked).
// The storage pre-flight runs on the estimate (+10 %), never handed to the upload as a size. The upload only finishes
// once the export committed: a cancel, a failure, a stalled or lost worker all end it without a version. After a
// new version, the watch state's resume point follows the edit.

// The quota pre-flight's margin over the plan's estimate.
const QUOTA_MARGIN = 1.1

// Progress callbacks arrive every ~250 ms while the worker lives; none for this long means it is gone.
const HEARTBEAT_LOST_MS = 30_000

// No output written for this long (and the row not paused) is a stall: an export that will not finish.
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

function refused(reason: VideoSaveRefusal, message: string): VideoSaveOutcome {
	return { status: "refused", reason, message }
}

function exportRefusal(result: Extract<ExportWorkerResult, { status: "error" }>): VideoSaveRefusal | null {
	return result.refusal
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
	let report = onProgress
	let cancelRequested = false
	let cancelRun: (() => void) | null = null

	const done = runSave(deps, request, id, {
		progress: progress => {
			report?.(progress)
		},
		cancelled: () => cancelRequested,
		onRun: cancel => {
			cancelRun = cancel
		}
	})

	return {
		id,
		done,
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

async function runSave(deps: VideoSaveDeps, request: VideoSaveRequest, id: string, hooks: SaveHooks): Promise<VideoSaveOutcome> {
	const { item, recipe, info, target } = request
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		return refused("target", "not a file")
	}

	if (!deps.isOnline()) {
		return refused("offline", "offline")
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
	const copyName =
		target === "copy"
			? editedCopyName(
					name,
					videoSaveTargets({ name, container: info.container }).copyExtension,
					request.copySuffix,
					await deps.takenNames(parent)
				)
			: null

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
	let lastBeat = started
	let lastAdvance = started
	let lastWritten = -1
	let lastSeconds = -1
	let stalled: string | null = null

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

				lastBeat = now

				if (progress.bytesWritten !== lastWritten || progress.outputSeconds !== lastSeconds) {
					lastWritten = progress.bytesWritten
					lastSeconds = progress.outputSeconds
					lastAdvance = now
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

			if (now - lastBeat > HEARTBEAT_LOST_MS) {
				stalled = "the export worker stopped answering"
			} else if (!deps.isPaused(id) && now - lastAdvance > EXPORT_STALL_MS) {
				stalled = "the export stalled"
			} else {
				return
			}

			stop()
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

		return await settle(deps, request, { id, uploaded, exported, stalled, plan, copyName })
	} catch (error) {
		// Ports never handed over (the source could not be opened) are closed here; handed-over ones are their holders'.
		save.port1.close()
		save.port2.close()
		source.port2.close()
		deps.transfers.settle(id, "error")

		return { status: "error", message: error instanceof Error ? error.message : String(error) }
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
		stalled: string | null
		plan: ReturnType<typeof planExport>
		copyName: string | null
	}
): Promise<VideoSaveOutcome> {
	const { id, uploaded, exported, stalled, plan, copyName } = result
	const { transfers } = deps

	if (uploaded.status === "success" && exported.status === "done") {
		const saved = asDirectoryOrFile(uploaded.item)

		transfers.settle(id, "done")
		transfers.setSize(id, exported.bytes)
		transfers.setItem(id, uploaded.item)

		if (copyName === null && saved.type === "file") {
			await rebaseWatch(deps, request, saved.data, plan.mode, plan.outputDuration)
		}

		return { status: "done", uuid: uploaded.item.data.uuid }
	}

	if (stalled !== null) {
		transfers.settle(id, "error")

		return { status: "error", message: stalled }
	}

	if (exported.status === "error") {
		transfers.settle(id, "error")

		const refusal = exportRefusal(exported)

		return refusal === null ? { status: "error", message: exported.message } : refused(refusal, exported.message)
	}

	if (uploaded.status === "error") {
		if (uploaded.dto.kind === "MaxStorageReached") {
			transfers.settle(id, "cancelled")
			transfers.remove(id)

			return refused("quota", uploaded.dto.message)
		}

		// A cancel (the editor's, the row's, a sign-out) drops the row; anything else stays as a failed row.
		if (exported.status === "cancelled") {
			transfers.settle(id, "cancelled")
			transfers.remove(id)

			return { status: "cancelled" }
		}

		return settleTransferFailure(transfers, id, uploaded.dto)
			? { status: "cancelled" }
			: { status: "error", message: uploaded.dto.message }
	}

	// Uploaded, yet the export did not report done: not trusted as saved (never happens: the upload only finishes on
	// the export's commit).
	transfers.settle(id, "error")

	return exported.status === "cancelled" ? { status: "cancelled" } : { status: "error", message: "the export did not finish" }
}

async function rebaseWatch(
	deps: VideoSaveDeps,
	request: VideoSaveRequest,
	saved: SdkFile,
	mode: "copy" | "transcode",
	duration: number
): Promise<void> {
	const original = asDirectoryOrFile(request.item)

	if (original.type !== "file" || saved.stableUUID === undefined) {
		return
	}

	const ranges = plannedRanges(request.recipe, request.info, mode)

	await deps
		.rebaseWatchState({
			stableUuid: saved.stableUUID,
			previous: { uuid: original.data.uuid, size: Number(original.data.size) },
			uuid: saved.uuid,
			size: Number(saved.size),
			duration,
			map: seconds => sourceToOutputTime(ranges, request.recipe.speed, seconds)
		})
		.catch((error: unknown) => {
			log.warn("video-edit", "moving the watch state onto the edited version failed", error)
		})
}

import { isCopyJobRunning } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { cancelSwDownload } from "@/features/drive/lib/saveDownload"
import { isActiveTransfer, useTransfersStore, type Transfer } from "@/features/transfers/store/useTransfersStore"
import { getCopyJob, useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"

// A copy's row stays active past its SDK job while its copies move to the trash, which has no pause.
function isSettledCopy(transfer: Transfer): boolean {
	const job = transfer.direction === "copy" ? getCopyJob(transfer.id) : undefined

	return job !== undefined && !isCopyJobRunning(job)
}

// The rows by id, read once per batch: acting on one row never changes another synchronously (the SDK
// calls are async posts), so a single snapshot answers every id without a scan each.
function transfersById(): ReadonlyMap<string, Transfer> {
	return new Map(useTransfersStore.getState().transfers.map(transfer => [transfer.id, transfer]))
}

// The row for an id, or undefined for an unknown id or an already-terminal transfer: nothing left to
// abort, pause or resume.
function activeIn(byId: ReadonlyMap<string, Transfer>, id: string): Transfer | undefined {
	const transfer = byId.get(id)

	return transfer !== undefined && isActiveTransfer(transfer.status) ? transfer : undefined
}

// The job settles as cancelled through its own report; trashCopied then moves its top-level items to
// the trash (never a permanent delete). The first request stands: its stop is already on its way, and a
// later one (Cancel all, sign-out) must not turn a "trash" into a "keep".
export function requestCopyCancel(jobId: string, options: { trashCopied: boolean }): void {
	const job = getCopyJob(jobId)

	if (job?.outcome.status !== "running" || job.cancelRequest !== null) {
		return
	}

	useCopyJobsStore.getState().update(jobId, running => ({ ...running, cancelRequest: options.trashCopied ? "trash" : "keep" }))
	void sdkApi.cancelTransfer(jobId)
}

// Direction-agnostic cancel entry point for the active-row cancel button (transferRow.tsx) and cancel-all.
// Reads the live transfers straight from the store — this fires outside any particular
// runUpload/runDownload call's own scope, so there is no deps object to route through — and fires the
// worker-side abort. The in-flight runUpload/runDownload catch does the actual store settle+remove once
// the worker call rejects with "Cancelled"; this only triggers that rejection.
export function cancelTransfers(ids: readonly string[]): void {
	const byId = transfersById()

	for (const id of ids) {
		const transfer = activeIn(byId, id)

		if (transfer === undefined) {
			continue
		}

		if (transfer.direction === "copy") {
			// Keeps what the copy already made; trashing it is an explicit choice made elsewhere.
			requestCopyCancel(id, { trashCopied: false })

			continue
		}

		// A service-worker download is the worker's to stop, not the page's SDK's.
		if (transfer.direction === "download" && cancelSwDownload(id)) {
			continue
		}

		void sdkApi.cancelTransfer(id)
	}
}

export function cancelTransfer(id: string): void {
	cancelTransfers([id])
}

// Sign-out: nothing may keep writing with the session being torn down. A copy keeps what it made unless
// its stop already asked for the trash.
export function cancelActiveTransfers(): void {
	cancelUploadRuns()
	cancelTransfers(useTransfersStore.getState().transfers.map(transfer => transfer.id))
}

// Stops every running upload run from starting anything more: a directory upload's files that are still
// waiting on their directory (or on a HEIC conversion) are not transfers yet, so cancelling the transfers
// alone would let them start afterwards. For Cancel all and sign-out, never for one row's Cancel.
export function cancelUploadRuns(): void {
	const { uploadBatches, cancelUploadBatches } = useTransfersStore.getState()
	const running = new Set<string>()

	for (const id in uploadBatches) {
		if (uploadBatches[id]?.running === true) {
			running.add(id)
		}
	}

	if (running.size > 0) {
		cancelUploadBatches(running)
	}
}

// Direction-agnostic pause/resume entry point for the active-row toggle (transferRow.tsx) and pause/resume
// all. Unlike cancel, pause never rejects the in-flight call the way abort does — the worker-side
// PauseSignal just stops delivering bytes/progress until resumed — so there is no later catch to react to,
// and the paused flag is flipped right here, in one store update, so the rows reflect it immediately.
export function setTransfersPaused(ids: readonly string[], paused: boolean): void {
	const byId = transfersById()
	const eligible = new Set<string>()

	for (const id of ids) {
		const transfer = activeIn(byId, id)

		if (transfer === undefined || isSettledCopy(transfer) || transfer.browserManaged === true) {
			continue
		}

		void (paused ? sdkApi.pauseTransfer(id) : sdkApi.resumeTransfer(id))
		eligible.add(id)
	}

	// Nothing eligible leaves the store untouched, so its subscribers hear nothing.
	if (eligible.size > 0) {
		useTransfersStore.getState().setPausedMany(eligible, paused)
	}
}

export function setTransferPaused(id: string, paused: boolean): void {
	setTransfersPaused([id], paused)
}

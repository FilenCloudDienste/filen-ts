import { isJobRunning } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { cancelSwDownload } from "@/features/drive/lib/saveDownload"
import { isActiveTransfer, isDriveJobDirection, useTransfersStore, type Transfer } from "@/features/transfers/store/useTransfersStore"
import { getDriveJob, useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"

// A drive job's row stays active past its SDK job while what it made moves to the trash, which has no pause.
function isSettledJob(transfer: Transfer): boolean {
	const job = isDriveJobDirection(transfer.direction) ? getDriveJob(transfer.id) : undefined

	return job !== undefined && !isJobRunning(job)
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

export type JobStopMode = "keep" | "trash"

// The job settles as cancelled through its own report; "trash" then moves what a copy or an extract made
// to the trash (never a permanent delete). A compress leaves nothing behind, so it always keeps. The
// first request stands: its stop is already on its way, and a later one (Cancel all, sign-out) must not
// turn a "trash" into a "keep".
export function requestJobCancel(jobId: string, mode: JobStopMode): void {
	const job = getDriveJob(jobId)

	if (job === undefined || !isJobRunning(job) || job.cancelRequest !== null) {
		return
	}

	const { update } = useDriveJobsStore.getState()

	switch (job.kind) {
		case "copy":
			update("copy", jobId, running => ({ ...running, cancelRequest: mode }))
			break
		case "extract":
			update("extract", jobId, running => ({ ...running, cancelRequest: mode }))
			break
		case "compress":
			update("compress", jobId, running => ({ ...running, cancelRequest: "keep" }))
			break
	}

	// A paused job needs no resume first: the SDK's pause wait also ends on a stop.
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

		if (isDriveJobDirection(transfer.direction)) {
			// Keeps what the job already made; trashing it is an explicit choice made elsewhere.
			requestJobCancel(id, "keep")

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

// Sign-out: nothing may keep writing with the session being torn down. A drive job keeps what it made
// unless its stop already asked for the trash.
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

		if (transfer === undefined || isSettledJob(transfer) || transfer.browserManaged === true) {
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

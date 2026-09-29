import { sdkApi } from "@/lib/sdk/client"
import { requestCopyCancel } from "@/features/drive/lib/copy"
import { isActiveTransfer, useTransfersStore, type Transfer } from "@/features/transfers/store/useTransfersStore"
import { getCopyJob } from "@/features/transfers/store/useCopyJobsStore"

// A copy's row stays active past its SDK job while its copies move to the trash, which has no pause.
function isSettledCopy(transfer: Transfer): boolean {
	const job = transfer.direction === "copy" ? getCopyJob(transfer.id) : undefined

	return job !== undefined && job.outcome.status !== "running"
}

// Direction-agnostic cancel entry point for the active-row cancel button (transferRow.tsx). Reads
// the live transfer straight from the store — this fires outside any particular runUpload/runDownload
// call's own scope, so there is no deps object to route through — and fires the worker-side abort. The
// in-flight runUpload/runDownload catch does the actual store settle+remove once the worker call
// rejects with "Cancelled"; this only triggers that rejection. A no-op for an unknown id or an
// already-terminal transfer — nothing left to abort.
export function cancelTransfer(id: string): void {
	const transfer = useTransfersStore.getState().transfers.find(t => t.id === id)

	if (transfer === undefined || !isActiveTransfer(transfer.status)) {
		return
	}

	if (transfer.direction === "copy") {
		// Keeps what the copy already made; trashing it is an explicit choice made elsewhere.
		requestCopyCancel(id, { trashCopied: false })

		return
	}

	void sdkApi.cancelTransfer(id)
}

// Sign-out: nothing may keep writing with the session being torn down. A copy keeps what it made unless
// its stop already asked for the trash.
export function cancelActiveTransfers(): void {
	for (const transfer of useTransfersStore.getState().transfers) {
		cancelTransfer(transfer.id)
	}
}

// Direction-agnostic pause entry point for the active-row pause/resume toggle (transferRow.tsx).
// Mirrors cancelTransfer, but pause never rejects the in-flight call the way abort does — the
// worker-side PauseSignal just stops delivering bytes/progress until resumeTransfer — so there is no
// later catch to react to, and setPaused is flipped right here so the row reflects it immediately.
// A no-op for an unknown id or an already-terminal transfer.
export function pauseTransfer(id: string): void {
	const transfer = useTransfersStore.getState().transfers.find(t => t.id === id)

	if (transfer === undefined || !isActiveTransfer(transfer.status) || isSettledCopy(transfer)) {
		return
	}

	void sdkApi.pauseTransfer(id)
	useTransfersStore.getState().setPaused(id, true)
}

// Symmetric resume entry point — mirrors pauseTransfer.
export function resumeTransfer(id: string): void {
	const transfer = useTransfersStore.getState().transfers.find(t => t.id === id)

	if (transfer === undefined || !isActiveTransfer(transfer.status) || isSettledCopy(transfer)) {
		return
	}

	void sdkApi.resumeTransfer(id)
	useTransfersStore.getState().setPaused(id, false)
}

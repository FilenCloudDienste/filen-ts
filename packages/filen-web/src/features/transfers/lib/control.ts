import { sdkApi } from "@/lib/sdk/client"
import { requestCopyCancel } from "@/features/drive/lib/copy"
import { isActiveTransfer, useTransfersStore } from "@/features/transfers/store/useTransfersStore"

// Direction-agnostic cancel entry point for the active-row cancel button (transferRow.tsx). Reads
// the live transfer straight from the store — this fires outside any particular runUpload/runDownload
// call's own scope, so there is no deps object to route through — and dispatches the worker-side abort
// by direction. The in-flight runUpload/runDownload catch does the actual store settle+remove once the
// worker call rejects with "Cancelled" (sdk.worker.ts's cancelUpload/cancelDownload); this only
// triggers that rejection. A no-op for an unknown id or an already-terminal transfer — nothing left to
// abort.
export function cancelTransfer(id: string): void {
	const transfer = useTransfersStore.getState().transfers.find(t => t.id === id)

	if (transfer === undefined || !isActiveTransfer(transfer.status)) {
		return
	}

	switch (transfer.direction) {
		case "upload":
			void sdkApi.cancelUpload(id)

			break
		case "download":
			void sdkApi.cancelDownload(id)

			break
		case "copy":
			// Keeps what the copy already made; trashing it is an explicit choice made elsewhere.
			requestCopyCancel(id, { trashCopied: false })

			break
	}
}

// Sign-out: nothing may keep writing with the session being torn down. Copies keep what they made.
export function cancelActiveTransfers(): void {
	for (const transfer of useTransfersStore.getState().transfers) {
		cancelTransfer(transfer.id)
	}
}

// Direction-agnostic pause entry point for the active-row pause/resume toggle (transferRow.tsx).
// Mirrors cancelTransfer's dispatch, but pause never rejects the in-flight call the way abort does —
// the worker-side PauseSignal just stops delivering bytes/progress until resumeTransfer — so there is
// no later catch to react to, and setPaused is flipped right here so the row reflects it immediately.
// A no-op for an unknown id or an already-terminal transfer.
export function pauseTransfer(id: string): void {
	const transfer = useTransfersStore.getState().transfers.find(t => t.id === id)

	if (transfer === undefined || !isActiveTransfer(transfer.status)) {
		return
	}

	switch (transfer.direction) {
		case "upload":
			void sdkApi.pauseUpload(id)

			break
		case "download":
			void sdkApi.pauseDownload(id)

			break
		case "copy":
			void sdkApi.pauseCopy(id)

			break
	}

	useTransfersStore.getState().setPaused(id, true)
}

// Symmetric resume entry point — mirrors pauseTransfer.
export function resumeTransfer(id: string): void {
	const transfer = useTransfersStore.getState().transfers.find(t => t.id === id)

	if (transfer === undefined || !isActiveTransfer(transfer.status)) {
		return
	}

	switch (transfer.direction) {
		case "upload":
			void sdkApi.resumeUpload(id)

			break
		case "download":
			void sdkApi.resumeDownload(id)

			break
		case "copy":
			void sdkApi.resumeCopy(id)

			break
	}

	useTransfersStore.getState().setPaused(id, false)
}

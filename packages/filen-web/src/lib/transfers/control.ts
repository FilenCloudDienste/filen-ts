import { sdkApi } from "@/lib/sdk/client"
import { isActiveTransfer, useTransfersStore } from "@/stores/transfers"

// Direction-agnostic cancel entry point for the active-row cancel button (transfer-row.tsx). Reads
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

	if (transfer.direction === "upload") {
		void sdkApi.cancelUpload(id)
		return
	}

	void sdkApi.cancelDownload(id)
}

import { cancelTransfers } from "@/features/transfers/lib/control"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { pendingCancelTargets, pendingDismissTargets, type PendingRowKey } from "@/features/drive/lib/pendingUploads.logic"

// A pending row's confirmed Cancel. The runs are marked first, so a file still being prepared never starts;
// the running ones abort through the transfers screen's own path, which removes their rows.
export function cancelPendingRow(key: PendingRowKey, parentUuid: string | null): void {
	const store = useTransfersStore.getState()
	const { transferIds, batchIds } = pendingCancelTargets(store, key, parentUuid)

	if (batchIds.size > 0) {
		store.cancelUploadBatches(batchIds)
	}

	cancelTransfers([...transferIds])
}

// A failed row's Dismiss: its transfers leave the transfers screen too, as that screen's own Remove does.
export function dismissPendingRow(key: PendingRowKey, parentUuid: string | null): void {
	const store = useTransfersStore.getState()
	const { transferIds, batchIds } = pendingDismissTargets(store, key, parentUuid)

	if (transferIds.size > 0) {
		store.removeMany(transferIds)
	}

	if (batchIds.size > 0) {
		store.removeUploadBatches(batchIds)
	}
}

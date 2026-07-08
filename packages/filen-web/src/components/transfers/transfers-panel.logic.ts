import { isActiveTransfer, type Transfer } from "@/stores/transfers"

// Newest-first — a freshly started upload surfaces at the top without the user scrolling, mirroring
// a browser downloads panel. Returns a new array; the store's own array is never mutated in place.
export function sortTransfersByStartedAt(transfers: Transfer[]): Transfer[] {
	return [...transfers].sort((a, b) => b.startedAt - a.startedAt)
}

// Gates the panel's "Clear finished" affordance — true the moment at least one row has settled
// (done/error/completedWithErrors). Active (uploading OR downloading) rows show no such control
// since there is nothing to clear yet.
export function hasFinishedTransfers(transfers: Transfer[]): boolean {
	return transfers.some(transfer => !isActiveTransfer(transfer.status))
}

import { isActiveTransfer, type Transfer } from "@/features/transfers/store/useTransfersStore"

// The screen's two rendered sections. Active on top, oldest-running first (ASC startedAt) — the
// longest-waiting transfer stays anchored at the top instead of being bumped down every time a newer
// one starts. Finished below, newest first (DESC startedAt — there is no finishedAt field, startedAt
// is the nearest proxy, same convention transfers-panel.logic.ts's sortTransfersByStartedAt already
// uses). "Finished" is simply isActiveTransfer's complement (done/error in practice: cancelled never
// reaches the store's list — removed on settle — and completedWithErrors is unused; see
// stores/transfers.ts's own header comment), so no per-status branching is needed here either.
export interface TransfersDisplayList {
	active: Transfer[]
	finished: Transfer[]
}

export function buildTransfersDisplayList(transfers: Transfer[]): TransfersDisplayList {
	const active: Transfer[] = []
	const finished: Transfer[] = []

	for (const transfer of transfers) {
		if (isActiveTransfer(transfer.status)) {
			active.push(transfer)
		} else {
			finished.push(transfer)
		}
	}

	active.sort((a, b) => a.startedAt - b.startedAt)
	finished.sort((a, b) => b.startedAt - a.startedAt)

	return { active, finished }
}

// Bulk-header target selection. Each helper returns exactly the id list its header button hands to
// lib/transfers/control.ts, and an empty return doubles as the button's own disable signal
// (`.length === 0`) — the screen never duplicates the selection rule between "what runs" and "when is
// this greyed out".

// Cancel-all's targets: every active transfer, paused or not — mirrors the row's own Cancel button,
// always present on an active row regardless of `paused`.
export function cancellableTransferIds(transfers: Transfer[]): string[] {
	return transfers.filter(transfer => isActiveTransfer(transfer.status)).map(transfer => transfer.id)
}

// Pause-all's targets: active AND not yet paused — an already-paused row has nothing left to pause.
export function pausableTransferIds(transfers: Transfer[]): string[] {
	return transfers.filter(transfer => isActiveTransfer(transfer.status) && !transfer.paused).map(transfer => transfer.id)
}

// Resume-all's targets: active AND currently paused — the mirror image of pausableTransferIds.
export function resumableTransferIds(transfers: Transfer[]): string[] {
	return transfers.filter(transfer => isActiveTransfer(transfer.status) && transfer.paused).map(transfer => transfer.id)
}

import { isCopyJobRunning } from "@filen/shared"
import { isActiveTransfer, type Transfer } from "@/features/transfers/store/useTransfersStore"
import type { CopyJob } from "@/features/drive/lib/copy.logic"

// Gates the header's "Clear finished" affordance — true the moment at least one row has settled
// (done/error/completedWithErrors). Active (uploading OR downloading) rows show no such control since
// there is nothing to clear yet. Previously lived in the now-removed rail popover's own logic module
// (transfersPanel.logic.ts) — the screen is this predicate's only consumer now that the popover is
// gone (the rail entry navigates straight here instead).
export function hasFinishedTransfers(transfers: Transfer[]): boolean {
	return transfers.some(transfer => !isActiveTransfer(transfer.status))
}

// The screen's two rendered sections. Active on top, oldest-running first (ASC startedAt) — the
// longest-waiting transfer stays anchored at the top instead of being bumped down every time a newer
// one starts. Finished below, newest first (DESC startedAt — there is no finishedAt field, startedAt
// is the nearest proxy). "Finished" is simply isActiveTransfer's complement (done/error in practice:
// cancelled never reaches the store's list — removed on settle — and completedWithErrors is unused;
// see stores/transfers.ts's own header comment), so no per-status branching is needed here either.
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
// features/transfers/lib/control.ts, and an empty return doubles as the button's own disable signal
// (`.length === 0`) — the screen never duplicates the selection rule between "what runs" and "when is
// this greyed out".

// The copies whose job has ended. Such a copy's row stays active while the copies it made move to the
// trash, which can be neither paused nor stopped.
export function endedCopyIds(jobs: Readonly<Record<string, CopyJob>>): Set<string> {
	const ended = new Set<string>()

	for (const job of Object.values(jobs)) {
		if (!isCopyJobRunning(job)) {
			ended.add(job.id)
		}
	}

	return ended
}

// An active row, left out while its copy's job has ended, as the row hides its own controls then.
function isControllableTransfer(transfer: Transfer, endedCopies: ReadonlySet<string>): boolean {
	return isActiveTransfer(transfer.status) && !endedCopies.has(transfer.id)
}

// Cancel-all's targets: every active transfer, paused or not — mirrors the row's own Cancel button,
// always present on an active row regardless of `paused`.
export function cancellableTransferIds(transfers: Transfer[], endedCopies: ReadonlySet<string>): string[] {
	return transfers.filter(transfer => isControllableTransfer(transfer, endedCopies)).map(transfer => transfer.id)
}

// Pause-all's targets: active AND not yet paused — an already-paused row has nothing left to pause.
export function pausableTransferIds(transfers: Transfer[], endedCopies: ReadonlySet<string>): string[] {
	return transfers.filter(transfer => isControllableTransfer(transfer, endedCopies) && !transfer.paused).map(transfer => transfer.id)
}

// Resume-all's targets: active AND currently paused — the mirror image of pausableTransferIds.
export function resumableTransferIds(transfers: Transfer[], endedCopies: ReadonlySet<string>): string[] {
	return transfers.filter(transfer => isControllableTransfer(transfer, endedCopies) && transfer.paused).map(transfer => transfer.id)
}

// Cancel-all's real side-effecting step, extracted from the header's onClick so the "confirmed cancel
// hits exactly the cancellable set, nothing else" contract is unit-testable without rendering the
// AlertDialog that gates it (transfers.tsx wires this to ConfirmDialog's onConfirm; the same
// cancellableTransferIds selection also drives the header button's disabled state, so what the dialog
// confirms is always what the button showed as available). `cancel` is injected (mirrors
// runDirectoryUpload's own DI shape) rather than importing control.ts's cancelTransfer directly, so a
// test can assert the call set without touching the real sdk worker.
export function confirmCancelAllTransfers(transfers: Transfer[], endedCopies: ReadonlySet<string>, cancel: (id: string) => void): void {
	for (const id of cancellableTransferIds(transfers, endedCopies)) {
		cancel(id)
	}
}

// The aggregate speed/progress readout's own render gate (iconRail.tsx's TransfersEntry, this screen's
// header) — mirrors mobile's floating pill: nothing renders while no transfer is active, even if a
// just-settled batch left a stale percent/speed sitting in the aggregate object for one more tick
// (useTransfersAggregate/computeTransfersAggregate — store/useTransfersStore.ts — never itself resets
// speed to 0 the instant the last transfer finishes; the rolling window just ages out over the next
// few seconds). A single shared predicate keeps both call sites' "when do we show this" rule in sync.
export function shouldShowTransfersAggregate(activeCount: number): boolean {
	return activeCount > 0
}

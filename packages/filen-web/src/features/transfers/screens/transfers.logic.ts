import { clampedRatio, isJobRunning } from "@filen/shared"
import { isActiveTransfer, type Transfer } from "@/features/transfers/store/useTransfersStore"
import type { DriveJob } from "@/features/drive/lib/driveJobs.logic"

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

// The drive jobs that have ended. Such a job's row stays active while what it made moves to the trash,
// which can be neither paused nor stopped.
export function endedJobIds(jobs: Readonly<Record<string, DriveJob>>): Set<string> {
	const ended = new Set<string>()

	for (const job of Object.values(jobs)) {
		if (!isJobRunning(job)) {
			ended.add(job.id)
		}
	}

	return ended
}

// An active row, left out while its drive job has ended, as the row hides its own controls then.
function isControllableTransfer(transfer: Transfer, endedJobs: ReadonlySet<string>): boolean {
	return isActiveTransfer(transfer.status) && !endedJobs.has(transfer.id)
}

// Cancel-all's targets: every active transfer, paused or not — mirrors the row's own Cancel button,
// always present on an active row regardless of `paused`.
export function cancellableTransferIds(transfers: Transfer[], endedJobs: ReadonlySet<string>): string[] {
	return transfers.filter(transfer => isControllableTransfer(transfer, endedJobs)).map(transfer => transfer.id)
}

// A download the browser itself is saving that already holds bytes: stopping it leaves the partial file
// with the browser, which keeps it for its own retry.
export function leavesBrowserPartial(transfer: Transfer): boolean {
	return transfer.browserManaged === true && transfer.bytesTransferred > 0
}

// Whether Cancel all stops any such download.
export function cancelAllLeavesBrowserPartial(transfers: Transfer[], endedJobs: ReadonlySet<string>): boolean {
	return transfers.some(transfer => isControllableTransfer(transfer, endedJobs) && leavesBrowserPartial(transfer))
}

// Pause-all's targets: active AND not yet paused — an already-paused row has nothing left to pause.
export function pausableTransferIds(transfers: Transfer[], endedJobs: ReadonlySet<string>): string[] {
	return transfers
		.filter(transfer => isControllableTransfer(transfer, endedJobs) && !transfer.paused && transfer.browserManaged !== true)
		.map(transfer => transfer.id)
}

// Resume-all's targets: active AND currently paused — the mirror image of pausableTransferIds.
export function resumableTransferIds(transfers: Transfer[], endedJobs: ReadonlySet<string>): string[] {
	return transfers.filter(transfer => isControllableTransfer(transfer, endedJobs) && transfer.paused).map(transfer => transfer.id)
}

// The aggregate speed/progress readout's own render gate (the rail's transfers ring tooltip, this screen's
// header) — mirrors mobile's floating pill: nothing renders while no transfer is active, even if a
// just-settled batch left a stale percent/speed sitting in the aggregate object for one more tick
// (useTransfersAggregate/computeTransfersAggregate — store/useTransfersStore.ts — never itself resets
// speed to 0 the instant the last transfer finishes; the rolling window just ages out over the next
// few seconds). A single shared predicate keeps both call sites' "when do we show this" rule in sync.
export function shouldShowTransfersAggregate(activeCount: number): boolean {
	return activeCount > 0
}

export interface TransfersRingState {
	visible: boolean
	// No rows at all: shown only because the transfers screen is open.
	empty: boolean
	activeCount: number
	// 0-100 over the active rows of known size; 100 once only finished rows are left, 0 with none.
	percent: number
	// A row failed, wholly or in part, and was not cleared yet.
	failed: boolean
}

// The rail's transfers ring. Shown while the store holds any row (active, failed or finished and not yet
// cleared), so exactly while the transfers screen has something to list, and always on that screen so its
// own entry never vanishes under the pointer when the list is cleared. Rows live in memory and leave on
// "Clear finished", a row's remove, or a reload.
export function transfersRingState(transfers: readonly Transfer[], onTransfersScreen: boolean): TransfersRingState {
	let activeCount = 0
	let transferred = 0
	let total = 0
	let failed = false

	for (const transfer of transfers) {
		if (transfer.status === "error" || transfer.status === "completedWithErrors") {
			failed = true
		}

		if (!isActiveTransfer(transfer.status)) {
			continue
		}

		activeCount++

		// computeTransfersAggregate's rule: a row of unknown size (a zip still walking its tree) has no share.
		if (transfer.size > 0) {
			transferred += transfer.bytesTransferred
			total += transfer.size
		}
	}

	return {
		visible: onTransfersScreen || transfers.length > 0,
		empty: transfers.length === 0,
		activeCount,
		percent: transfers.length === 0 ? 0 : activeCount === 0 ? 100 : clampedRatio(transferred, total, 100),
		failed
	}
}

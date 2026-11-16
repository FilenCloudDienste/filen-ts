import { isWaitingForArchiveSlot } from "@filen/shared"
import { isActiveTransfer, type Transfer, type UploadBatch } from "@/features/transfers/store/useTransfersStore"
import type { ExternalTransferRow } from "@/features/transfers/lib/externalTransfers.logic"
import type { DriveJob } from "@/features/drive/lib/driveJobs.logic"

// The order every transfer list shows its rows in: by state, and within a state in the order the rows started, which
// never changes while a row keeps its state, so a progress tick moves nothing. A row moves only when its group changes.
export const TRANSFER_GROUP = {
	// Bytes moving.
	active: 0,
	// Waiting its turn: an archive job behind the page's one archive slot, a directory upload still being walked, the
	// drive cache's queued uploads.
	queued: 1,
	paused: 2,
	// Failed, wholly or in part (a job that finished with some items failed).
	failed: 3,
	done: 4,
	// A cancel settles a row to it and removes it at once, so it is never expected to render; last if it ever does.
	cancelled: 5
} as const

export type TransferGroup = (typeof TRANSFER_GROUP)[keyof typeof TRANSFER_GROUP]

const GROUP_COUNT = 6

// A row of the transfers store, the desktop app's native host's included. `queued`: what the row's store does not
// hold itself, its drive job waiting for the archive slot or its directory run still being walked. A paused row is
// paused whatever it waits for.
export function transferGroupOf(transfer: Pick<Transfer, "status" | "paused" | "waitingForSlot">, queued: boolean): TransferGroup {
	if (isActiveTransfer(transfer.status)) {
		if (transfer.paused) {
			return TRANSFER_GROUP.paused
		}

		return queued || transfer.waitingForSlot === true ? TRANSFER_GROUP.queued : TRANSFER_GROUP.active
	}

	switch (transfer.status) {
		case "error":
		case "completedWithErrors":
			return TRANSFER_GROUP.failed
		case "cancelled":
			return TRANSFER_GROUP.cancelled
		default:
			return TRANSFER_GROUP.done
	}
}

// The desktop app's sync and mounts rows: listed only while they move, or as the cache's queued uploads.
export function externalTransferGroupOf(row: ExternalTransferRow): TransferGroup {
	return row.kind === "queued" ? TRANSFER_GROUP.queued : TRANSFER_GROUP.active
}

// The rows waiting their turn that the transfers store does not mark itself: drive jobs waiting for the archive slot,
// and directory uploads still being walked.
export function waitingJobIds(jobs: Readonly<Record<string, DriveJob>>): Set<string> {
	const waiting = new Set<string>()

	for (const job of Object.values(jobs)) {
		if (isWaitingForArchiveSlot(job)) {
			waiting.add(job.id)
		}
	}

	return waiting
}

export function scanningRunIds(batches: Readonly<Record<string, UploadBatch>>): Set<string> {
	const scanning = new Set<string>()

	for (const id in batches) {
		if (batches[id]?.scanning === true) {
			scanning.add(id)
		}
	}

	return scanning
}

export interface GroupedRows<T> {
	// Every row, in group order, each group in its sources' order.
	rows: T[]
	// Per group, the index past its last row: group g holds rows[ends[g - 1] ?? 0 .. ends[g]).
	ends: number[]
}

// The rows of `sources`, in that order, put in group order. A counting pass and a placing pass: O(n), no comparisons,
// and stable, so a row keeps its place in its group however often this runs.
export function groupRows<T>(sources: readonly (readonly T[])[], groupOf: (row: T) => TransferGroup): GroupedRows<T> {
	let total = 0

	for (const source of sources) {
		total += source.length
	}

	const groups = new Uint8Array(total)
	const counts = new Array<number>(GROUP_COUNT).fill(0)
	let index = 0

	for (const source of sources) {
		for (const row of source) {
			const group = groupOf(row)

			groups[index++] = group
			counts[group] = (counts[group] ?? 0) + 1
		}
	}

	const ends: number[] = []
	const next: number[] = []
	let end = 0

	for (const count of counts) {
		next.push(end)
		end += count
		ends.push(end)
	}

	const rows = new Array<T>(total)

	index = 0

	for (const source of sources) {
		for (const row of source) {
			const group = groups[index++] ?? 0
			const at = next[group] ?? 0

			rows[at] = row
			next[group] = at + 1
		}
	}

	return { rows, ends }
}

// The index of the first row past `group`'s.
export function groupEnd(grouped: Pick<GroupedRows<unknown>, "ends">, group: TransferGroup): number {
	return grouped.ends[group] ?? 0
}

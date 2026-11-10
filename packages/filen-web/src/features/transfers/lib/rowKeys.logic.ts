import { isJobRunning } from "@filen/shared"
import { jobRevealItem, type DriveJob } from "@/features/drive/lib/driveJobs.logic"
import type { DriveItem } from "@/features/drive/lib/item"
import { isActiveTransfer, isDriveJobDirection, type Transfer } from "@/features/transfers/store/useTransfersStore"
import { hasClosest } from "@/lib/domTarget"

// A transfer row's marker: its transfer's id (transferRow.tsx).
export const TRANSFER_ROW_ATTRIBUTE = "data-transfer-id"

// The transfer whose row itself holds focus, or null: a key pressed on one of the row's buttons is that button's.
export function focusedTransferId(target: EventTarget | null): string | null {
	if (!hasClosest(target)) {
		return null
	}

	const row = target.closest(`[${TRANSFER_ROW_ATTRIBUTE}]`)

	return row === target ? row.getAttribute(TRANSFER_ROW_ATTRIBUTE) : null
}

// What a row's keys may do, the same gates its buttons show under (transferRow.tsx): an active row pauses and
// cancels unless its job already ended (what it made is moving to the trash), a browser-managed download never
// pauses; a finished row is removed, and opens where it landed when that is known.
export type TransferRowCommand = "pause" | "cancel" | "remove" | "reveal" | "details"

export function transferRowCommands(transfer: Transfer, job: DriveJob | undefined): ReadonlySet<TransferRowCommand> {
	const commands = new Set<TransferRowCommand>()
	const isJob = isDriveJobDirection(transfer.direction)

	if (isJob && job !== undefined) {
		commands.add("details")
	}

	if (isActiveTransfer(transfer.status)) {
		if (isJob && job !== undefined && !isJobRunning(job)) {
			return commands
		}

		if (transfer.browserManaged !== true) {
			commands.add("pause")
		}

		commands.add("cancel")

		return commands
	}

	commands.add("remove")

	if (landedRevealItem(transfer, isJob ? job : undefined) !== null) {
		commands.add("reveal")
	}

	return commands
}

// Where a finished transfer's "Show in directory" goes: the landed upload's file, or a job's own result.
export function landedRevealItem(transfer: Transfer, job: DriveJob | undefined): DriveItem | null {
	if (transfer.status !== "done" && transfer.status !== "completedWithErrors") {
		return null
	}

	return transfer.item ?? (job === undefined ? null : jobRevealItem(job))
}

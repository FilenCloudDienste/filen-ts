import { formatBytes, formatSecondsToMediaClock } from "@filen/shared"
import { errorLabel } from "@/lib/i18n/errorLabel"
import {
	computeTransfersAggregate,
	isDriveJobDirection,
	useTransfersStore,
	type Transfer
} from "@/features/transfers/store/useTransfersStore"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { buildTransfersDisplayList } from "@/features/transfers/screens/transfers.logic"
import { runningPercentFraction, transferProgress, transferRate } from "@/features/transfers/components/transferRow.logic"
import { driveJobRate } from "@/features/drive/lib/driveJobs.logic"
import { driveName, showDrive, type ToolAdapter, type ToolScope } from "@/features/assistant/tools/entities"

// A many-file upload is one row per file: the model sees the longest-running few and the counts.
const ACTIVE_LIMIT = 10
const FINISHED_LIMIT = 10

function percent(value: number): string {
	return `${String(Math.round(runningPercentFraction(value) * 100))}%`
}

// The rate the transfers screen's row shows: a drive job's own, else the row's rolling window.
function timeLeft(transfer: Transfer): string | undefined {
	const job = isDriveJobDirection(transfer.direction) ? useDriveJobsStore.getState().jobs[transfer.id] : undefined
	const rate =
		job === undefined ? transferRate(transfer, useTransfersStore.getState().rowSpeedSamples[transfer.id] ?? []) : driveJobRate(job)

	const seconds = rate?.etaSeconds ?? null

	return seconds === null ? undefined : formatSecondsToMediaClock(seconds)
}

function finishedStatus(transfer: Transfer): string {
	switch (transfer.status) {
		case "done":
			return "done"
		case "completedWithErrors":
			return "done, some items failed"
		case "cancelled":
			return "stopped"
		default:
			return "failed"
	}
}

function itemHandle(transfer: Transfer, scope: ToolScope): { handle?: string } {
	return transfer.item === undefined ? {} : { handle: showDrive(scope, transfer.item) }
}

// What the transfers screen lists, read from its store: running rows oldest first, then the newest finished.
// Nothing here pauses, resumes or stops a transfer.
export const getTransfersTool: ToolAdapter = (_input, scope) => {
	const { transfers, speedSamples } = useTransfersStore.getState()
	const { active, finished } = buildTransfersDisplayList(transfers)
	const aggregate = computeTransfersAggregate(transfers, speedSamples)
	const failed = finished.filter(transfer => transfer.status === "error").length

	return Promise.resolve({
		value: {
			running: active.length,
			// The aggregate counts only rows of known size: with none (a zip still walking its tree) it reads 0%.
			...(active.some(transfer => transfer.size > 0) ? { overall: percent(aggregate.percent) } : {}),
			failed,
			transfers: [
				...active.slice(0, ACTIVE_LIMIT).map(transfer => {
					const left = timeLeft(transfer)

					return {
						name: transfer.item === undefined ? transfer.name : driveName(transfer.item),
						...itemHandle(transfer, scope),
						kind: transfer.direction,
						status: transfer.paused ? "paused" : transfer.waitingForSlot === true ? "waiting" : "running",
						...(transfer.size > 0 ? { progress: percent(transferProgress(transfer)), size: formatBytes(transfer.size) } : {}),
						...(left === undefined ? {} : { left })
					}
				}),
				...finished.slice(0, FINISHED_LIMIT).map(transfer => ({
					name: transfer.item === undefined ? transfer.name : driveName(transfer.item),
					...itemHandle(transfer, scope),
					kind: transfer.direction,
					status: finishedStatus(transfer),
					...(transfer.status === "error" && transfer.error !== undefined ? { error: errorLabel(transfer.error) } : {})
				}))
			],
			...(active.length > ACTIVE_LIMIT || finished.length > FINISHED_LIMIT
				? {
						total: active.length + finished.length,
						more: Math.max(0, active.length - ACTIVE_LIMIT) + Math.max(0, finished.length - FINISHED_LIMIT)
					}
				: {}),
			...(transfers.length === 0 ? { note: "No uploads or downloads in this tab since it was opened." } : {})
		}
	})
}

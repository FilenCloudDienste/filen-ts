import { isCopyTrashPending, type CopyJob } from "@/features/drive/lib/copy.logic"
import { type ErrorDTO } from "@/lib/sdk/errors"

// Pure reads of a copy job for its progress card, so what the card says is testable without rendering.

export type CopyJobTitle =
	| { key: "transfersCopyCardTitleRunning" | "transfersCopyCardTitleDone"; count: number; destination: string }
	| { key: "transfersCopyCardTitleEnded"; destination: string }

export function copyJobTitle(job: CopyJob): CopyJobTitle {
	const destination = job.destination.name

	switch (job.outcome.status) {
		case "running":
			return { key: "transfersCopyCardTitleRunning", count: job.itemCount, destination }
		case "done":
			// A stop asking for the trash undoes even a copy that finished before the stop reached it.
			return job.cancelRequest === "trash"
				? { key: "transfersCopyCardTitleEnded", destination }
				: { key: "transfersCopyCardTitleDone", count: job.itemCount, destination }
		default:
			return { key: "transfersCopyCardTitleEnded", destination }
	}
}

// Plural keys are named by their base; i18next picks _one/_other from `count`.
export type CopyJobStatusKey =
	| "transfersStatusDone"
	| "transfersStatusPaused"
	| "transfersCopyFailedItems"
	| "transfersCopyPhaseCancelling"
	| "transfersCopyPhasePausing"
	| "transfersCopyPhaseScanning"
	| "transfersCopyPhaseCreatingDirectories"
	| "transfersCopyPhaseFinishing"
	| "transfersCopyCancelledKept"
	| "transfersCopyCancelledTrashFailed"
	| "transfersCopyCancelledTrashed"
	| "transfersCopyTrashFailed"
	| "transfersCopyTrashed"
	| "transfersCopyMovingToTrash"

export interface CopyJobKeyStatus {
	kind: "key"
	key: CopyJobStatusKey
	count?: number
}

// The line under the title. A failed copy's error is put into words where it's shown, so the text
// follows the language; what its stop's move to the trash did follows it.
export type CopyJobStatus =
	| CopyJobKeyStatus
	| { kind: "files"; done: number; count: number }
	| { kind: "error"; error: ErrorDTO; trash?: CopyJobKeyStatus }
	| { kind: "quota"; freeBytes: number }

export function copyJobStatus(job: CopyJob): CopyJobStatus {
	if (isCopyTrashPending(job)) {
		return { kind: "key", key: "transfersCopyMovingToTrash" }
	}

	switch (job.outcome.status) {
		case "running":
			return runningStatus(job)
		case "done":
			return trashedStatus(job) ?? { kind: "key", key: "transfersStatusDone" }
		case "doneWithFailures":
			return trashedStatus(job) ?? { kind: "key", key: "transfersCopyFailedItems", count: job.failures.length }
		case "quotaExceeded":
			return { kind: "quota", freeBytes: job.outcome.freeBytes }
		case "failed": {
			const trash = trashedStatus(job)

			return trash === undefined ? { kind: "error", error: job.outcome.error } : { kind: "error", error: job.outcome.error, trash }
		}
		case "cancelled":
			return cancelledStatus(job)
	}
}

// What the stop's move to the trash did, for a copy that ended before the stop reached it.
function trashedStatus(job: CopyJob): CopyJobKeyStatus | undefined {
	if (job.trashResult === null) {
		return undefined
	}

	if (job.trashResult.failed > 0) {
		return { kind: "key", key: "transfersCopyTrashFailed" }
	}

	return { kind: "key", key: "transfersCopyTrashed", count: job.trashResult.moved }
}

function runningStatus(job: CopyJob): CopyJobStatus {
	if (job.cancelling || job.cancelRequest !== null) {
		return { kind: "key", key: "transfersCopyPhaseCancelling" }
	}

	if (job.paused) {
		return { kind: "key", key: "transfersStatusPaused" }
	}

	if (job.pausing) {
		return { kind: "key", key: "transfersCopyPhasePausing" }
	}

	switch (job.phase) {
		case "scanning":
			return { kind: "key", key: "transfersCopyPhaseScanning" }
		case "creatingDirectories":
			return { kind: "key", key: "transfersCopyPhaseCreatingDirectories" }
		case "finishing":
			return { kind: "key", key: "transfersCopyPhaseFinishing" }
		default:
			return { kind: "files", done: job.counts.filesDone, count: job.totals.files }
	}
}

function cancelledStatus(job: CopyJob): CopyJobStatus {
	if (job.trashResult === null) {
		return { kind: "key", key: "transfersCopyCancelledKept" }
	}

	if (job.trashResult.failed > 0) {
		return { kind: "key", key: "transfersCopyCancelledTrashFailed" }
	}

	return { kind: "key", key: "transfersCopyCancelledTrashed", count: job.trashResult.moved }
}

export const COPY_CARD_FAILURES_SHOWN = 20
export const COPY_CARD_ACTIVE_SHOWN = 5

export type CopyJobNoteKey =
	"transfersCopyRenamedNote" | "transfersCopySkippedNote" | "transfersCopySavedAsVersionNote" | "transfersCopyPropagationNote"

// The notes the details section lists, each with its count; zero counts are left out.
export function copyJobNotes(job: CopyJob): { key: CopyJobNoteKey; count: number }[] {
	const notes: { key: CopyJobNoteKey; count: number }[] = [
		{ key: "transfersCopyRenamedNote", count: job.renamedCount },
		{ key: "transfersCopySkippedNote", count: job.counts.entriesSkipped },
		{ key: "transfersCopySavedAsVersionNote", count: job.savedAsVersionCount },
		{ key: "transfersCopyPropagationNote", count: job.propagationFailedCount }
	]

	return notes.filter(note => note.count > 0)
}

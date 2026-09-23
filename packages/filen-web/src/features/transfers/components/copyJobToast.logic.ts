import { clampedRatio } from "@filen/shared"
import { type CopyJob } from "@/features/drive/lib/copy.logic"

// Pure reads of a copy job for its progress card, so what the card says is testable without rendering.

export function isCopyJobRunning(job: CopyJob): boolean {
	return job.outcome.status === "running"
}

// 0-100 for the bar, or null while the total is still unknown (the scan), which renders indeterminate.
export function copyJobPercent(job: CopyJob): number | null {
	if (job.outcome.status === "done") {
		return 100
	}

	if (isCopyJobRunning(job) && (job.phase === "scanning" || job.totals.bytes === 0)) {
		return null
	}

	return clampedRatio(job.counts.bytesDone, job.totals.bytes, 100)
}

export type CopyJobTitle =
	| { key: "transfersCopyCardTitleRunning" | "transfersCopyCardTitleDone"; count: number; destination: string }
	| { key: "transfersCopyCardTitleEnded"; destination: string }

export function copyJobTitle(job: CopyJob): CopyJobTitle {
	const destination = job.destination.name

	switch (job.outcome.status) {
		case "running":
			return { key: "transfersCopyCardTitleRunning", count: job.itemCount, destination }
		case "done":
			return { key: "transfersCopyCardTitleDone", count: job.itemCount, destination }
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

// The line under the title. A failed copy shows its error's own label, which is already localized.
export type CopyJobStatus =
	| { kind: "key"; key: CopyJobStatusKey; count?: number }
	| { kind: "files"; done: number; count: number }
	| { kind: "error"; label: string }
	| { kind: "quota"; freeBytes: number }

export function copyJobStatus(job: CopyJob): CopyJobStatus {
	switch (job.outcome.status) {
		case "running":
			return runningStatus(job)
		case "done":
			return { kind: "key", key: "transfersStatusDone" }
		case "doneWithFailures":
			return { kind: "key", key: "transfersCopyFailedItems", count: job.failures.length }
		case "quotaExceeded":
			return { kind: "quota", freeBytes: job.outcome.freeBytes }
		case "failed":
			return { kind: "error", label: job.outcome.error.label }
		case "cancelled":
			return cancelledStatus(job)
	}
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

// Speed and time left only mean something while bytes are moving.
export function copyJobRate(job: CopyJob): { bytesPerSecond: number; etaSeconds: number | null } | null {
	if (!isCopyJobRunning(job) || job.paused || job.pausing || job.bytesPerSecond === null || job.bytesPerSecond <= 0) {
		return null
	}

	return { bytesPerSecond: job.bytesPerSecond, etaSeconds: job.etaMs === null ? null : Math.ceil(job.etaMs / 1000) }
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

import { cappedTotal, isJobRunning, summarizeDispositions, type JobDisposition, type SourceDisposalKind } from "@filen/shared"
import { isExtractTrashPending, type CompressJob, type ExtractJob } from "@/features/drive/lib/archiveJobs.logic"
import { RESULT_TOAST_MS, RESULT_TOAST_WITH_PROBLEMS_MS } from "@/lib/toastDurations"
import { type ErrorDTO } from "@/lib/sdk/errors"

// Pure reads of a compress or extract job for its progress card, the copy card's siblings
// (copyJobToast.logic.ts), so what the card says is testable without rendering.

export type ArchiveJob = CompressJob | ExtractJob

// Sticky while the job still does something, and while it waits for a password only the card and its row
// can take; timed once it is over, longer when there is something to read.
export function archiveCardDuration(job: ArchiveJob): number {
	if (isJobRunning(job) || (job.kind === "extract" && isExtractTrashPending(job))) {
		return Infinity
	}

	if (job.outcome.status === "passwordRequired" || job.outcome.status === "wrongPassword") {
		return Infinity
	}

	const clean =
		job.outcome.status === "done" && job.cancelRequest === null && (job.kind === "compress" || cappedTotal(job.misleadingNames) === 0)

	return clean ? RESULT_TOAST_MS : RESULT_TOAST_WITH_PROBLEMS_MS
}

export type ArchiveJobTitle =
	| { key: "transfersCompressCardTitleRunning" | "transfersCompressCardTitleDone"; values: { count: number; name: string } }
	| { key: "transfersCompressCardTitleEnded"; values: { name: string } }
	| {
			key: "transfersExtractCardTitleExtracting" | "transfersExtractCardTitleExtracted" | "transfersExtractCardTitleEnded"
			values: { name: string; destination: string }
	  }

export function compressJobTitle(job: CompressJob): ArchiveJobTitle {
	const values = { count: job.itemCount, name: job.name }

	switch (job.outcome.status) {
		case "running":
			return { key: "transfersCompressCardTitleRunning", values }
		// The archive is saved, whatever else needs a look.
		case "done":
		case "doneWithIssues":
			return { key: "transfersCompressCardTitleDone", values }
		default:
			return { key: "transfersCompressCardTitleEnded", values: { name: job.name } }
	}
}

export function extractJobTitle(job: ExtractJob): ArchiveJobTitle {
	const values = { name: job.archiveName, destination: job.destination.name }

	switch (job.outcome.status) {
		case "running":
			return { key: "transfersExtractCardTitleExtracting", values }
		case "done":
			// A stop asking for the trash undoes even an extract that finished before the stop reached it.
			return { key: job.cancelRequest === "trash" ? "transfersExtractCardTitleEnded" : "transfersExtractCardTitleExtracted", values }
		default:
			return { key: "transfersExtractCardTitleEnded", values }
	}
}

// Plural keys are named by their base; i18next picks _one/_other from `count`.
export type ArchiveJobStatusKey =
	| "transfersStatusDone"
	| "transfersStatusPaused"
	| "transfersStatusWaitingForSlot"
	| "transfersCopyPhaseCancelling"
	| "transfersCopyPhasePausing"
	| "transfersCopyPhaseScanning"
	| "transfersCopyPhaseFinishing"
	| "transfersJobDoneWithIssues"
	| "transfersArchivePhaseTrashingOriginals"
	| "transfersArchivePhaseDeletingOriginals"
	| "transfersCompressPhaseVerifying"
	| "transfersCompressCancelled"
	| "transfersExtractPhaseScanning"
	| "transfersExtractFilesExtracted"
	| "transfersExtractFailedItems"
	| "transfersExtractCancelledKept"
	| "transfersExtractCancelledTrashed"
	| "transfersExtractCancelledTrashFailed"
	| "transfersExtractTrashed"
	| "transfersExtractTrashFailed"
	| "transfersExtractMovingToTrash"

export interface ArchiveJobKeyStatus {
	kind: "key"
	key: ArchiveJobStatusKey
	count?: number
}

// The line under the title. Errors are put into words where they're shown, so the text follows the
// language. A refusal part way through states no total, so neededBytes can be unknown.
export type ArchiveJobStatus =
	| ArchiveJobKeyStatus
	| { kind: "files"; done: number; count: number }
	| { kind: "listing"; done: number; count: number }
	| { kind: "error"; error: ErrorDTO; trash?: ArchiveJobKeyStatus }
	| { kind: "quota"; neededBytes: number | null; freeBytes: number }
	| { kind: "password"; wrong: boolean }

function disposalStatus(dispose: SourceDisposalKind | null): ArchiveJobKeyStatus {
	return {
		kind: "key",
		key: dispose === "deletePermanently" ? "transfersArchivePhaseDeletingOriginals" : "transfersArchivePhaseTrashingOriginals"
	}
}

// What a stop, a pause or the slot queue makes of a running job, before its phase says anything.
function runStateStatus(job: ArchiveJob): ArchiveJobKeyStatus | undefined {
	if (job.cancelling || job.cancelRequest !== null) {
		return { kind: "key", key: "transfersCopyPhaseCancelling" }
	}

	if (job.paused) {
		return { kind: "key", key: "transfersStatusPaused" }
	}

	if (job.pausing) {
		return { kind: "key", key: "transfersCopyPhasePausing" }
	}

	return job.phase === "waitingForWorker" ? { kind: "key", key: "transfersStatusWaitingForSlot" } : undefined
}

export function compressJobStatus(job: CompressJob): ArchiveJobStatus {
	switch (job.outcome.status) {
		case "running":
			return runStateStatus(job) ?? compressPhaseStatus(job)
		case "done":
			return { kind: "key", key: "transfersStatusDone" }
		case "doneWithIssues":
			return job.endError === null ? { kind: "key", key: "transfersJobDoneWithIssues" } : { kind: "error", error: job.endError }
		case "cancelled":
			return { kind: "key", key: "transfersCompressCancelled" }
		case "quotaExceeded":
			return { kind: "quota", neededBytes: job.outcome.neededBytes, freeBytes: job.outcome.freeBytes }
		case "passwordRequired":
		case "wrongPassword":
			return { kind: "password", wrong: job.outcome.status === "wrongPassword" }
		case "failed":
			return { kind: "error", error: job.outcome.error }
	}
}

function compressPhaseStatus(job: CompressJob): ArchiveJobStatus {
	switch (job.phase) {
		case "scanning":
			return job.scan.sourcesTotal > 0
				? { kind: "listing", done: job.scan.sourcesDone, count: job.scan.sourcesTotal }
				: { kind: "key", key: "transfersCopyPhaseScanning" }
		case "finishing":
			return { kind: "key", key: "transfersCopyPhaseFinishing" }
		case "verifying":
			return { kind: "key", key: "transfersCompressPhaseVerifying" }
		case "disposingSources":
			return disposalStatus(job.dispose)
		default:
			return { kind: "files", done: job.counts.filesDone, count: job.totals.files }
	}
}

export function extractJobStatus(job: ExtractJob): ArchiveJobStatus {
	if (isExtractTrashPending(job)) {
		return { kind: "key", key: "transfersExtractMovingToTrash" }
	}

	switch (job.outcome.status) {
		case "running":
			return runStateStatus(job) ?? extractPhaseStatus(job)
		case "done":
			return extractTrashedStatus(job) ?? { kind: "key", key: "transfersStatusDone" }
		case "doneWithIssues": {
			const failed = cappedTotal(job.failures)

			return (
				extractTrashedStatus(job) ??
				(failed > 0
					? { kind: "key", key: "transfersExtractFailedItems", count: failed }
					: { kind: "key", key: "transfersJobDoneWithIssues" })
			)
		}
		case "quotaExceeded":
			return { kind: "quota", neededBytes: job.outcome.neededBytes, freeBytes: job.outcome.freeBytes }
		case "passwordRequired":
		case "wrongPassword":
			return { kind: "password", wrong: job.outcome.status === "wrongPassword" }
		case "failed": {
			const trash = extractTrashedStatus(job)

			return trash === undefined ? { kind: "error", error: job.outcome.error } : { kind: "error", error: job.outcome.error, trash }
		}
		case "cancelled":
			return extractCancelledStatus(job)
	}
}

function extractPhaseStatus(job: ExtractJob): ArchiveJobStatus {
	switch (job.phase) {
		case "scanning":
			return { kind: "key", key: "transfersExtractPhaseScanning" }
		case "finishing":
			return { kind: "key", key: "transfersCopyPhaseFinishing" }
		case "disposingSources":
			return disposalStatus(job.dispose)
		default:
			// Only a listing tells how many files are to come.
			return job.basis.type === "planned"
				? { kind: "files", done: job.counts.filesDone, count: job.basis.files }
				: { kind: "key", key: "transfersExtractFilesExtracted", count: job.counts.filesDone }
	}
}

// What the stop's move to the trash did, for an extract that ended before the stop reached it.
function extractTrashedStatus(job: ExtractJob): ArchiveJobKeyStatus | undefined {
	if (job.trashResult === null) {
		return undefined
	}

	if (job.trashResult.failed > 0) {
		return { kind: "key", key: "transfersExtractTrashFailed" }
	}

	return { kind: "key", key: "transfersExtractTrashed", count: job.trashResult.moved }
}

function extractCancelledStatus(job: ExtractJob): ArchiveJobKeyStatus {
	if (job.trashResult === null) {
		return { kind: "key", key: "transfersExtractCancelledKept" }
	}

	if (job.trashResult.failed > 0) {
		return { kind: "key", key: "transfersExtractCancelledTrashFailed" }
	}

	return { kind: "key", key: "transfersExtractCancelledTrashed", count: job.trashResult.moved }
}

// The result line of an extract that got anywhere; a password stop has nothing to sum up.
export function extractJobSummary(job: ExtractJob): { extracted: number; skipped: number; failed: number } | null {
	if (isJobRunning(job) || job.outcome.status === "passwordRequired" || job.outcome.status === "wrongPassword") {
		return null
	}

	const summary = { extracted: job.counts.filesDone, skipped: cappedTotal(job.skipped), failed: cappedTotal(job.failures) }

	return summary.extracted + summary.skipped + summary.failed > 0 ? summary : null
}

export type ArchiveJobNoteKey =
	| "transfersCopyRenamedNote"
	| "transfersCopySkippedNote"
	| "transfersCopySavedAsVersionNote"
	| "transfersCopyPropagationNote"
	| "transfersArchiveOriginalsKeptNote"
	| "transfersCompressHashMismatchNote"
	| "transfersCompressStoppedAfterArchiveNote"
	| "transfersCompressLateArchiveNote"
	| "transfersExtractSkippedNote"
	| "transfersExtractMacMetadataNote"
	| "transfersExtractTopLevelTrashedNote"

// The card re-renders on every update, while the dispositions change far less often: each count is kept
// for the list it was taken from.
const keptCounts = new WeakMap<readonly JobDisposition<unknown>[], number>()

function keptCount(dispositions: readonly JobDisposition<unknown>[]): number {
	let count = keptCounts.get(dispositions)

	if (count === undefined) {
		count = summarizeDispositions(dispositions).kept
		keptCounts.set(dispositions, count)
	}

	return count
}

// The notes the details section lists, each with its count; zero counts are left out. A note that only
// states a fact counts 1.
export function archiveJobNotes(job: ArchiveJob): { key: ArchiveJobNoteKey; count: number }[] {
	const notes: { key: ArchiveJobNoteKey; count: number }[] =
		job.kind === "compress"
			? [
					{ key: "transfersCopyRenamedNote", count: cappedTotal(job.renamed) },
					{ key: "transfersCopySkippedNote", count: cappedTotal(job.skipped) },
					{ key: "transfersCompressHashMismatchNote", count: cappedTotal(job.hashMismatches) },
					{ key: "transfersCopyPropagationNote", count: job.propagationFailedCount },
					{ key: "transfersArchiveOriginalsKeptNote", count: keptCount(job.dispositions) },
					{ key: "transfersCompressStoppedAfterArchiveNote", count: job.stoppedAfterArchive ? 1 : 0 },
					{ key: "transfersCompressLateArchiveNote", count: job.lateArchive ? 1 : 0 }
				]
			: [
					{ key: "transfersCopyRenamedNote", count: cappedTotal(job.renamed) },
					{ key: "transfersExtractSkippedNote", count: cappedTotal(job.skipped) },
					{ key: "transfersExtractMacMetadataNote", count: job.macMetadataSkippedCount },
					{ key: "transfersCopySavedAsVersionNote", count: job.savedAsVersionCount },
					{ key: "transfersCopyPropagationNote", count: job.propagationFailedCount },
					{ key: "transfersExtractTopLevelTrashedNote", count: job.topLevelTrashedCount },
					{ key: "transfersArchiveOriginalsKeptNote", count: keptCount(job.dispositions) }
				]

	return notes.filter(note => note.count > 0)
}

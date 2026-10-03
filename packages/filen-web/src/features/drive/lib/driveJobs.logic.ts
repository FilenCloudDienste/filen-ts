import {
	cappedTotal,
	compressJobPercent,
	compressJobRowFigures,
	copyJobPercent,
	copyJobRate,
	copyJobShownBytes,
	extractJobPercent,
	extractJobRowFigures,
	isJobRunning,
	jobRate,
	type DriveJobKind,
	type JobRowFigures
} from "@filen/shared"
import { canRetryCopy, isCopyTrashPending, type CopyJob } from "@/features/drive/lib/copy.logic"
import {
	canRerunCompress,
	canRetryExtract,
	isExtractTrashPending,
	type CompressJob,
	type ExtractJob
} from "@/features/drive/lib/archiveJobs.logic"
import type { DriveItem } from "@/features/drive/lib/item"

// Reads of any drive job, whatever its kind, for the surfaces that show one by id alone (the transfers
// row, the card, the pending rows). Copy goes through its own functions, unchanged.

export type DriveJob = CopyJob | CompressJob | ExtractJob

export type DriveJobOf<K extends DriveJobKind> = Extract<DriveJob, { kind: K }>

export function isDriveJobRunning(job: DriveJob): boolean {
	return isJobRunning(job)
}

export function driveJobPercent(job: DriveJob): number | null {
	switch (job.kind) {
		case "copy":
			return copyJobPercent(job)
		case "compress":
			return compressJobPercent(job)
		case "extract":
			return extractJobPercent(job)
	}
}

export function driveJobRowFigures(job: DriveJob): JobRowFigures {
	switch (job.kind) {
		case "copy":
			return { size: job.totals.bytes, shown: copyJobShownBytes(job) }
		case "compress":
			return compressJobRowFigures(job)
		case "extract":
			return extractJobRowFigures(job)
	}
}

export function driveJobRate(job: DriveJob): { bytesPerSecond: number; etaSeconds: number | null } | null {
	return job.kind === "copy" ? copyJobRate(job) : jobRate(job)
}

// A settled job whose stop is still moving what it made to the trash. A compress stop leaves nothing.
export function isDriveJobTrashPending(job: DriveJob): boolean {
	switch (job.kind) {
		case "copy":
			return isCopyTrashPending(job)
		case "compress":
			return false
		case "extract":
			return isExtractTrashPending(job)
	}
}

// A compress leaves nothing behind when stopped, so there is nothing to keep or trash.
export function jobCancelStyle(job: DriveJob): "keepOrTrash" | "confirm" {
	return job.kind === "compress" ? "confirm" : "keepOrTrash"
}

// "failed" retries what failed in a new job; "rerun" starts the whole job again.
export function jobRetryKind(job: DriveJob): "failed" | "rerun" | null {
	switch (job.kind) {
		case "copy":
			return canRetryCopy(job) ? "failed" : null
		case "compress":
			return canRerunCompress(job) ? "rerun" : null
		case "extract":
			return canRetryExtract(job) ? "failed" : null
	}
}

// Whether a settled archive job has anything its report lists. Copy's card lists its failures itself.
export function jobHasReport(job: DriveJob): boolean {
	if (isJobRunning(job)) {
		return false
	}

	switch (job.kind) {
		case "copy":
			return false
		case "compress":
			return (
				cappedTotal(job.skipped) > 0 ||
				cappedTotal(job.renamed) > 0 ||
				cappedTotal(job.hashMismatches) > 0 ||
				job.dispositions.length > 0 ||
				job.propagationFailedCount > 0
			)
		case "extract":
			return (
				cappedTotal(job.failures) > 0 ||
				cappedTotal(job.skipped) > 0 ||
				cappedTotal(job.renamed) > 0 ||
				cappedTotal(job.misleadingNames) > 0 ||
				job.duplicates !== null ||
				job.dispositions.length > 0 ||
				job.savedAsVersionCount > 0 ||
				job.propagationFailedCount > 0
			)
	}
}

// What "Show in directory" reveals: the archive, the extracted directory or first item, or a copy's first
// item. What a stop sends to the trash is nothing to go and see.
export function jobRevealItem(job: DriveJob): DriveItem | null {
	if (job.cancelRequest === "trash") {
		return null
	}

	switch (job.kind) {
		case "copy":
			return job.created[0] ?? null
		case "compress":
			return job.archive
		case "extract":
			return job.firstCreated
	}
}

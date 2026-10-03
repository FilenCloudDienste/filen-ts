import { cappedTotal, copyJobPercent, copyJobRate, isCopyJobRunning, isJobRunning, type DriveJobKind } from "@filen/shared"
import { canRetryCopy, type CopyJob } from "@/features/drive/lib/copy.logic"
import {
	driveJobPercent,
	driveJobRate,
	driveJobRowFigures,
	jobHasReport,
	jobRetryKind,
	jobRevealItem,
	type DriveJob
} from "@/features/drive/lib/driveJobs.logic"
import { type DriveItem } from "@/features/drive/lib/item"
import {
	COPY_CARD_ACTIVE_SHOWN,
	COPY_CARD_FAILURES_SHOWN,
	copyCardDuration,
	copyJobNotes,
	copyJobStatus,
	copyJobTitle,
	type CopyJobKeyStatus,
	type CopyJobNoteKey,
	type CopyJobStatus,
	type CopyJobTitle
} from "@/features/transfers/components/copyJobToast.logic"
import {
	archiveCardDuration,
	archiveJobNotes,
	compressJobStatus,
	compressJobTitle,
	extractJobStatus,
	extractJobSummary,
	extractJobTitle,
	type ArchiveJobKeyStatus,
	type ArchiveJobNoteKey,
	type ArchiveJobStatus,
	type ArchiveJobTitle
} from "@/features/transfers/components/archiveJobToast.logic"
import { type ErrorDTO } from "@/lib/sdk/errors"

// One view-model for every drive job's progress card (copy, compress, extract), so the card renders the
// same way whatever the kind. Copy goes through its own reads (copyJobToast.logic.ts) unchanged.

export function jobCardDuration(job: DriveJob): number {
	return job.kind === "copy" ? copyCardDuration(job) : archiveCardDuration(job)
}

// The words that only change with the kind.
const LABELS = {
	copy: {
		dismiss: "transfersCopyCardDismiss",
		progress: "transfersCopyProgressLabel",
		tabNote: "transfersCopyTabNote",
		current: "transfersCopyCurrentFiles",
		failures: "transfersCopyFailures",
		quota: "transfersCopyQuotaExceeded"
	},
	compress: {
		dismiss: "transfersCompressCardDismiss",
		progress: "transfersCompressProgressLabel",
		tabNote: "transfersCompressTabNote",
		current: "transfersCompressCurrentFiles",
		// A compress has no failures of single items; the card never shows this heading for one.
		failures: "transfersExtractFailures",
		quota: "transfersCompressQuotaExceeded"
	},
	extract: {
		dismiss: "transfersExtractCardDismiss",
		progress: "transfersExtractProgressLabel",
		tabNote: "transfersExtractTabNote",
		current: "transfersExtractCurrentFiles",
		failures: "transfersExtractFailures",
		quota: "transfersExtractQuotaExceeded"
	}
} as const

export type JobCardLabels = (typeof LABELS)[DriveJobKind]

export type JobCardKeyStatus = CopyJobKeyStatus | ArchiveJobKeyStatus

export type JobCardStatus =
	| JobCardKeyStatus
	| { kind: "files"; done: number; count: number }
	| { kind: "listing"; done: number; count: number }
	| { kind: "error"; error: ErrorDTO; trash?: JobCardKeyStatus }
	| { kind: "quota"; neededBytes: number | null; freeBytes: number }
	| { kind: "password"; wrong: boolean }

export interface JobCardTitle {
	key: CopyJobTitle["key"] | ArchiveJobTitle["key"]
	values: Readonly<Record<string, string | number>>
}

export type JobCardWarningKey = "transfersExtractMisleadingNamesWarning" | "transfersJobSlotHeldWarning"

export interface JobCardActiveFile {
	key: string
	name: string
	done: number
	// null when the archive states none.
	size: number | null
}

export interface JobCardFailure {
	key: string
	path: string
	error: ErrorDTO
}

export interface JobCardModel {
	labels: JobCardLabels
	title: JobCardTitle
	status: JobCardStatus
	statusFailed: boolean
	percent: number | null
	bytes: { done: number; total: number } | null
	rate: { bytesPerSecond: number; etaSeconds: number | null } | null
	// An extract's result line.
	summary: { extracted: number; skipped: number; failed: number } | null
	warnings: { key: JobCardWarningKey; count: number }[]
	notes: { key: CopyJobNoteKey | ArchiveJobNoteKey; count: number }[]
	details: { active: JobCardActiveFile[]; failures: JobCardFailure[]; moreFailures: number }
	actions: {
		pauseCancel: boolean
		// Failures go again into where they were meant for; a rerun starts the whole job again.
		retry: "failed" | "rerun" | null
		report: boolean
		password: boolean
		showDirectory: DriveItem | null
	}
}

export interface JobCardContext {
	// This job is paused while holding the page's one archive slot that another job waits for.
	slotHeldWhilePaused: boolean
}

function copyCardModel(job: CopyJob): JobCardModel {
	const title = copyJobTitle(job)
	const status: CopyJobStatus = copyJobStatus(job)
	const failures = job.failures.slice(0, COPY_CARD_FAILURES_SHOWN)

	return {
		labels: LABELS.copy,
		title:
			title.key === "transfersCopyCardTitleEnded"
				? { key: title.key, values: { destination: title.destination } }
				: { key: title.key, values: { count: title.count, destination: title.destination } },
		status,
		statusFailed: job.outcome.status === "failed" || job.outcome.status === "quotaExceeded",
		percent: copyJobPercent(job),
		bytes: job.totals.bytes > 0 ? { done: job.counts.bytesDone, total: job.totals.bytes } : null,
		rate: copyJobRate(job),
		summary: null,
		warnings: [],
		notes: copyJobNotes(job),
		details: {
			active: job.active
				.slice(0, COPY_CARD_ACTIVE_SHOWN)
				.map(file => ({ key: file.destUuid, name: file.name, done: file.bytesDone, size: file.size })),
			failures: failures.map(failure => ({
				key: `${failure.sourceUuid}:${failure.destName}`,
				path: failure.sourcePath,
				error: failure.error
			})),
			moreFailures: job.failures.length - failures.length
		},
		actions: {
			pauseCancel: isCopyJobRunning(job),
			retry: canRetryCopy(job) ? "failed" : null,
			report: false,
			password: false,
			showDirectory: null
		}
	}
}

export function jobCardModel(job: DriveJob, context: JobCardContext): JobCardModel {
	if (job.kind === "copy") {
		return copyCardModel(job)
	}

	const running = isJobRunning(job)
	const figures = driveJobRowFigures(job)
	const warnings: JobCardModel["warnings"] = []
	let title: ArchiveJobTitle
	let status: ArchiveJobStatus
	let active: JobCardActiveFile[]
	let failures: JobCardFailure[] = []
	let moreFailures = 0

	if (job.kind === "compress") {
		title = compressJobTitle(job)
		status = compressJobStatus(job)
		active = job.active
			.slice(0, COPY_CARD_ACTIVE_SHOWN)
			.map(file => ({ key: file.sourceUuid, name: file.name, done: file.bytesDone, size: file.size }))
	} else {
		const misleading = cappedTotal(job.misleadingNames)
		const shown = job.failures.items.slice(0, COPY_CARD_FAILURES_SHOWN)

		title = extractJobTitle(job)
		status = extractJobStatus(job)
		active = job.active
			.slice(0, COPY_CARD_ACTIVE_SHOWN)
			.map(file => ({ key: file.destUuid, name: file.name, done: file.bytesDone, size: file.size }))
		failures = shown.map(failure => ({
			key: `${failure.entry.archive}:${String(failure.entry.index)}`,
			path: failure.path,
			error: failure.error
		}))
		moreFailures = cappedTotal(job.failures) - shown.length

		if (misleading > 0) {
			warnings.push({ key: "transfersExtractMisleadingNamesWarning", count: misleading })
		}
	}

	if (context.slotHeldWhilePaused) {
		warnings.push({ key: "transfersJobSlotHeldWarning", count: 1 })
	}

	const outcome = job.outcome.status

	return {
		labels: LABELS[job.kind],
		title,
		status,
		statusFailed: outcome === "failed" || outcome === "quotaExceeded" || outcome === "wrongPassword",
		percent: driveJobPercent(job),
		bytes: figures.size > 0 ? { done: figures.shown, total: figures.size } : null,
		rate: driveJobRate(job),
		summary: job.kind === "extract" ? extractJobSummary(job) : null,
		warnings,
		notes: archiveJobNotes(job),
		details: { active, failures, moreFailures },
		actions: {
			pauseCancel: running,
			retry: jobRetryKind(job),
			report: !running && jobHasReport(job),
			password: outcome === "passwordRequired" || outcome === "wrongPassword",
			// What a stop sends to the trash is nothing to go and see.
			showDirectory: running || job.cancelRequest === "trash" ? null : jobRevealItem(job)
		}
	}
}

// What the stop prompt shows for the job it is open for: everything it reads is a primitive, so it
// re-renders only when one of them changes, not on every progress update.
export interface JobCancelPrompt {
	open: boolean
	kind: DriveJobKind
	destination: string
	// A compress whose archive is already saved: stopping now only keeps the originals not yet removed.
	afterArchive: boolean
	// An extract whose archive is being removed: what it extracted no longer goes to the trash, since the
	// archive may be gone with it.
	disposingArchive: boolean
}

export function jobCancelPrompt(job: DriveJob | undefined): JobCancelPrompt | null {
	if (job === undefined) {
		return null
	}

	return {
		open: isJobRunning(job) && job.cancelRequest === null,
		kind: job.kind,
		destination: job.destination.name,
		afterArchive: job.kind === "compress" && (job.phase === "verifying" || job.phase === "disposingSources"),
		disposingArchive: job.kind === "extract" && job.phase === "disposingSources" && job.dispose !== null
	}
}

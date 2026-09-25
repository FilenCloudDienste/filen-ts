import { freeBytes, type StorageCounters } from "./storageQuota"

// Pure state for one copy job. The SDK's bigint progress is narrowed to numbers here, so nothing
// downstream renders or compares a bigint. Each app's adapter maps its own SDK surface onto the inputs
// below (the phase as a string, an update's events already classified); the item, failure and error
// shapes stay the app's own.

export type CopyJobPhase = "scanning" | "creatingDirectories" | "copyingFiles" | "finishing" | "done" | "cancelled" | "failed"

export interface CopyDestination {
	// null for the drive root.
	uuid: string | null
	name: string
}

export interface CopyJobActiveFile {
	destUuid: string
	name: string
	size: number
	bytesDone: number
}

export interface CopyJobCounts {
	dirsCreated: number
	dirsFailed: number
	filesDone: number
	filesFailed: number
	bytesDone: number
	bytesFailed: number
	dirsNotAttempted: number
	filesNotAttempted: number
	bytesNotAttempted: number
	entriesSkipped: number
	bytesSkipped: number
}

export interface CopyJobTotals {
	dirs: number
	files: number
	bytes: number
}

// The SDK's progress figures, shaped alike on every surface.
export type CopyCountsInput = { readonly [K in keyof CopyJobCounts]: bigint }
export type CopyTotalsInput = { readonly [K in keyof CopyJobTotals]: bigint }

export interface CopyActiveFileInput {
	destUuid: string
	name: string
	size: bigint
	bytesDone: bigint
}

// What an update's events add. A file the backend registered as a new version of an existing one is
// not a failure the user can act on: its bytes are stored, retrying would add yet another version, and
// it is not a copy to trash.
export interface CopyUpdateEvents<TFailure> {
	failures: TFailure[]
	savedAsVersion: number
	renamed: number
	propagationFailed: number
}

// One progress callback: the complete current state plus what its events add.
export interface CopyUpdateInput<TFailure> {
	phase: CopyJobPhase
	pausing: boolean
	paused: boolean
	cancelling: boolean
	scan: { sourcesDone: bigint; sourcesTotal: bigint }
	totals: CopyTotalsInput
	counts: CopyCountsInput
	active: readonly CopyActiveFileInput[]
	bytesPerSecond: bigint | undefined
	etaMs: bigint | undefined
	events: CopyUpdateEvents<TFailure>
}

export interface CopyJobErrorLike {
	kind?: string | undefined
}

export interface CopyReportInput<TFailure, TRetryable, TError extends CopyJobErrorLike> {
	createdCount: number
	totals: CopyTotalsInput
	counts: CopyCountsInput
	// What a retry could fix, each as shown and as the SDK takes it back; saved-as-version files are
	// counted apart.
	failures: { failure: TFailure; retryable: TRetryable }[]
	savedAsVersionCount: number
	renamedCount: number
	// Why the job ended early; undefined when it ran to the end, failures of single items included.
	error: TError | undefined
}

export type CopyJobOutcome<TError> =
	| { status: "running" }
	| { status: "done" }
	| { status: "doneWithFailures" }
	| { status: "cancelled" }
	| { status: "quotaExceeded"; neededBytes: number; freeBytes: number }
	| { status: "failed"; error: TError }

export interface CopyJob<TItem, TFailure, TRetryable, TError> {
	id: string
	destination: CopyDestination
	itemCount: number
	phase: CopyJobPhase
	pausing: boolean
	paused: boolean
	cancelling: boolean
	scan: { sourcesDone: number; sourcesTotal: number }
	totals: CopyJobTotals
	counts: CopyJobCounts
	active: CopyJobActiveFile[]
	bytesPerSecond: number | null
	etaMs: number | null
	failures: TFailure[]
	renamedCount: number
	savedAsVersionCount: number
	propagationFailedCount: number
	// Top-level items this job created — the only ones "move copied items to trash" may touch.
	created: TItem[]
	// The report's failures, as the SDK takes them back for a retry.
	retryable: TRetryable[]
	cancelRequest: "keep" | "trash" | null
	// What "move copied items to trash" did, once it ran.
	trashResult: { moved: number; failed: number } | null
	outcome: CopyJobOutcome<TError>
}

const ZERO_COUNTS: CopyJobCounts = {
	dirsCreated: 0,
	dirsFailed: 0,
	filesDone: 0,
	filesFailed: 0,
	bytesDone: 0,
	bytesFailed: 0,
	dirsNotAttempted: 0,
	filesNotAttempted: 0,
	bytesNotAttempted: 0,
	entriesSkipped: 0,
	bytesSkipped: 0
}

export function createCopyJob<TItem, TFailure, TRetryable, TError>(
	id: string,
	destination: CopyDestination,
	itemCount: number
): CopyJob<TItem, TFailure, TRetryable, TError> {
	return {
		id,
		destination,
		itemCount,
		phase: "scanning",
		pausing: false,
		paused: false,
		cancelling: false,
		scan: { sourcesDone: 0, sourcesTotal: 0 },
		totals: { dirs: 0, files: 0, bytes: 0 },
		counts: ZERO_COUNTS,
		active: [],
		bytesPerSecond: null,
		etaMs: null,
		failures: [],
		renamedCount: 0,
		savedAsVersionCount: 0,
		propagationFailedCount: 0,
		created: [],
		retryable: [],
		cancelRequest: null,
		trashResult: null,
		outcome: { status: "running" }
	}
}

function toCounts(counts: CopyCountsInput): CopyJobCounts {
	return {
		dirsCreated: Number(counts.dirsCreated),
		dirsFailed: Number(counts.dirsFailed),
		filesDone: Number(counts.filesDone),
		filesFailed: Number(counts.filesFailed),
		bytesDone: Number(counts.bytesDone),
		bytesFailed: Number(counts.bytesFailed),
		dirsNotAttempted: Number(counts.dirsNotAttempted),
		filesNotAttempted: Number(counts.filesNotAttempted),
		bytesNotAttempted: Number(counts.bytesNotAttempted),
		entriesSkipped: Number(counts.entriesSkipped),
		bytesSkipped: Number(counts.bytesSkipped)
	}
}

function toTotals(totals: CopyTotalsInput): CopyJobTotals {
	return { dirs: Number(totals.dirs), files: Number(totals.files), bytes: Number(totals.bytes) }
}

export function applyCopyUpdate<TFailure, TJob extends CopyJob<unknown, TFailure, unknown, unknown>>(
	job: TJob,
	update: CopyUpdateInput<TFailure>
): TJob {
	const { failures, savedAsVersion, renamed, propagationFailed } = update.events

	return {
		...job,
		phase: update.phase,
		pausing: update.pausing,
		paused: update.paused,
		cancelling: update.cancelling,
		scan: { sourcesDone: Number(update.scan.sourcesDone), sourcesTotal: Number(update.scan.sourcesTotal) },
		totals: toTotals(update.totals),
		counts: toCounts(update.counts),
		active: update.active.map(file => ({
			destUuid: file.destUuid,
			name: file.name,
			size: Number(file.size),
			bytesDone: Number(file.bytesDone)
		})),
		bytesPerSecond: update.bytesPerSecond === undefined ? null : Number(update.bytesPerSecond),
		etaMs: update.etaMs === undefined ? null : Number(update.etaMs),
		failures: failures.length === 0 ? job.failures : [...job.failures, ...failures],
		renamedCount: job.renamedCount + renamed,
		savedAsVersionCount: job.savedAsVersionCount + savedAsVersion,
		propagationFailedCount: job.propagationFailedCount + propagationFailed
	}
}

export function applyCopyCreated<TItem, TJob extends CopyJob<TItem, unknown, unknown, unknown>>(job: TJob, item: TItem): TJob {
	return { ...job, created: [...job.created, item] }
}

// The SDK checks maxBytes after its scan and fails before writing anything, reporting the totals the
// copy needs as not attempted. The server's own limit can refuse the same way before anything lands.
export function isQuotaPreflightFailure(report: CopyReportInput<unknown, unknown, CopyJobErrorLike>): boolean {
	return (
		report.error?.kind === "MaxStorageReached" &&
		report.createdCount === 0 &&
		report.counts.dirsCreated === 0n &&
		report.counts.filesDone === 0n
	)
}

// The storage still free, as maxBytes takes it; undefined when unknown, which leaves the check to the
// server.
export function copyMaxBytes(info: StorageCounters | undefined): number | undefined {
	const free = info === undefined ? null : freeBytes(info)

	return free === null ? undefined : Number(free)
}

export type CopySettlement<TFailure, TRetryable, TError extends CopyJobErrorLike> =
	{ report: CopyReportInput<TFailure, TRetryable, TError>; maxBytes: number | undefined } | { error: TError }

// The report is authoritative once the job is over, so it replaces what the updates accumulated.
export function settleCopyJob<
	TFailure,
	TRetryable,
	TError extends CopyJobErrorLike,
	TJob extends CopyJob<unknown, TFailure, TRetryable, TError>
>(job: TJob, settlement: CopySettlement<TFailure, TRetryable, TError>): TJob {
	if ("error" in settlement) {
		const outcome: CopyJobOutcome<TError> =
			settlement.error.kind === "Cancelled" ? { status: "cancelled" } : { status: "failed", error: settlement.error }

		return { ...job, active: [], pausing: false, paused: false, outcome }
	}

	const { report, maxBytes } = settlement
	let outcome: CopyJobOutcome<TError>

	if (report.error === undefined) {
		outcome = report.failures.length === 0 ? { status: "done" } : { status: "doneWithFailures" }
	} else if (report.error.kind === "Cancelled") {
		outcome = { status: "cancelled" }
	} else if (isQuotaPreflightFailure(report) && maxBytes !== undefined && Number(report.totals.bytes) > maxBytes) {
		outcome = { status: "quotaExceeded", neededBytes: Number(report.totals.bytes), freeBytes: maxBytes }
	} else {
		outcome = { status: "failed", error: report.error }
	}

	return {
		...job,
		totals: toTotals(report.totals),
		counts: toCounts(report.counts),
		active: [],
		pausing: false,
		paused: false,
		failures: report.failures.map(entry => entry.failure),
		savedAsVersionCount: report.savedAsVersionCount,
		renamedCount: report.renamedCount,
		retryable: report.failures.map(entry => entry.retryable),
		outcome
	}
}

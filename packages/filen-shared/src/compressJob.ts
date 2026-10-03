import { toPlanTotals, type CopyJobTotals, type CopyTotalsInput } from "./copyJob"
import {
	EMPTY_CAPPED_LIST,
	appendCapped,
	cappedList,
	cappedTotal,
	jobNumber,
	jobNumberOrNull,
	jobRunFlags,
	mapCapped,
	toDisposition,
	type CappedList,
	type DispositionInput,
	type JobDestination,
	type JobDisposition,
	type JobErrorLike,
	type JobOutcome,
	type JobRunStateInput,
	type SourceDisposalKind
} from "./driveJob"

// Pure state for one compress job, the copy job's sibling: the SDK's bigints are narrowed here, the
// archive and error shapes stay the app's own.

export type CompressJobPhase =
	"scanning" | "waitingForWorker" | "compressing" | "finishing" | "verifying" | "disposingSources" | "done" | "cancelled" | "failed"

export interface CompressJobCounts {
	filesDone: number
	entriesSkipped: number
	bytesSkipped: number
	bytesRead: number
	bytesWritten: number
	// 0 until the archive is registered.
	archiveBytes: number
	// Read back before the sources are deleted for good.
	bytesVerified: number
}

export type CompressCountsInput = { readonly [K in keyof CompressJobCounts]: bigint }

export type CompressSkipReasonInput = { type: "undecryptableFile"; uuid: string } | { type: "unreachable"; count: bigint }

export type CompressSkipReason = { type: "undecryptableFile"; uuid: string } | { type: "unreachable"; count: number }

export interface CompressSkippedInput {
	sourcePath: string
	bytes: bigint
	reason: CompressSkipReasonInput
}

export interface CompressSkipped {
	sourcePath: string
	bytes: number
	reason: CompressSkipReason
}

export type CompressRenameReason = "duplicateName" | "undecryptable" | "invalidName"

export interface CompressRenamed {
	sourceUuid: string
	sourcePath: string
	name: string
	reason: CompressRenameReason
}

export interface CompressHashMismatch {
	sourceUuid: string
	path: string
}

export interface CompressActiveInput {
	sourceUuid: string
	name: string
	path: string
	size: bigint
	bytesDone: bigint
}

export interface CompressActive {
	sourceUuid: string
	name: string
	path: string
	size: number
	bytesDone: number
}

export type CompressEventInput<TError> =
	| ({ type: "skipped" } & CompressSkippedInput)
	| ({ type: "renamed" } & CompressRenamed)
	| ({ type: "sourceHashMismatch" } & CompressHashMismatch)
	| ({ type: "sourceDisposition" } & DispositionInput<TError>)
	| { type: "propagationFailed"; destUuid: string; error: TError }

// What the app's event delivery counted but did not pass on, past its own cap.
export interface CompressOmittedInput {
	skipped: number
	renamed: number
	hashMismatches: number
}

export interface CompressUpdateEvents<TError> {
	skipped: readonly CompressSkipped[]
	renamed: readonly CompressRenamed[]
	hashMismatches: readonly CompressHashMismatch[]
	dispositions: readonly JobDisposition<TError>[]
	propagationFailed: number
	omitted: CompressOmittedInput
}

// One progress callback: the complete current state plus what its events add.
export interface CompressUpdateInput<TError> {
	phase: CompressJobPhase
	runState: JobRunStateInput
	scan: { sourcesDone: bigint; sourcesTotal: bigint }
	totals: CopyTotalsInput
	counts: CompressCountsInput
	active: readonly CompressActiveInput[]
	bytesPerSecond: bigint | undefined
	etaMs: bigint | undefined
	events: CompressUpdateEvents<TError>
}

export interface CompressReportInput<TArchive, TError extends JobErrorLike> {
	archive: TArchive | undefined
	skipped: readonly CompressSkippedInput[]
	renamed: readonly CompressRenamed[]
	totals: CopyTotalsInput
	counts: CompressCountsInput
	// Set only when a storage limit refused the archive up front.
	neededBytes: bigint | undefined
	dispositions: readonly DispositionInput<TError>[]
	hashMismatches: readonly CompressHashMismatch[]
	omittedHashMismatches: bigint
	// Why the job ended early; undefined when it ran to the end.
	error: TError | undefined
}

export interface CompressJob<TArchive, TError> {
	id: string
	kind: "compress"
	destination: JobDestination
	name: string
	itemCount: number
	dispose: SourceDisposalKind | null
	encrypted: boolean
	phase: CompressJobPhase
	pausing: boolean
	paused: boolean
	cancelling: boolean
	scan: { sourcesDone: number; sourcesTotal: number }
	totals: CopyJobTotals
	counts: CompressJobCounts
	active: CompressActive[]
	bytesPerSecond: number | null
	etaMs: number | null
	skipped: CappedList<CompressSkipped>
	renamed: CappedList<CompressRenamed>
	hashMismatches: CappedList<CompressHashMismatch>
	dispositions: readonly JobDisposition<TError>[]
	propagationFailedCount: number
	neededBytes: number | null
	archive: TArchive | null
	// The stop came after the archive was registered, so the archive stays and the originals are kept.
	stoppedAfterArchive: boolean
	// The archive was announced after a rejected call had already settled the job.
	lateArchive: boolean
	// The archive exists, but the job ended with this error.
	endError: TError | null
	cancelRequest: "keep" | null
	outcome: JobOutcome<TError>
}

export interface CompressJobInit {
	destination: JobDestination
	name: string
	itemCount: number
	dispose: SourceDisposalKind | null
	encrypted: boolean
}

const ZERO_COUNTS: CompressJobCounts = {
	filesDone: 0,
	entriesSkipped: 0,
	bytesSkipped: 0,
	bytesRead: 0,
	bytesWritten: 0,
	archiveBytes: 0,
	bytesVerified: 0
}

export function createCompressJob<TArchive, TError>(id: string, init: CompressJobInit): CompressJob<TArchive, TError> {
	return {
		id,
		kind: "compress",
		destination: init.destination,
		name: init.name,
		itemCount: init.itemCount,
		dispose: init.dispose,
		encrypted: init.encrypted,
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
		skipped: EMPTY_CAPPED_LIST,
		renamed: EMPTY_CAPPED_LIST,
		hashMismatches: EMPTY_CAPPED_LIST,
		dispositions: [],
		propagationFailedCount: 0,
		neededBytes: null,
		archive: null,
		stoppedAfterArchive: false,
		lateArchive: false,
		endError: null,
		cancelRequest: null,
		outcome: { status: "running" }
	}
}

function toCompressCounts(counts: CompressCountsInput): CompressJobCounts {
	return {
		filesDone: jobNumber(counts.filesDone),
		entriesSkipped: jobNumber(counts.entriesSkipped),
		bytesSkipped: jobNumber(counts.bytesSkipped),
		bytesRead: jobNumber(counts.bytesRead),
		bytesWritten: jobNumber(counts.bytesWritten),
		archiveBytes: jobNumber(counts.archiveBytes),
		bytesVerified: jobNumber(counts.bytesVerified)
	}
}

function toSkipped(input: CompressSkippedInput): CompressSkipped {
	const { reason } = input

	return {
		sourcePath: input.sourcePath,
		bytes: jobNumber(input.bytes),
		reason: reason.type === "unreachable" ? { type: "unreachable", count: jobNumber(reason.count) } : reason
	}
}

const NO_OMISSIONS: CompressOmittedInput = { skipped: 0, renamed: 0, hashMismatches: 0 }

const NO_EVENTS: CompressUpdateEvents<never> = {
	skipped: [],
	renamed: [],
	hashMismatches: [],
	dispositions: [],
	propagationFailed: 0,
	omitted: NO_OMISSIONS
}

// Records without a bigint are the events themselves: nothing reads their `type`, and a copy of each
// would cost an object per event five times a second.
export function classifyCompressEvents<TError>(
	events: readonly CompressEventInput<TError>[],
	omitted: CompressOmittedInput = NO_OMISSIONS
): CompressUpdateEvents<TError> {
	if (events.length === 0 && omitted.skipped === 0 && omitted.renamed === 0 && omitted.hashMismatches === 0) {
		return NO_EVENTS
	}

	const skipped: CompressSkipped[] = []
	const renamed: CompressRenamed[] = []
	const hashMismatches: CompressHashMismatch[] = []
	const dispositions: JobDisposition<TError>[] = []
	let propagationFailed = 0

	for (const event of events) {
		switch (event.type) {
			case "skipped":
				skipped.push(toSkipped(event))

				break
			case "renamed":
				renamed.push(event)

				break
			case "sourceHashMismatch":
				hashMismatches.push(event)

				break
			case "sourceDisposition":
				dispositions.push(toDisposition(event))

				break
			case "propagationFailed":
				propagationFailed++

				break
		}
	}

	return { skipped, renamed, hashMismatches, dispositions, propagationFailed, omitted }
}

function toActive(active: readonly CompressActiveInput[], previous: CompressActive[]): CompressActive[] {
	if (active.length === 0) {
		return previous.length === 0 ? previous : []
	}

	return active.map(file => ({
		sourceUuid: file.sourceUuid,
		name: file.name,
		path: file.path,
		size: jobNumber(file.size),
		bytesDone: jobNumber(file.bytesDone)
	}))
}

export function applyCompressUpdate<TArchive, TError, TJob extends CompressJob<TArchive, TError>>(
	job: TJob,
	update: CompressUpdateInput<TError>
): TJob {
	const { skipped, renamed, hashMismatches, dispositions, propagationFailed, omitted } = update.events

	return {
		...job,
		...jobRunFlags(update.runState),
		phase: update.phase,
		scan: { sourcesDone: jobNumber(update.scan.sourcesDone), sourcesTotal: jobNumber(update.scan.sourcesTotal) },
		totals: toPlanTotals(update.totals),
		counts: toCompressCounts(update.counts),
		active: toActive(update.active, job.active),
		bytesPerSecond: jobNumberOrNull(update.bytesPerSecond),
		etaMs: jobNumberOrNull(update.etaMs),
		skipped: appendCapped(job.skipped, skipped, omitted.skipped),
		renamed: appendCapped(job.renamed, renamed, omitted.renamed),
		hashMismatches: appendCapped(job.hashMismatches, hashMismatches, omitted.hashMismatches),
		dispositions: dispositions.length === 0 ? job.dispositions : job.dispositions.concat(dispositions),
		propagationFailedCount: job.propagationFailedCount + propagationFailed
	}
}

// The event-fed lists and tallies as `before` held them, for a call refused up front that runs again:
// its events would otherwise count twice until the settle.
export function rewindCompressEvents<TArchive, TError, TJob extends CompressJob<TArchive, TError>>(
	job: TJob,
	before: CompressJob<TArchive, TError>
): TJob {
	return {
		...job,
		skipped: before.skipped,
		renamed: before.renamed,
		hashMismatches: before.hashMismatches,
		dispositions: before.dispositions,
		propagationFailedCount: before.propagationFailedCount
	}
}

// A bare tar states its size before writing anything, so a storage limit refuses it up front with the
// size it needed; a compressed archive's size is only known as it is written.
export function isCompressPreflightRefusal(report: CompressReportInput<unknown, JobErrorLike>): boolean {
	return report.error?.kind === "MaxStorageReached" && report.neededBytes !== undefined && report.archive === undefined
}

export function compressHasIssues(job: CompressJob<unknown, unknown>): boolean {
	return (
		cappedTotal(job.skipped) > 0 ||
		cappedTotal(job.hashMismatches) > 0 ||
		job.propagationFailedCount > 0 ||
		job.endError !== null ||
		job.dispositions.some(disposition => disposition.outcome.type === "kept")
	)
}

export type CompressSettlement<TArchive, TError extends JobErrorLike> =
	{ report: CompressReportInput<TArchive, TError>; maxBytes: number | undefined } | { error: TError }

function isPasswordError(error: JobErrorLike): boolean {
	return error.kind === "ArchivePasswordRequired" || error.kind === "ArchiveWrongPassword"
}

function finished<TJob extends CompressJob<unknown, unknown>>(job: TJob): TJob {
	return { ...job, outcome: compressHasIssues(job) ? { status: "doneWithIssues" } : { status: "done" } }
}

// The report is authoritative once the job is over, so it replaces what the updates accumulated.
export function settleCompressJob<TArchive, TError extends JobErrorLike, TJob extends CompressJob<TArchive, TError>>(
	job: TJob,
	settlement: CompressSettlement<TArchive, TError>
): TJob {
	if ("error" in settlement) {
		const ended: TJob = { ...job, active: [], pausing: false, paused: false }

		// A call rejects only on bad arguments or a job still running well after its cancel, so an
		// archive already announced means the stop came after it. A source whose outcome never arrived
		// may or may not be gone, which is worth a look.
		if (job.archive !== null) {
			const stopped: TJob = { ...ended, stoppedAfterArchive: true }

			return job.dispose !== null && job.dispositions.length < job.itemCount
				? { ...stopped, outcome: { status: "doneWithIssues" } }
				: finished(stopped)
		}

		return {
			...ended,
			outcome:
				settlement.error.kind === "Cancelled" || job.cancelRequest !== null
					? { status: "cancelled" }
					: { status: "failed", error: settlement.error }
		}
	}

	const { report, maxBytes } = settlement
	const archive = report.archive === undefined ? job.archive : report.archive
	const settled: TJob = {
		...job,
		totals: toPlanTotals(report.totals),
		counts: toCompressCounts(report.counts),
		active: [],
		pausing: false,
		paused: false,
		skipped: mapCapped(report.skipped, 0, toSkipped),
		renamed: cappedList(report.renamed, 0),
		hashMismatches: cappedList(report.hashMismatches, jobNumber(report.omittedHashMismatches)),
		dispositions: report.dispositions.map(toDisposition),
		neededBytes: jobNumberOrNull(report.neededBytes),
		archive
	}
	const { error } = report

	// A stop that reaches the job once its archive is registered ends it without an error.
	if (error === undefined) {
		return finished(job.cancelRequest !== null && archive !== null ? { ...settled, stoppedAfterArchive: true } : settled)
	}

	if (error.kind === "Cancelled") {
		return archive === null ? { ...settled, outcome: { status: "cancelled" } } : finished({ ...settled, stoppedAfterArchive: true })
	}

	if (error.kind === "MaxStorageReached" && archive === null && maxBytes !== undefined) {
		return { ...settled, outcome: { status: "quotaExceeded", neededBytes: settled.neededBytes, freeBytes: maxBytes } }
	}

	// The options dialog always asks for the password it encrypts with, so these never reach a user.
	if (isPasswordError(error) || archive === null) {
		return { ...settled, outcome: { status: "failed", error } }
	}

	return finished({ ...settled, endError: error })
}

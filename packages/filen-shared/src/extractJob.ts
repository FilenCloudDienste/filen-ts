import { toItemCounts, type CopyCountsInput, type CopyJobCounts } from "./copyJob"
import {
	EMPTY_CAPPED_LIST,
	REPORT_LIST_CAP,
	addItemCounts,
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

// Pure state for one extract job, which may span several SDK calls (a retry of failures that landed in
// different directories). The directory shape a retry is handed back stays the app's own.

export type ExtractJobPhase =
	"waitingForWorker" | "scanning" | "extracting" | "finishing" | "disposingSources" | "done" | "cancelled" | "failed"

export interface ExtractEntryRef {
	archive: string
	index: number
}

// Where a failed entry goes again for it to land where it was meant to.
export interface ExtractRetry<TDir> {
	destination: string
	destinationDir: TDir
	base: string
}

export type ExtractStage =
	{ type: "createDirectory" } | { type: "upload" } | { type: "finalize" } | { type: "registeredAsVersion"; existingFile: string }

export interface ExtractFailureInput<TDir, TError> {
	entry: ExtractEntryRef
	path: string
	destParent: string
	destName: string
	stage: ExtractStage
	// undefined only for a tar's hard link, which is a copy of a file already in the drive.
	retry: ExtractRetry<TDir> | undefined
	error: TError
}

export interface ExtractFailure<TDir, TError> {
	entry: ExtractEntryRef
	path: string
	destParent: string
	destName: string
	stage: ExtractStage
	retry: ExtractRetry<TDir> | null
	error: TError
}

export type ExtractJobSkipReason =
	| { type: "symlink"; target: string }
	| { type: "hardlink"; target: string }
	| { type: "device" }
	| { type: "sparse" }
	| { type: "unsupportedType" }
	| { type: "pathTooLong" }
	| { type: "pathTooDeep" }
	| { type: "unsafePath" }
	| { type: "overlappingData" }
	| { type: "unsupportedMethod" }
	| { type: "antiItem" }
	| { type: "macMetadata" }

export interface ExtractSkippedInput {
	entry: ExtractEntryRef
	path: string
	pathTruncated: boolean
	bytes: bigint
	reason: ExtractJobSkipReason
}

export interface ExtractSkipped {
	entry: ExtractEntryRef
	path: string
	pathTruncated: boolean
	bytes: number
	reason: ExtractJobSkipReason
}

export interface ExtractRenamed {
	entry: ExtractEntryRef
	path: string
	name: string
	reason: "duplicateName" | "pathRewritten"
}

// A name that reads as something it is not (a bidi override, an invisible character).
export interface ExtractMisleading {
	entry: ExtractEntryRef
	path: string
}

export interface ExtractActiveInput {
	entry: ExtractEntryRef
	destUuid: string
	destParent: string
	name: string
	size: bigint | undefined
	bytesDone: bigint
}

export interface ExtractActive {
	entry: ExtractEntryRef
	destUuid: string
	destParent: string
	name: string
	size: number | null
	bytesDone: number
}

// What a percent is measured against. archiveRead: the archive's bytes read, sound for any full extract
// and for a partial tar or single compressed file, which is always read whole. planned: the entry bytes
// a listing said the selection holds. unknown: a partial zip or 7z without a listing.
export type ExtractProgressBasis = { type: "archiveRead" } | { type: "planned"; bytes: number; files: number } | { type: "unknown" }

// The events the app passes on: the ones it never reads are dropped before they reach it.
export type ExtractEventInput<TDir, TError> =
	| ({ type: "dirFailed" } & ExtractFailureInput<TDir, TError>)
	| ({ type: "fileFailed" } & ExtractFailureInput<TDir, TError>)
	| ({ type: "skipped" } & ExtractSkippedInput)
	| ({ type: "renamed" } & ExtractRenamed)
	| ({ type: "misleadingName" } & ExtractMisleading)
	| { type: "topLevelTrashed"; destUuid: string }
	| ({ type: "sourceDisposition" } & DispositionInput<TError>)
	| { type: "propagationFailed"; destUuid: string; error: TError }

// What the app's event delivery counted but did not pass on, past its own cap, per list.
export interface ExtractOmittedLists {
	failures: number
	skipped: number
	renamed: number
	misleadingNames: number
}

// savedAsVersion is the part of failures registered as a new version, macMetadata the part of skipped
// that was macOS metadata: past the cap, what the events would have said.
export interface ExtractOmittedInput extends ExtractOmittedLists {
	savedAsVersion: number
	macMetadata: number
}

export interface ExtractUpdateEvents<TDir, TError> {
	failures: readonly ExtractFailure<TDir, TError>[]
	skipped: readonly ExtractSkipped[]
	renamed: readonly ExtractRenamed[]
	misleadingNames: readonly ExtractMisleading[]
	// Folders already handed over that a late wrong password moved to the trash.
	topLevelTrashed: readonly string[]
	dispositions: readonly JobDisposition<TError>[]
	// Both with the left-out ones; `omitted.failures` excludes the files saved as versions.
	savedAsVersion: number
	macMetadataSkipped: number
	propagationFailed: number
	omitted: ExtractOmittedLists
}

export interface ExtractUpdateInput<TDir, TError> {
	phase: ExtractJobPhase
	runState: JobRunStateInput
	archiveBytes: bigint
	counts: CopyCountsInput
	bytesRead: bigint
	active: readonly ExtractActiveInput[]
	bytesPerSecond: bigint | undefined
	etaMs: bigint | undefined
	events: ExtractUpdateEvents<TDir, TError>
}

export interface ExtractReportOmittedInput {
	skipped: bigint
	renamed: bigint
	misleadingNames: bigint
	failures: bigint
	topLevel: bigint
}

// The top-level items themselves stay with the app; only their count is read here.
export interface ExtractReportInput<TDir, TError> {
	topLevelCount: number
	failures: readonly ExtractFailureInput<TDir, TError>[]
	skipped: readonly ExtractSkippedInput[]
	renamed: readonly ExtractRenamed[]
	misleadingNames: readonly ExtractMisleading[]
	omitted: ExtractReportOmittedInput
	archiveBytes: bigint
	counts: CopyCountsInput
	unaccountedBytes: bigint
	duplicates: { names: readonly string[]; count: bigint } | undefined
	dispositions: readonly DispositionInput<TError>[]
	// Why the extract ended early; undefined when it ran to the end, failures of single entries included.
	error: TError | undefined
}

export interface ExtractJob<TItem, TDir, TError> {
	id: string
	kind: "extract"
	destination: JobDestination
	archiveUuid: string
	archiveName: string
	rowName: string
	root: "newFolder" | "destination"
	partial: boolean
	retry: boolean
	dispose: SourceDisposalKind | null
	basis: ExtractProgressBasis
	phase: ExtractJobPhase
	pausing: boolean
	paused: boolean
	cancelling: boolean
	archiveBytes: number
	bytesRead: number
	counts: CopyJobCounts
	active: ExtractActive[]
	bytesPerSecond: number | null
	etaMs: number | null
	failures: CappedList<ExtractFailure<TDir, TError>>
	skipped: CappedList<ExtractSkipped>
	renamed: CappedList<ExtractRenamed>
	misleadingNames: CappedList<ExtractMisleading>
	duplicates: { names: readonly string[]; count: number } | null
	unaccountedBytes: number
	dispositions: readonly JobDisposition<TError>[]
	topLevelCount: number
	topLevelTrashedCount: number
	savedAsVersionCount: number
	// Of skipped, the macOS metadata, past the list's cap too.
	macMetadataSkippedCount: number
	propagationFailedCount: number
	// Top-level items this job created, kept only for "move extracted items to trash".
	created: TItem[]
	cancelRequest: "keep" | "trash" | null
	trashResult: { moved: number; failed: number } | null
	// A retry job took over its failures.
	retriedAway: boolean
	outcome: JobOutcome<TError>
}

export interface ExtractJobInit {
	destination: JobDestination
	archiveUuid: string
	archiveName: string
	rowName: string
	root: "newFolder" | "destination"
	partial: boolean
	retry: boolean
	dispose: SourceDisposalKind | null
	basis: ExtractProgressBasis
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

export function createExtractJob<TItem, TDir, TError>(id: string, init: ExtractJobInit): ExtractJob<TItem, TDir, TError> {
	return {
		id,
		kind: "extract",
		destination: init.destination,
		archiveUuid: init.archiveUuid,
		archiveName: init.archiveName,
		rowName: init.rowName,
		root: init.root,
		partial: init.partial,
		retry: init.retry,
		dispose: init.dispose,
		basis: init.basis,
		phase: "waitingForWorker",
		pausing: false,
		paused: false,
		cancelling: false,
		archiveBytes: 0,
		bytesRead: 0,
		counts: ZERO_COUNTS,
		active: [],
		bytesPerSecond: null,
		etaMs: null,
		failures: EMPTY_CAPPED_LIST,
		skipped: EMPTY_CAPPED_LIST,
		renamed: EMPTY_CAPPED_LIST,
		misleadingNames: EMPTY_CAPPED_LIST,
		duplicates: null,
		unaccountedBytes: 0,
		dispositions: [],
		topLevelCount: 0,
		topLevelTrashedCount: 0,
		savedAsVersionCount: 0,
		macMetadataSkippedCount: 0,
		propagationFailedCount: 0,
		created: [],
		cancelRequest: null,
		trashResult: null,
		retriedAway: false,
		outcome: { status: "running" }
	}
}

function toFailure<TDir, TError>(input: ExtractFailureInput<TDir, TError>): ExtractFailure<TDir, TError> {
	return {
		entry: input.entry,
		path: input.path,
		destParent: input.destParent,
		destName: input.destName,
		stage: input.stage,
		retry: input.retry ?? null,
		error: input.error
	}
}

function toSkipped(input: ExtractSkippedInput): ExtractSkipped {
	return { entry: input.entry, path: input.path, pathTruncated: input.pathTruncated, bytes: jobNumber(input.bytes), reason: input.reason }
}

const NO_OMISSIONS: ExtractOmittedInput = { failures: 0, skipped: 0, renamed: 0, misleadingNames: 0, savedAsVersion: 0, macMetadata: 0 }

const NO_EVENTS: ExtractUpdateEvents<never, never> = {
	failures: [],
	skipped: [],
	renamed: [],
	misleadingNames: [],
	topLevelTrashed: [],
	dispositions: [],
	savedAsVersion: 0,
	macMetadataSkipped: 0,
	propagationFailed: 0,
	omitted: NO_OMISSIONS
}

// Records without a bigint are the events themselves, as the compress job keeps them.
// A file the backend registered as a new version of an existing one is not a failure the user can act
// on: its bytes are stored, and a retry would add yet another version.
export function classifyExtractEvents<TDir, TError>(
	events: readonly ExtractEventInput<TDir, TError>[],
	omitted: ExtractOmittedInput = NO_OMISSIONS
): ExtractUpdateEvents<TDir, TError> {
	if (events.length === 0 && omitted.failures === 0 && omitted.skipped === 0 && omitted.renamed === 0 && omitted.misleadingNames === 0) {
		return NO_EVENTS
	}

	const failures: ExtractFailure<TDir, TError>[] = []
	const skipped: ExtractSkipped[] = []
	const renamed: ExtractRenamed[] = []
	const misleadingNames: ExtractMisleading[] = []
	const topLevelTrashed: string[] = []
	const dispositions: JobDisposition<TError>[] = []
	let savedAsVersion = omitted.savedAsVersion
	let macMetadataSkipped = omitted.macMetadata
	let propagationFailed = 0

	for (const event of events) {
		switch (event.type) {
			case "dirFailed":
			case "fileFailed":
				if (event.stage.type === "registeredAsVersion") {
					savedAsVersion++
				} else {
					failures.push(toFailure(event))
				}

				break
			case "skipped":
				if (event.reason.type === "macMetadata") {
					macMetadataSkipped++
				}

				skipped.push(toSkipped(event))

				break
			case "renamed":
				renamed.push(event)

				break
			case "misleadingName":
				misleadingNames.push(event)

				break
			case "topLevelTrashed":
				topLevelTrashed.push(event.destUuid)

				break
			case "sourceDisposition":
				dispositions.push(toDisposition(event))

				break
			case "propagationFailed":
				propagationFailed++

				break
		}
	}

	const lists: ExtractOmittedLists =
		omitted.savedAsVersion === 0
			? omitted
			: {
					failures: omitted.failures - omitted.savedAsVersion,
					skipped: omitted.skipped,
					renamed: omitted.renamed,
					misleadingNames: omitted.misleadingNames
				}

	return {
		failures,
		skipped,
		renamed,
		misleadingNames,
		topLevelTrashed,
		dispositions,
		savedAsVersion,
		macMetadataSkipped,
		propagationFailed,
		omitted: lists
	}
}

function toActive(active: readonly ExtractActiveInput[], previous: ExtractActive[]): ExtractActive[] {
	if (active.length === 0) {
		return previous.length === 0 ? previous : []
	}

	return active.map(file => ({
		entry: file.entry,
		destUuid: file.destUuid,
		destParent: file.destParent,
		name: file.name,
		size: jobNumberOrNull(file.size),
		bytesDone: jobNumber(file.bytesDone)
	}))
}

// `base` is what the job's earlier calls counted: each call's own counts start from zero.
export function applyExtractUpdate<TItem, TDir, TError, TJob extends ExtractJob<TItem, TDir, TError>>(
	job: TJob,
	update: ExtractUpdateInput<TDir, TError>,
	base?: CopyJobCounts
): TJob {
	const {
		failures,
		skipped,
		renamed,
		misleadingNames,
		topLevelTrashed,
		dispositions,
		savedAsVersion,
		macMetadataSkipped,
		propagationFailed,
		omitted
	} = update.events
	const counts = toItemCounts(update.counts)

	return {
		...job,
		...jobRunFlags(update.runState),
		phase: update.phase,
		archiveBytes: jobNumber(update.archiveBytes),
		bytesRead: jobNumber(update.bytesRead),
		counts: base === undefined ? counts : addItemCounts(base, counts),
		active: toActive(update.active, job.active),
		bytesPerSecond: jobNumberOrNull(update.bytesPerSecond),
		etaMs: jobNumberOrNull(update.etaMs),
		failures: appendCapped(job.failures, failures, omitted.failures),
		skipped: appendCapped(job.skipped, skipped, omitted.skipped),
		renamed: appendCapped(job.renamed, renamed, omitted.renamed),
		misleadingNames: appendCapped(job.misleadingNames, misleadingNames, omitted.misleadingNames),
		dispositions: dispositions.length === 0 ? job.dispositions : job.dispositions.concat(dispositions),
		topLevelTrashedCount: job.topLevelTrashedCount + topLevelTrashed.length,
		savedAsVersionCount: job.savedAsVersionCount + savedAsVersion,
		macMetadataSkippedCount: job.macMetadataSkippedCount + macMetadataSkipped,
		propagationFailedCount: job.propagationFailedCount + propagationFailed
	}
}

// The event-fed lists and tallies as `before` held them, for a call refused up front that runs again:
// its events would otherwise count twice until the settle. The counts need no rewind, each update
// bringing them whole.
export function rewindExtractEvents<TItem, TDir, TError, TJob extends ExtractJob<TItem, TDir, TError>>(
	job: TJob,
	before: ExtractJob<TItem, TDir, TError>
): TJob {
	return {
		...job,
		failures: before.failures,
		skipped: before.skipped,
		renamed: before.renamed,
		misleadingNames: before.misleadingNames,
		dispositions: before.dispositions,
		topLevelTrashedCount: before.topLevelTrashedCount,
		savedAsVersionCount: before.savedAsVersionCount,
		macMetadataSkippedCount: before.macMetadataSkippedCount,
		propagationFailedCount: before.propagationFailedCount
	}
}

// A zip or 7z states its files' sizes in its index, so a storage limit refuses it before anything is
// created; a tar is checked as it is read and keeps what it extracted.
export function isExtractPreflightRefusal(report: ExtractReportInput<unknown, JobErrorLike>): boolean {
	return (
		report.error?.kind === "MaxStorageReached" &&
		report.counts.dirsCreated === 0n &&
		report.counts.filesDone === 0n &&
		report.topLevelCount === 0 &&
		report.omitted.topLevel === 0n
	)
}

function mergeCapped<T>(a: readonly T[], aOmitted: bigint, b: readonly T[], bOmitted: bigint): { items: readonly T[]; omitted: bigint } {
	if (b.length === 0) {
		return { items: a, omitted: aOmitted + bOmitted }
	}

	const room = Math.max(0, REPORT_LIST_CAP - a.length)
	const taken = b.length <= room ? b : b.slice(0, room)

	return { items: a.length === 0 ? taken : a.concat(taken), omitted: aOmitted + bOmitted + BigInt(b.length - taken.length) }
}

function addCounts(a: CopyCountsInput, b: CopyCountsInput): CopyCountsInput {
	return {
		dirsCreated: a.dirsCreated + b.dirsCreated,
		dirsFailed: a.dirsFailed + b.dirsFailed,
		filesDone: a.filesDone + b.filesDone,
		filesFailed: a.filesFailed + b.filesFailed,
		bytesDone: a.bytesDone + b.bytesDone,
		bytesFailed: a.bytesFailed + b.bytesFailed,
		dirsNotAttempted: a.dirsNotAttempted + b.dirsNotAttempted,
		filesNotAttempted: a.filesNotAttempted + b.filesNotAttempted,
		bytesNotAttempted: a.bytesNotAttempted + b.bytesNotAttempted,
		entriesSkipped: a.entriesSkipped + b.entriesSkipped,
		bytesSkipped: a.bytesSkipped + b.bytesSkipped
	}
}

// One report for the calls of a multi-call job. Every call reads the same archive, so its own figures
// (size, unaccounted bytes, duplicates) are the first call's. The app joins its own top-level items.
export function mergeExtractReports<TDir, TError>(
	a: ExtractReportInput<TDir, TError>,
	b: ExtractReportInput<TDir, TError>
): ExtractReportInput<TDir, TError> {
	const failures = mergeCapped(a.failures, a.omitted.failures, b.failures, b.omitted.failures)
	const skipped = mergeCapped(a.skipped, a.omitted.skipped, b.skipped, b.omitted.skipped)
	const renamed = mergeCapped(a.renamed, a.omitted.renamed, b.renamed, b.omitted.renamed)
	const misleadingNames = mergeCapped(a.misleadingNames, a.omitted.misleadingNames, b.misleadingNames, b.omitted.misleadingNames)

	return {
		topLevelCount: a.topLevelCount + b.topLevelCount,
		failures: failures.items,
		skipped: skipped.items,
		renamed: renamed.items,
		misleadingNames: misleadingNames.items,
		omitted: {
			failures: failures.omitted,
			skipped: skipped.omitted,
			renamed: renamed.omitted,
			misleadingNames: misleadingNames.omitted,
			topLevel: a.omitted.topLevel + b.omitted.topLevel
		},
		archiveBytes: a.archiveBytes,
		counts: addCounts(a.counts, b.counts),
		unaccountedBytes: a.unaccountedBytes,
		duplicates: a.duplicates ?? b.duplicates,
		dispositions: b.dispositions.length === 0 ? a.dispositions : a.dispositions.concat(b.dispositions),
		error: a.error ?? b.error
	}
}

export interface ExtractRetryGroup<TDir> {
	destination: string
	destinationDir: TDir
	base: string
	entries: ExtractEntryRef[]
}

// Failures sharing a retry go again in one call, in the order they first failed.
export function groupExtractRetries<TDir, TError>(failures: readonly ExtractFailure<TDir, TError>[]): ExtractRetryGroup<TDir>[] {
	const groups = new Map<string, ExtractRetryGroup<TDir>>()

	for (const { retry, entry } of failures) {
		if (retry === null) {
			continue
		}

		const key = `${retry.destination}\0${retry.base}`
		const group = groups.get(key)

		if (group === undefined) {
			groups.set(key, { destination: retry.destination, destinationDir: retry.destinationDir, base: retry.base, entries: [entry] })
		} else {
			group.entries.push(entry)
		}
	}

	return Array.from(groups.values())
}

// macOS metadata is left out by design; any other skip is worth a look.
export function extractHasIssues(job: ExtractJob<unknown, unknown, unknown>): boolean {
	return (
		cappedTotal(job.failures) > 0 ||
		cappedTotal(job.skipped) > job.macMetadataSkippedCount ||
		job.propagationFailedCount > 0 ||
		job.dispositions.some(disposition => disposition.outcome.type === "kept")
	)
}

export type ExtractSettlement<TDir, TError extends JobErrorLike> =
	{ report: ExtractReportInput<TDir, TError>; maxBytes: number | undefined } | { error: TError }

function settledOutcome<TError extends JobErrorLike>(
	job: ExtractJob<unknown, unknown, TError>,
	error: TError | undefined,
	maxBytes: number | undefined
): JobOutcome<TError> {
	if (error === undefined) {
		return extractHasIssues(job) ? { status: "doneWithIssues" } : { status: "done" }
	}

	switch (error.kind) {
		case "Cancelled":
			return { status: "cancelled" }
		case "ArchivePasswordRequired":
			return { status: "passwordRequired" }
		case "ArchiveWrongPassword":
			return { status: "wrongPassword" }
		case "MaxStorageReached":
			if (maxBytes !== undefined) {
				// Before anything was created or after a tar was partly extracted: only a listing's plan
				// states what the whole extract needs.
				return {
					status: "quotaExceeded",
					neededBytes: job.basis.type === "planned" ? job.basis.bytes : null,
					freeBytes: maxBytes
				}
			}

			return { status: "failed", error }
		default:
			return { status: "failed", error }
	}
}

// The report is authoritative once the job is over, so it replaces what the updates accumulated.
export function settleExtractJob<TItem, TDir, TError extends JobErrorLike, TJob extends ExtractJob<TItem, TDir, TError>>(
	job: TJob,
	settlement: ExtractSettlement<TDir, TError>
): TJob {
	if ("error" in settlement) {
		return {
			...job,
			active: [],
			pausing: false,
			paused: false,
			outcome:
				settlement.error.kind === "Cancelled" || job.cancelRequest !== null
					? { status: "cancelled" }
					: { status: "failed", error: settlement.error }
		}
	}

	const { report, maxBytes } = settlement
	const failures: ExtractFailure<TDir, TError>[] = []
	let savedAsVersionCount = 0
	let macMetadataSkippedCount = 0

	for (const failure of report.failures) {
		if (failure.stage.type === "registeredAsVersion") {
			savedAsVersionCount++
		} else if (failures.length < REPORT_LIST_CAP) {
			failures.push(toFailure(failure))
		}
	}

	for (const entry of report.skipped) {
		if (entry.reason.type === "macMetadata") {
			macMetadataSkippedCount++
		}
	}

	// Past its caps the report counts entries without their stage or reason, where the updates' tallies
	// counted every one.
	if (report.omitted.failures > 0n) {
		savedAsVersionCount = Math.max(savedAsVersionCount, job.savedAsVersionCount)
	}

	if (report.omitted.skipped > 0n) {
		macMetadataSkippedCount = Math.max(macMetadataSkippedCount, job.macMetadataSkippedCount)
	}

	const settled: TJob = {
		...job,
		archiveBytes: jobNumber(report.archiveBytes),
		counts: toItemCounts(report.counts),
		active: [],
		pausing: false,
		paused: false,
		failures: cappedList(failures, jobNumber(report.omitted.failures) + report.failures.length - savedAsVersionCount - failures.length),
		skipped: mapCapped(report.skipped, jobNumber(report.omitted.skipped), toSkipped),
		renamed: cappedList(report.renamed, jobNumber(report.omitted.renamed)),
		misleadingNames: cappedList(report.misleadingNames, jobNumber(report.omitted.misleadingNames)),
		duplicates: report.duplicates === undefined ? null : { names: report.duplicates.names, count: jobNumber(report.duplicates.count) },
		unaccountedBytes: jobNumber(report.unaccountedBytes),
		dispositions: report.dispositions.map(toDisposition),
		topLevelCount: report.topLevelCount + jobNumber(report.omitted.topLevel),
		savedAsVersionCount,
		macMetadataSkippedCount
	}

	return { ...settled, outcome: settledOutcome(settled, report.error, maxBytes) }
}

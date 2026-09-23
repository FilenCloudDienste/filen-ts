import type { CopyCounts, CopyEntry, CopyError, CopyFailure, CopyFailureInfo, CopyPhase, CopyReport, CopyUpdate } from "@filen/sdk-rs"
import { labelFirst, type ErrorDTO } from "@/lib/sdk/errors"
import { freeBytes, type StorageCounters } from "@/features/drive/lib/quota.logic"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"

// Pure state for one copy job: the SDK's bigint progress is narrowed to numbers here, so nothing
// downstream renders or compares a bigint.

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

export interface CopyJobFailure {
	sourceUuid: string
	sourcePath: string
	destName: string
	error: ErrorDTO
	// A failed directory takes its whole subtree with it.
	affectedFiles: number
	affectedBytes: number
}

export type CopyJobCounts = { [K in keyof CopyCounts]: number }

// What a copy's transfers row shows as its icon: the one item's kind, or several items.
export type CopyJobGlyph = "directory" | "file" | "items"

export function copyGlyphForItems(items: readonly DriveItem[]): CopyJobGlyph {
	const [only] = items

	if (only === undefined || items.length > 1) {
		return "items"
	}

	return asDirectoryOrFile(only).type
}

// A retry's entries carry SDK items: a file is the only kind with chunks.
export function copyGlyphForEntries(entries: readonly CopyEntry[]): CopyJobGlyph {
	const [only] = entries

	if (only === undefined || entries.length > 1) {
		return "items"
	}

	return "chunks" in only.item ? "file" : "directory"
}

export type CopyJobOutcome =
	| { status: "running" }
	| { status: "done" }
	| { status: "doneWithFailures" }
	| { status: "cancelled" }
	| { status: "quotaExceeded"; freeBytes: number }
	| { status: "failed"; error: ErrorDTO }

export interface CopyJob {
	id: string
	destination: CopyDestination
	itemCount: number
	glyph: CopyJobGlyph
	phase: CopyPhase
	pausing: boolean
	paused: boolean
	cancelling: boolean
	scan: { sourcesDone: number; sourcesTotal: number }
	totals: { dirs: number; files: number; bytes: number }
	counts: CopyJobCounts
	active: CopyJobActiveFile[]
	bytesPerSecond: number | null
	etaMs: number | null
	failures: CopyJobFailure[]
	renamedCount: number
	savedAsVersionCount: number
	propagationFailedCount: number
	// Top-level items this job created — the only ones "move copied items to trash" may touch.
	created: DriveItem[]
	// The report's failures, as copyItemsTo takes them back.
	retryable: CopyFailure[]
	cancelRequest: "keep" | "trash" | null
	// What "move copied items to trash" did, once it ran.
	trashResult: { moved: number; failed: number } | null
	outcome: CopyJobOutcome
	// The progress card is showing; a job whose card is dismissed announces its end with a toast.
	cardVisible: boolean
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

export function createCopyJob(id: string, destination: CopyDestination, itemCount: number, glyph: CopyJobGlyph = "items"): CopyJob {
	return {
		id,
		destination,
		itemCount,
		glyph,
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
		outcome: { status: "running" },
		cardVisible: false
	}
}

function toCounts(counts: CopyCounts): CopyJobCounts {
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

export function copyErrorDTO(error: CopyError): ErrorDTO {
	const dto: ErrorDTO = {
		species: "sdk",
		kind: error.kind,
		message: error.message,
		...(error.serverMessage !== undefined ? { serverMessage: error.serverMessage } : {}),
		...(error.serverCode !== undefined ? { serverCode: error.serverCode } : {}),
		label: ""
	}

	dto.label = labelFirst(dto)

	return dto
}

// A file the backend registered as a new version of an existing one is not a failure the user can
// act on: its bytes are stored, retrying would add yet another version, and it is not a copy to trash.
export function isSavedAsVersion(info: CopyFailureInfo): boolean {
	return info.stage === "registeredAsVersion"
}

function toFailure(info: CopyFailureInfo): CopyJobFailure {
	return {
		sourceUuid: info.sourceUuid,
		sourcePath: info.sourcePath,
		destName: info.destName,
		error: copyErrorDTO(info.error),
		affectedFiles: Number(info.affectedFiles),
		affectedBytes: Number(info.affectedBytes)
	}
}

// An update carries the complete current state plus the events since the previous one; only the
// events that name something the user may want to see are kept.
export function applyCopyUpdate(job: CopyJob, update: CopyUpdate): CopyJob {
	const failures: CopyJobFailure[] = []
	let renamedCount = job.renamedCount
	let savedAsVersionCount = job.savedAsVersionCount
	let propagationFailedCount = job.propagationFailedCount

	for (const event of update.events) {
		switch (event.type) {
			case "dirFailed":
			case "fileFailed":
				if (isSavedAsVersion(event)) {
					savedAsVersionCount++
				} else {
					failures.push(toFailure(event))
				}

				break
			case "renamed":
				renamedCount++

				break
			case "propagationFailed":
				propagationFailedCount++

				break
			default:
				break
		}
	}

	return {
		...job,
		phase: update.phase,
		pausing: update.pausing,
		paused: update.paused,
		cancelling: update.cancelling,
		scan: { sourcesDone: Number(update.scan.sourcesDone), sourcesTotal: Number(update.scan.sourcesTotal) },
		totals: { dirs: Number(update.totals.dirs), files: Number(update.totals.files), bytes: Number(update.totals.bytes) },
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
		renamedCount,
		savedAsVersionCount,
		propagationFailedCount
	}
}

export function applyCopyCreated(job: CopyJob, item: DriveItem): CopyJob {
	return { ...job, created: [...job.created, item] }
}

// The SDK checks maxBytes after its scan and fails before writing anything; it reports no totals then.
export function isQuotaPreflightFailure(report: CopyReport): boolean {
	return (
		report.error?.kind === "MaxStorageReached" &&
		report.topLevel.length === 0 &&
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

export type CopySettlement = { report: CopyReport; maxBytes: number | undefined } | { error: ErrorDTO }

// The report is authoritative once the job is over, so it replaces what the updates accumulated.
export function settleCopyJob(job: CopyJob, settlement: CopySettlement): CopyJob {
	if ("error" in settlement) {
		const outcome: CopyJobOutcome =
			settlement.error.kind === "Cancelled" ? { status: "cancelled" } : { status: "failed", error: settlement.error }

		return { ...job, active: [], pausing: false, paused: false, outcome }
	}

	const { report, maxBytes } = settlement
	const retryable = report.failures.filter(failure => !isSavedAsVersion(failure.info))
	let outcome: CopyJobOutcome

	if (report.error === undefined) {
		outcome = retryable.length === 0 ? { status: "done" } : { status: "doneWithFailures" }
	} else if (report.error.kind === "Cancelled") {
		outcome = { status: "cancelled" }
	} else if (isQuotaPreflightFailure(report) && maxBytes !== undefined) {
		outcome = { status: "quotaExceeded", freeBytes: maxBytes }
	} else {
		outcome = { status: "failed", error: copyErrorDTO(report.error) }
	}

	return {
		...job,
		totals: { dirs: Number(report.totals.dirs), files: Number(report.totals.files), bytes: Number(report.totals.bytes) },
		counts: toCounts(report.counts),
		active: [],
		pausing: false,
		paused: false,
		failures: retryable.map(failure => toFailure(failure.info)),
		savedAsVersionCount: report.failures.length - retryable.length,
		renamedCount: report.renamed.length,
		retryable,
		outcome
	}
}

// Each failed item goes back to the directory it was meant for, under the name it was planned with.
export function retryEntries(failures: readonly CopyFailure[]): CopyEntry[] {
	return failures.map(failure => ({ item: failure.item, destination: failure.info.destParentDir, name: failure.info.destName }))
}

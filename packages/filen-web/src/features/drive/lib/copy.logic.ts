import type { CopiedTopLevelItem, CopyEntry } from "@filen/sdk-rs"
import {
	copyJobGlyph,
	createCopyJob as createSharedCopyJob,
	isCopyJobRunning,
	type CopyJob as SharedCopyJob,
	type CopyReportInput,
	type CopyUpdateEvents,
	type CopyUpdateInput,
	type CopyDestination,
	type CopyJobGlyph
} from "@filen/shared"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { CopyEventDTO, CopyFailureDTO, CopyFailureInfoDTO, CopyReportDTO, CopyUpdateDTO } from "@/lib/sdk/jobErrors"
import { asDirectoryOrFile, narrowItem, type DriveItem } from "@/features/drive/lib/item"
import type { ThumbnailCopy } from "@/features/drive/lib/thumbnails.logic"

// The wasm side of @filen/shared's copy job: maps the SDK's copy values onto its inputs, and adds what
// only web's copy card and transfers row use.

export type { CopyDestination, CopyJobGlyph }

export interface CopyJobFailure {
	sourceUuid: string
	sourcePath: string
	destName: string
	error: ErrorDTO
}

export function copyGlyphForItems(items: readonly DriveItem[]): CopyJobGlyph {
	const [only] = items

	return copyJobGlyph(items.length, only !== undefined && asDirectoryOrFile(only).type === "directory")
}

// A retry's entries carry SDK items: a file is the only kind with chunks.
export function copyGlyphForEntries(entries: readonly CopyEntry[]): CopyJobGlyph {
	const [only] = entries

	return copyJobGlyph(entries.length, only !== undefined && !("chunks" in only.item))
}

export interface CopyJob extends SharedCopyJob<DriveItem, CopyJobFailure, CopyFailureDTO, ErrorDTO> {
	glyph: CopyJobGlyph
	// The progress card is showing.
	cardVisible: boolean
}

export interface CopyJobReport extends CopyReportInput<CopyJobFailure, CopyFailureDTO, ErrorDTO> {
	// The top-level items the report lists as created.
	topLevel: CopiedTopLevelItem[]
	// Existing files it registered new versions of: stored, not created, so never trashed as copies.
	versionTargets: ReadonlySet<string>
}

export type CopySettlement = { report: CopyJobReport; maxBytes: number | undefined } | { error: ErrorDTO }

export function createCopyJob(id: string, destination: CopyDestination, itemCount: number, glyph: CopyJobGlyph = "items"): CopyJob {
	return {
		...createSharedCopyJob<DriveItem, CopyJobFailure, CopyFailureDTO, ErrorDTO>(id, destination, itemCount),
		glyph,
		cardVisible: false
	}
}

// The file the backend registered this copy as a new version of, if it did.
function versionTarget(info: CopyFailureInfoDTO): string | undefined {
	return info.stage.type === "registeredAsVersion" ? info.stage.existingFile : undefined
}

function toFailure(info: CopyFailureInfoDTO): CopyJobFailure {
	return {
		sourceUuid: info.sourceUuid,
		sourcePath: info.sourcePath,
		destName: info.destName,
		error: info.error
	}
}

// Only the events that name something the user may want to see are kept.
function classifyEvents(events: readonly CopyEventDTO[]): CopyUpdateEvents<CopyJobFailure> {
	const classified: CopyUpdateEvents<CopyJobFailure> = { failures: [], savedAsVersion: 0, renamed: 0, propagationFailed: 0 }

	for (const event of events) {
		switch (event.type) {
			case "dirFailed":
			case "fileFailed":
				if (versionTarget(event) !== undefined) {
					classified.savedAsVersion++
				} else {
					classified.failures.push(toFailure(event))
				}

				break
			case "renamed":
				classified.renamed++

				break
			case "propagationFailed":
				classified.propagationFailed++

				break
			default:
				break
		}
	}

	return classified
}

export function copyUpdateInput(update: CopyUpdateDTO): CopyUpdateInput<CopyJobFailure> {
	const { runState, events, ...rest } = update

	return {
		...rest,
		pausing: runState === "pausing",
		paused: runState === "paused",
		cancelling: runState === "cancelling",
		events: classifyEvents(events)
	}
}

// Each file an update reports done, as its source's thumbnail handed to the copy.
export function copiedFileThumbnails(events: readonly CopyEventDTO[]): ThumbnailCopy[] {
	const copies: ThumbnailCopy[] = []

	for (const event of events) {
		if (event.type === "fileDone") {
			copies.push({ from: event.sourceUuid, to: event.destUuid })
		}
	}

	return copies
}

export function copyReportInput(report: CopyReportDTO): CopyJobReport {
	const failures: CopyFailureDTO[] = []
	const versionTargets = new Set<string>()

	for (const failure of report.failures) {
		const target = versionTarget(failure.info)

		if (target === undefined) {
			failures.push(failure)
		} else {
			versionTargets.add(target)
		}
	}

	return {
		createdCount: report.topLevel.length,
		totals: report.totals,
		counts: report.counts,
		failures: failures.map(failure => ({ failure: toFailure(failure.info), retryable: failure })),
		savedAsVersionCount: report.failures.length - failures.length,
		renamedCount: report.renamed.length,
		error: report.error,
		topLevel: report.topLevel,
		versionTargets
	}
}

// Everything a job made at the top level, for "move copied items to trash": its report's items joined
// with those its callbacks delivered, once each, never a version target. A call that rejected has no
// report, only the delivered items.
export function copiedTopLevel(settlement: CopySettlement, delivered: readonly DriveItem[]): DriveItem[] {
	const report = "report" in settlement ? settlement.report : undefined
	const seen = new Set<string>()
	const items: DriveItem[] = []

	const add = (item: DriveItem): void => {
		if (!seen.has(item.data.uuid) && report?.versionTargets.has(item.data.uuid) !== true) {
			seen.add(item.data.uuid)
			items.push(item)
		}
	}

	for (const item of delivered) {
		add(item)
	}

	for (const entry of report?.topLevel ?? []) {
		if (!seen.has(entry.item.uuid)) {
			add(narrowItem(entry.item))
		}
	}

	return items
}

// A settled job whose stop asked for its copies to go to the trash, still moving them there. The job
// keeps that batch until its trash ends, whatever a late item's trash records meanwhile.
export function isCopyTrashPending(job: CopyJob): boolean {
	return !isCopyJobRunning(job) && job.cancelRequest === "trash" && job.created.length > 0
}

// A settled job's failures can go into a new job once its stop is done moving its copies to the trash:
// whether the retry may take the job's row depends on how that went.
export function canRetryCopy(job: CopyJob): boolean {
	return !isCopyJobRunning(job) && job.retryable.length > 0 && !isCopyTrashPending(job)
}

// Each failed item goes back to the directory it was meant for, under the name it was planned with.
export function retryEntries(failures: readonly CopyFailureDTO[]): CopyEntry[] {
	return failures.map(failure => ({ item: failure.item, destination: failure.info.destParentDir, name: failure.info.destName }))
}

import type { CopyEntry, CopyError, CopyEvent, CopyFailure, CopyFailureInfo, CopyReport, CopyUpdate } from "@filen/sdk-rs"
import {
	createCopyJob as createSharedCopyJob,
	type CopyJob as SharedCopyJob,
	type CopyJobOutcome as SharedCopyJobOutcome,
	type CopyReportInput,
	type CopySettlement as SharedCopySettlement,
	type CopyUpdateEvents,
	type CopyUpdateInput,
	type CopyDestination
} from "@filen/shared"
import { labelFirst, type ErrorDTO } from "@/lib/sdk/errors"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"

// The wasm side of @filen/shared's copy job: maps the SDK's copy values onto its inputs, and adds what
// only web's copy card and transfers row use.

export type { CopyDestination }

export interface CopyJobFailure {
	sourceUuid: string
	sourcePath: string
	destName: string
	error: ErrorDTO
	// A failed directory takes its whole subtree with it.
	affectedFiles: number
	affectedBytes: number
}

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

export type CopyJobOutcome = SharedCopyJobOutcome<ErrorDTO>

export interface CopyJob extends SharedCopyJob<DriveItem, CopyJobFailure, CopyFailure, ErrorDTO> {
	glyph: CopyJobGlyph
	// The progress card is showing.
	cardVisible: boolean
}

export type CopySettlement = SharedCopySettlement<CopyJobFailure, CopyFailure, ErrorDTO>

export function createCopyJob(id: string, destination: CopyDestination, itemCount: number, glyph: CopyJobGlyph = "items"): CopyJob {
	return {
		...createSharedCopyJob<DriveItem, CopyJobFailure, CopyFailure, ErrorDTO>(id, destination, itemCount),
		glyph,
		cardVisible: false
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

function isSavedAsVersion(info: CopyFailureInfo): boolean {
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

// Only the events that name something the user may want to see are kept.
function classifyEvents(events: readonly CopyEvent[]): CopyUpdateEvents<CopyJobFailure> {
	const classified: CopyUpdateEvents<CopyJobFailure> = { failures: [], savedAsVersion: 0, renamed: 0, propagationFailed: 0 }

	for (const event of events) {
		switch (event.type) {
			case "dirFailed":
			case "fileFailed":
				if (isSavedAsVersion(event)) {
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

export function copyUpdateInput(update: CopyUpdate): CopyUpdateInput<CopyJobFailure> {
	return { ...update, events: classifyEvents(update.events) }
}

export function copyReportInput(report: CopyReport): CopyReportInput<CopyJobFailure, CopyFailure, ErrorDTO> {
	const failures = report.failures.filter(failure => !isSavedAsVersion(failure.info))

	return {
		createdCount: report.topLevel.length,
		totals: report.totals,
		counts: report.counts,
		failures: failures.map(failure => ({ failure: toFailure(failure.info), retryable: failure })),
		savedAsVersionCount: report.failures.length - failures.length,
		renamedCount: report.renamed.length,
		error: report.error === undefined ? undefined : copyErrorDTO(report.error)
	}
}

// Each failed item goes back to the directory it was meant for, under the name it was planned with.
export function retryEntries(failures: readonly CopyFailure[]): CopyEntry[] {
	return failures.map(failure => ({ item: failure.item, destination: failure.info.destParentDir, name: failure.info.destName }))
}

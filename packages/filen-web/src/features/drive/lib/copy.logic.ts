import type {
	CopiedTopLevelItem,
	CopyEntry,
	CopyError,
	CopyEvent,
	CopyFailure,
	CopyFailureInfo,
	CopyReport,
	CopyUpdate
} from "@filen/sdk-rs"
import {
	createCopyJob as createSharedCopyJob,
	type CopyJob as SharedCopyJob,
	type CopyJobOutcome as SharedCopyJobOutcome,
	type CopyReportInput,
	type CopyUpdateEvents,
	type CopyUpdateInput,
	type CopyDestination
} from "@filen/shared"
import { labelFirst, type ErrorDTO } from "@/lib/sdk/errors"
import { asDirectoryOrFile, narrowItem, type DriveItem } from "@/features/drive/lib/item"

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

export interface CopyJobReport extends CopyReportInput<CopyJobFailure, CopyFailure, ErrorDTO> {
	// The top-level items the report lists as created.
	topLevel: CopiedTopLevelItem[]
	// Existing files it registered new versions of: stored, not created, so never trashed as copies.
	versionTargets: ReadonlySet<string>
}

export type CopySettlement = { report: CopyJobReport; maxBytes: number | undefined } | { error: ErrorDTO }

export function createCopyJob(id: string, destination: CopyDestination, itemCount: number, glyph: CopyJobGlyph = "items"): CopyJob {
	return {
		...createSharedCopyJob<DriveItem, CopyJobFailure, CopyFailure, ErrorDTO>(id, destination, itemCount),
		glyph,
		cardVisible: false
	}
}

// The SDK's message is developer text, kept for logs; the card words what it shows with errorLabelOr.
export function copyErrorDTO(error: CopyError): ErrorDTO {
	const dto: ErrorDTO = {
		species: "sdk",
		kind: error.kind,
		message: error.message,
		...(error.innerMessage !== undefined ? { innerMessage: error.innerMessage } : {}),
		...(error.serverMessage !== undefined ? { serverMessage: error.serverMessage } : {}),
		...(error.serverCode !== undefined ? { serverCode: error.serverCode } : {}),
		label: ""
	}

	dto.label = labelFirst(dto)

	return dto
}

// The file the backend registered this copy as a new version of, if it did.
function versionTarget(info: CopyFailureInfo): string | undefined {
	return info.stage.type === "registeredAsVersion" ? info.stage.existingFile : undefined
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

export function copyUpdateInput(update: CopyUpdate): CopyUpdateInput<CopyJobFailure> {
	const { runState, events, ...rest } = update

	return {
		...rest,
		pausing: runState === "pausing",
		paused: runState === "paused",
		cancelling: runState === "cancelling",
		events: classifyEvents(events)
	}
}

export function copyReportInput(report: CopyReport): CopyJobReport {
	const failures: CopyFailure[] = []
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
		error: report.error === undefined ? undefined : copyErrorDTO(report.error),
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
	return job.outcome.status !== "running" && job.cancelRequest === "trash" && job.created.length > 0
}

// A settled job's failures can go into a new job once its stop is done moving its copies to the trash:
// whether the retry may take the job's row depends on how that went.
export function canRetryCopy(job: CopyJob): boolean {
	return job.outcome.status !== "running" && job.retryable.length > 0 && !isCopyTrashPending(job)
}

// Each failed item goes back to the directory it was meant for, under the name it was planned with.
export function retryEntries(failures: readonly CopyFailure[]): CopyEntry[] {
	return failures.map(failure => ({ item: failure.item, destination: failure.info.destParentDir, name: failure.info.destName }))
}

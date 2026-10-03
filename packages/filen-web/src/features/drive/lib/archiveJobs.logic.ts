import type { AnyFile, AnyItemWithContext, AnyNormalDir, ArchiveEntryId, ArchiveFormat, CompressFormat, ExtractRoot } from "@filen/sdk-rs"
import {
	classifyCompressEvents,
	classifyExtractEvents,
	createCompressJob,
	createExtractJob,
	driveItemName,
	isJobRunning,
	type CompressJob as SharedCompressJob,
	type CompressReportInput,
	type CompressSettlement,
	type CompressUpdateInput,
	type CopyJobGlyph,
	type ExtractJob as SharedExtractJob,
	type ExtractProgressBasis,
	type ExtractReportInput,
	type ExtractUpdateInput,
	type JobDestination,
	type SourceDisposalKind
} from "@filen/shared"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { CompressReportDTO, ExtractReportDTO } from "@/lib/sdk/jobErrors"
import type { CompressJobUpdate, ExtractJobUpdate, JobDestinationRef } from "@/workers/sdk.worker"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"

// The wasm side of @filen/shared's compress and extract jobs, as copy.logic.ts is for copy: maps the
// SDK's values onto their inputs, and adds what only web's card and transfers row use.

// "linked" carries SDK items as they came from a public link; they have no DriveItem shape to narrow from.
export type CompressSource = { kind: "items"; items: DriveItem[] } | { kind: "linked"; items: AnyItemWithContext[] }

export interface CompressJobRequest {
	id: string
	source: CompressSource
	destination: JobDestination
	// Ends with the format's extension.
	name: string
	format: CompressFormat
	encrypted: boolean
	dispose: SourceDisposalKind | null
	itemCount: number
}

// One SDK call of an extract job: the whole archive, or some of its entries below `base`.
export type ExtractCall = { type: "all" } | { type: "entries"; entries: ArchiveEntryId[]; base: string; destination: JobDestinationRef }

export interface ExtractJobRequest {
	id: string
	archive: { file: AnyFile; uuid: string; name: string }
	destination: JobDestination
	root: ExtractRoot
	rowName: string
	// Run in order, each waiting for the page's archive slot again.
	calls: ExtractCall[]
	skipMacMetadata: boolean
	// Only for a whole extract of an own file.
	dispose: SourceDisposalKind | null
	basis: ExtractProgressBasis
	// What the archive's name says it is; its bytes decide.
	formatHint: ArchiveFormat["type"] | null
	glyph: CopyJobGlyph
	// Takes over another job's failures.
	retry?: boolean
}

export interface CompressJob extends SharedCompressJob<DriveItem, ErrorDTO> {
	glyph: CopyJobGlyph
	// The progress card is showing.
	cardVisible: boolean
	// What a rerun starts again with.
	request: CompressJobRequest
	// The sources' names by uuid, for the report's originals; only when they were to be removed.
	sourceNames: Readonly<Record<string, string>>
}

export interface ExtractJob extends SharedExtractJob<DriveItem, AnyNormalDir, ErrorDTO> {
	glyph: CopyJobGlyph
	cardVisible: boolean
	request: ExtractJobRequest
	// What the row and card reveal: the new directory, or the first item extracted into the destination.
	firstCreated: DriveItem | null
}

export type CompressJobSettlement = CompressSettlement<DriveItem, ErrorDTO>

export interface ExtractJobReport extends ExtractReportInput<AnyNormalDir, ErrorDTO> {
	// The top-level items the reports list as created, narrowed only if a stop trashes them.
	topLevel: ExtractReportDTO["topLevel"]
}

export type ExtractJobSettlement = { report: ExtractJobReport; maxBytes: number | undefined } | { error: ErrorDTO }

const NO_SOURCE_NAMES: Readonly<Record<string, string>> = {}

export function createWebCompressJob(request: CompressJobRequest): CompressJob {
	return {
		...createCompressJob<DriveItem, ErrorDTO>(request.id, {
			destination: request.destination,
			name: request.name,
			itemCount: request.itemCount,
			dispose: request.dispose,
			encrypted: request.encrypted
		}),
		glyph: "file",
		cardVisible: false,
		request,
		sourceNames:
			request.dispose === null || request.source.kind !== "items"
				? NO_SOURCE_NAMES
				: Object.fromEntries(request.source.items.map(item => [item.data.uuid, driveItemName(item)]))
	}
}

export function createWebExtractJob(request: ExtractJobRequest): ExtractJob {
	return {
		...createExtractJob<DriveItem, AnyNormalDir, ErrorDTO>(request.id, {
			destination: request.destination,
			archiveUuid: request.archive.uuid,
			archiveName: request.archive.name,
			rowName: request.rowName,
			root: request.root.type,
			partial: request.calls.some(call => call.type === "entries"),
			retry: request.retry === true,
			dispose: request.dispose,
			basis: request.basis
		}),
		glyph: request.glyph,
		cardVisible: false,
		request,
		firstCreated: null
	}
}

export function compressUpdateInput(update: CompressJobUpdate): CompressUpdateInput<ErrorDTO> {
	const { events, omitted, ...rest } = update

	return { ...rest, events: classifyCompressEvents(events, omitted) }
}

export function compressReportInput(report: CompressReportDTO): CompressReportInput<DriveItem, ErrorDTO> {
	return { ...report, archive: report.archive === undefined ? undefined : narrowItem(report.archive) }
}

export function extractUpdateInput(update: ExtractJobUpdate): ExtractUpdateInput<AnyNormalDir, ErrorDTO> {
	const { events, omitted, ...rest } = update

	return { ...rest, events: classifyExtractEvents(events, omitted) }
}

export function extractReportInput(report: ExtractReportDTO): ExtractJobReport {
	return { ...report, topLevelCount: report.topLevel.length }
}

// Everything a job made at the top level, for "move extracted items to trash": its report's items joined
// with those its callbacks delivered, once each. A call that rejected has no report, only the delivered
// items. A folder a late wrong password trashed is in neither.
export function extractedTopLevel(settlement: ExtractJobSettlement, delivered: readonly DriveItem[]): DriveItem[] {
	const report = "report" in settlement ? settlement.report : undefined
	const seen = new Set<string>()
	const items: DriveItem[] = []

	for (const item of delivered) {
		if (!seen.has(item.data.uuid)) {
			seen.add(item.data.uuid)
			items.push(item)
		}
	}

	for (const entry of report?.topLevel ?? []) {
		if (!seen.has(entry.item.uuid)) {
			seen.add(entry.item.uuid)
			items.push(narrowItem(entry.item))
		}
	}

	return items
}

// A settled extract whose stop asked for its items to go to the trash, still moving them there.
export function isExtractTrashPending(job: ExtractJob): boolean {
	return !isJobRunning(job) && job.cancelRequest === "trash" && job.created.length > 0
}

// Only a failure that names where it goes again can be retried (a tar's failed hard link cannot).
export function canRetryExtract(job: ExtractJob): boolean {
	return (
		!isJobRunning(job) && !job.retriedAway && !isExtractTrashPending(job) && job.failures.items.some(failure => failure.retry !== null)
	)
}

// A compress that made no archive runs again from scratch; one that made it has nothing to redo.
export function canRerunCompress(job: CompressJob): boolean {
	return job.outcome.status === "failed" || job.outcome.status === "quotaExceeded"
}

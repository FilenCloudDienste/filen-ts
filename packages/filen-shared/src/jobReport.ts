import type { CappedList, JobDisposition, KeptReason, SourceDisposalKind } from "./driveJob"
import type { CompressJob } from "./compressJob"
import type { ExtractJob } from "./extractJob"

// The data model of an archive job's report: sections of rows, flattened into the lines a virtualized
// list renders. Rows reference the job's records; one flatten runs per open or toggle.

export type JobReportSectionKind =
	| "failed"
	| "skipped"
	| "renamed"
	| "misleadingNames"
	| "duplicates"
	| "originalsKept"
	| "originalsRemoved"
	| "hashMismatches"
	| "savedAsVersion"
	| "propagationFailed"

export type JobReportNote<TError> =
	| { type: "error"; error: TError }
	| { type: "renamedTo"; name: string; reason: string }
	| { type: "skipReason"; reason: string; target: string | null }
	| { type: "kept"; reason: KeptReason<TError> }
	| { type: "disposed"; how: SourceDisposalKind }

export interface JobReportRow<TError> {
	// Unique within the report.
	key: string
	path: string
	note: JobReportNote<TError> | null
	retryable: boolean
}

// A section the job only counts has no rows: its count is all in `omitted`.
export interface JobReportSection<TError> {
	// Unique within the report; what the collapsed set holds.
	key: string
	kind: JobReportSectionKind
	// The skip reason a skipped section groups by; null for every other section.
	group: string | null
	rows: readonly JobReportRow<TError>[]
	omitted: number
	collapsedByDefault: boolean
}

function section<TError>(
	kind: JobReportSectionKind,
	rows: readonly JobReportRow<TError>[],
	omitted: number,
	group: string | null = null,
	collapsedByDefault = false
): JobReportSection<TError> {
	return { key: group === null ? kind : `${kind}:${group}`, kind, group, rows, omitted, collapsedByDefault }
}

function rowsOf<T, TError>(
	kind: JobReportSectionKind,
	list: CappedList<T>,
	toRow: (item: T, key: string) => JobReportRow<TError>
): JobReportSection<TError> {
	return section(
		kind,
		list.items.map((item, index) => toRow(item, `${kind}:${index}`)),
		list.omitted
	)
}

// macOS metadata can run to thousands of entries nobody wants to read, so its group starts collapsed
// and comes last. The skipped entries past the cap carry no reason: they get a group of their own.
function skippedSections<T extends { reason: { type: string } }, TError>(
	list: CappedList<T>,
	toRow: (item: T, key: string) => JobReportRow<TError>
): JobReportSection<TError>[] {
	const groups = new Map<string, JobReportRow<TError>[]>()

	list.items.forEach((item, index) => {
		const row = toRow(item, `skipped:${index}`)
		const rows = groups.get(item.reason.type)

		if (rows === undefined) {
			groups.set(item.reason.type, [row])
		} else {
			rows.push(row)
		}
	})

	const sections: JobReportSection<TError>[] = []
	let macMetadata: JobReportRow<TError>[] | undefined

	for (const [reason, rows] of groups) {
		if (reason === "macMetadata") {
			macMetadata = rows
		} else {
			sections.push(section("skipped", rows, 0, reason))
		}
	}

	if (macMetadata !== undefined) {
		sections.push(section("skipped", macMetadata, 0, "macMetadata", true))
	}

	if (list.omitted > 0) {
		sections.push(section("skipped", [], list.omitted, "omitted"))
	}

	return sections
}

function nonEmpty<TError>(sections: JobReportSection<TError>[]): JobReportSection<TError>[] {
	return sections.filter(entry => entry.rows.length > 0 || entry.omitted > 0)
}

function dispositionSections<TError>(
	dispositions: readonly JobDisposition<TError>[],
	pathOf: (uuid: string) => string
): JobReportSection<TError>[] {
	const kept: JobReportRow<TError>[] = []
	const removed: JobReportRow<TError>[] = []

	dispositions.forEach(({ uuid, outcome }, index) => {
		if (outcome.type === "kept") {
			kept.push({
				key: `originalsKept:${index}`,
				path: pathOf(uuid),
				note: { type: "kept", reason: outcome.reason },
				retryable: false
			})
		} else {
			removed.push({
				key: `originalsRemoved:${index}`,
				path: pathOf(uuid),
				note: { type: "disposed", how: outcome.how },
				retryable: false
			})
		}
	})

	return [section("originalsKept", kept, 0), section("originalsRemoved", removed, 0, null, true)]
}

// `nameOf` names a source by its uuid; one it cannot name shows as the uuid.
export function compressReportSections<TError>(
	job: CompressJob<unknown, TError>,
	nameOf: (uuid: string) => string | undefined
): JobReportSection<TError>[] {
	return nonEmpty([
		...skippedSections(job.skipped, (item, key): JobReportRow<TError> => ({
			key,
			path: item.sourcePath,
			note: { type: "skipReason", reason: item.reason.type, target: null },
			retryable: false
		})),
		rowsOf("renamed", job.renamed, (item, key): JobReportRow<TError> => ({
			key,
			path: item.sourcePath,
			note: { type: "renamedTo", name: item.name, reason: item.reason },
			retryable: false
		})),
		...dispositionSections(job.dispositions, uuid => nameOf(uuid) ?? uuid),
		rowsOf("hashMismatches", job.hashMismatches, (item, key): JobReportRow<TError> => ({
			key,
			path: item.path,
			note: null,
			retryable: false
		})),
		section<TError>("propagationFailed", [], job.propagationFailedCount)
	])
}

export function extractReportSections<TDir, TError>(job: ExtractJob<unknown, TDir, TError>): JobReportSection<TError>[] {
	const duplicates = job.duplicates
	const duplicateRows: JobReportRow<TError>[] =
		duplicates === null
			? []
			: duplicates.names.map((name, index) => ({ key: `duplicates:${index}`, path: name, note: null, retryable: false }))

	return nonEmpty([
		rowsOf("failed", job.failures, (item, key): JobReportRow<TError> => ({
			key,
			path: item.path,
			note: { type: "error", error: item.error },
			retryable: item.retry !== null
		})),
		...skippedSections(job.skipped, (item, key): JobReportRow<TError> => ({
			key,
			path: item.path,
			note: { type: "skipReason", reason: item.reason.type, target: "target" in item.reason ? item.reason.target : null },
			retryable: false
		})),
		rowsOf("renamed", job.renamed, (item, key): JobReportRow<TError> => ({
			key,
			path: item.path,
			note: { type: "renamedTo", name: item.name, reason: item.reason },
			retryable: false
		})),
		rowsOf("misleadingNames", job.misleadingNames, (item, key): JobReportRow<TError> => ({
			key,
			path: item.path,
			note: null,
			retryable: false
		})),
		// The count is of entries left out for a later one of the same name, the names at most 100.
		section<TError>("duplicates", duplicateRows, duplicates === null ? 0 : Math.max(0, duplicates.count - duplicateRows.length)),
		...dispositionSections(job.dispositions, () => job.archiveName),
		section<TError>("savedAsVersion", [], job.savedAsVersionCount),
		section<TError>("propagationFailed", [], job.propagationFailedCount)
	])
}

export type JobReportLine<TError> =
	| { type: "heading"; section: JobReportSection<TError> }
	| { type: "row"; row: JobReportRow<TError> }
	| { type: "omitted"; section: JobReportSection<TError>; count: number }

export function defaultCollapsedSections(sections: readonly JobReportSection<unknown>[]): Set<string> {
	const collapsed = new Set<string>()

	for (const entry of sections) {
		if (entry.collapsedByDefault) {
			collapsed.add(entry.key)
		}
	}

	return collapsed
}

// `collapsed` holds the keys of the sections showing only their heading.
export function flattenReportSections<TError>(
	sections: readonly JobReportSection<TError>[],
	collapsed: ReadonlySet<string>
): JobReportLine<TError>[] {
	const lines: JobReportLine<TError>[] = []

	for (const entry of sections) {
		lines.push({ type: "heading", section: entry })

		if (collapsed.has(entry.key)) {
			continue
		}

		for (const row of entry.rows) {
			lines.push({ type: "row", row })
		}

		if (entry.omitted > 0) {
			lines.push({ type: "omitted", section: entry, count: entry.omitted })
		}
	}

	return lines
}

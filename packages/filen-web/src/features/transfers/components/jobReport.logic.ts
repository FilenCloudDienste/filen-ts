import type { TFunction } from "i18next"
import {
	formatBytes,
	type CompressSkipReason,
	type ExtractJobSkipReason,
	type JobReportLine,
	type JobReportNote,
	type JobReportRow,
	type JobReportSection,
	type JobReportSectionKind,
	type KeptReason
} from "@filen/shared"
import type { ArchiveKey } from "@/lib/i18n"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { errorLabelOr } from "@/lib/i18n/errorLabel"
import { MISLEADING_CHARACTER } from "@/lib/sdk/archiveListing"

// The words and sizes of an archive job's report (jobReportDialog.tsx); its sections come from
// @filen/shared's jobReport.ts.

export const REPORT_LINE_HEIGHT = { heading: 40, row: 44, omitted: 32 } as const

type SkipReasonType = ExtractJobSkipReason["type"] | CompressSkipReason["type"] | "omitted"

const SKIP_REASON_KEYS: Record<SkipReasonType, ArchiveKey> = {
	symlink: "archiveReportSkipped_symlink",
	hardlink: "archiveReportSkipped_hardlink",
	device: "archiveReportSkipped_device",
	sparse: "archiveReportSkipped_sparse",
	unsupportedType: "archiveReportSkipped_unsupportedType",
	pathTooLong: "archiveReportSkipped_pathTooLong",
	pathTooDeep: "archiveReportSkipped_pathTooDeep",
	unsafePath: "archiveReportSkipped_unsafePath",
	overlappingData: "archiveReportSkipped_overlappingData",
	unsupportedMethod: "archiveReportSkipped_unsupportedMethod",
	antiItem: "archiveReportSkipped_antiItem",
	macMetadata: "archiveReportSkipped_macMetadata",
	undecryptableFile: "archiveReportSkipped_undecryptableFile",
	unreachable: "archiveReportSkipped_unreachable",
	omitted: "archiveReportSkipped_omitted"
}

const KEPT_REASON_KEYS: Record<KeptReason<unknown>["type"], ArchiveKey> = {
	incomplete: "archiveReportKept_incomplete",
	unaccountedData: "archiveReportKept_unaccountedData",
	hashMismatch: "archiveReportKept_hashMismatch",
	hashUnavailable: "archiveReportKept_hashUnavailable",
	changed: "archiveReportKept_changed",
	unconfirmed: "archiveReportKept_unconfirmed",
	hasVersions: "archiveReportKept_hasVersions",
	interrupted: "archiveReportKept_interrupted",
	failed: "archiveReportKept_failed"
}

const SECTION_TITLE_KEYS: Record<Exclude<JobReportSectionKind, "skipped">, ArchiveKey> = {
	failed: "archiveReportSectionFailed",
	renamed: "archiveReportSectionRenamed",
	misleadingNames: "archiveReportSectionMisleadingNames",
	duplicates: "archiveReportSectionDuplicates",
	originalsKept: "archiveReportSectionOriginalsKept",
	originalsRemoved: "archiveReportSectionOriginalsRemoved",
	hashMismatches: "archiveReportSectionHashMismatches",
	savedAsVersion: "archiveReportSectionSavedAsVersion",
	propagationFailed: "archiveReportSectionPropagationFailed"
}

function isSkipReason(reason: string): reason is SkipReasonType {
	return Object.hasOwn(SKIP_REASON_KEYS, reason)
}

// A reason this build does not know (a newer SDK's) reads as a type it cannot handle.
export function skipReasonKey(reason: string): ArchiveKey {
	return SKIP_REASON_KEYS[isSkipReason(reason) ? reason : "unsupportedType"]
}

export function keptReasonKey(reason: KeptReason<unknown>["type"]): ArchiveKey {
	return KEPT_REASON_KEYS[reason]
}

// A skipped section is titled by the reason it groups.
export function sectionTitleKey(section: JobReportSection<unknown>): ArchiveKey {
	return section.kind === "skipped" ? skipReasonKey(section.group ?? "omitted") : SECTION_TITLE_KEYS[section.kind]
}

export function sectionCount(section: JobReportSection<unknown>): number {
	return section.rows.length + section.omitted
}

// The line under a row's path; null when the section's title says it all.
export function noteText(note: JobReportNote<ErrorDTO> | null, t: TFunction<["archive", "transfers"]>): string | null {
	if (note === null) {
		return null
	}

	switch (note.type) {
		case "error":
			return errorLabelOr(note.error, t("transfers:transfersCopyErrorGeneric"))
		case "renamedTo":
			return t("archiveReportRenamedTo", { name: note.name })
		case "skipReason":
			return note.target === null ? null : t("archiveReportSkippedTarget", { target: note.target })
		case "kept": {
			const { reason } = note

			switch (reason.type) {
				case "failed":
					return errorLabelOr(reason.error, t(keptReasonKey(reason.type)))
				case "unaccountedData":
					return t("archiveReportKept_unaccountedData", { size: formatBytes(reason.bytes) })
				default:
					return t(keptReasonKey(reason.type))
			}
		}
		case "disposed":
			return t(note.how === "trash" ? "archiveReportRemovedTrash" : "archiveReportRemovedDelete")
	}
}

export function lineKey(line: JobReportLine<unknown>): string {
	switch (line.type) {
		case "heading":
			return `heading:${line.section.key}`
		case "row":
			return `row:${line.row.key}`
		case "omitted":
			return `omitted:${line.section.key}`
	}
}

export function lineHeight(line: JobReportLine<unknown>): number {
	return REPORT_LINE_HEIGHT[line.type]
}

// A misleading name shows what it is made of; every other path as it is. Rows are keyed by their section
// kind (@filen/shared jobReport.ts), and a row carries no section of its own.
export function reportRowPath(row: JobReportRow<unknown>): string {
	return row.key.startsWith("misleadingNames:") ? revealHiddenCharacters(row.path) : row.path
}

const MISLEADING_CHARACTERS = new RegExp(MISLEADING_CHARACTER.source, "gu")

// Shows every invisible or direction-changing character the SDK flags (a right-to-left override, a
// zero-width joiner, a byte-order mark) as its code point, so a name reads as what it is.
export function revealHiddenCharacters(value: string): string {
	return value.replace(
		MISLEADING_CHARACTERS,
		character => `⟨U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`
	)
}

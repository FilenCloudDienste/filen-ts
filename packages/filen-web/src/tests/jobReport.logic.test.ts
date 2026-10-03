import { describe, expect, it } from "vitest"
import { compressReportSections, defaultCollapsedSections, extractReportSections, flattenReportSections } from "@filen/shared"
import { i18n } from "@/lib/i18n"
import {
	keptReasonKey,
	lineHeight,
	lineKey,
	noteText,
	reportRowPath,
	revealHiddenCharacters,
	sectionCount,
	sectionTitleKey,
	skipReasonKey
} from "@/features/transfers/components/jobReport.logic"
import { compressJob, extractFailure, extractJob } from "@/tests/support/archiveJobFixtures"

const t = i18n.getFixedT<["archive", "transfers"]>("en", ["archive", "transfers"])
const ENTRY = { archive: "a", index: 0 }

function capped<T>(items: T[], omitted = 0): { items: T[]; omitted: number } {
	return { items, omitted }
}

describe("revealHiddenCharacters", () => {
	it("shows a right-to-left override, a zero-width joiner and a byte-order mark as their code points", () => {
		expect(revealHiddenCharacters("invoice‮fdp.exe")).toBe("invoice⟨U+202E⟩fdp.exe")
		expect(revealHiddenCharacters("a‍b")).toBe("a⟨U+200D⟩b")
		expect(revealHiddenCharacters("﻿name")).toBe("⟨U+FEFF⟩name")
		expect(revealHiddenCharacters("tab\there")).toBe("tab⟨U+0009⟩here")
		expect(revealHiddenCharacters("plain/päth.txt")).toBe("plain/päth.txt")
	})

	it("reveals only the misleading names' rows", () => {
		const job = extractJob({
			misleadingNames: capped([{ entry: ENTRY, path: "a‮b" }]),
			renamed: capped([{ entry: ENTRY, path: "c‮d", name: "x", reason: "duplicateName" }])
		})
		const rows = extractReportSections(job).flatMap(section => section.rows)

		expect(rows.map(reportRowPath)).toEqual(["c‮d", "a⟨U+202E⟩b"])
	})
})

describe("report sections", () => {
	it("titles a skipped group by its reason, any other by its kind, and counts the rows left out", () => {
		const job = extractJob({
			failures: capped([extractFailure("x.txt", 0, { species: "plain", message: "m", label: "l" })], 4),
			skipped: capped(
				[
					{ entry: ENTRY, path: "link", pathTruncated: false, bytes: 0, reason: { type: "symlink", target: "../etc" } },
					{ entry: ENTRY, path: "__MACOSX/a", pathTruncated: false, bytes: 0, reason: { type: "macMetadata" } }
				],
				2
			)
		})
		const sections = extractReportSections(job)

		expect(sections.map(sectionTitleKey)).toEqual([
			"archiveReportSectionFailed",
			"archiveReportSkipped_symlink",
			"archiveReportSkipped_macMetadata",
			"archiveReportSkipped_omitted"
		])
		expect(sections.map(sectionCount)).toEqual([5, 1, 1, 2])
	})

	it("starts with the macOS metadata collapsed and the misleading names expanded", () => {
		const job = extractJob({
			skipped: capped([{ entry: ENTRY, path: "._a", pathTruncated: false, bytes: 0, reason: { type: "macMetadata" } }]),
			misleadingNames: capped([{ entry: ENTRY, path: "a‮b" }], 3)
		})
		const sections = extractReportSections(job)
		const collapsed = defaultCollapsedSections(sections)
		const lines = flattenReportSections(sections, collapsed)

		expect([...collapsed]).toEqual(["skipped:macMetadata"])
		expect(lines.map(lineKey)).toEqual([
			"heading:skipped:macMetadata",
			"heading:misleadingNames",
			"row:misleadingNames:0",
			"omitted:misleadingNames"
		])
		expect(lines.map(lineHeight)).toEqual([40, 40, 44, 32])

		const expanded = flattenReportSections(sections, new Set())

		expect(expanded.map(lineKey)).toContain("row:skipped:0")
	})

	it("names a compress's originals by the name it kept, falling back to the uuid", () => {
		const job = compressJob({
			dispositions: [
				{ uuid: "known", outcome: { type: "kept", reason: { type: "changed" }, bytesFreed: 0 } },
				{ uuid: "unknown", outcome: { type: "disposed", how: "trash", bytesFreed: 0 } }
			],
			sourceNames: { known: "Holiday.jpg" }
		})
		const sections = compressReportSections(job, uuid => job.sourceNames[uuid])

		expect(sections.flatMap(section => section.rows.map(row => row.path))).toEqual(["Holiday.jpg", "unknown"])
	})

	it("reads an unknown skip reason as an unsupported entry", () => {
		expect(skipReasonKey("somethingNew")).toBe("archiveReportSkipped_unsupportedType")
		expect(skipReasonKey("unreachable")).toBe("archiveReportSkipped_unreachable")
		expect(keptReasonKey("hasVersions")).toBe("archiveReportKept_hasVersions")
	})
})

describe("noteText", () => {
	it("words every note", () => {
		expect(noteText(null, t)).toBeNull()
		expect(noteText({ type: "renamedTo", name: "b.txt", reason: "duplicateName" }, t)).toBe("Renamed to b.txt")
		expect(noteText({ type: "skipReason", reason: "symlink", target: "../etc" }, t)).toBe("Points to ../etc")
		expect(noteText({ type: "skipReason", reason: "unsafePath", target: null }, t)).toBeNull()
		expect(noteText({ type: "kept", reason: { type: "hashMismatch" } }, t)).toBe("Its content didn't match its checksum")
		expect(noteText({ type: "kept", reason: { type: "unaccountedData", bytes: 2048 } }, t)).toBe(
			"The archive holds 2 KiB after its last entry"
		)
		expect(noteText({ type: "disposed", how: "trash" }, t)).toBe("Moved to the trash")
		expect(noteText({ type: "disposed", how: "deletePermanently" }, t)).toBe("Deleted permanently")
		expect(noteText({ type: "error", error: { species: "plain", message: "developer text", label: "x" } }, t)).toBe(
			"Something went wrong."
		)
	})
})

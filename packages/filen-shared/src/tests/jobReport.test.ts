import { describe, expect, it } from "vitest"
import {
	compressReportSections,
	createCompressJob,
	createExtractJob,
	defaultCollapsedSections,
	extractReportSections,
	flattenReportSections,
	type CompressJob,
	type ExtractJob,
	type ExtractSkipped
} from "@filen/shared"

interface TestError {
	label: string
}

type Compress = CompressJob<unknown, TestError>
type Extract = ExtractJob<unknown, unknown, TestError>

function compress(overrides: Partial<Compress> = {}): Compress {
	return {
		...createCompressJob<unknown, TestError>("c", {
			destination: { uuid: null, name: "Drive" },
			name: "a.zip",
			itemCount: 1,
			dispose: "trash",
			encrypted: false
		}),
		...overrides
	}
}

function extract(overrides: Partial<Extract> = {}): Extract {
	return {
		...createExtractJob<unknown, unknown, TestError>("e", {
			destination: { uuid: null, name: "Drive" },
			archiveUuid: "arc",
			archiveName: "photos.zip",
			rowName: "photos",
			root: "newFolder",
			partial: false,
			retry: false,
			dispose: "trash",
			basis: { type: "archiveRead" }
		}),
		...overrides
	}
}

function skipped(index: number, reason: ExtractSkipped["reason"]): ExtractSkipped {
	return { entry: { archive: "arc", index }, path: `s${index}`, pathTruncated: false, bytes: 1, reason }
}

describe("extractReportSections", () => {
	it("is empty for a clean job", () => {
		expect(extractReportSections(extract())).toEqual([])
	})

	it("orders the sections and groups skipped entries by reason, macOS metadata last and collapsed", () => {
		const sections = extractReportSections(
			extract({
				failures: {
					items: [
						{
							entry: { archive: "arc", index: 1 },
							path: "f1",
							destParent: "d",
							destName: "f1",
							stage: { type: "upload" },
							retry: { destination: "d", destinationDir: {}, base: "" },
							error: { label: "x" }
						},
						{
							entry: { archive: "arc", index: 2 },
							path: "f2",
							destParent: "d",
							destName: "f2",
							stage: { type: "upload" },
							retry: null,
							error: { label: "y" }
						}
					],
					omitted: 3
				},
				skipped: {
					items: [
						skipped(1, { type: "macMetadata" }),
						skipped(2, { type: "symlink", target: "../etc" }),
						skipped(3, { type: "macMetadata" }),
						skipped(4, { type: "device" })
					],
					omitted: 2
				},
				renamed: {
					items: [{ entry: { archive: "arc", index: 5 }, path: "a/b", name: "b (1)", reason: "duplicateName" }],
					omitted: 0
				},
				misleadingNames: { items: [{ entry: { archive: "arc", index: 6 }, path: "x‮txt.exe" }], omitted: 0 },
				duplicates: { names: ["dup.txt"], count: 4 },
				dispositions: [{ uuid: "arc", outcome: { type: "kept", reason: { type: "incomplete" }, bytesFreed: 0 } }],
				savedAsVersionCount: 2,
				propagationFailedCount: 1
			})
		)

		expect(sections.map(section => section.key)).toEqual([
			"failed",
			"skipped:symlink",
			"skipped:device",
			"skipped:macMetadata",
			"skipped:omitted",
			"renamed",
			"misleadingNames",
			"duplicates",
			"originalsKept",
			"savedAsVersion",
			"propagationFailed"
		])

		const [failed] = sections

		expect(failed?.rows.map(row => row.retryable)).toEqual([true, false])
		expect(failed?.rows[0]?.note).toEqual({ type: "error", error: { label: "x" } })
		expect(failed?.omitted).toBe(3)
		expect(sections.find(section => section.key === "skipped:symlink")?.rows[0]?.note).toEqual({
			type: "skipReason",
			reason: "symlink",
			target: "../etc"
		})
		expect(sections.find(section => section.key === "skipped:macMetadata")).toMatchObject({
			collapsedByDefault: true,
			group: "macMetadata"
		})
		expect(sections.find(section => section.key === "skipped:macMetadata")?.rows.map(row => row.path)).toEqual(["s1", "s3"])
		expect(sections.find(section => section.key === "skipped:omitted")).toMatchObject({ rows: [], omitted: 2 })
		expect(sections.find(section => section.key === "duplicates")).toMatchObject({ omitted: 3 })
		expect(sections.find(section => section.key === "originalsKept")?.rows[0]).toMatchObject({
			path: "photos.zip",
			note: { type: "kept", reason: { type: "incomplete" } }
		})
		expect(sections.find(section => section.key === "savedAsVersion")).toMatchObject({ rows: [], omitted: 2 })
	})

	it("references the job's error rather than copying it", () => {
		const error = { label: "x" }
		const [failed] = extractReportSections(
			extract({
				failures: {
					items: [
						{
							entry: { archive: "arc", index: 1 },
							path: "f",
							destParent: "d",
							destName: "f",
							stage: { type: "upload" },
							retry: null,
							error
						}
					],
					omitted: 0
				}
			})
		)

		expect(failed?.rows[0]?.note?.type === "error" && failed.rows[0].note.error).toBe(error)
	})
})

describe("compressReportSections", () => {
	it("names sources through the app and lists removed originals collapsed", () => {
		const sections = compressReportSections(
			compress({
				skipped: { items: [{ sourcePath: "a/x", bytes: 1, reason: { type: "undecryptableFile", uuid: "u" } }], omitted: 0 },
				renamed: { items: [{ sourceUuid: "r", sourcePath: "a/b", name: "b (1)", reason: "duplicateName" }], omitted: 0 },
				dispositions: [
					{ uuid: "known", outcome: { type: "kept", reason: { type: "hashMismatch" }, bytesFreed: 0 } },
					{ uuid: "unknown", outcome: { type: "disposed", how: "trash", bytesFreed: 10 } }
				],
				hashMismatches: { items: [{ sourceUuid: "h", path: "a/h" }], omitted: 7 }
			}),
			uuid => (uuid === "known" ? "Report.pdf" : undefined)
		)

		expect(sections.map(section => section.key)).toEqual([
			"skipped:undecryptableFile",
			"renamed",
			"originalsKept",
			"originalsRemoved",
			"hashMismatches"
		])
		expect(sections[1]?.rows[0]?.note).toEqual({ type: "renamedTo", name: "b (1)", reason: "duplicateName" })
		expect(sections[2]?.rows[0]?.path).toBe("Report.pdf")
		expect(sections[3]).toMatchObject({ collapsedByDefault: true })
		expect(sections[3]?.rows[0]).toMatchObject({ path: "unknown", note: { type: "disposed", how: "trash" } })
		expect(sections[4]?.omitted).toBe(7)
	})

	it("is empty for a clean job", () => {
		expect(compressReportSections(compress(), () => undefined)).toEqual([])
	})
})

describe("flattenReportSections", () => {
	const sections = extractReportSections(
		extract({
			skipped: { items: [skipped(1, { type: "device" }), skipped(2, { type: "macMetadata" })], omitted: 0 },
			renamed: { items: [{ entry: { archive: "arc", index: 5 }, path: "a/b", name: "b (1)", reason: "pathRewritten" }], omitted: 4 }
		})
	)

	it("emits each heading, then its rows and what was left out", () => {
		const lines = flattenReportSections(sections, new Set())

		expect(lines.map(line => (line.type === "row" ? `row:${line.row.path}` : `${line.type}:${line.section.key}`))).toEqual([
			"heading:skipped:device",
			"row:s1",
			"heading:skipped:macMetadata",
			"row:s2",
			"heading:renamed",
			"row:a/b",
			"omitted:renamed"
		])
		expect(lines.at(-1)).toMatchObject({ type: "omitted", count: 4 })
	})

	it("shows only the heading of a collapsed section", () => {
		const lines = flattenReportSections(sections, defaultCollapsedSections(sections))

		expect(lines.map(line => line.type)).toEqual(["heading", "row", "heading", "heading", "row", "omitted"])
	})

	it("references the sections' rows", () => {
		const lines = flattenReportSections(sections, new Set())

		expect(lines[1]?.type === "row" && lines[1].row).toBe(sections[0]?.rows[0])
	})

	it("collapses by default only the sections that say so", () => {
		expect([...defaultCollapsedSections(sections)]).toEqual(["skipped:macMetadata"])
	})
})

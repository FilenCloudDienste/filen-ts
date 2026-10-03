import { describe, expect, it } from "vitest"
import type { Dir, File } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import { createCopyJob, type CopyJob } from "@/features/drive/lib/copy.logic"
import { createWebCompressJob, createWebExtractJob, type CompressJob, type ExtractJob } from "@/features/drive/lib/archiveJobs.logic"
import {
	driveJobPercent,
	driveJobRate,
	driveJobRowFigures,
	isDriveJobRunning,
	isDriveJobTrashPending,
	jobCancelStyle,
	jobHasReport,
	jobRetryKind,
	jobRevealItem
} from "@/features/drive/lib/driveJobs.logic"
import { testUuid } from "@/tests/support/uuid"
import { sdkErrorDTO } from "@/tests/support/sdkError"

const ROOT = testUuid("root")
const DESTINATION = { uuid: null, name: "My Drive" }

const FILE: File = {
	uuid: testUuid("archive"),
	stableUUID: undefined,
	parent: ROOT,
	size: 100n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "a.zip", mime: "application/zip", modified: 0n, size: 100n, key: "k", version: 2 } }
}

const DIR: Dir = {
	uuid: testUuid("dir"),
	parent: ROOT,
	color: "default",
	timestamp: 0n,
	favorited: false,
	meta: { type: "decoded", data: { name: "d" } }
}

function copyJob(overrides: Partial<CopyJob> = {}): CopyJob {
	return { ...createCopyJob("copy", DESTINATION, 1), ...overrides }
}

function compressJob(overrides: Partial<CompressJob> = {}): CompressJob {
	return {
		...createWebCompressJob({
			id: "compress",
			source: { kind: "items", items: [] },
			destination: DESTINATION,
			name: "a.zip",
			format: { type: "zip", method: { type: "stored" } },
			encrypted: false,
			dispose: null,
			itemCount: 1
		}),
		...overrides
	}
}

function extractJob(overrides: Partial<ExtractJob> = {}): ExtractJob {
	return {
		...createWebExtractJob({
			id: "extract",
			archive: { file: FILE, uuid: FILE.uuid, name: "a.zip" },
			destination: DESTINATION,
			root: { type: "newFolder" },
			rowName: "a",
			calls: [{ type: "all" }],
			skipMacMetadata: true,
			dispose: null,
			basis: { type: "archiveRead" },
			formatHint: "zip",
			glyph: "directory"
		}),
		...overrides
	}
}

describe("driveJobs.logic", () => {
	it("reads progress and the row's figures by kind", () => {
		const copy = copyJob({
			phase: "copyingFiles",
			totals: { dirs: 0, files: 1, bytes: 200 },
			counts: { ...copyJob().counts, bytesDone: 100 }
		})
		const extract = extractJob({ phase: "extracting", archiveBytes: 1_000, bytesRead: 250 })
		const compress = compressJob({
			phase: "compressing",
			totals: { dirs: 0, files: 1, bytes: 400 },
			counts: { ...compressJob().counts, bytesRead: 100 }
		})

		expect(driveJobPercent(copy)).toBe(50)
		expect(driveJobRowFigures(copy)).toEqual({ size: 200, shown: 100 })
		expect(driveJobPercent(extract)).toBe(25)
		expect(driveJobRowFigures(extract)).toEqual({ size: 1_000, shown: 250 })
		expect(driveJobPercent(compress)).toBe(25)
		expect(driveJobRowFigures(compress)).toEqual({ size: 400, shown: 100 })
		expect(driveJobPercent(extractJob({ phase: "waitingForWorker" }))).toBeNull()
	})

	it("gives a rate only while a job moves bytes", () => {
		expect(driveJobRate(extractJob({ bytesPerSecond: 1_000, etaMs: 2_500 }))).toEqual({ bytesPerSecond: 1_000, etaSeconds: 3 })
		expect(driveJobRate(extractJob({ bytesPerSecond: 1_000, paused: true }))).toBeNull()
		expect(driveJobRate(copyJob({ bytesPerSecond: 500, etaMs: null }))).toEqual({ bytesPerSecond: 500, etaSeconds: null })
	})

	it("tells running, trash-pending and cancel styles apart by kind", () => {
		const trashing = { cancelRequest: "trash" as const, created: [narrowItem(DIR)], outcome: { status: "cancelled" as const } }

		expect(isDriveJobRunning(compressJob())).toBe(true)
		expect(isDriveJobRunning(compressJob({ outcome: { status: "done" } }))).toBe(false)
		expect(isDriveJobTrashPending(copyJob(trashing))).toBe(true)
		expect(isDriveJobTrashPending(extractJob(trashing))).toBe(true)
		expect(isDriveJobTrashPending(compressJob({ outcome: { status: "cancelled" } }))).toBe(false)
		expect(jobCancelStyle(compressJob())).toBe("confirm")
		expect(jobCancelStyle(extractJob())).toBe("keepOrTrash")
		expect(jobCancelStyle(copyJob())).toBe("keepOrTrash")
	})

	it("offers a retry of failures for copy and extract, and a rerun for a compress that made nothing", () => {
		const error = sdkErrorDTO("Server", "boom")
		const failure = {
			entry: { archive: FILE.uuid, index: 0 },
			path: "x",
			destParent: DIR.uuid,
			destName: "x",
			stage: { type: "upload" as const },
			retry: { destination: DIR.uuid, destinationDir: DIR, base: "" },
			error
		}

		expect(jobRetryKind(extractJob({ outcome: { status: "doneWithIssues" }, failures: { items: [failure], omitted: 0 } }))).toBe(
			"failed"
		)
		expect(jobRetryKind(extractJob({ outcome: { status: "done" } }))).toBeNull()
		expect(jobRetryKind(compressJob({ outcome: { status: "failed", error } }))).toBe("rerun")
		expect(jobRetryKind(compressJob({ outcome: { status: "done" } }))).toBeNull()
		expect(jobRetryKind(copyJob({ outcome: { status: "doneWithFailures" } }))).toBeNull()
	})

	it("has a report only for a settled archive job with something to list", () => {
		const kept = { uuid: FILE.uuid, outcome: { type: "kept" as const, reason: { type: "changed" as const }, bytesFreed: 0 } }

		expect(jobHasReport(compressJob({ outcome: { status: "done" } }))).toBe(false)
		expect(jobHasReport(compressJob({ outcome: { status: "doneWithIssues" }, dispositions: [kept] }))).toBe(true)
		expect(jobHasReport(compressJob({ dispositions: [kept] }))).toBe(false)
		expect(jobHasReport(extractJob({ outcome: { status: "done" }, duplicates: { names: ["a"], count: 1 } }))).toBe(true)
		expect(jobHasReport(copyJob({ outcome: { status: "doneWithFailures" } }))).toBe(false)
	})

	it("reveals the archive, the extracted directory or a copy's first item", () => {
		const archive = narrowItem(FILE)
		const dir = narrowItem(DIR)

		expect(jobRevealItem(compressJob({ archive }))).toBe(archive)
		expect(jobRevealItem(extractJob({ firstCreated: dir }))).toBe(dir)
		expect(jobRevealItem(copyJob({ created: [dir] }))).toBe(dir)
		expect(jobRevealItem(extractJob())).toBeNull()
	})
})

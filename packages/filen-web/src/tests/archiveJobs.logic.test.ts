import { describe, expect, it } from "vitest"
import type { Dir, File, ItemCounts, UuidStr } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import {
	canRerunCompress,
	canRetryExtract,
	compressReportInput,
	compressUpdateInput,
	createWebCompressJob,
	createWebExtractJob,
	extractedTopLevel,
	extractReportInput,
	extractUpdateInput,
	isExtractTrashPending,
	keepsJobPassword,
	type CompressJobRequest,
	type ExtractJobRequest
} from "@/features/drive/lib/archiveJobs.logic"
import type { CompressJobUpdate, ExtractJobUpdate } from "@/workers/sdk.worker"
import type { ExtractReportDTO } from "@/lib/sdk/jobErrors"
import { testUuid } from "@/tests/support/uuid"
import { sdkErrorDTO } from "@/tests/support/sdkError"

const ROOT = testUuid("root")
const DESTINATION = { uuid: null, name: "My Drive" }

function mockFile(label: string, parent: UuidStr = ROOT): File {
	return {
		uuid: testUuid(label),
		stableUUID: undefined,
		parent,
		size: 100n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name: `${label}.txt`, mime: "text/plain", modified: 0n, size: 100n, key: "k", version: 2 } }
	}
}

function mockDir(label: string): Dir {
	return {
		uuid: testUuid(label),
		parent: ROOT,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: label } }
	}
}

function counts(overrides: Partial<ItemCounts> = {}): ItemCounts {
	return {
		dirsCreated: 0n,
		dirsFailed: 0n,
		filesDone: 0n,
		filesFailed: 0n,
		bytesDone: 0n,
		bytesFailed: 0n,
		dirsNotAttempted: 0n,
		filesNotAttempted: 0n,
		bytesNotAttempted: 0n,
		entriesSkipped: 0n,
		bytesSkipped: 0n,
		...overrides
	}
}

function compressRequest(overrides: Partial<CompressJobRequest> = {}): CompressJobRequest {
	return {
		id: "c",
		source: { kind: "items", items: [narrowItem(mockFile("a")), narrowItem(mockDir("b"))] },
		destination: DESTINATION,
		name: "a.7z",
		format: { type: "sevenZ", method: { type: "lzma2", level: 5 }, solid: true },
		encrypted: false,
		dispose: null,
		itemCount: 2,
		...overrides
	}
}

function extractRequest(overrides: Partial<ExtractJobRequest> = {}): ExtractJobRequest {
	const archive = mockFile("archive")

	return {
		id: "e",
		archive: { file: archive, uuid: archive.uuid, name: "archive.zip" },
		destination: DESTINATION,
		root: { type: "newFolder" },
		rowName: "archive",
		calls: [{ type: "all" }],
		skipMacMetadata: true,
		dispose: null,
		basis: { type: "archiveRead" },
		formatHint: "zip",
		glyph: "directory",
		...overrides
	}
}

function extractReport(overrides: Partial<ExtractReportDTO> = {}): ExtractReportDTO {
	return {
		topLevel: [],
		failures: [],
		skipped: [],
		renamed: [],
		misleadingNames: [],
		omitted: { skipped: 0n, renamed: 0n, misleadingNames: 0n, failures: 0n, topLevel: 0n },
		archiveBytes: 1_000n,
		counts: counts(),
		unaccountedBytes: 0n,
		duplicates: undefined,
		dispositions: [],
		error: undefined,
		...overrides
	}
}

function failure(index: number, retry: boolean) {
	const dir = mockDir("target")

	return {
		entry: { archive: testUuid("archive"), index },
		path: String(index),
		destParent: dir.uuid,
		destName: String(index),
		stage: { type: "upload" as const },
		retry: retry ? { destination: dir.uuid, destinationDir: dir, base: "" } : null,
		error: sdkErrorDTO("Server", "boom")
	}
}

describe("createWebCompressJob", () => {
	it("starts a compress job with the request, a file glyph, and no source names unless the sources go", () => {
		const request = compressRequest()
		const job = createWebCompressJob(request)

		expect(job).toMatchObject({ id: "c", kind: "compress", name: "a.7z", itemCount: 2, glyph: "file", cardVisible: false })
		expect(job.request).toBe(request)
		expect(job.sourceNames).toEqual({})
		expect(createWebCompressJob(compressRequest({ dispose: "trash" })).sourceNames).toEqual({
			[testUuid("a")]: "a.txt",
			[testUuid("b")]: "b"
		})
	})
})

describe("createWebExtractJob", () => {
	it("derives the shared job's fields from the request", () => {
		const job = createWebExtractJob(
			extractRequest({
				root: { type: "destination" },
				calls: [{ type: "entries", entries: [], base: "", destination: { uuid: null } }],
				retry: true
			})
		)

		expect(job).toMatchObject({
			kind: "extract",
			archiveUuid: testUuid("archive"),
			archiveName: "archive.zip",
			rowName: "archive",
			root: "destination",
			partial: true,
			retry: true,
			glyph: "directory",
			firstCreated: null
		})
		expect(createWebExtractJob(extractRequest())).toMatchObject({ partial: false, retry: false, root: "newFolder" })
	})
})

describe("update and report inputs", () => {
	it("classifies a compress update's events with the worker's omitted tallies", () => {
		const update: CompressJobUpdate = {
			phase: "compressing",
			runState: "paused",
			scan: { sourcesDone: 1n, sourcesTotal: 1n, listingBytes: 0n, listingTotalBytes: undefined },
			totals: { dirs: 0n, files: 1n, bytes: 10n },
			counts: {
				filesDone: 0n,
				entriesSkipped: 0n,
				bytesSkipped: 0n,
				bytesRead: 0n,
				bytesWritten: 0n,
				archiveBytes: 0n,
				bytesVerified: 0n
			},
			active: [],
			events: [{ type: "skipped", sourcePath: "x", bytes: 5n, reason: { type: "unreachable", count: 2n } }],
			bytesPerSecond: undefined,
			etaMs: undefined,
			activeTimeMs: 0n,
			omitted: { skipped: 3, renamed: 0, hashMismatches: 0 }
		}

		const input = compressUpdateInput(update)

		expect(input.runState).toBe("paused")
		expect(input.events.skipped).toEqual([{ sourcePath: "x", bytes: 5, reason: { type: "unreachable", count: 2 } }])
		expect(input.events.omitted.skipped).toBe(3)
	})

	it("narrows a compress report's archive", () => {
		const archive = mockFile("archive")
		const input = compressReportInput({
			archive,
			skipped: [],
			renamed: [],
			totals: { dirs: 0n, files: 0n, bytes: 0n },
			counts: {
				filesDone: 0n,
				entriesSkipped: 0n,
				bytesSkipped: 0n,
				bytesRead: 0n,
				bytesWritten: 0n,
				archiveBytes: 0n,
				bytesVerified: 0n
			},
			neededBytes: undefined,
			dispositions: [],
			hashMismatches: [],
			omittedHashMismatches: 0n,
			error: undefined
		})

		expect(input.archive).toEqual(narrowItem(archive))
	})

	it("classifies an extract update, trashed folders included", () => {
		const update: ExtractJobUpdate = {
			phase: "extracting",
			runState: "running",
			archiveBytes: 10n,
			counts: counts(),
			bytesRead: 5n,
			active: [],
			events: [{ type: "topLevelTrashed", destUuid: testUuid("dir") }],
			bytesPerSecond: undefined,
			etaMs: undefined,
			activeTimeMs: 0n,
			omitted: { failures: 3, skipped: 4, renamed: 0, misleadingNames: 1, savedAsVersion: 2, macMetadata: 4 }
		}

		const input = extractUpdateInput(update)

		expect(input.events.topLevelTrashed).toEqual([testUuid("dir")])
		expect(input.events.omitted).toEqual({ failures: 1, skipped: 4, renamed: 0, misleadingNames: 1 })
		expect(input.events.savedAsVersion).toBe(2)
		expect(input.events.macMetadataSkipped).toBe(4)
	})

	it("counts an extract report's top-level items and keeps them unnarrowed", () => {
		const dir = mockDir("folder")
		const topLevel = [{ key: { type: "root" as const }, item: { type: "dir" as const, ...dir } }]
		const input = extractReportInput(extractReport({ topLevel }))

		expect(input.topLevelCount).toBe(1)
		expect(input.topLevel).toBe(topLevel)
	})
})

describe("extractedTopLevel", () => {
	it("joins the delivered items with the report's, once each", () => {
		const delivered = narrowItem(mockDir("delivered"))
		const reported = mockDir("reported")
		const report = extractReportInput(
			extractReport({
				topLevel: [
					{ key: { type: "root" }, item: { type: "dir", ...mockDir("delivered") } },
					{ key: { type: "root" }, item: { type: "dir", ...reported } }
				]
			})
		)

		expect(extractedTopLevel({ report, maxBytes: undefined }, [delivered]).map(item => item.data.uuid)).toEqual([
			delivered.data.uuid,
			reported.uuid
		])
		expect(extractedTopLevel({ error: sdkErrorDTO("Cancelled", "x") }, [delivered])).toEqual([delivered])
	})
})

describe("retry and rerun", () => {
	it("retries a settled extract with a retryable failure, once, and not while its stop still trashes", () => {
		const settled = { ...createWebExtractJob(extractRequest()), outcome: { status: "doneWithIssues" as const } }
		const withFailures = { ...settled, failures: { items: [failure(1, false), failure(2, true)], omitted: 0 } }

		expect(canRetryExtract(settled)).toBe(false)
		expect(canRetryExtract({ ...withFailures, failures: { items: [failure(1, false)], omitted: 0 } })).toBe(false)
		expect(canRetryExtract(withFailures)).toBe(true)
		expect(canRetryExtract({ ...withFailures, retriedAway: true })).toBe(false)
		expect(canRetryExtract({ ...withFailures, outcome: { status: "running" } })).toBe(false)

		const trashing = { ...withFailures, cancelRequest: "trash" as const, created: [narrowItem(mockDir("x"))] }

		expect(isExtractTrashPending(trashing)).toBe(true)
		expect(canRetryExtract(trashing)).toBe(false)
	})

	it("reruns a compress only when it made no archive", () => {
		const job = createWebCompressJob(compressRequest())

		expect(canRerunCompress({ ...job, outcome: { status: "failed", error: sdkErrorDTO("Server", "x") } })).toBe(true)
		expect(canRerunCompress({ ...job, outcome: { status: "quotaExceeded", neededBytes: null, freeBytes: 0 } })).toBe(true)
		expect(canRerunCompress({ ...job, outcome: { status: "doneWithIssues" } })).toBe(false)
		expect(canRerunCompress(job)).toBe(false)
	})

	it("keeps a settled job's password only while a rerun, a retry or the password prompt can use it", () => {
		const compress = createWebCompressJob(compressRequest())
		const extract = createWebExtractJob(extractRequest())
		const retryable = {
			...extract,
			outcome: { status: "doneWithIssues" as const },
			failures: { items: [failure(1, true)], omitted: 0 }
		}

		expect(keepsJobPassword({ ...compress, outcome: { status: "failed", error: sdkErrorDTO("Server", "x") } })).toBe(true)
		expect(keepsJobPassword({ ...compress, outcome: { status: "quotaExceeded", neededBytes: 1, freeBytes: 0 } })).toBe(true)
		expect(keepsJobPassword({ ...compress, outcome: { status: "done" } })).toBe(false)
		expect(keepsJobPassword({ ...compress, outcome: { status: "cancelled" } })).toBe(false)
		expect(keepsJobPassword({ ...extract, outcome: { status: "passwordRequired" } })).toBe(true)
		expect(keepsJobPassword({ ...extract, outcome: { status: "wrongPassword" } })).toBe(true)
		expect(keepsJobPassword(retryable)).toBe(true)
		expect(keepsJobPassword({ ...retryable, failures: { items: [failure(1, false)], omitted: 0 } })).toBe(false)
		expect(keepsJobPassword({ ...extract, outcome: { status: "done" } })).toBe(false)
		expect(keepsJobPassword({ ...extract, outcome: { status: "cancelled" } })).toBe(false)
	})
})

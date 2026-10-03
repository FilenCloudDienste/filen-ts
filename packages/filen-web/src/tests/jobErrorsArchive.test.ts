import { describe, expect, it } from "vitest"
import type {
	AnyNormalDir,
	ArchiveSourceDisposition,
	CompressCounts,
	CompressReport,
	ExtractFailureInfo,
	ExtractReport,
	FilenSdkError,
	ItemCounts,
	ListReport
} from "@filen/sdk-rs"
import {
	compressEventToDTO,
	compressReportToDTO,
	dispositionToDTO,
	extractEventToDTO,
	extractReportToDTO,
	freeSdkError,
	listReportToDTO
} from "@/lib/sdk/jobErrors"
import { liveSdkError, sdkErrorDTO } from "@/tests/support/sdkError"
import { testUuid } from "@/tests/support/uuid"

const ARCHIVE = testUuid("archive")

function itemCounts(): ItemCounts {
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
		bytesSkipped: 0n
	}
}

function compressCounts(): CompressCounts {
	return { filesDone: 0n, entriesSkipped: 0n, bytesSkipped: 0n, bytesRead: 0n, bytesWritten: 0n, archiveBytes: 0n, bytesVerified: 0n }
}

function compressReport(overrides: Partial<CompressReport> = {}): CompressReport {
	return {
		archive: undefined,
		skipped: [],
		renamed: [],
		totals: { dirs: 0n, files: 1n, bytes: 1n },
		counts: compressCounts(),
		neededBytes: undefined,
		dispositions: [],
		hashMismatches: [],
		omittedHashMismatches: 0n,
		error: undefined,
		...overrides
	}
}

function extractReport(overrides: Partial<ExtractReport> = {}): ExtractReport {
	return {
		topLevel: [],
		failures: [],
		skipped: [],
		renamed: [],
		misleadingNames: [],
		omitted: { skipped: 0n, renamed: 0n, misleadingNames: 0n, failures: 0n, topLevel: 0n },
		archiveBytes: 10n,
		counts: itemCounts(),
		unaccountedBytes: 0n,
		duplicates: undefined,
		dispositions: [],
		error: undefined,
		...overrides
	}
}

function listReport(overrides: Partial<ListReport> = {}): ListReport {
	return {
		format: { type: "zip" },
		password: "notNeeded",
		entries: [],
		omittedEntries: 0n,
		undeliveredEntries: 0n,
		totals: { entries: 0n, dirs: 0n, files: 0n, bytes: 0n, skipped: 0n, bytesSkipped: 0n },
		unaccountedBytes: 0n,
		duplicates: undefined,
		error: undefined,
		...overrides
	}
}

function failure(error: FilenSdkError): ExtractFailureInfo {
	return {
		entry: { archive: ARCHIVE, index: 3 },
		path: "a/b.txt",
		destParent: testUuid("dest"),
		destName: "b.txt",
		stage: { type: "upload" },
		retry: { destination: testUuid("dest"), destinationDir: { uuid: testUuid("dest") } as unknown as AnyNormalDir, base: "a" },
		error
	}
}

function keptFailed(error: FilenSdkError): ArchiveSourceDisposition {
	return { uuid: testUuid("src"), outcome: { type: "kept", reason: { type: "failed", error }, bytesFreed: 0n } }
}

const DISPOSED: ArchiveSourceDisposition = {
	uuid: testUuid("gone"),
	outcome: { type: "disposed", how: "trash", bytesFreed: 5n }
}

const KEPT_UNCONFIRMED: ArchiveSourceDisposition = {
	uuid: testUuid("kept"),
	outcome: { type: "kept", reason: { type: "unconfirmed" }, bytesFreed: 0n }
}

describe("freeSdkError", () => {
	it("frees a live error, and tolerates one with nothing to free", () => {
		const error = liveSdkError("Server", "Error of kind Server: error: x")

		freeSdkError(error)
		freeSdkError(new Error("plain") as unknown as FilenSdkError)

		expect(error.freed).toHaveBeenCalledTimes(1)
	})
})

describe("dispositionToDTO", () => {
	it("returns a disposition without an error as it is", () => {
		expect(dispositionToDTO(DISPOSED)).toBe(DISPOSED)
		expect(dispositionToDTO(KEPT_UNCONFIRMED)).toBe(KEPT_UNCONFIRMED)
	})

	it("lifts the error of a source kept because its removal failed", () => {
		const error = liveSdkError("Server", "Error of kind Server: error: trash")
		const lifted = dispositionToDTO(keptFailed(error))

		expect(lifted).toEqual({
			uuid: testUuid("src"),
			outcome: {
				type: "kept",
				reason: { type: "failed", error: sdkErrorDTO("Server", "Error of kind Server: error: trash") },
				bytesFreed: 0n
			}
		})
		expect(structuredClone(lifted)).toEqual(lifted)
		expect(error.freed).toHaveBeenCalledTimes(1)
	})
})

describe("archive events", () => {
	it("lifts a compress event's error and returns error-free ones as they are", () => {
		const error = liveSdkError("Server", "Error of kind Server: error: link")
		const skipped = { type: "skipped", sourcePath: "a", bytes: 1n, reason: { type: "unreachable", count: 1n } } as const
		const disposition = { type: "sourceDisposition", ...DISPOSED } as const

		expect(compressEventToDTO(skipped)).toBe(skipped)
		expect(compressEventToDTO(disposition)).toBe(disposition)
		expect(compressEventToDTO({ type: "propagationFailed", destUuid: testUuid("d"), error })).toEqual({
			type: "propagationFailed",
			destUuid: testUuid("d"),
			error: sdkErrorDTO("Server", "Error of kind Server: error: link")
		})
		expect(error.freed).toHaveBeenCalledTimes(1)
	})

	it("lifts an extract event's failure, disposition and propagation errors", () => {
		const failed = liveSdkError("IO", "Error of kind IO: error: disk")
		const trash = liveSdkError("Server", "Error of kind Server: error: trash")
		const propagation = liveSdkError("Server", "Error of kind Server: error: link")
		const trashed = { type: "topLevelTrashed", destUuid: testUuid("t") } as const

		expect(extractEventToDTO(trashed)).toBe(trashed)
		expect(extractEventToDTO({ type: "dirFailed", ...failure(failed) })).toMatchObject({
			type: "dirFailed",
			destName: "b.txt",
			error: sdkErrorDTO("IO", "Error of kind IO: error: disk")
		})
		expect(extractEventToDTO({ type: "sourceDisposition", ...keptFailed(trash) })).toMatchObject({
			type: "sourceDisposition",
			outcome: { reason: { error: sdkErrorDTO("Server", "Error of kind Server: error: trash") } }
		})
		expect(extractEventToDTO({ type: "propagationFailed", destUuid: testUuid("d"), error: propagation })).toMatchObject({
			error: { kind: "Server" }
		})
		expect([failed, trash, propagation].map(error => error.freed.mock.calls.length)).toEqual([1, 1, 1])
	})
})

describe("compressReportToDTO", () => {
	it("returns a report without errors as it is", () => {
		const plain = compressReport({ dispositions: [DISPOSED, KEPT_UNCONFIRMED] })

		expect(compressReportToDTO(plain)).toBe(plain)
	})

	it("lifts a failed disposal and the stopping error, keeping the rest", () => {
		const trash = liveSdkError("Server", "Error of kind Server: error: trash")
		const stopped = liveSdkError("Cancelled", "Error of kind Cancelled")
		const source = compressReport({ dispositions: [DISPOSED, keptFailed(trash)], error: stopped })
		const lifted = compressReportToDTO(source)

		expect(lifted.dispositions[0]).toBe(DISPOSED)
		expect(lifted.dispositions[1]?.outcome).toMatchObject({ reason: { type: "failed", error: { kind: "Server" } } })
		expect(lifted.error).toEqual(sdkErrorDTO("Cancelled", "Error of kind Cancelled"))
		expect(lifted.counts).toBe(source.counts)
		expect(structuredClone(lifted)).toEqual(lifted)
		expect([trash, stopped].map(error => error.freed.mock.calls.length)).toEqual([1, 1])
	})
})

describe("extractReportToDTO", () => {
	it("returns a report without errors as it is", () => {
		const plain = extractReport({ dispositions: [DISPOSED] })

		expect(extractReportToDTO(plain)).toBe(plain)
	})

	it("lifts the failures, a failed disposal and the stopping error", () => {
		const failed = liveSdkError("IO", "Error of kind IO: error: disk")
		const trash = liveSdkError("Server", "Error of kind Server: error: trash")
		const stopped = liveSdkError("ArchiveWrongPassword", "Error of kind ArchiveWrongPassword")
		const source = extractReport({ failures: [failure(failed)], dispositions: [keptFailed(trash)], error: stopped })
		const lifted = extractReportToDTO(source)

		expect(lifted.failures[0]).toMatchObject({ path: "a/b.txt", error: sdkErrorDTO("IO", "Error of kind IO: error: disk") })
		expect(lifted.failures[0]?.retry).toBe(source.failures[0]?.retry)
		expect(lifted.dispositions[0]?.outcome).toMatchObject({ reason: { error: { kind: "Server" } } })
		expect(lifted.error?.kind).toBe("ArchiveWrongPassword")
		expect(structuredClone(lifted)).toEqual(lifted)
		expect([failed, trash, stopped].map(error => error.freed.mock.calls.length)).toEqual([1, 1, 1])
	})

	it("lifts failures with no stopping error", () => {
		const failed = liveSdkError("IO", "Error of kind IO: error: disk")
		const lifted = extractReportToDTO(extractReport({ failures: [failure(failed)] }))

		expect(lifted.error).toBeUndefined()
		expect(lifted.failures[0]?.error.kind).toBe("IO")
	})
})

describe("listReportToDTO", () => {
	it("returns a complete listing as it is and lifts a stopping error", () => {
		const plain = listReport()
		const stopped = liveSdkError("ArchiveCorrupt", "Error of kind ArchiveCorrupt: error: bad index")

		expect(listReportToDTO(plain)).toBe(plain)
		expect(listReportToDTO(listReport({ error: stopped })).error).toEqual(
			sdkErrorDTO("ArchiveCorrupt", "Error of kind ArchiveCorrupt: error: bad index")
		)
		expect(stopped.freed).toHaveBeenCalledTimes(1)
	})
})

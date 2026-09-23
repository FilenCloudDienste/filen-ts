import { describe, expect, it } from "vitest"
import type { CopyCounts, CopyFailure, CopyFailureInfo, CopyReport, CopyUpdate, Dir, File, UuidStr } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import {
	applyCopyCreated,
	applyCopyUpdate,
	copyErrorDTO,
	copyMaxBytes,
	createCopyJob,
	isQuotaPreflightFailure,
	retryEntries,
	settleCopyJob
} from "@/features/drive/lib/copy.logic"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const DESTINATION = { uuid: null, name: "My Drive" }

function counts(overrides: Partial<CopyCounts> = {}): CopyCounts {
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

function update(overrides: Partial<CopyUpdate> = {}): CopyUpdate {
	return {
		phase: "copyingFiles",
		pausing: false,
		paused: false,
		cancelling: false,
		scan: { sourcesDone: 1n, sourcesTotal: 1n, listingBytes: 0n, listingTotalBytes: undefined },
		totals: { dirs: 1n, files: 3n, bytes: 300n },
		counts: counts(),
		active: [],
		events: [],
		bytesPerSecond: undefined,
		etaMs: undefined,
		activeTimeMs: 0n,
		...overrides
	}
}

function failureInfo(overrides: Partial<CopyFailureInfo> = {}): CopyFailureInfo {
	return {
		sourceUuid: testUuid("src"),
		sourcePath: "a/b.txt",
		destParent: testUuid("dest"),
		destParentDir: { uuid: testUuid("dest") },
		destName: "b.txt",
		stage: "upload",
		error: { kind: "Server", message: "upload failed", serverMessage: "Server said no", serverCode: "code" },
		affectedFiles: 1n,
		affectedBytes: 100n,
		existingFile: undefined,
		...overrides
	}
}

function mockFile(label: string): File {
	return {
		uuid: testUuid(label),
		stableUUID: undefined,
		parent: testUuid("dest"),
		size: 100n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: { name: `${label}.txt`, mime: "text/plain", modified: 1_700_000_000_000n, size: 100n, key: "k", version: 2 }
		}
	}
}

function failure(overrides: Partial<CopyFailureInfo> = {}): CopyFailure {
	return { item: mockFile("failed"), info: failureInfo(overrides) }
}

function report(overrides: Partial<CopyReport> = {}): CopyReport {
	return {
		topLevel: [],
		failures: [],
		skipped: [],
		renamed: [],
		totals: { dirs: 1n, files: 3n, bytes: 300n },
		counts: counts({ filesDone: 3n, bytesDone: 300n, dirsCreated: 1n }),
		error: undefined,
		...overrides
	}
}

describe("applyCopyUpdate", () => {
	it("narrows the SDK's bigint state to numbers", () => {
		const job = applyCopyUpdate(
			createCopyJob("j", DESTINATION, 2),
			update({
				counts: counts({ filesDone: 2n, bytesDone: 200n }),
				active: [
					{ sourceUuid: testUuid("s"), destUuid: testUuid("d"), destParent: testUuid("p"), name: "x", size: 50n, bytesDone: 10n }
				],
				bytesPerSecond: 1_000n,
				etaMs: 5_000n
			})
		)

		expect(job.totals).toEqual({ dirs: 1, files: 3, bytes: 300 })
		expect(job.counts.filesDone).toBe(2)
		expect(job.counts.bytesDone).toBe(200)
		expect(job.active).toEqual([{ destUuid: testUuid("d"), name: "x", size: 50, bytesDone: 10 }])
		expect(job.bytesPerSecond).toBe(1_000)
		expect(job.etaMs).toBe(5_000)
		expect(job.phase).toBe("copyingFiles")
	})

	it("reads an unknown speed and ETA as null", () => {
		const job = applyCopyUpdate(createCopyJob("j", DESTINATION, 1), update())

		expect(job.bytesPerSecond).toBeNull()
		expect(job.etaMs).toBeNull()
	})

	it("appends failures across updates and counts a saved-as-version file apart from them", () => {
		let job = applyCopyUpdate(createCopyJob("j", DESTINATION, 1), update({ events: [{ type: "fileFailed", ...failureInfo() }] }))

		job = applyCopyUpdate(
			job,
			update({
				events: [
					{ type: "dirFailed", ...failureInfo({ sourcePath: "a/dir", destName: "dir", affectedFiles: 4n }) },
					{ type: "fileFailed", ...failureInfo({ stage: "registeredAsVersion", existingFile: testUuid("existing") }) }
				]
			})
		)

		expect(job.failures.map(f => f.destName)).toEqual(["b.txt", "dir"])
		expect(job.failures[1]?.affectedFiles).toBe(4)
		expect(job.failures[0]?.error.label).toBe("Server said no")
		expect(job.savedAsVersionCount).toBe(1)
	})

	it("counts renames and propagation failures and ignores routine events", () => {
		const job = applyCopyUpdate(
			createCopyJob("j", DESTINATION, 1),
			update({
				events: [
					{ type: "renamed", sourceUuid: testUuid("s"), sourcePath: "x", name: "x (1)", reason: "duplicateName" },
					{ type: "propagationFailed", destUuid: testUuid("d"), error: failureInfo().error },
					{
						type: "fileDone",
						sourceUuid: testUuid("s"),
						destUuid: testUuid("d"),
						destParent: testUuid("p"),
						name: "x",
						size: 1n
					},
					{ type: "colorFailed", destUuid: testUuid("d"), error: failureInfo().error }
				]
			})
		)

		expect(job.renamedCount).toBe(1)
		expect(job.propagationFailedCount).toBe(1)
		expect(job.failures).toEqual([])
	})

	it("keeps the failures array identity when an update brings none", () => {
		const job = applyCopyUpdate(createCopyJob("j", DESTINATION, 1), update())

		expect(applyCopyUpdate(job, update()).failures).toBe(job.failures)
	})
})

describe("applyCopyCreated", () => {
	it("records created top-level items in creation order", () => {
		const first = narrowItem(mockFile("one"))
		const second = narrowItem(mockFile("two"))
		const job = applyCopyCreated(applyCopyCreated(createCopyJob("j", DESTINATION, 2), first), second)

		expect(job.created).toEqual([first, second])
	})
})

describe("copyErrorDTO", () => {
	it("labels a copy error server-message first", () => {
		expect(copyErrorDTO(failureInfo().error)).toEqual({
			species: "sdk",
			kind: "Server",
			message: "upload failed",
			serverMessage: "Server said no",
			serverCode: "code",
			label: "Server said no"
		})
	})

	it("falls back to the message and omits absent server fields", () => {
		expect(copyErrorDTO({ kind: "IO", message: "disk", serverMessage: undefined, serverCode: undefined })).toEqual({
			species: "sdk",
			kind: "IO",
			message: "disk",
			label: "disk"
		})
	})
})

describe("copyMaxBytes", () => {
	it("is the free storage as a number", () => {
		expect(copyMaxBytes({ maxStorage: 1_000n, storageUsed: 400n })).toBe(600)
	})

	it("is undefined without a cached account or a resolvable quota", () => {
		expect(copyMaxBytes(undefined)).toBeUndefined()
		expect(copyMaxBytes({ maxStorage: 0n, storageUsed: 0n })).toBeUndefined()
	})

	it("floors at zero when usage exceeds the plan", () => {
		expect(copyMaxBytes({ maxStorage: 100n, storageUsed: 500n })).toBe(0)
	})
})

describe("isQuotaPreflightFailure", () => {
	it("is a MaxStorageReached report that wrote nothing", () => {
		expect(
			isQuotaPreflightFailure(
				report({
					counts: counts(),
					totals: { dirs: 0n, files: 0n, bytes: 0n },
					error: { kind: "MaxStorageReached", message: "needs more", serverMessage: undefined, serverCode: undefined }
				})
			)
		).toBe(true)
	})

	it("is not a server-side quota failure part way through", () => {
		expect(
			isQuotaPreflightFailure(
				report({ error: { kind: "MaxStorageReached", message: "full", serverMessage: undefined, serverCode: undefined } })
			)
		).toBe(false)
	})

	it("is not another error", () => {
		expect(
			isQuotaPreflightFailure(
				report({ counts: counts(), error: { kind: "Server", message: "x", serverMessage: undefined, serverCode: undefined } })
			)
		).toBe(false)
	})
})

describe("settleCopyJob", () => {
	const running = createCopyJob("j", DESTINATION, 3)

	it("settles a clean report as done with the report's totals and counts", () => {
		const job = settleCopyJob(
			{ ...running, active: [{ destUuid: "d", name: "x", size: 1, bytesDone: 0 }], paused: true },
			{
				report: report(),
				maxBytes: undefined
			}
		)

		expect(job.outcome).toEqual({ status: "done" })
		expect(job.totals.bytes).toBe(300)
		expect(job.counts.filesDone).toBe(3)
		expect(job.active).toEqual([])
		expect(job.paused).toBe(false)
	})

	it("settles as doneWithFailures and keeps only retryable failures", () => {
		const version = failure({ stage: "registeredAsVersion", existingFile: testUuid("existing") })
		const failed = failure()
		const job = settleCopyJob(running, { report: report({ failures: [failed, version] }), maxBytes: undefined })

		expect(job.outcome).toEqual({ status: "doneWithFailures" })
		expect(job.retryable).toEqual([failed])
		expect(job.failures).toHaveLength(1)
		expect(job.savedAsVersionCount).toBe(1)
	})

	it("is done when the only failures were saved as versions", () => {
		const job = settleCopyJob(running, {
			report: report({ failures: [failure({ stage: "registeredAsVersion" })] }),
			maxBytes: undefined
		})

		expect(job.outcome).toEqual({ status: "done" })
		expect(job.retryable).toEqual([])
	})

	it("settles a Cancelled report as cancelled", () => {
		const job = settleCopyJob(running, {
			report: report({ error: { kind: "Cancelled", message: "copy cancelled", serverMessage: undefined, serverCode: undefined } }),
			maxBytes: undefined
		})

		expect(job.outcome).toEqual({ status: "cancelled" })
	})

	it("settles a quota pre-flight refusal with the free storage it was checked against", () => {
		const job = settleCopyJob(running, {
			report: report({
				counts: counts(),
				totals: { dirs: 0n, files: 0n, bytes: 0n },
				error: { kind: "MaxStorageReached", message: "x", serverMessage: undefined, serverCode: undefined }
			}),
			maxBytes: 42
		})

		expect(job.outcome).toEqual({ status: "quotaExceeded", freeBytes: 42 })
	})

	it("settles any other report error as failed", () => {
		const job = settleCopyJob(running, {
			report: report({ error: { kind: "Server", message: "boom", serverMessage: undefined, serverCode: undefined } }),
			maxBytes: 42
		})

		expect(job.outcome).toMatchObject({ status: "failed", error: { kind: "Server", label: "boom" } })
	})

	it("settles a rejection: Cancelled as cancelled, anything else as failed", () => {
		expect(settleCopyJob(running, { error: { species: "sdk", kind: "Cancelled", message: "c", label: "c" } }).outcome).toEqual({
			status: "cancelled"
		})
		expect(settleCopyJob(running, { error: { species: "plain", message: "no client", label: "no client" } }).outcome).toEqual({
			status: "failed",
			error: { species: "plain", message: "no client", label: "no client" }
		})
	})
})

describe("retryEntries", () => {
	it("sends each failed item back to its own directory under its planned name", () => {
		const dir: Dir = {
			uuid: testUuid("nested"),
			parent: testUuid("dest"),
			color: "default",
			timestamp: 0n,
			favorited: false,
			meta: { type: "decoded", data: { name: "nested" } }
		}
		const failed = failure({ destParentDir: dir, destName: "b (1).txt" })

		expect(retryEntries([failed])).toEqual([{ item: failed.item, destination: dir, name: "b (1).txt" }])
	})
})

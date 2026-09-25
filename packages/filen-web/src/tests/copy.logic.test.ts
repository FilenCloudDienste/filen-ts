import { describe, expect, it } from "vitest"
import type { CopyCounts, CopyFailure, CopyFailureInfo, CopyReport, CopyUpdate, Dir, File, UuidStr } from "@filen/sdk-rs"
import { applyCopyCreated, applyCopyUpdate, settleCopyJob } from "@filen/shared"
import { narrowItem } from "@/features/drive/lib/item"
import {
	canRetryCopy,
	copiedTopLevel,
	copyErrorDTO,
	copyGlyphForEntries,
	copyGlyphForItems,
	copyReportInput,
	copyUpdateInput,
	createCopyJob,
	isCopyTrashPending,
	retryEntries
} from "@/features/drive/lib/copy.logic"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const DESTINATION = { uuid: null, name: "My Drive" }
// The SDK's own message: developer text, kept on the error for logs.
const SERVER_INNER_MESSAGE = 'error: API Error, message: `Some("Server said no")`'
const SERVER_MESSAGE = `Error of kind Server: ${SERVER_INNER_MESSAGE}`

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
		runState: "running",
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
		stage: { type: "upload" },
		error: {
			kind: "Server",
			message: SERVER_MESSAGE,
			serverMessage: "Server said no",
			serverCode: "code",
			innerMessage: SERVER_INNER_MESSAGE
		},
		affectedFiles: 1n,
		affectedBytes: 100n,
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

describe("copyUpdateInput", () => {
	it("narrows the SDK's bigint state to numbers through the shared job", () => {
		const job = applyCopyUpdate(
			createCopyJob("j", DESTINATION, 2),
			copyUpdateInput(
				update({
					counts: counts({ filesDone: 2n, bytesDone: 200n }),
					active: [
						{
							sourceUuid: testUuid("s"),
							destUuid: testUuid("d"),
							destParent: testUuid("p"),
							name: "x",
							size: 50n,
							bytesDone: 10n
						}
					],
					bytesPerSecond: 1_000n,
					etaMs: 5_000n
				})
			)
		)

		expect(job.totals).toEqual({ dirs: 1, files: 3, bytes: 300 })
		expect(job.counts.bytesDone).toBe(200)
		expect(job.active).toEqual([{ destUuid: testUuid("d"), name: "x", size: 50, bytesDone: 10 }])
		expect(job.bytesPerSecond).toBe(1_000)
		expect(job.etaMs).toBe(5_000)
		expect(job.phase).toBe("copyingFiles")
		expect(job.glyph).toBe("items")
	})

	it("keeps failures, counting a saved-as-version file apart from them", () => {
		const { events } = copyUpdateInput(
			update({
				events: [
					{ type: "fileFailed", ...failureInfo() },
					{ type: "dirFailed", ...failureInfo({ sourcePath: "a/dir", destName: "dir", affectedFiles: 4n }) },
					{ type: "fileFailed", ...failureInfo({ stage: { type: "registeredAsVersion", existingFile: testUuid("existing") } }) }
				]
			})
		)

		expect(events.failures.map(f => f.destName)).toEqual(["b.txt", "dir"])
		expect(events.failures[1]?.affectedFiles).toBe(4)
		expect(events.failures[0]?.error.label).toBe("Server said no")
		expect(events.savedAsVersion).toBe(1)
	})

	it("reads the run state into the shared job's pause and cancel flags", () => {
		const flags = (runState: CopyUpdate["runState"]) => {
			const { pausing, paused, cancelling } = copyUpdateInput(update({ runState }))

			return { pausing, paused, cancelling }
		}

		expect(flags("running")).toEqual({ pausing: false, paused: false, cancelling: false })
		expect(flags("pausing")).toEqual({ pausing: true, paused: false, cancelling: false })
		expect(flags("paused")).toEqual({ pausing: false, paused: true, cancelling: false })
		expect(flags("cancelling")).toEqual({ pausing: false, paused: false, cancelling: true })

		const job = applyCopyUpdate(createCopyJob("j", DESTINATION, 1), copyUpdateInput(update({ runState: "paused" })))

		expect(job.paused).toBe(true)
		expect(applyCopyUpdate(job, copyUpdateInput(update({ runState: "running" }))).paused).toBe(false)
	})

	it("leaves skipped entries to the counts: they are neither failures nor retryable", () => {
		const { events } = copyUpdateInput(
			update({
				counts: counts({ entriesSkipped: 2n, bytesSkipped: 150n }),
				events: [
					{
						type: "skipped",
						sourcePath: "a/broken.bin",
						bytes: 100n,
						reason: { type: "undecryptableFile", uuid: testUuid("broken") }
					},
					{ type: "skipped", sourcePath: "a/lost", bytes: 50n, reason: { type: "unreachable", count: 3n } }
				]
			})
		)

		expect(events).toEqual({ failures: [], savedAsVersion: 0, renamed: 0, propagationFailed: 0 })
	})

	it("counts renames and propagation failures and ignores routine events", () => {
		const { events } = copyUpdateInput(
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

		expect(events).toEqual({ failures: [], savedAsVersion: 0, renamed: 1, propagationFailed: 1 })
	})
})

describe("copyReportInput", () => {
	it("pairs each retryable failure with its SDK form and counts saved-as-version files apart", () => {
		const version = failure({ stage: { type: "registeredAsVersion", existingFile: testUuid("existing") } })
		const failed = failure()
		const input = copyReportInput(report({ failures: [failed, version] }))

		expect(input.failures).toHaveLength(1)
		expect(input.failures[0]?.retryable).toBe(failed)
		expect(input.failures[0]?.failure.destName).toBe("b.txt")
		expect(input.savedAsVersionCount).toBe(1)
	})

	it("reads a version target off its stage, never from another stage's failure", () => {
		const input = copyReportInput(
			report({
				failures: [
					failure({ stage: { type: "registeredAsVersion", existingFile: testUuid("existing") } }),
					failure({ stage: { type: "download" } }),
					failure({ stage: { type: "finalize" } })
				],
				skipped: [{ sourcePath: "a/broken.bin", bytes: 100n, reason: { type: "undecryptableFile", uuid: testUuid("broken") } }]
			})
		)

		expect([...input.versionTargets]).toEqual([testUuid("existing")])
		expect(input.failures.map(f => f.retryable.info.stage.type)).toEqual(["download", "finalize"])
		expect(input.savedAsVersionCount).toBe(1)
	})

	it("counts the created top-level items and the renames, and labels the error", () => {
		const dir: Dir = {
			uuid: testUuid("copied"),
			parent: testUuid("dest"),
			color: "default",
			timestamp: 0n,
			favorited: false,
			meta: { type: "decoded", data: { name: "copied" } }
		}
		const input = copyReportInput(
			report({
				topLevel: [{ request: 0n, sourceUuid: testUuid("s"), item: { type: "dir", ...dir } }],
				renamed: [{ sourceUuid: testUuid("s"), sourcePath: "x", name: "x (1)", reason: "duplicateName" }],
				error: {
					kind: "Server",
					message: "Error of kind Server: error: API Error",
					serverMessage: undefined,
					serverCode: undefined,
					innerMessage: "error: API Error"
				}
			})
		)

		expect(input.createdCount).toBe(1)
		expect(input.renamedCount).toBe(1)
		expect(input.error).toMatchObject({ species: "sdk", kind: "Server", message: "Error of kind Server: error: API Error" })
	})

	it("settles through the shared job with the report's retryable failures", () => {
		const failed = failure()
		const job = settleCopyJob(createCopyJob("j", DESTINATION, 3), {
			report: copyReportInput(report({ failures: [failed] })),
			maxBytes: undefined
		})

		expect(job.outcome).toEqual({ status: "doneWithFailures" })
		expect(job.retryable).toEqual([failed])
		expect(job.failures.map(f => f.destName)).toEqual(["b.txt"])
	})

	it("reads a quota pre-flight refusal through the shared job", () => {
		const job = settleCopyJob(createCopyJob("j", DESTINATION, 3), {
			report: copyReportInput(
				report({
					counts: counts(),
					totals: { dirs: 0n, files: 0n, bytes: 0n },
					error: {
						kind: "MaxStorageReached",
						message: "Error of kind MaxStorageReached: error: the copy needs 300 bytes, 42 are free",
						serverMessage: undefined,
						serverCode: undefined,
						innerMessage: "error: the copy needs 300 bytes, 42 are free"
					}
				})
			),
			maxBytes: 42
		})

		expect(job.outcome).toEqual({ status: "quotaExceeded", freeBytes: 42 })
	})
})

describe("copiedTopLevel", () => {
	const dir: Dir = {
		uuid: testUuid("copied"),
		parent: testUuid("dest"),
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: "copied" } }
	}

	it("joins the report's items with the delivered ones, once each, and never a file saved as a new version", () => {
		const delivered = narrowItem(dir)
		const listed = mockFile("listed")
		const versioned = mockFile("versioned")
		const settlement = {
			report: copyReportInput(
				report({
					topLevel: [
						{ request: 0n, sourceUuid: testUuid("s"), item: { type: "dir", ...dir } },
						{ request: 1n, sourceUuid: testUuid("s"), item: { type: "file", ...listed } },
						{ request: 2n, sourceUuid: testUuid("s"), item: { type: "file", ...versioned } }
					],
					failures: [failure({ stage: { type: "registeredAsVersion", existingFile: versioned.uuid } })]
				})
			),
			maxBytes: undefined
		}

		expect(copiedTopLevel(settlement, [delivered]).map(item => item.data.uuid)).toEqual([dir.uuid, listed.uuid])
		expect(copiedTopLevel(settlement, [delivered])[0]).toBe(delivered)
	})

	it("keeps the delivered items of a call that rejected without a report", () => {
		const delivered = narrowItem(dir)

		expect(copiedTopLevel({ error: { species: "plain", message: "m", label: "m" } }, [delivered, delivered])).toEqual([delivered])
	})
})

describe("isCopyTrashPending", () => {
	const batch = [narrowItem(mockFile("copied"))]
	const stopped = { ...createCopyJob("j", DESTINATION, 1), outcome: { status: "cancelled" as const }, cancelRequest: "trash" as const }

	// An item delivered after the job ended can reach the trash before the batch its stop settled with.
	it("holds while the stop's batch is still moving, whatever a late item's trash recorded", () => {
		const withRetry = { ...stopped, retryable: [failure()] }

		expect(isCopyTrashPending({ ...stopped, created: batch })).toBe(true)
		expect(isCopyTrashPending({ ...stopped, created: batch, trashResult: { moved: 1, failed: 0 } })).toBe(true)
		expect(canRetryCopy({ ...withRetry, created: batch, trashResult: { moved: 1, failed: 0 } })).toBe(false)
		expect(isCopyTrashPending({ ...stopped, created: [], trashResult: { moved: 2, failed: 0 } })).toBe(false)
		expect(canRetryCopy({ ...withRetry, created: [], trashResult: { moved: 2, failed: 0 } })).toBe(true)
		expect(isCopyTrashPending({ ...stopped, cancelRequest: "keep", created: batch })).toBe(false)
		expect(isCopyTrashPending({ ...stopped, outcome: { status: "running" }, created: batch })).toBe(false)
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
			message: SERVER_MESSAGE,
			innerMessage: SERVER_INNER_MESSAGE,
			serverMessage: "Server said no",
			serverCode: "code",
			label: "Server said no"
		})
	})

	it("labels one without a server message by its inner message, without the kind wrapper", () => {
		const innerMessage = "error: No space left on device (os error 28)"
		const message = `Error of kind IO: ${innerMessage}`

		expect(copyErrorDTO({ kind: "IO", message, serverMessage: undefined, serverCode: undefined, innerMessage })).toEqual({
			species: "sdk",
			kind: "IO",
			message,
			innerMessage,
			label: innerMessage
		})
	})

	it("falls back to the message and omits absent fields", () => {
		const message = "Error of kind Cancelled"

		expect(
			copyErrorDTO({ kind: "Cancelled", message, serverMessage: undefined, serverCode: undefined, innerMessage: undefined })
		).toEqual({
			species: "sdk",
			kind: "Cancelled",
			message,
			label: message
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

describe("copy glyphs", () => {
	const dir: Dir = {
		uuid: testUuid("dir"),
		parent: testUuid("dest"),
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: "dir" } }
	}

	it("names the one item's kind, or several items", () => {
		expect(copyGlyphForItems([narrowItem(dir)])).toBe("directory")
		expect(copyGlyphForItems([narrowItem(mockFile("a"))])).toBe("file")
		expect(copyGlyphForItems([narrowItem(mockFile("a")), narrowItem(dir)])).toBe("items")
		expect(copyGlyphForItems([])).toBe("items")
	})

	it("reads a retry's single entry the same way", () => {
		const destination = { uuid: testUuid("dest") }

		expect(copyGlyphForEntries([{ item: mockFile("a"), destination }])).toBe("file")
		expect(copyGlyphForEntries([{ item: dir, destination }])).toBe("directory")
		expect(
			copyGlyphForEntries([
				{ item: dir, destination },
				{ item: mockFile("a"), destination }
			])
		).toBe("items")
	})

	it("defaults a job to several items", () => {
		expect(createCopyJob("j", DESTINATION, 2).glyph).toBe("items")
		expect(createCopyJob("j", DESTINATION, 1, "file").glyph).toBe("file")
	})
})

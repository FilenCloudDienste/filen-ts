import { describe, expect, it } from "vitest"
import type { CopyEvent, CopyFailureInfo, CopyReport, CopyUpdate, File, FilenSdkError, ItemCounts } from "@filen/sdk-rs"
import { copyReportToDTO, copyUpdateToDTO, liftError } from "@/lib/sdk/jobErrors"
import { liveSdkError, sdkErrorDTO, type LiveSdkErrorMock } from "@/tests/support/sdkError"
import { testUuid } from "@/tests/support/uuid"

// The SDK's own message: developer text, kept on the error for logs.
const SERVER_INNER_MESSAGE = 'error: API Error, message: `Some("Server said no")`'
const SERVER_MESSAGE = `Error of kind Server: ${SERVER_INNER_MESSAGE}`

function counts(): ItemCounts {
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

function update(events: CopyEvent[]): CopyUpdate {
	return {
		phase: "copyingFiles",
		runState: "running",
		scan: { sourcesDone: 1n, sourcesTotal: 1n, listingBytes: 0n, listingTotalBytes: undefined },
		totals: { dirs: 0n, files: 2n, bytes: 200n },
		counts: counts(),
		active: [],
		events,
		bytesPerSecond: undefined,
		etaMs: undefined,
		activeTimeMs: 0n
	}
}

function report(overrides: Partial<CopyReport> = {}): CopyReport {
	return {
		topLevel: [],
		failures: [],
		skipped: [],
		renamed: [],
		totals: { dirs: 0n, files: 2n, bytes: 200n },
		counts: counts(),
		error: undefined,
		...overrides
	}
}

function failureInfo(error: FilenSdkError): CopyFailureInfo {
	return {
		sourceUuid: testUuid("src"),
		sourcePath: "a/b.txt",
		destParent: testUuid("dest"),
		destParentDir: { uuid: testUuid("dest") },
		destName: "b.txt",
		stage: { type: "upload" },
		error,
		affectedFiles: 1n,
		affectedBytes: 100n
	}
}

function serverError(): LiveSdkErrorMock {
	return liveSdkError("Server", SERVER_MESSAGE, {
		serverMessage: "Server said no",
		serverCode: "code",
		innerMessage: SERVER_INNER_MESSAGE
	})
}

const FILE_DONE: CopyEvent = {
	type: "fileDone",
	sourceUuid: testUuid("s"),
	destUuid: testUuid("d"),
	destParent: testUuid("p"),
	name: "x",
	size: 1n
}

describe("liftError", () => {
	it("labels an SDK error server-message first and frees it", () => {
		const error = serverError()

		expect(liftError(error)).toEqual({
			species: "sdk",
			kind: "Server",
			message: SERVER_MESSAGE,
			innerMessage: SERVER_INNER_MESSAGE,
			serverMessage: "Server said no",
			serverCode: "code",
			label: "Server said no"
		})
		expect(error.freed).toHaveBeenCalledTimes(1)
	})

	it("labels one without a server message by its inner message, without the kind wrapper", () => {
		const innerMessage = "error: No space left on device (os error 28)"
		const message = `Error of kind IO: ${innerMessage}`

		expect(liftError(liveSdkError("IO", message, { innerMessage }))).toEqual({
			species: "sdk",
			kind: "IO",
			message,
			innerMessage,
			label: innerMessage
		})
	})

	it("falls back to the message and omits absent fields", () => {
		const message = "Error of kind Cancelled"

		expect(liftError(liveSdkError("Cancelled", message))).toEqual({ species: "sdk", kind: "Cancelled", message, label: message })
	})

	it("converts an error with nothing to free", () => {
		expect(liftError(new Error("boom") as unknown as FilenSdkError)).toMatchObject({ species: "plain", message: "boom" })
	})
})

describe("copyUpdateToDTO", () => {
	it("returns an update without errors as it is", () => {
		const plain = update([FILE_DONE])

		expect(copyUpdateToDTO(plain)).toBe(plain)
	})

	it("replaces only the errors, keeping every other event and field", () => {
		const failed = serverError()
		const propagation = liveSdkError("Server", "Error of kind Server: error: link")
		const color = liveSdkError("IO", "Error of kind IO: error: color")
		const source = update([
			FILE_DONE,
			{ type: "fileFailed", ...failureInfo(failed) },
			{ type: "propagationFailed", destUuid: testUuid("d"), error: propagation },
			{ type: "colorFailed", destUuid: testUuid("d"), error: color }
		])
		const lifted = copyUpdateToDTO(source)

		expect(lifted).not.toBe(source)
		expect(lifted.counts).toBe(source.counts)
		expect(lifted.events[0]).toBe(FILE_DONE)
		expect(lifted.events.map(event => ("error" in event ? event.error : undefined))).toEqual([
			undefined,
			sdkErrorDTO("Server", SERVER_MESSAGE, {
				serverMessage: "Server said no",
				serverCode: "code",
				innerMessage: SERVER_INNER_MESSAGE
			}),
			sdkErrorDTO("Server", "Error of kind Server: error: link"),
			sdkErrorDTO("IO", "Error of kind IO: error: color")
		])
		expect(lifted.events[1]).toMatchObject({ type: "fileFailed", destName: "b.txt", affectedBytes: 100n })
		expect(structuredClone(lifted)).toEqual(lifted)
		expect([failed.freed, propagation.freed, color.freed].map(freed => freed.mock.calls.length)).toEqual([1, 1, 1])
	})
})

describe("copyReportToDTO", () => {
	it("returns a report without errors as it is", () => {
		const plain = report()

		expect(copyReportToDTO(plain)).toBe(plain)
	})

	it("replaces the failures' errors and the stopping error, keeping their items", () => {
		const failed = serverError()
		const stopped = liveSdkError("Cancelled", "Error of kind Cancelled: error: copy cancelled")
		const item: File = {
			uuid: testUuid("failed"),
			stableUUID: undefined,
			parent: testUuid("dest"),
			size: 100n,
			favorited: false,
			region: "de-1",
			bucket: "filen-1",
			timestamp: 0n,
			chunks: 1n,
			canMakeThumbnail: false,
			meta: { type: "decoded", data: { name: "b.txt", mime: "text/plain", modified: 0n, size: 100n, key: "k", version: 2 } }
		}
		const source = report({ failures: [{ item, info: failureInfo(failed) }], error: stopped })
		const lifted = copyReportToDTO(source)

		expect(lifted.failures[0]?.item).toBe(item)
		expect(lifted.failures[0]?.info.error.label).toBe("Server said no")
		expect(lifted.error).toEqual(sdkErrorDTO("Cancelled", "Error of kind Cancelled: error: copy cancelled"))
		expect(lifted.totals).toBe(source.totals)
		expect(failed.freed).toHaveBeenCalledTimes(1)
		expect(stopped.freed).toHaveBeenCalledTimes(1)
	})

	it("replaces a stopping error with no failures", () => {
		const stopped = liveSdkError("MaxStorageReached", "Error of kind MaxStorageReached: error: full")
		const lifted = copyReportToDTO(report({ error: stopped }))

		expect(lifted.error?.kind).toBe("MaxStorageReached")
		expect(lifted.failures).toEqual([])
	})
})

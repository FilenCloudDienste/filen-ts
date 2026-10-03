import { describe, expect, it, vi } from "vitest"
import type {
	CompressEvent,
	CompressUpdate,
	ExtractEvent,
	ExtractFailureInfo,
	ExtractUpdate,
	FilenSdkError,
	PauseSignal
} from "@filen/sdk-rs"
import {
	archivePassword,
	COMPRESS_EVENT_CAPS,
	createEventCapper,
	EXTRACT_EVENT_CAPS,
	runOrderedJob,
	slimCompressUpdate,
	slimExtractUpdate,
	type JobControls
} from "@/workers/driveJobRunner"
import { liveSdkError, sdkErrorDTO } from "@/tests/support/sdkError"
import { testUuid } from "@/tests/support/uuid"

const ARCHIVE = testUuid("archive")

function controls(): JobControls {
	return { abort: new AbortController(), pause: { isPaused: () => false } as unknown as PauseSignal }
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise(resolve => setTimeout(resolve, 0))
	}
}

function compressUpdate(events: CompressEvent[]): CompressUpdate {
	return {
		phase: "compressing",
		runState: "running",
		scan: { sourcesDone: 1n, sourcesTotal: 1n, listingBytes: 0n, listingTotalBytes: undefined },
		totals: { dirs: 0n, files: 1n, bytes: 1n },
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
		events,
		bytesPerSecond: undefined,
		etaMs: undefined,
		activeTimeMs: 0n
	}
}

function extractUpdate(events: ExtractEvent[]): ExtractUpdate {
	return {
		phase: "extracting",
		runState: "running",
		archiveBytes: 10n,
		counts: {
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
		},
		bytesRead: 5n,
		active: [],
		events,
		bytesPerSecond: 1n,
		etaMs: undefined,
		activeTimeMs: 0n
	}
}

function failure(error: FilenSdkError, index: number): ExtractFailureInfo {
	return {
		entry: { archive: ARCHIVE, index },
		path: `f${index.toString()}`,
		destParent: testUuid("dest"),
		destName: `f${index.toString()}`,
		stage: { type: "upload" },
		retry: undefined,
		error
	}
}

function skipped(index: number): CompressEvent {
	return { type: "skipped", sourcePath: `s${index.toString()}`, bytes: 1n, reason: { type: "unreachable", count: 1n } }
}

describe("runOrderedJob", () => {
	it("returns only once the caller took the last event, without waiting on each", async () => {
		const replies: (() => void)[] = []
		const onEvent = vi.fn(
			(_event: number) =>
				new Promise<void>(resolve => {
					replies.push(resolve)
				})
		)
		let returned = false
		const job = runOrderedJob(
			controls(),
			onEvent,
			deliver => {
				deliver(1)
				deliver(2)

				return Promise.resolve("report")
			},
			"test"
		).then(report => {
			returned = true

			return report
		})

		await settle()

		expect(onEvent).toHaveBeenCalledTimes(2)
		expect(returned).toBe(false)

		replies[1]?.()

		await expect(job).resolves.toBe("report")
	})

	it("still returns the report when the caller failed to take an event", async () => {
		await expect(
			runOrderedJob(
				controls(),
				() => Promise.reject(new Error("render failed")),
				deliver => {
					deliver(1)

					return Promise.resolve("report")
				},
				"test"
			)
		).resolves.toBe("report")
	})

	it("hands the job's own signals to the SDK and waits for delivery when the call rejects", async () => {
		const jobControls = controls()
		const reply = Promise.withResolvers<undefined>()
		let settled = false
		const job = runOrderedJob(
			jobControls,
			() => reply.promise,
			(deliver, managedFuture) => {
				expect(managedFuture).toEqual({ abortSignal: jobControls.abort.signal, pauseSignal: jobControls.pause })
				deliver(1)

				return Promise.reject(new Error("refused"))
			},
			"test"
		).catch((e: unknown) => {
			settled = true

			throw e
		})

		await settle()

		expect(settled).toBe(false)

		reply.resolve(undefined)

		await expect(job).rejects.toThrow("refused")
	})
})

describe("createEventCapper", () => {
	it("admits up to each category's cap and counts the rest until taken", () => {
		const capper = createEventCapper({ a: 2, b: 1 })

		expect([capper.admit("a"), capper.admit("a"), capper.admit("a"), capper.admit("b"), capper.admit("b")]).toEqual([
			true,
			true,
			false,
			true,
			false
		])
		expect(capper.takeOmitted()).toEqual({ a: 1, b: 1 })
		expect(capper.takeOmitted()).toEqual({ a: 0, b: 0 })
		expect(capper.admit("a")).toBe(false)
		expect(capper.takeOmitted()).toEqual({ a: 1, b: 0 })
	})

	it("caps every category at the SDK's report cap", () => {
		expect(Object.values({ ...COMPRESS_EVENT_CAPS, ...EXTRACT_EVENT_CAPS }).every(cap => cap === 1000)).toBe(true)
	})
})

describe("slimCompressUpdate", () => {
	it("caps skipped, renamed and hash mismatches but never dispositions or propagation failures", () => {
		const capper = createEventCapper({ skipped: 1, renamed: 1, hashMismatches: 1 })
		const propagation = liveSdkError("Server", "Error of kind Server: error: link")
		const disposition = {
			type: "sourceDisposition",
			uuid: testUuid("src"),
			outcome: { type: "disposed", how: "trash", bytesFreed: 1n }
		} as const
		const source = compressUpdate([
			skipped(0),
			skipped(1),
			{ type: "renamed", sourceUuid: testUuid("r"), sourcePath: "r", name: "r (1)", reason: "duplicateName" },
			{ type: "sourceHashMismatch", sourceUuid: testUuid("h0"), path: "h0" },
			{ type: "sourceHashMismatch", sourceUuid: testUuid("h1"), path: "h1" },
			disposition,
			disposition,
			{ type: "propagationFailed", destUuid: testUuid("d"), error: propagation }
		])
		const slim = slimCompressUpdate(source, capper)

		expect(slim.events.map(event => event.type)).toEqual([
			"skipped",
			"renamed",
			"sourceHashMismatch",
			"sourceDisposition",
			"sourceDisposition",
			"propagationFailed"
		])
		expect(slim.events[5]).toEqual({
			type: "propagationFailed",
			destUuid: testUuid("d"),
			error: sdkErrorDTO("Server", "Error of kind Server: error: link")
		})
		expect(slim.omitted).toEqual({ skipped: 1, renamed: 0, hashMismatches: 1 })
		expect(slim.counts).toBe(source.counts)
		expect(structuredClone(slim)).toEqual(slim)
		expect(slimCompressUpdate(compressUpdate([skipped(2)]), capper).omitted).toEqual({ skipped: 1, renamed: 0, hashMismatches: 0 })
	})
})

describe("slimExtractUpdate", () => {
	it("drops the per-file events and keeps the rest in order, errors lifted", () => {
		const capper = createEventCapper(EXTRACT_EVENT_CAPS)
		const failed = liveSdkError("IO", "Error of kind IO: error: disk")
		const entry = { archive: ARCHIVE, index: 0 }
		const slim = slimExtractUpdate(
			extractUpdate([
				{ type: "dirCreated", destUuid: testUuid("d"), destParent: testUuid("p"), name: "d" },
				{ type: "fileStarted", entry, destUuid: testUuid("f"), destParent: testUuid("p"), name: "f", size: 1n, bytesDone: 0n },
				{ type: "fileDone", entry, destUuid: testUuid("f"), destParent: testUuid("p"), name: "f", size: 1n },
				{ type: "fileFailed", ...failure(failed, 1) },
				{ type: "misleadingName", entry, path: "a‮txt.exe" },
				{ type: "topLevelTrashed", destUuid: testUuid("t") }
			]),
			capper
		)

		expect(slim.events.map(event => event.type)).toEqual(["fileFailed", "misleadingName", "topLevelTrashed"])
		expect(slim.events[0]).toMatchObject({ path: "f1", error: sdkErrorDTO("IO", "Error of kind IO: error: disk") })
		expect(slim.omitted).toEqual({ failures: 0, skipped: 0, renamed: 0, misleadingNames: 0, savedAsVersion: 0, macMetadata: 0 })
		expect(failed.freed).toHaveBeenCalledTimes(1)
	})

	it("counts failures past the cap and frees their errors unread, but never caps trashed folders", () => {
		const capper = createEventCapper({ failures: 1, skipped: 1, renamed: 1, misleadingNames: 1 })
		const errors = [0, 1, 2].map(i => liveSdkError("IO", `Error of kind IO: error: ${i.toString()}`))
		const entry = { archive: ARCHIVE, index: 0 }
		const slim = slimExtractUpdate(
			extractUpdate([
				...errors.map((error, i): ExtractEvent => ({ type: i === 0 ? "dirFailed" : "fileFailed", ...failure(error, i) })),
				{
					type: "fileFailed",
					...failure(liveSdkError("IO", "Error of kind IO: error: 3"), 3),
					stage: { type: "registeredAsVersion", existingFile: testUuid("old") }
				},
				{ type: "skipped", entry, path: "._a", pathTruncated: false, bytes: 1n, reason: { type: "macMetadata" } },
				{ type: "skipped", entry, path: "._b", pathTruncated: false, bytes: 1n, reason: { type: "macMetadata" } },
				{ type: "skipped", entry, path: "c", pathTruncated: false, bytes: 1n, reason: { type: "unsafePath" } },
				{ type: "renamed", entry, path: "a", name: "a (1)", reason: "duplicateName" },
				{ type: "renamed", entry, path: "b", name: "b (1)", reason: "duplicateName" },
				{ type: "misleadingName", entry, path: "x" },
				{ type: "misleadingName", entry, path: "y" },
				{ type: "topLevelTrashed", destUuid: testUuid("t0") },
				{ type: "topLevelTrashed", destUuid: testUuid("t1") }
			]),
			capper
		)

		expect(slim.events.map(event => event.type)).toEqual([
			"dirFailed",
			"skipped",
			"renamed",
			"misleadingName",
			"topLevelTrashed",
			"topLevelTrashed"
		])
		expect(slim.omitted).toEqual({ failures: 3, skipped: 2, renamed: 1, misleadingNames: 1, savedAsVersion: 1, macMetadata: 1 })
		expect(errors.map(error => error.freed.mock.calls.length)).toEqual([1, 1, 1])
	})
})

describe("archivePassword", () => {
	it("passes no password for an empty one", () => {
		expect(archivePassword("")).toBeUndefined()
		expect(archivePassword(undefined)).toBeUndefined()
		expect(archivePassword("secret")).toBe("secret")
	})
})

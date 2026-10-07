import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Remote } from "comlink"
import type {
	AnyFile,
	AnyNormalDir,
	ArchiveEntry,
	CompressFormat,
	CompressItemsParams,
	CompressReport,
	ExtractArchiveEntriesParams,
	ExtractArchiveParams,
	ExtractReport,
	UuidStr,
	ExtractUpdate,
	ListArchiveParams,
	ListReport,
	ListUpdate,
	StringifiedClient
} from "@filen/sdk-rs"
import type { CompressJobEvent, ExtractJobEvent, ListJobEvent, SdkWorkerApi } from "@/workers/sdk.worker"
import { getCachedDir } from "@/features/drive/lib/cache"
import { liveSdkError, sdkErrorDTO } from "@/tests/support/sdkError"
import { testUuid } from "@/tests/support/uuid"

// The worker's archive bridge against a stand-in client: only the wasm module and Comlink's expose are
// replaced, so the registries, the callback wrapping and the call lifecycle are the real ones.
interface FakePause {
	pause: () => void
	isPaused: () => boolean
	free: () => void
	freed: number
}

interface Signals {
	managedFuture: { abortSignal: AbortSignal; pauseSignal: FakePause }
}
type Password = string | null | undefined

const { exposed, fakeClient, helpers } = vi.hoisted(() => ({
	exposed: new Map<"api", unknown>(),
	fakeClient: {
		root: () => ({ uuid: "root" }),
		getDirOptional: vi.fn<(uuid: string) => Promise<unknown>>(),
		compressItems: vi.fn<(params: CompressItemsParams & Signals, password?: Password) => Promise<CompressReport>>(),
		extractArchive: vi.fn<(params: ExtractArchiveParams & Signals, password?: Password) => Promise<ExtractReport>>(),
		extractArchiveEntries: vi.fn<(params: ExtractArchiveEntriesParams & Signals, password?: Password) => Promise<ExtractReport>>(),
		listArchive: vi.fn<(params: ListArchiveParams & Signals, password?: Password) => Promise<ListReport>>(),
		archiveCodecMemBudget: vi.fn(() => 128n * 1024n * 1024n),
		free: vi.fn()
	},
	helpers: {
		archiveExtension: vi.fn((format: { type: string }) => `.${format.type}`),
		archiveEncoderMemory: vi.fn<(format: { type: string }) => bigint>(),
		archiveFormatLevels: vi.fn<(format: { type: string }) => unknown>(),
		archiveMaxLevel: vi.fn<(format: { type: string }, budget: bigint) => number | undefined>(),
		archiveFormatOfName: vi.fn((name: string) => (name.endsWith(".zip") ? { type: "zip" } : undefined)),
		archiveDefaultName: vi.fn((name: string) => name.replace(/\.zip$/, ""))
	}
}))

vi.mock("@filen/sdk-rs", () => {
	class PauseSignal {
		paused = false
		freed = 0

		pause(): void {
			this.paused = true
		}

		resume(): void {
			this.paused = false
		}

		isPaused(): boolean {
			return this.paused
		}

		free(): void {
			this.freed++
		}
	}

	// The wasm class is no Error; this one is only so it can be thrown here.
	class EntryNameErrorJS extends Error {
		freed = 0
		reason: string

		constructor(reason: string) {
			super(reason)
			this.reason = reason
		}

		kind(): string {
			return this.reason
		}

		free(): void {
			this.freed++
		}
	}

	return {
		default: vi.fn(),
		initThreadPool: vi.fn(),
		PauseSignal,
		EntryNameErrorJS,
		parseName: (name: string) => {
			if (name === "a:b") {
				throw new EntryNameErrorJS("ForbiddenChar")
			}

			if (name === "boom") {
				throw new Error("wasm gone")
			}

			return name
		},
		UnauthClient: { from_config: () => ({ free: vi.fn(), fromStringified: () => fakeClient }) },
		...helpers
	}
})

vi.mock("comlink", () => ({
	expose: (api: unknown) => {
		exposed.set("api", api)
	},
	proxy: (value: unknown) => value,
	transfer: (value: unknown) => value
}))

await import("@/workers/sdk.worker")

// What the page sees: every call answers with a promise.
const api = exposed.get("api") as Remote<SdkWorkerApi>

const ARCHIVE = { type: "file", uuid: testUuid("archive") } as unknown as AnyFile
// A real uuid: the worker answers a malformed one (testUuid's readable labels) as not found unasked.
const DEST = "0d0d0d0d-0000-4000-8000-000000000000" as UuidStr
const DEST_DIR = { uuid: DEST, meta: { type: "decoded", data: { name: "dest" } } }
const ZIP: CompressFormat = { type: "zip", method: { type: "deflate", level: 6 } }

function itemCounts(): ExtractReport["counts"] {
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

const COMPRESS_REPORT: CompressReport = {
	archive: undefined,
	skipped: [],
	renamed: [],
	totals: { dirs: 0n, files: 1n, bytes: 1n },
	counts: { filesDone: 1n, entriesSkipped: 0n, bytesSkipped: 0n, bytesRead: 1n, bytesWritten: 1n, archiveBytes: 1n, bytesVerified: 0n },
	neededBytes: undefined,
	dispositions: [],
	hashMismatches: [],
	omittedHashMismatches: 0n,
	error: undefined
}

const EXTRACT_REPORT: ExtractReport = {
	topLevel: [],
	failures: [],
	skipped: [],
	renamed: [],
	misleadingNames: [],
	omitted: { skipped: 0n, renamed: 0n, misleadingNames: 0n, failures: 0n, topLevel: 0n },
	archiveBytes: 1n,
	counts: itemCounts(),
	unaccountedBytes: 0n,
	duplicates: undefined,
	dispositions: [],
	error: undefined
}

const ENTRY: ArchiveEntry = {
	id: { archive: testUuid("archive"), index: 0 },
	storedPath: "a.txt",
	storedPathTruncated: false,
	path: { path: "a.txt", rewritten: false, misleading: false },
	kind: { type: "file" },
	size: 1n,
	encrypted: false,
	method: undefined,
	skip: undefined,
	macMetadata: false,
	access: undefined
}

const LIST_REPORT: ListReport = {
	format: { type: "zip" },
	password: "notNeeded",
	entries: [ENTRY],
	omittedEntries: 0n,
	undeliveredEntries: 0n,
	totals: { entries: 1n, dirs: 0n, files: 1n, bytes: 1n, skipped: 0n, bytesSkipped: 0n },
	unaccountedBytes: 0n,
	duplicates: undefined,
	error: undefined
}

const EXTRACT_UPDATE: ExtractUpdate = {
	phase: "extracting",
	runState: "running",
	archiveBytes: 1n,
	counts: itemCounts(),
	bytesRead: 1n,
	active: [],
	events: [],
	bytesPerSecond: undefined,
	etaMs: undefined,
	activeTimeMs: 0n
}

beforeEach(async () => {
	await api.injectClient("session" as unknown as StringifiedClient)
	fakeClient.compressItems.mockResolvedValue(COMPRESS_REPORT)
	fakeClient.extractArchive.mockResolvedValue(EXTRACT_REPORT)
	fakeClient.extractArchiveEntries.mockResolvedValue(EXTRACT_REPORT)
	fakeClient.listArchive.mockResolvedValue(LIST_REPORT)
	fakeClient.getDirOptional.mockResolvedValue(DEST_DIR)
})

function compressParams(
	overrides: Partial<Parameters<SdkWorkerApi["compressItems"]>[1]> = {}
): Parameters<SdkWorkerApi["compressItems"]>[1] {
	return { items: [], destinationUuid: null, name: "a.zip", format: ZIP, maxBytes: undefined, dispose: undefined, ...overrides }
}

function extractParams(
	overrides: Partial<Parameters<SdkWorkerApi["extractArchive"]>[1]> = {}
): Parameters<SdkWorkerApi["extractArchive"]>[1] {
	return {
		archive: ARCHIVE,
		destinationUuid: null,
		root: { type: "newFolder" },
		maxBytes: undefined,
		skipMacMetadata: undefined,
		dispose: undefined,
		...overrides
	}
}

function lastCall<P>(mock: { mock: { calls: P[] } }): P {
	const call = mock.mock.calls.at(-1)

	if (call === undefined) {
		throw new Error("no call")
	}

	return call
}

describe("sdk worker lookups", () => {
	it("answers a malformed uuid (a hand-edited URL) as not found without asking the SDK", async () => {
		fakeClient.getDirOptional.mockClear()

		await expect(api.getDirectory("not-a-uuid")).resolves.toBeUndefined()
		expect(fakeClient.getDirOptional).not.toHaveBeenCalled()

		await expect(api.getDirectory(DEST)).resolves.toEqual(DEST_DIR)
		expect(fakeClient.getDirOptional).toHaveBeenCalledWith(DEST)
	})
})

describe("sdk worker archives", () => {
	it("leaves out the options a compress was not given, and passes an empty password as none", async () => {
		await api.compressItems("plain", compressParams(), "", () => undefined)

		const [params, password] = lastCall(fakeClient.compressItems)

		expect(params).not.toHaveProperty("maxBytes")
		expect(params).not.toHaveProperty("dispose")
		expect(params).toMatchObject({ name: "a.zip", format: ZIP, destination: { uuid: "root" } })
		expect(lastCall(fakeClient.compressItems)).toHaveLength(2)
		expect(password).toBeUndefined()

		await api.compressItems("full", compressParams({ maxBytes: 5, dispose: "trash" }), "secret", () => undefined)

		expect(lastCall(fakeClient.compressItems)[0]).toMatchObject({ maxBytes: 5, dispose: "trash" })
		expect(lastCall(fakeClient.compressItems)[1]).toBe("secret")

		await api.releaseJob("plain")
		await api.releaseJob("full")
	})

	it("posts a compress's slimmed updates and its archive, and lifts the report's errors", async () => {
		const onEvent = vi.fn<(event: CompressJobEvent) => void>()
		const stopped = liveSdkError("Cancelled", "Error of kind Cancelled")
		const archive = { uuid: testUuid("zip") }

		fakeClient.compressItems.mockImplementation(params => {
			params.onUpdate?.({
				phase: "compressing",
				runState: "running",
				scan: { sourcesDone: 1n, sourcesTotal: 1n, listingBytes: 0n, listingTotalBytes: undefined },
				totals: COMPRESS_REPORT.totals,
				counts: COMPRESS_REPORT.counts,
				active: [],
				events: [],
				bytesPerSecond: undefined,
				etaMs: undefined,
				activeTimeMs: 0n
			})
			params.onArchiveCreated?.(archive as never)

			return Promise.resolve({ ...COMPRESS_REPORT, error: stopped })
		})

		const report = await api.compressItems("events", compressParams(), undefined, onEvent)

		expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(["update", "archiveCreated"])
		expect(onEvent.mock.calls[0]?.[0]).toMatchObject({ update: { omitted: { skipped: 0, renamed: 0, hashMismatches: 0 } } })
		expect(onEvent.mock.calls[1]?.[0]).toEqual({ type: "archiveCreated", archive })
		expect(report.error).toEqual(sdkErrorDTO("Cancelled", "Error of kind Cancelled"))
		expect(stopped.freed).toHaveBeenCalledTimes(1)

		await api.releaseJob("events")
	})

	it("registers an archive job's controls before its destination lookup", async () => {
		const lookup = Promise.withResolvers<unknown>()

		fakeClient.getDirOptional.mockReturnValue(lookup.promise)

		const compress = api.compressItems("compress-lookup", compressParams({ destinationUuid: DEST }), undefined, () => undefined)

		await api.cancelTransfer("compress-lookup")
		lookup.resolve(DEST_DIR)
		await compress

		expect(lastCall(fakeClient.compressItems)[0].managedFuture.abortSignal.aborted).toBe(true)

		await api.releaseJob("compress-lookup")
	})

	it("leaves out the options an extract was not given and caches the directories it creates", async () => {
		const onEvent = vi.fn<(event: ExtractJobEvent) => void>()
		const created = { type: "dir", uuid: testUuid("created"), meta: { type: "decoded", data: { name: "photos" } } }

		fakeClient.extractArchive.mockImplementation(params => {
			params.onTopLevelBatch?.([
				{ key: { type: "root" }, item: created as never },
				{ key: { type: "root" }, item: { type: "file", uuid: testUuid("file") } as never }
			])
			params.onUpdate?.(EXTRACT_UPDATE)

			return Promise.resolve(EXTRACT_REPORT)
		})

		await api.extractArchive("extract", extractParams(), "", onEvent)

		const [params, password] = lastCall(fakeClient.extractArchive)

		for (const key of ["maxBytes", "skipMacMetadata", "dispose"]) {
			expect(params).not.toHaveProperty(key)
		}

		expect(password).toBeUndefined()
		expect(lastCall(fakeClient.extractArchive)).toHaveLength(2)
		expect(getCachedDir(testUuid("created"))).toBe(created)
		expect(getCachedDir(testUuid("file"))).toBeUndefined()
		expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(["topLevelBatch", "update"])
		expect(onEvent.mock.calls[1]?.[0]).toMatchObject({
			update: { omitted: { failures: 0, skipped: 0, renamed: 0, misleadingNames: 0 } }
		})

		await api.extractArchive(
			"extract-full",
			extractParams({ maxBytes: 9, skipMacMetadata: false, dispose: "deletePermanently" }),
			"pw",
			() => undefined
		)

		expect(lastCall(fakeClient.extractArchive)[0]).toMatchObject({ maxBytes: 9, skipMacMetadata: false, dispose: "deletePermanently" })
		expect(lastCall(fakeClient.extractArchive)[1]).toBe("pw")

		await api.releaseJob("extract")
		await api.releaseJob("extract-full")
	})

	it("extracts entries into a directory it was handed without looking one up", async () => {
		const dir = { uuid: testUuid("retry") } as unknown as AnyNormalDir
		const entries = [{ archive: testUuid("archive"), index: 4 }]

		fakeClient.getDirOptional.mockClear()

		await api.extractArchiveEntries(
			"entries",
			{
				archive: ARCHIVE,
				entries,
				base: "a",
				destination: { dir },
				root: { type: "destination" },
				maxBytes: undefined,
				skipMacMetadata: undefined
			},
			undefined,
			() => undefined
		)

		expect(fakeClient.getDirOptional).not.toHaveBeenCalled()
		expect(lastCall(fakeClient.extractArchiveEntries)[0]).toMatchObject({
			entries,
			base: "a",
			destination: dir,
			root: { type: "destination" }
		})
		expect(lastCall(fakeClient.extractArchiveEntries)[0]).not.toHaveProperty("maxBytes")

		await api.extractArchiveEntries(
			"entries-uuid",
			{
				archive: ARCHIVE,
				entries,
				base: "",
				destination: { uuid: DEST },
				root: { type: "newFolder", name: "x" },
				maxBytes: 3,
				skipMacMetadata: true
			},
			"",
			() => undefined
		)

		expect(lastCall(fakeClient.extractArchiveEntries)[0]).toMatchObject({ destination: DEST_DIR, maxBytes: 3, skipMacMetadata: true })
		expect(lastCall(fakeClient.extractArchiveEntries)[1]).toBeUndefined()

		await api.releaseJob("entries")
		await api.releaseJob("entries-uuid")
	})

	it("lifts an extract report's errors", async () => {
		const wrong = liveSdkError("ArchiveWrongPassword", "Error of kind ArchiveWrongPassword")

		fakeClient.extractArchive.mockResolvedValue({ ...EXTRACT_REPORT, error: wrong })

		const report = await api.extractArchive("wrong", extractParams(), "pw", () => undefined)

		expect(report.error).toEqual(sdkErrorDTO("ArchiveWrongPassword", "Error of kind ArchiveWrongPassword"))
		expect(structuredClone(report)).toEqual(report)
		expect(wrong.freed).toHaveBeenCalledTimes(1)

		await api.releaseJob("wrong")
	})

	it("packs a listing's batches, posting what it holds before every update and once more at the end", async () => {
		const onEvent = vi.fn<(event: ListJobEvent) => void>()
		const update = { phase: "reading", runState: "running", entries: 2n } as unknown as ListUpdate

		fakeClient.listArchive.mockImplementation(params => {
			params.onEntriesBatch?.([ENTRY])
			params.onEntriesBatch?.([
				{
					...ENTRY,
					id: { ...ENTRY.id, index: 1 },
					storedPath: "b/c.txt",
					path: { path: "b/c.txt", rewritten: false, misleading: false }
				}
			])
			params.onUpdate?.(update)
			params.onUpdate?.(update)
			params.onEntriesBatch?.([{ ...ENTRY, id: { ...ENTRY.id, index: 2 } }])

			return Promise.resolve(LIST_REPORT)
		})

		const slim = await api.listArchive(
			"list",
			{ archive: ARCHIVE, skipMacMetadata: undefined, deliverEntries: true, keepReportEntries: false },
			"",
			onEvent
		)
		const events = onEvent.mock.calls.map(([event]) => event)

		expect(events.map(event => event.type)).toEqual(["entries", "update", "update", "entries"])

		const [first, , , last] = events

		if (first?.type !== "entries" || last?.type !== "entries") {
			throw new Error("expected entry batches")
		}

		expect(first.batch.count).toBe(2)
		expect([...first.batch.index]).toEqual([0, 1])
		expect(first.batch.name).toEqual(["a.txt", "c.txt"])
		expect(first.batch.parents).toEqual(["", "b"])
		expect([...last.batch.index]).toEqual([2])
		expect(structuredClone(first.batch)).toEqual(first.batch)
		expect(events[1]).toEqual({ type: "update", update })
		expect(slim.entries).toEqual([])
		expect(slim.totals).toEqual(LIST_REPORT.totals)
		expect(lastCall(fakeClient.listArchive)[0]).not.toHaveProperty("skipMacMetadata")
		expect(lastCall(fakeClient.listArchive)).toHaveLength(2)
		expect(lastCall(fakeClient.listArchive)[1]).toBeUndefined()

		await api.releaseJob("list")
	})

	it("lists without entries when none are wanted, and keeps the report's on request", async () => {
		const onEvent = vi.fn<(event: ListJobEvent) => void>()

		const kept = await api.listArchive(
			"list-kept",
			{ archive: ARCHIVE, skipMacMetadata: false, deliverEntries: false, keepReportEntries: true },
			"pw",
			onEvent
		)

		expect(kept.entries).toEqual([ENTRY])
		expect(lastCall(fakeClient.listArchive)[0]).not.toHaveProperty("onEntriesBatch")
		expect(lastCall(fakeClient.listArchive)[0]).toMatchObject({ skipMacMetadata: false })
		expect(lastCall(fakeClient.listArchive)[1]).toBe("pw")
		expect(onEvent).not.toHaveBeenCalled()

		await api.releaseJob("list-kept")
	})

	it("frees a job's pause once, however often it is released", async () => {
		await api.listArchive(
			"release",
			{ archive: ARCHIVE, skipMacMetadata: undefined, deliverEntries: true, keepReportEntries: false },
			undefined,
			() => undefined
		)

		const pause = lastCall(fakeClient.listArchive)[0].managedFuture.pauseSignal

		await api.releaseJob("release")
		await api.releaseJob("release")
		await api.pauseTransfer("release")

		expect(pause.freed).toBe(1)
		expect(pause.isPaused()).toBe(false)
	})

	it("reads every format's figures in one pass, with the client's budget and no encoder memory for a level it refuses", async () => {
		const sevenZ: CompressFormat = { type: "sevenZ", method: { type: "lzma2", level: 99 }, solid: true }

		helpers.archiveEncoderMemory.mockImplementation(format => {
			if (format.type === "sevenZ") {
				throw new Error("level not taken")
			}

			return 3n
		})
		helpers.archiveFormatLevels.mockImplementation(format => (format.type === "zip" ? { min: 0, max: 9, defaultLevel: 6 } : undefined))
		helpers.archiveMaxLevel.mockImplementation(format => (format.type === "zip" ? 9 : undefined))
		fakeClient.archiveCodecMemBudget.mockClear()

		await expect(api.archiveFormatInfo([ZIP, sevenZ])).resolves.toEqual([
			{ extension: ".zip", levels: { min: 0, max: 9, defaultLevel: 6 }, maxLevel: 9, encoderMemory: 3 },
			{ extension: ".sevenZ", levels: null, maxLevel: null, encoderMemory: null }
		])
		expect(fakeClient.archiveCodecMemBudget).toHaveBeenCalledTimes(1)
		expect(helpers.archiveMaxLevel.mock.calls.map(([, budget]) => budget)).toEqual([128n * 1024n * 1024n, 128n * 1024n * 1024n])
		await expect(api.archiveCodecMemBudget()).resolves.toBe(128 * 1024 * 1024)
	})

	it("tells each name's archive format and default directory name", async () => {
		await expect(api.archiveNameInfo(["photos.zip", "notes.txt"])).resolves.toEqual([
			{ format: { type: "zip" }, defaultName: "photos" },
			{ format: null, defaultName: "notes.txt" }
		])
	})

	it("tells why the SDK refuses each name, and rethrows anything but a name error", async () => {
		await expect(api.itemNameErrors(["photos.zip", "a:b"])).resolves.toEqual([null, "ForbiddenChar"])
		await expect(api.itemNameErrors(["boom"])).rejects.toThrow("wasm gone")
	})
})

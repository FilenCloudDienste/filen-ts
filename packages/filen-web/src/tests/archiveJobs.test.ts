import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { CompressCounts, Dir, File, ItemCounts, UserInfo, UuidStr } from "@filen/sdk-rs"
import type { CompressReportDTO, ExtractReportDTO } from "@/lib/sdk/jobErrors"
import type { CompressJobEvent, CompressJobUpdate, ExtractJobEvent, ExtractJobUpdate } from "@/workers/sdk.worker"

const { compressItems, extractArchive, extractArchiveEntries, releaseJob, cancelTransfer, resumeTransfer } = vi.hoisted(() => ({
	compressItems: vi.fn<(id: string, params: unknown, password: string | undefined, onEvent: unknown) => Promise<CompressReportDTO>>(),
	extractArchive: vi.fn<(id: string, params: unknown, password: string | undefined, onEvent: unknown) => Promise<ExtractReportDTO>>(),
	extractArchiveEntries:
		vi.fn<(id: string, params: unknown, password: string | undefined, onEvent: unknown) => Promise<ExtractReportDTO>>(),
	releaseJob: vi.fn<(id: string) => void>(),
	cancelTransfer: vi.fn<(id: string) => void>(),
	resumeTransfer: vi.fn<(id: string) => void>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { compressItems, extractArchive, extractArchiveEntries, releaseJob, cancelTransfer, resumeTransfer }
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import {
	rerunCompress,
	rerunExtractWithPassword,
	retryFailedExtract,
	runCompressJob,
	runExtractJob,
	startCompress,
	startExtract,
	type CompressJobRequest,
	type ExtractJobRequest,
	type RunArchiveDeps
} from "@/features/drive/lib/archiveJobs"
import { afterDriveJobSettled, liesWithin } from "@/features/drive/lib/driveJobs"
import { forgetJobPassword, holdJobPassword, jobPassword } from "@/features/drive/lib/jobSecrets"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { getJobOf, jobsAccess, useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { directorySizeQueryKey, discardListingPatches, driveListingQueryKey } from "@/features/drive/queries/drive"
import { testUuid } from "@/tests/support/uuid"
import { sdkErrorDTO } from "@/tests/support/sdkError"
import { errorLabel } from "@/lib/i18n/errorLabel"

const ROOT = testUuid("root")
const DESTINATION = { uuid: null, name: "My Drive" }

function mockFile(label: string, parent: UuidStr = ROOT, size = 100n): File {
	return {
		uuid: testUuid(label),
		stableUUID: undefined,
		parent,
		size,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: { name: `${label}.zip`, mime: "application/zip", modified: 1_700_000_000_000n, size, key: "k", version: 2 }
		}
	}
}

function mockDir(label: string, parent: UuidStr = ROOT): Dir {
	return {
		uuid: testUuid(label),
		parent,
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: label } }
	}
}

function compressCounts(overrides: Partial<CompressCounts> = {}): CompressCounts {
	return {
		filesDone: 0n,
		entriesSkipped: 0n,
		bytesSkipped: 0n,
		bytesRead: 0n,
		bytesWritten: 0n,
		archiveBytes: 0n,
		bytesVerified: 0n,
		...overrides
	}
}

function itemCounts(overrides: Partial<ItemCounts> = {}): ItemCounts {
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

function compressUpdate(overrides: Partial<CompressJobUpdate> = {}): CompressJobUpdate {
	return {
		phase: "compressing",
		runState: "running",
		scan: { sourcesDone: 2n, sourcesTotal: 2n, listingBytes: 0n, listingTotalBytes: undefined },
		totals: { dirs: 0n, files: 2n, bytes: 200n },
		counts: compressCounts(),
		active: [],
		events: [],
		bytesPerSecond: undefined,
		etaMs: undefined,
		activeTimeMs: 0n,
		omitted: { skipped: 0, renamed: 0, hashMismatches: 0 },
		...overrides
	}
}

function compressReport(overrides: Partial<CompressReportDTO> = {}): CompressReportDTO {
	return {
		archive: mockFile("archive", ROOT, 150n),
		skipped: [],
		renamed: [],
		totals: { dirs: 0n, files: 2n, bytes: 200n },
		counts: compressCounts({ filesDone: 2n, bytesRead: 200n, bytesWritten: 150n, archiveBytes: 150n }),
		neededBytes: undefined,
		dispositions: [],
		hashMismatches: [],
		omittedHashMismatches: 0n,
		error: undefined,
		...overrides
	}
}

function extractUpdate(overrides: Partial<ExtractJobUpdate> = {}): ExtractJobUpdate {
	return {
		phase: "extracting",
		runState: "running",
		archiveBytes: 1_000n,
		counts: itemCounts(),
		bytesRead: 0n,
		active: [],
		events: [],
		bytesPerSecond: undefined,
		etaMs: undefined,
		activeTimeMs: 0n,
		omitted: { failures: 0, skipped: 0, renamed: 0, misleadingNames: 0, savedAsVersion: 0, macMetadata: 0 },
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
		counts: itemCounts({ filesDone: 3n, bytesDone: 3_000n }),
		unaccountedBytes: 0n,
		duplicates: undefined,
		dispositions: [],
		error: undefined,
		...overrides
	}
}

const ARCHIVE = mockFile("photos")
const SOURCES: DriveItem[] = [narrowItem(mockFile("a")), narrowItem(mockDir("b"))]
const QUOTA_ERROR = sdkErrorDTO("MaxStorageReached", "the job needs more storage")

function compressFields(overrides: Partial<CompressJobRequest> = {}): Omit<CompressJobRequest, "id"> {
	return {
		source: { kind: "items", items: SOURCES },
		destination: DESTINATION,
		name: "Archive.zip",
		format: { type: "zip", method: { type: "deflate", level: 6 } },
		encrypted: false,
		dispose: null,
		itemCount: 2,
		...overrides
	}
}

function compressRequest(overrides: Partial<CompressJobRequest> = {}): CompressJobRequest {
	return { id: "job", ...compressFields(overrides) }
}

function extractFields(overrides: Partial<ExtractJobRequest> = {}): Omit<ExtractJobRequest, "id"> {
	return {
		archive: { file: ARCHIVE, uuid: ARCHIVE.uuid, name: "photos.zip" },
		destination: DESTINATION,
		root: { type: "newFolder" },
		rowName: "photos",
		calls: [{ type: "all" }],
		skipMacMetadata: true,
		dispose: null,
		basis: { type: "archiveRead" },
		formatHint: "zip",
		glyph: "directory",
		...overrides
	}
}

function extractRequest(overrides: Partial<ExtractJobRequest> = {}): ExtractJobRequest {
	return { id: "job", ...extractFields(overrides) }
}

function makeDeps() {
	return {
		compressItems: vi.fn<RunArchiveDeps["compressItems"]>(),
		extractArchive: vi.fn<RunArchiveDeps["extractArchive"]>(),
		extractArchiveEntries: vi.fn<RunArchiveDeps["extractArchiveEntries"]>(),
		release: vi.fn<RunArchiveDeps["release"]>(),
		transfers: useTransfersStore.getState(),
		compressJobs: jobsAccess("compress"),
		extractJobs: jobsAccess("extract"),
		account: {
			cached: vi.fn<RunArchiveDeps["account"]["cached"]>(() => undefined),
			fetchFresh: vi.fn<RunArchiveDeps["account"]["fetchFresh"]>()
		},
		patchCreated: vi.fn<RunArchiveDeps["patchCreated"]>(),
		patchLeft: vi.fn<RunArchiveDeps["patchLeft"]>(),
		trash: vi.fn<RunArchiveDeps["trash"]>(() => Promise.resolve({ succeeded: [], failed: [] })),
		settled: vi.fn<RunArchiveDeps["settled"]>()
	}
}

// The worker rejects with its error's DTO: a call still running past its cancel grace.
function rejectCancelled(): Promise<never> {
	return Promise.reject(
		Object.assign(new Error("Error of kind Cancelled: error: grace exceeded"), { species: "sdk", kind: "Cancelled", label: "" })
	)
}

function row(id = "job") {
	return useTransfersStore.getState().transfers.find(transfer => transfer.id === id)
}

function topLevel(item: Dir | File) {
	return "chunks" in item
		? { key: { type: "root" as const }, item: { type: "file" as const, ...item } }
		: { key: { type: "root" as const }, item: { type: "dir" as const, ...item } }
}

function stopWith(id: string, cancelRequest: "keep" | "trash"): void {
	useDriveJobsStore.getState().update("extract", id, job => ({ ...job, cancelRequest }))
}

// Counts the writes each store gets while `run` delivers one event.
function countWrites(run: () => void): { jobs: number; transfers: number } {
	const writes = { jobs: 0, transfers: 0 }
	const unsubscribeJobs = useDriveJobsStore.subscribe(() => {
		writes.jobs++
	})
	const unsubscribeTransfers = useTransfersStore.subscribe(() => {
		writes.transfers++
	})

	run()
	unsubscribeJobs()
	unsubscribeTransfers()

	return writes
}

beforeEach(() => {
	useTransfersStore.setState({ transfers: [], speedSamples: [] })
	useDriveJobsStore.setState({ jobs: {}, cancelPromptId: null, passwordPromptId: null, reportJobId: null })
	queryClient.clear()
	discardListingPatches()
	forgetJobPassword("job")

	for (const mock of [compressItems, extractArchive, extractArchiveEntries, releaseJob, cancelTransfer, resumeTransfer]) {
		mock.mockReset()
	}
})

describe("runCompressJob", () => {
	it("adds one compressing row and one job, and hands the SDK the narrowed items and the held password", async () => {
		const deps = makeDeps()
		let seenRow: ReturnType<typeof row>

		holdJobPassword("job", "secret")
		deps.compressItems.mockImplementation(() => {
			seenRow = row()

			return Promise.resolve(compressReport())
		})

		const job = await runCompressJob(deps, compressRequest({ encrypted: true }))

		expect(seenRow).toMatchObject({ direction: "compress", status: "compressing", name: "Archive.zip", parentUuid: null })
		expect(deps.compressItems.mock.calls[0]?.[1]).toMatchObject({
			items: [SOURCES[0]?.data, SOURCES[1]?.data],
			destinationUuid: null,
			name: "Archive.zip",
			dispose: undefined
		})
		expect(deps.compressItems.mock.calls[0]?.[2]).toBe("secret")
		expect(job?.outcome).toEqual({ status: "done" })
		expect(job?.archive?.data.uuid).toBe(testUuid("archive"))
		expect(row()).toMatchObject({ status: "done", size: 200, bytesTransferred: 200 })
		expect(deps.release).toHaveBeenCalledWith("job")
	})

	it("writes the job once per update, the row only when its figures move, and the archive with the next update", async () => {
		const deps = makeDeps()
		const archive = mockFile("archive")
		const writes: { jobs: number; transfers: number }[] = []
		let afterArchive: DriveItem | null | undefined

		deps.compressItems.mockImplementation((_id, _params, _password, onEvent) => {
			const first = compressUpdate({ counts: compressCounts({ bytesRead: 100n }) })

			writes.push(
				countWrites(() => {
					onEvent({ type: "update", update: first })
				})
			)
			// The same figures again: only the job is written.
			writes.push(
				countWrites(() => {
					onEvent({ type: "update", update: first })
				})
			)

			onEvent({ type: "archiveCreated", archive })
			afterArchive = getJobOf("compress", "job")?.archive

			writes.push(
				countWrites(() => {
					onEvent({ type: "update", update: compressUpdate({ phase: "finishing" }) })
				})
			)

			return Promise.resolve(compressReport({ archive }))
		})

		const job = await runCompressJob(deps, compressRequest())

		// Size and progress on the first; nothing on the row for the repeat; progress on the third.
		expect(writes).toEqual([
			{ jobs: 1, transfers: 2 },
			{ jobs: 1, transfers: 0 },
			{ jobs: 1, transfers: 1 }
		])
		expect(afterArchive).toBeNull()
		expect(deps.patchCreated).toHaveBeenCalledTimes(1)
		expect(row()?.item?.data.uuid).toBe(archive.uuid)
		expect(job?.archive?.data.uuid).toBe(archive.uuid)
	})

	it("renames the row to the archive's own name, which the SDK's keep-both may have changed", async () => {
		const deps = makeDeps()
		const archive = mockFile("photos (1)")

		deps.compressItems.mockImplementation((_id, _params, _password, onEvent) => {
			onEvent({ type: "archiveCreated", archive })

			return Promise.resolve(compressReport({ archive }))
		})

		await runCompressJob(deps, compressRequest({ name: "photos.zip" }))

		expect(row()?.name).toBe("photos (1).zip")
	})

	it("keeps an archive announced just before a rejected call, as stopped after the archive", async () => {
		const deps = makeDeps()
		const archive = mockFile("archive")

		deps.compressItems.mockImplementation((_id, _params, _password, onEvent) => {
			onEvent({ type: "archiveCreated", archive })

			return rejectCancelled()
		})

		const job = await runCompressJob(deps, compressRequest())

		expect(job?.archive?.data.uuid).toBe(archive.uuid)
		expect(job?.stoppedAfterArchive).toBe(true)
		expect(job?.outcome.status).toBe("done")
	})

	it("records an archive the worker delivers only after its call rejected", async () => {
		const deps = makeDeps()
		const archive = mockFile("archive")
		let deliver: ((event: CompressJobEvent) => void) | undefined

		deps.compressItems.mockImplementation((_id, _params, _password, onEvent) => {
			deliver = onEvent

			return rejectCancelled()
		})

		const job = await runCompressJob(deps, compressRequest())

		expect(job?.outcome).toEqual({ status: "cancelled" })

		deliver?.({ type: "archiveCreated", archive })

		expect(getJobOf("compress", "job")).toMatchObject({ lateArchive: true, archive: { data: { uuid: archive.uuid } } })
		expect(deps.patchCreated).toHaveBeenCalledTimes(1)
	})

	describe("a bare tar refused up front for storage", () => {
		const refusal = compressReport({ archive: undefined, neededBytes: 900n, counts: compressCounts(), error: QUOTA_ERROR })

		it("runs again once a fresh read frees more", async () => {
			const deps = makeDeps()

			deps.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 900n })
			deps.account.fetchFresh.mockResolvedValue({ maxStorage: 1_000n, storageUsed: 0n })
			deps.compressItems.mockResolvedValueOnce(refusal).mockResolvedValueOnce(compressReport())

			const job = await runCompressJob(deps, compressRequest())

			expect(deps.compressItems).toHaveBeenCalledTimes(2)
			expect(deps.compressItems.mock.calls[1]?.[1]).toMatchObject({ maxBytes: 1_000 })
			expect(job?.outcome).toEqual({ status: "done" })
		})

		it("keeps the fresh figure when it frees nothing more", async () => {
			const deps = makeDeps()

			deps.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 900n })
			deps.account.fetchFresh.mockResolvedValue({ maxStorage: 1_000n, storageUsed: 950n })
			deps.compressItems.mockResolvedValue(refusal)

			const job = await runCompressJob(deps, compressRequest())

			expect(deps.compressItems).toHaveBeenCalledTimes(1)
			expect(deps.account.fetchFresh).toHaveBeenCalledTimes(1)
			expect(job?.outcome).toEqual({ status: "quotaExceeded", neededBytes: 900, freeBytes: 50 })
			expect(row()).toMatchObject({
				status: "error",
				error: { label: "This archive needs 900 B but only 50 B is free." }
			})
			expect(errorLabel(row()?.error)).toBe("This archive needs 900 B but only 50 B is free.")
		})

		it("ends as the stop it was when stopped meanwhile", async () => {
			const deps = makeDeps()

			deps.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 900n })
			deps.compressItems.mockImplementation(() => {
				useDriveJobsStore.getState().update("compress", "job", job => ({ ...job, cancelRequest: "keep" }))

				return Promise.resolve(refusal)
			})

			const job = await runCompressJob(deps, compressRequest())

			expect(deps.account.fetchFresh).not.toHaveBeenCalled()
			expect(job?.outcome).toEqual({ status: "cancelled" })
			expect(row()).toBeUndefined()
		})
	})

	it("takes removed originals out of the listings by kind, and counts what a permanent delete freed", async () => {
		const deps = makeDeps()

		deps.compressItems.mockImplementation((_id, _params, _password, onEvent) => {
			onEvent({
				type: "update",
				update: compressUpdate({
					phase: "disposingSources",
					events: [
						{
							type: "sourceDisposition",
							uuid: testUuid("a"),
							outcome: { type: "disposed", how: "deletePermanently", bytesFreed: 100n }
						},
						{
							type: "sourceDisposition",
							uuid: testUuid("b"),
							outcome: { type: "kept", reason: { type: "changed" }, bytesFreed: 0n }
						}
					]
				})
			})

			return Promise.resolve(
				compressReport({
					dispositions: [
						{ uuid: testUuid("a"), outcome: { type: "disposed", how: "deletePermanently", bytesFreed: 100n } },
						{ uuid: testUuid("b"), outcome: { type: "kept", reason: { type: "changed" }, bytesFreed: 0n } }
					]
				})
			)
		})

		const job = await runCompressJob(deps, compressRequest({ dispose: "deletePermanently" }))

		expect(deps.patchLeft.mock.calls).toEqual([[[testUuid("a")], "delete", "file"]])
		expect(job?.outcome.status).toBe("doneWithIssues")
		expect(job?.sourceNames).toEqual({ [testUuid("a")]: "a.zip", [testUuid("b")]: "b" })
		expect(deps.settled.mock.calls[0]?.[1]).toEqual({
			destinationUuid: null,
			writtenDirs: [],
			bytesWritten: 150,
			bytesFreed: 100,
			sourceParents: [ROOT]
		})
	})
})

describe("runCompressJob, more", () => {
	it("counts the events of a call refused up front only once when it runs again", async () => {
		const deps = makeDeps()
		const skipped = {
			type: "skipped" as const,
			sourcePath: "a.zip",
			bytes: 1n,
			reason: { type: "undecryptableFile" as const, uuid: testUuid("u") }
		}
		let midSecond: number | undefined

		deps.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 900n })
		deps.account.fetchFresh.mockResolvedValue({ maxStorage: 1_000n, storageUsed: 0n })
		deps.compressItems
			.mockImplementationOnce((_id, _params, _password, onEvent) => {
				onEvent({ type: "update", update: compressUpdate({ events: [skipped] }) })

				return Promise.resolve(
					compressReport({ archive: undefined, neededBytes: 900n, counts: compressCounts(), error: QUOTA_ERROR })
				)
			})
			.mockImplementationOnce((_id, _params, _password, onEvent) => {
				onEvent({ type: "update", update: compressUpdate({ events: [skipped] }) })
				midSecond = getJobOf("compress", "job")?.skipped.items.length

				return Promise.resolve(compressReport())
			})

		await runCompressJob(deps, compressRequest())

		expect(midSecond).toBe(1)
	})

	it("trashes a source inside another removed source only out of the listings, never as a trash row of its own", async () => {
		const deps = makeDeps()
		const outer = narrowItem(mockDir("outer"))
		const inner = narrowItem(mockFile("inner", testUuid("outer")))
		const disposed = { type: "disposed" as const, how: "trash" as const, bytesFreed: 0n }

		deps.compressItems.mockImplementation((_id, _params, _password, onEvent) => {
			onEvent({
				type: "update",
				update: compressUpdate({
					phase: "disposingSources",
					events: [
						{ type: "sourceDisposition", uuid: testUuid("outer"), outcome: disposed },
						{ type: "sourceDisposition", uuid: testUuid("inner"), outcome: disposed }
					]
				})
			})

			return Promise.resolve(
				compressReport({
					dispositions: [
						{ uuid: testUuid("outer"), outcome: disposed },
						{ uuid: testUuid("inner"), outcome: disposed }
					]
				})
			)
		})

		await runCompressJob(deps, compressRequest({ source: { kind: "items", items: [outer, inner] }, dispose: "trash" }))

		expect(deps.patchLeft.mock.calls).toEqual([
			[[testUuid("outer")], "trash", "directory"],
			[[testUuid("inner")], "delete", "file"]
		])
	})

	it("notes the archive was kept when a stop reached the job only once it was registered", async () => {
		const deps = makeDeps()

		deps.compressItems.mockImplementation(() => {
			useDriveJobsStore.getState().update("compress", "job", job => ({ ...job, cancelRequest: "keep" }))

			return Promise.resolve(compressReport())
		})

		const job = await runCompressJob(deps, compressRequest())

		expect(job).toMatchObject({ stoppedAfterArchive: true, outcome: { status: "done" } })
		expect(row()?.status).toBe("done")
	})
})

describe("runExtractJob", () => {
	it("adds one extracting row, patches each top-level item and reveals the first", async () => {
		const deps = makeDeps()
		const folder = mockDir("photos")
		let midRun: { firstCreated: string | undefined; rowItem: string | undefined } | undefined

		deps.extractArchive.mockImplementation((_id, _params, _password, onEvent) => {
			onEvent({ type: "topLevelBatch", items: [topLevel(folder)] })
			midRun = { firstCreated: getJobOf("extract", "job")?.firstCreated?.data.uuid, rowItem: row()?.item?.data.uuid }
			onEvent({ type: "update", update: extractUpdate({ bytesRead: 500n }) })

			return Promise.resolve(extractReport({ topLevel: [topLevel(folder)] }))
		})

		const job = await runExtractJob(deps, extractRequest())

		// The reveal waits for the next update's write; the row gets it at once.
		expect(midRun).toEqual({ firstCreated: undefined, rowItem: folder.uuid })
		expect(deps.patchCreated).toHaveBeenCalledTimes(1)
		expect(job?.firstCreated?.data.uuid).toBe(folder.uuid)
		expect(deps.extractArchive.mock.calls[0]?.[1]).toMatchObject({
			archive: ARCHIVE,
			root: { type: "newFolder" },
			skipMacMetadata: true
		})
		expect(row()).toMatchObject({ direction: "extract", status: "done", size: 1_000, bytesTransferred: 1_000 })
		expect(deps.settled.mock.calls[0]?.[1]).toMatchObject({ writtenDirs: [folder.uuid], bytesWritten: 3_000, bytesFreed: 0 })
	})

	it("writes the job once per update and skips the row's progress while it does not move", async () => {
		const deps = makeDeps()
		const writes: { jobs: number; transfers: number }[] = []

		deps.extractArchive.mockImplementation((_id, _params, _password, onEvent) => {
			const waiting = extractUpdate({ phase: "waitingForWorker", archiveBytes: 0n })

			for (const update of [waiting, waiting, extractUpdate({ bytesRead: 100n })]) {
				writes.push(
					countWrites(() => {
						onEvent({ type: "update", update })
					})
				)
			}

			return Promise.resolve(extractReport())
		})

		await runExtractJob(deps, extractRequest())

		expect(writes).toEqual([
			{ jobs: 1, transfers: 0 },
			{ jobs: 1, transfers: 0 },
			{ jobs: 1, transfers: 2 }
		])
	})

	describe("a zip refused up front for storage", () => {
		const refusal = extractReport({ counts: itemCounts(), error: QUOTA_ERROR })

		it("runs again once a fresh read frees more", async () => {
			const deps = makeDeps()

			deps.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 900n })
			deps.account.fetchFresh.mockResolvedValue({ maxStorage: 1_000n, storageUsed: 0n })
			deps.extractArchive.mockResolvedValueOnce(refusal).mockResolvedValueOnce(extractReport())

			const job = await runExtractJob(deps, extractRequest())

			expect(deps.extractArchive).toHaveBeenCalledTimes(2)
			expect(deps.extractArchive.mock.calls[1]?.[1]).toMatchObject({ maxBytes: 1_000 })
			expect(job?.outcome).toEqual({ status: "done" })
		})

		it("keeps the fresh figure when it frees nothing more", async () => {
			const deps = makeDeps()

			deps.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 900n })
			deps.account.fetchFresh.mockResolvedValue({ maxStorage: 1_000n, storageUsed: 980n })
			deps.extractArchive.mockResolvedValue(refusal)

			const job = await runExtractJob(deps, extractRequest())

			expect(deps.extractArchive).toHaveBeenCalledTimes(1)
			expect(job?.outcome).toEqual({ status: "quotaExceeded", neededBytes: null, freeBytes: 20 })
			expect(row()).toMatchObject({ status: "error", error: { label: "There isn't enough free storage. Only 20 B is free." } })
		})

		it("ends as the stop it was when stopped meanwhile", async () => {
			const deps = makeDeps()

			deps.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 900n })
			deps.extractArchive.mockImplementation(() => {
				stopWith("job", "keep")

				return Promise.resolve(refusal)
			})

			const job = await runExtractJob(deps, extractRequest())

			expect(job?.outcome).toEqual({ status: "cancelled" })
			expect(row()).toBeUndefined()
		})
	})

	it("keeps what a stop asked to keep", async () => {
		const deps = makeDeps()
		const folder = mockDir("photos")

		deps.extractArchive.mockImplementation((_id, _params, _password, onEvent) => {
			onEvent({ type: "topLevelBatch", items: [topLevel(folder)] })
			stopWith("job", "keep")

			return Promise.resolve(extractReport({ topLevel: [topLevel(folder)], error: sdkErrorDTO("Cancelled", "cancelled") }))
		})

		const job = await runExtractJob(deps, extractRequest())

		expect(job?.outcome).toEqual({ status: "cancelled" })
		expect(deps.trash).not.toHaveBeenCalled()
		expect(row()).toBeUndefined()
	})

	it("trashes what a stop asked to trash, delivered or reported, and one delivered after a rejected call", async () => {
		const deps = makeDeps()
		const delivered = mockDir("delivered")
		const late = mockFile("late")
		let deliver: ((event: ExtractJobEvent) => void) | undefined

		deps.extractArchive.mockImplementation((_id, _params, _password, onEvent) => {
			deliver = onEvent
			onEvent({ type: "topLevelBatch", items: [topLevel(delivered)] })
			stopWith("job", "trash")

			return rejectCancelled()
		})
		deps.trash.mockImplementation(items => Promise.resolve({ succeeded: items, failed: [] }))

		const job = await runExtractJob(deps, extractRequest({ root: { type: "destination" } }))

		expect(deps.trash.mock.calls[0]?.[0].map(item => item.data.uuid)).toEqual([delivered.uuid])
		expect(job).toMatchObject({ outcome: { status: "cancelled" }, created: [], trashResult: { moved: 1, failed: 0 } })

		deliver?.({ type: "topLevelBatch", items: [topLevel(late), topLevel(delivered)] })

		await vi.waitFor(() => {
			expect(getJobOf("extract", "job")?.trashResult).toEqual({ moved: 2, failed: 0 })
		})
		expect(deps.trash).toHaveBeenCalledTimes(2)
		expect(deps.trash.mock.calls[1]?.[0].map(item => item.data.uuid)).toEqual([late.uuid])
	})

	it("drops folders a late wrong password trashed from the listings, the reveal and the stop's trash", async () => {
		const deps = makeDeps()
		const first = mockDir("first")
		const second = mockDir("second")

		deps.extractArchive.mockImplementation((_id, _params, _password, onEvent) => {
			onEvent({ type: "topLevelBatch", items: [topLevel(first), topLevel(second)] })
			onEvent({ type: "update", update: extractUpdate({ events: [{ type: "topLevelTrashed", destUuid: first.uuid }] }) })
			stopWith("job", "trash")

			return Promise.resolve(extractReport({ topLevel: [topLevel(second)], error: sdkErrorDTO("ArchiveWrongPassword", "wrong") }))
		})
		deps.trash.mockImplementation(items => Promise.resolve({ succeeded: items, failed: [] }))

		const job = await runExtractJob(deps, extractRequest({ root: { type: "destination" } }))

		expect(deps.patchLeft).toHaveBeenCalledWith([first.uuid], "trash", "directory")
		expect(deps.trash.mock.calls.flatMap(call => call[0].map(item => item.data.uuid))).toEqual([second.uuid])
		expect(job?.firstCreated).toBeNull()
		expect(job?.topLevelTrashedCount).toBe(1)
	})

	it("takes a removed archive out of the listings and its parent's size", async () => {
		const deps = makeDeps()
		const disposition = { uuid: ARCHIVE.uuid, outcome: { type: "disposed" as const, how: "trash" as const, bytesFreed: 0n } }

		deps.extractArchive.mockImplementation((_id, _params, _password, onEvent) => {
			onEvent({
				type: "update",
				update: extractUpdate({ phase: "disposingSources", events: [{ type: "sourceDisposition", ...disposition }] })
			})

			return Promise.resolve(extractReport({ dispositions: [disposition] }))
		})

		await runExtractJob(deps, extractRequest({ dispose: "trash" }))

		expect(deps.patchLeft).toHaveBeenCalledWith([ARCHIVE.uuid], "trash", "file")
		expect(deps.settled.mock.calls[0]?.[1]).toMatchObject({ bytesFreed: 0, sourceParents: [ROOT] })
	})

	it("settles a missing or wrong password as an error the row reads as the card's text", async () => {
		const deps = makeDeps()

		deps.extractArchive.mockResolvedValueOnce(
			extractReport({ counts: itemCounts(), error: sdkErrorDTO("ArchivePasswordRequired", "needs one") })
		)

		const job = await runExtractJob(deps, extractRequest())

		expect(job?.outcome).toEqual({ status: "passwordRequired" })
		expect(row()?.status).toBe("error")
		expect(row()?.error?.kind).toBeUndefined()
		expect(errorLabel(row()?.error)).toBe("This archive is protected by a password.")
	})

	it("runs its calls one after another, adds their counts, and stops between them on a stop", async () => {
		const deps = makeDeps()
		const dir = mockDir("target")
		const call = { type: "entries" as const, entries: [{ archive: ARCHIVE.uuid, index: 1 }], base: "", destination: { dir } }
		let midSecond: number | undefined

		deps.extractArchiveEntries
			.mockImplementationOnce(() => Promise.resolve(extractReport({ counts: itemCounts({ filesDone: 1n, bytesDone: 10n }) })))
			.mockImplementationOnce((_id, _params, _password, onEvent) => {
				onEvent({ type: "update", update: extractUpdate({ counts: itemCounts({ filesDone: 1n, bytesDone: 5n }) }) })
				midSecond = getJobOf("extract", "job")?.counts.bytesDone
				stopWith("job", "keep")

				return Promise.resolve(extractReport({ counts: itemCounts({ filesDone: 2n, bytesDone: 20n }) }))
			})

		const job = await runExtractJob(
			deps,
			extractRequest({ root: { type: "destination" }, calls: [call, call, call], basis: { type: "unknown" } })
		)

		expect(deps.extractArchiveEntries).toHaveBeenCalledTimes(2)
		expect(deps.extractArchiveEntries.mock.calls[0]?.[1]).toMatchObject({ destination: { dir }, root: { type: "destination" } })
		expect(midSecond).toBe(15)
		expect(job?.counts).toMatchObject({ filesDone: 3, bytesDone: 30 })
	})
})

describe("runExtractJob, more", () => {
	it("keeps what it extracted when a stop to trash it finds the archive already removed", async () => {
		const deps = makeDeps()
		const folder = mockDir("photos")
		const disposition = { uuid: ARCHIVE.uuid, outcome: { type: "disposed" as const, how: "trash" as const, bytesFreed: 0n } }

		deps.extractArchive.mockImplementation((_id, _params, _password, onEvent) => {
			onEvent({ type: "topLevelBatch", items: [topLevel(folder)] })
			stopWith("job", "trash")
			onEvent({
				type: "update",
				update: extractUpdate({ phase: "disposingSources", events: [{ type: "sourceDisposition", ...disposition }] })
			})

			return Promise.resolve(extractReport({ topLevel: [topLevel(folder)], dispositions: [disposition] }))
		})

		const job = await runExtractJob(deps, extractRequest({ dispose: "trash" }))

		expect(deps.trash).not.toHaveBeenCalled()
		expect(job).toMatchObject({ cancelRequest: "keep", created: [], outcome: { status: "done" } })
		expect(row()?.status).toBe("done")
	})

	it("gives each later call only what the earlier ones left of the free storage", async () => {
		const deps = makeDeps()
		const dir = mockDir("target")
		const call = { type: "entries" as const, entries: [{ archive: ARCHIVE.uuid, index: 1 }], base: "", destination: { dir } }

		deps.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 900n })
		deps.extractArchiveEntries
			.mockResolvedValueOnce(extractReport({ counts: itemCounts({ filesDone: 1n, bytesDone: 30n }) }))
			.mockResolvedValueOnce(extractReport({ counts: itemCounts({ filesDone: 1n, bytesDone: 50n }) }))
			.mockResolvedValueOnce(extractReport({ counts: itemCounts({ filesDone: 1n, bytesDone: 10n }) }))

		await runExtractJob(deps, extractRequest({ root: { type: "destination" }, calls: [call, call, call], basis: { type: "unknown" } }))

		expect(deps.extractArchiveEntries.mock.calls.map(entry => entry[1].maxBytes)).toEqual([100, 70, 20])
	})

	it("counts the events of a call refused up front only once when it runs again", async () => {
		const deps = makeDeps()
		const skipped = {
			type: "skipped" as const,
			entry: { archive: ARCHIVE.uuid, index: 1 },
			path: "a",
			pathTruncated: false,
			bytes: 1n,
			reason: { type: "device" as const }
		}
		let midSecond: number | undefined

		deps.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 900n })
		deps.account.fetchFresh.mockResolvedValue({ maxStorage: 1_000n, storageUsed: 0n })
		deps.extractArchive
			.mockImplementationOnce((_id, _params, _password, onEvent) => {
				onEvent({ type: "update", update: extractUpdate({ events: [skipped] }) })

				return Promise.resolve(extractReport({ counts: itemCounts(), error: QUOTA_ERROR }))
			})
			.mockImplementationOnce((_id, _params, _password, onEvent) => {
				onEvent({ type: "update", update: extractUpdate({ events: [skipped] }) })
				midSecond = getJobOf("extract", "job")?.skipped.items.length

				return Promise.resolve(extractReport())
			})

		await runExtractJob(deps, extractRequest())

		expect(midSecond).toBe(1)
	})
})

describe("afterDriveJobSettled", () => {
	it("adds what the job wrote less what it freed to the storage used", () => {
		queryClient.setQueryData<Partial<UserInfo>>(ACCOUNT_QUERY_KEY, { rootDirUuid: ROOT, maxStorage: 10_000n, storageUsed: 1_000n })

		afterDriveJobSettled({ destinationUuid: null, writtenDirs: [], bytesWritten: 300, bytesFreed: 500, sourceParents: [] })

		expect(queryClient.getQueryData<UserInfo>(ACCOUNT_QUERY_KEY)?.storageUsed).toBe(800n)
	})

	it("invalidates the destination's chain, the written directories and the sources' chains, each once", () => {
		const parent = testUuid("parent")
		const child = testUuid("child")
		const written = testUuid("written")
		const invalidate = vi.spyOn(queryClient, "invalidateQueries")

		queryClient.setQueryData<Partial<UserInfo>>(ACCOUNT_QUERY_KEY, { rootDirUuid: ROOT, maxStorage: 10_000n, storageUsed: 0n })
		queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: parent }), [narrowItem(mockDir("child", parent))])
		queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: null }), [narrowItem(mockDir("parent"))])

		afterDriveJobSettled({
			destinationUuid: child,
			writtenDirs: [written],
			bytesWritten: 10,
			bytesFreed: 0,
			sourceParents: [parent, null]
		})

		const invalidated = invalidate.mock.calls.flatMap(call => {
			const key = call[0]?.queryKey

			return key?.[1] === "dirSize" ? [key] : []
		})

		invalidate.mockRestore()

		expect(invalidated).toEqual(
			expect.arrayContaining([directorySizeQueryKey(child), directorySizeQueryKey(written), directorySizeQueryKey(parent)])
		)
		expect(invalidated).toHaveLength(3)
	})
})

describe("liesWithin", () => {
	it("walks up through the listing cache to a match, and stops at the root or an uncached directory", () => {
		const outer = testUuid("outer")
		const middle = testUuid("middle")

		queryClient.setQueryData<Partial<UserInfo>>(ACCOUNT_QUERY_KEY, { rootDirUuid: ROOT, maxStorage: 10_000n, storageUsed: 0n })
		queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: outer }), [narrowItem(mockDir("middle", outer))])

		expect(liesWithin({ uuid: middle }, new Set([outer]))).toBe(true)
		expect(liesWithin({ uuid: middle, parent: ROOT }, new Set([outer]))).toBe(false)
		expect(liesWithin({ uuid: testUuid("uncached") }, new Set([outer]))).toBe(false)
		expect(liesWithin({ uuid: ROOT }, new Set([ROOT]))).toBe(false)
	})
})

describe("entry points", () => {
	beforeEach(() => {
		queryClient.setQueryData<Partial<UserInfo>>(ACCOUNT_QUERY_KEY, { rootDirUuid: ROOT, maxStorage: 10_000n, storageUsed: 0n })
	})

	it("reruns an extract with a password under the same id, keeping its card, and never stores the password", async () => {
		extractArchive
			.mockResolvedValueOnce(extractReport({ counts: itemCounts(), error: sdkErrorDTO("ArchiveWrongPassword", "wrong") }))
			.mockResolvedValueOnce(extractReport())

		const id = startExtract(extractFields(), undefined)

		await vi.waitFor(() => {
			expect(getJobOf("extract", id)?.outcome.status).toBe("wrongPassword")
		})

		useDriveJobsStore.getState().update("extract", id, job => ({ ...job, cardVisible: true }))
		// A stop prompt the first run left behind never opens over the rerun.
		useDriveJobsStore.getState().setCancelPromptId(id)

		expect(rerunExtractWithPassword(id, "hunter2")).toBe(true)
		expect(getJobOf("extract", id)).toMatchObject({ cardVisible: true, outcome: { status: "running" } })
		expect(useDriveJobsStore.getState().cancelPromptId).toBeNull()

		await vi.waitFor(() => {
			expect(getJobOf("extract", id)?.outcome.status).toBe("done")
		})

		expect(extractArchive.mock.calls[1]?.[0]).toBe(id)
		expect(extractArchive.mock.calls[1]?.[2]).toBe("hunter2")
		expect(useTransfersStore.getState().transfers.filter(transfer => transfer.id === id)).toHaveLength(1)

		const replacer = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value)

		expect(JSON.stringify(useDriveJobsStore.getState(), replacer)).not.toContain("hunter2")
		expect(JSON.stringify(useTransfersStore.getState(), replacer)).not.toContain("hunter2")
	})

	it("refuses a password rerun for an extract that did not ask for one", async () => {
		extractArchive.mockResolvedValueOnce(extractReport())

		const id = startExtract(extractFields(), undefined)

		await vi.waitFor(() => {
			expect(getJobOf("extract", id)?.outcome.status).toBe("done")
		})

		expect(rerunExtractWithPassword(id, "pw")).toBe(false)
	})

	it("retries an extract's failures as a new job, one call per directory, and hands on its password", async () => {
		const dirA = mockDir("dir-a")
		const dirB = mockDir("dir-b")
		const failure = (index: number, dir: Dir) => ({
			entry: { archive: ARCHIVE.uuid, index },
			path: `x/${String(index)}`,
			destParent: dir.uuid,
			destName: String(index),
			stage: { type: "upload" as const },
			retry: { destination: dir.uuid, destinationDir: dir, base: "x" },
			error: sdkErrorDTO("Server", "boom")
		})

		extractArchive.mockResolvedValueOnce(extractReport({ failures: [failure(1, dirA), failure(2, dirB), failure(3, dirA)] }))
		extractArchiveEntries.mockResolvedValue(extractReport())

		const id = startExtract(extractFields({ formatHint: "tar" }), "pw")

		await vi.waitFor(() => {
			expect(getJobOf("extract", id)?.outcome.status).toBe("doneWithIssues")
		})

		// Retryable failures keep the password for the retry, which takes it on from the job it supersedes.
		expect(jobPassword(id)).toBe("pw")

		const retryId = retryFailedExtract(id) ?? ""

		expect(jobPassword(retryId)).toBe("pw")
		expect(jobPassword(id)).toBeUndefined()
		expect(getJobOf("extract", retryId)).toMatchObject({ retry: true, partial: true, basis: { type: "unknown" }, root: "destination" })

		await vi.waitFor(() => {
			expect(getJobOf("extract", retryId)?.outcome.status).toBe("done")
		})

		expect(extractArchiveEntries.mock.calls.map(call => call[1])).toMatchObject([
			{ entries: [{ index: 1 }, { index: 3 }], destination: { dir: dirA }, base: "x" },
			{ entries: [{ index: 2 }], destination: { dir: dirB }, base: "x" }
		])
		expect(row(id)).toBeUndefined()
		expect(retryFailedExtract(id)).toBeNull()
		expect(jobPassword(retryId)).toBeUndefined()
	})

	it("reruns a failed compress as a new job with the same request and password", async () => {
		compressItems
			.mockResolvedValueOnce(compressReport({ archive: undefined, error: sdkErrorDTO("Server", "boom") }))
			.mockResolvedValueOnce(compressReport())

		const id = startCompress(compressFields({ encrypted: true }), "pw")

		await vi.waitFor(() => {
			expect(getJobOf("compress", id)?.outcome.status).toBe("failed")
		})

		expect(jobPassword(id)).toBe("pw")

		const rerunId = rerunCompress(id) ?? ""

		expect(rerunId).not.toBe(id)
		expect(jobPassword(rerunId)).toBe("pw")
		expect(row(id)).toBeUndefined()

		await vi.waitFor(() => {
			expect(getJobOf("compress", rerunId)?.outcome.status).toBe("done")
		})

		expect(compressItems.mock.calls[1]?.[2]).toBe("pw")
		expect(jobPassword(rerunId)).toBeUndefined()
	})

	it("forgets a password once its job can no longer use it, keeping it while the job waits for the right one", async () => {
		extractArchive
			.mockResolvedValueOnce(extractReport({ counts: itemCounts(), error: sdkErrorDTO("ArchiveWrongPassword", "wrong") }))
			.mockResolvedValueOnce(extractReport())

		const id = startExtract(extractFields(), "nope")

		await vi.waitFor(() => {
			expect(getJobOf("extract", id)?.outcome.status).toBe("wrongPassword")
		})

		expect(jobPassword(id)).toBe("nope")
		expect(rerunExtractWithPassword(id, "right")).toBe(true)

		await vi.waitFor(() => {
			expect(getJobOf("extract", id)?.outcome.status).toBe("done")
		})

		expect(extractArchive.mock.calls[1]?.[2]).toBe("right")
		expect(jobPassword(id)).toBeUndefined()

		compressItems.mockResolvedValueOnce(compressReport())

		const compressId = startCompress(compressFields({ encrypted: true }), "pw")

		await vi.waitFor(() => {
			expect(getJobOf("compress", compressId)?.outcome.status).toBe("done")
		})

		expect(jobPassword(compressId)).toBeUndefined()
	})
})

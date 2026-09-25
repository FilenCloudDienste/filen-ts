import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type {
	AnyItemWithContext,
	CopiedTopLevelItem,
	CopyCounts,
	CopyFailure,
	CopyReport,
	CopyUpdate,
	Dir,
	File,
	UserInfo,
	UuidStr
} from "@filen/sdk-rs"
import type { CopyJobEvent } from "@/workers/sdk.worker"

type SdkCopyItems = (
	id: string,
	items: unknown,
	destinationUuid: string | null,
	maxBytes: number | undefined,
	onEvent: (event: CopyJobEvent) => void
) => Promise<CopyReport>

const { copyItems, copyItemsTo, cancelCopy, releaseCopy, getUserInfo } = vi.hoisted(() => ({
	copyItems: vi.fn<SdkCopyItems>(),
	copyItemsTo: vi.fn<(id: string, entries: unknown, maxBytes: number | undefined, onEvent: unknown) => Promise<CopyReport>>(),
	cancelCopy: vi.fn<(id: string) => void>(),
	releaseCopy: vi.fn<(id: string) => void>(),
	getUserInfo: vi.fn<() => Promise<UserInfo>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { copyItems, copyItemsTo, cancelCopy, releaseCopy, getUserInfo } }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { toastSuccess, toastError, toastCustom, toastDismiss } = vi.hoisted(() => ({
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastCustom: vi.fn(),
	toastDismiss: vi.fn()
}))

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError, custom: toastCustom, dismiss: toastDismiss } }))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type BulkOutcome } from "@/features/drive/lib/bulk"
import {
	pruneSettledCopyJobs,
	requestCopyCancel,
	retryFailedCopy,
	runCopyJob,
	startCopy,
	type RunCopyDeps
} from "@/features/drive/lib/copy"
import { createCopyJob } from "@/features/drive/lib/copy.logic"
import { copyJobStatus, copyJobTitle } from "@/features/transfers/components/copyJobToast.logic"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { getCopyJob, useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { accountQuotaDeps, addAccountStorageUsed } from "@/features/drive/lib/quota"
import { discardListingPatches, driveListingQueryKey, flushListingCreates } from "@/features/drive/queries/drive"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const ROOT = testUuid("root")
const DESTINATION = { uuid: null, name: "My Drive" }
const NO_SERVER = { serverMessage: undefined, serverCode: undefined, innerMessage: undefined }

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
		totals: { dirs: 0n, files: 2n, bytes: 200n },
		counts: counts(),
		active: [],
		events: [],
		bytesPerSecond: undefined,
		etaMs: undefined,
		activeTimeMs: 0n,
		...overrides
	}
}

function report(overrides: Partial<CopyReport> = {}): CopyReport {
	return {
		topLevel: [],
		failures: [],
		skipped: [],
		renamed: [],
		totals: { dirs: 0n, files: 2n, bytes: 200n },
		counts: counts({ filesDone: 2n, bytesDone: 200n }),
		error: undefined,
		...overrides
	}
}

const QUOTA_REPORT = report({
	totals: { dirs: 0n, files: 0n, bytes: 0n },
	counts: counts(),
	error: { kind: "MaxStorageReached", message: "the copy needs 900 bytes but only 100 are free", ...NO_SERVER }
})

function mockFile(label: string, parent: UuidStr = ROOT): File {
	return {
		uuid: testUuid(label),
		stableUUID: undefined,
		parent,
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

function created(dir: Dir): CopiedTopLevelItem {
	return { request: 0n, sourceUuid: testUuid("source"), item: { type: "dir", ...dir } }
}

function createdFile(file: File): CopiedTopLevelItem {
	return { request: 0n, sourceUuid: testUuid("source"), item: { type: "file", ...file } }
}

const CANCELLED = { kind: "Cancelled", message: "Error of kind Cancelled: error: copy cancelled", ...NO_SERVER } as const

function copyFailure(label: string, stage: CopyFailure["info"]["stage"] = { type: "upload" }): CopyFailure {
	return {
		item: mockFile(label),
		info: {
			sourceUuid: testUuid(label),
			sourcePath: `${label}.txt`,
			destParent: ROOT,
			destParentDir: { uuid: ROOT },
			destName: `${label}.txt`,
			stage,
			error: {
				kind: "Server",
				message: "Error of kind Server: error: API Error",
				serverMessage: "Upload rejected",
				serverCode: undefined,
				innerMessage: "error: API Error"
			},
			affectedFiles: 1n,
			affectedBytes: 100n
		}
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => undefined
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

function makeDeps() {
	return {
		copyItems: vi.fn<RunCopyDeps["copyItems"]>(),
		copyItemsTo: vi.fn<RunCopyDeps["copyItemsTo"]>(),
		release: vi.fn<RunCopyDeps["release"]>(),
		transfers: useTransfersStore.getState(),
		jobs: { ...useCopyJobsStore.getState(), get: getCopyJob },
		account: {
			cached: vi.fn<RunCopyDeps["account"]["cached"]>(() => undefined),
			fetchFresh: vi.fn<RunCopyDeps["account"]["fetchFresh"]>()
		},
		patchCreated: vi.fn<RunCopyDeps["patchCreated"]>(),
		trash: vi.fn<RunCopyDeps["trash"]>(() => Promise.resolve({ succeeded: [], failed: [] })),
		settled: vi.fn<RunCopyDeps["settled"]>()
	}
}

const SOURCE_ITEMS: DriveItem[] = [narrowItem(mockFile("a")), narrowItem(mockDir("b"))]

function request(id = "job") {
	return {
		id,
		source: { kind: "items" as const, items: SOURCE_ITEMS, destinationUuid: null },
		destination: DESTINATION,
		itemCount: 2,
		name: "2 items",
		glyph: "items" as const
	}
}

function row(id = "job") {
	return useTransfersStore.getState().transfers.find(transfer => transfer.id === id)
}

beforeEach(() => {
	useTransfersStore.setState({ transfers: [], speedSamples: [] })
	useCopyJobsStore.setState({ jobs: {} })
	queryClient.clear()
	discardListingPatches()
})

describe("runCopyJob", () => {
	it("adds one copying row and one job, and passes the narrowed items and destination to the SDK", async () => {
		const deps = makeDeps()
		let seenRow: ReturnType<typeof row>

		deps.copyItems.mockImplementation(() => {
			seenRow = row()

			return Promise.resolve(report())
		})

		await runCopyJob(deps, request())

		expect(seenRow).toMatchObject({ direction: "copy", status: "copying", name: "2 items", parentUuid: null, size: 0 })
		expect(deps.copyItems).toHaveBeenCalledTimes(1)
		expect(deps.copyItems.mock.calls[0]?.[0]).toBe("job")
		expect(deps.copyItems.mock.calls[0]?.[1]).toEqual([SOURCE_ITEMS[0]?.data, SOURCE_ITEMS[1]?.data])
		expect(deps.copyItems.mock.calls[0]?.[2]).toBeNull()
	})

	// A public link's file or directory has no DriveItem shape: it goes to the SDK exactly as it came.
	it("passes a linked source's SDK items through untouched", async () => {
		const deps = makeDeps()
		const linked = { dir: { inner: { uuid: "root" }, linkedTag: true }, link: { linkUuid: "link" } } as unknown as AnyItemWithContext

		deps.copyItems.mockResolvedValue(report())

		await runCopyJob(deps, {
			...request(),
			source: { kind: "linked", items: [linked], destinationUuid: "dest" },
			itemCount: 1,
			name: "Shared",
			glyph: "directory"
		})

		expect(deps.copyItems.mock.calls[0]?.[1]).toEqual([linked])
		expect(deps.copyItems.mock.calls[0]?.[2]).toBe("dest")
		expect(row()).toMatchObject({ name: "Shared", status: "done" })
	})

	it("feeds updates into the job and the row, and patches each created top-level item", async () => {
		const deps = makeDeps()
		const dir = mockDir("copied")
		let midRun: { bytesDone: number | undefined; created: number | undefined; row: ReturnType<typeof row> } | undefined

		deps.copyItems.mockImplementation((_id, _items, _dest, _max, onEvent) => {
			onEvent({ type: "update", update: update({ counts: counts({ bytesDone: 50n }) }) })
			onEvent({ type: "created", item: created(dir) })

			midRun = { bytesDone: getCopyJob("job")?.counts.bytesDone, created: getCopyJob("job")?.created.length, row: row() }

			return Promise.resolve(report())
		})

		const job = await runCopyJob(deps, request())

		// A created item stays off the job until the settle, the only reader.
		expect(midRun).toMatchObject({ bytesDone: 50, created: 0, row: { size: 200, bytesTransferred: 50 } })

		expect(deps.patchCreated).toHaveBeenCalledTimes(1)
		expect(deps.patchCreated.mock.calls[0]?.[0].data.uuid).toBe(dir.uuid)
		// Only "move copied items to trash" reads what a job made, so a settled one lets go of it.
		expect(job?.created).toEqual([])
	})

	// The SDK's bytesDone already includes in-flight chunks; adding the active files again doubled it.
	it("counts in-flight bytes once in the row's progress", async () => {
		const deps = makeDeps()

		deps.copyItems.mockImplementation((_id, _items, _dest, _max, onEvent) => {
			onEvent({
				type: "update",
				update: update({
					counts: counts({ bytesDone: 50n }),
					active: [
						{ sourceUuid: testUuid("s"), destUuid: testUuid("d"), destParent: ROOT, name: "b.txt", size: 100n, bytesDone: 30n }
					]
				})
			})

			expect(row()).toMatchObject({ size: 200, bytesTransferred: 50 })

			return Promise.resolve(report())
		})

		await runCopyJob(deps, request())

		expect(row()).toMatchObject({ status: "done", bytesTransferred: 200 })
	})

	// Bytes finish before the files are registered: a running copy's row stops short of 100%.
	it("keeps a running copy's row below 100% until it settles", async () => {
		const deps = makeDeps()

		deps.copyItems.mockImplementation((_id, _items, _dest, _max, onEvent) => {
			onEvent({ type: "update", update: update({ counts: counts({ bytesDone: 200n }) }) })

			expect(row()).toMatchObject({ size: 200, bytesTransferred: 198 })

			return Promise.resolve(report())
		})

		await runCopyJob(deps, request())

		expect(row()).toMatchObject({ status: "done", bytesTransferred: 200 })
	})

	it("settles a clean copy as done and hands the settled job to the announcer", async () => {
		const deps = makeDeps()

		deps.copyItems.mockResolvedValue(report())

		const job = await runCopyJob(deps, request())

		expect(job?.outcome).toEqual({ status: "done" })
		expect(row()).toMatchObject({ status: "done", size: 200, bytesTransferred: 200 })
		expect(deps.settled).toHaveBeenCalledWith(job)
		expect(deps.trash).not.toHaveBeenCalled()
	})

	it("settles a copy with failures as completedWithErrors", async () => {
		const deps = makeDeps()
		const failure: CopyFailure = {
			item: mockFile("failed"),
			info: {
				sourceUuid: testUuid("failed"),
				sourcePath: "failed.txt",
				destParent: ROOT,
				destParentDir: { uuid: ROOT },
				destName: "failed.txt",
				stage: { type: "upload" },
				error: { kind: "Server", message: "x", ...NO_SERVER },
				affectedFiles: 1n,
				affectedBytes: 100n
			}
		}

		deps.copyItems.mockResolvedValue(report({ failures: [failure] }))

		const job = await runCopyJob(deps, request())

		expect(job?.outcome).toEqual({ status: "doneWithFailures" })
		expect(row()?.status).toBe("completedWithErrors")
	})

	it("drops the row of a cancelled copy but keeps its job", async () => {
		const deps = makeDeps()

		deps.copyItems.mockResolvedValue(report({ error: { kind: "Cancelled", message: "copy cancelled", ...NO_SERVER } }))

		const job = await runCopyJob(deps, request())

		expect(job?.outcome).toEqual({ status: "cancelled" })
		expect(row()).toBeUndefined()
		expect(getCopyJob("job")).toBeDefined()
	})

	it("settles a rejection as a failed job with an error row, never throwing", async () => {
		const deps = makeDeps()

		deps.copyItems.mockRejectedValue({ species: "plain", message: "no authenticated client", label: "no authenticated client" })

		const job = await runCopyJob(deps, request())

		expect(job?.outcome).toMatchObject({ status: "failed" })
		expect(row()).toMatchObject({ status: "error", error: { label: "no authenticated client" } })
	})

	it("fails the job, not the caller, when a selection cannot be narrowed", async () => {
		const deps = makeDeps()
		const nested = narrowItem(mockDir("nested"))
		const orphan = { ...nested, type: "sharedDirectory" } as DriveItem

		const job = await runCopyJob(deps, { ...request(), source: { kind: "items", items: [orphan], destinationUuid: null } })

		expect(job?.outcome).toMatchObject({ status: "failed" })
		expect(deps.copyItems).not.toHaveBeenCalled()
	})

	it("retries through copyItemsTo for an entries source", async () => {
		const deps = makeDeps()
		const entries = [{ item: mockFile("x"), destination: { uuid: ROOT }, name: "x.txt" }]

		deps.copyItemsTo.mockResolvedValue(report())

		await runCopyJob(deps, { ...request(), source: { kind: "entries", entries } })

		expect(deps.copyItemsTo.mock.calls[0]?.[1]).toBe(entries)
		expect(deps.copyItems).not.toHaveBeenCalled()
	})
})

describe("runCopyJob quota", () => {
	it("passes the cached free storage as maxBytes, and nothing when no account is cached", async () => {
		const withAccount = makeDeps()

		withAccount.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 250n })
		withAccount.copyItems.mockResolvedValue(report())

		await runCopyJob(withAccount, request("a"))

		expect(withAccount.copyItems.mock.calls[0]?.[3]).toBe(750)

		const withoutAccount = makeDeps()

		withoutAccount.copyItems.mockResolvedValue(report())

		await runCopyJob(withoutAccount, request("b"))

		expect(withoutAccount.copyItems.mock.calls[0]?.[3]).toBeUndefined()
		expect(withoutAccount.account.fetchFresh).not.toHaveBeenCalled()
	})

	it("reads the account once fresh after a refusal and runs again when that frees more", async () => {
		const deps = makeDeps()

		deps.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 900n })
		deps.account.fetchFresh.mockResolvedValue({ maxStorage: 1_000n, storageUsed: 0n })
		deps.copyItems.mockResolvedValueOnce(QUOTA_REPORT).mockResolvedValueOnce(report())

		const job = await runCopyJob(deps, request())

		expect(deps.account.fetchFresh).toHaveBeenCalledTimes(1)
		expect(deps.copyItems.mock.calls.map(call => call[3])).toEqual([100, 1_000])
		expect(job?.outcome).toEqual({ status: "done" })
	})

	it("reports the fresh free storage when the fresh read frees nothing more, without running again", async () => {
		const deps = makeDeps()

		deps.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 900n })
		deps.account.fetchFresh.mockResolvedValue({ maxStorage: 1_000n, storageUsed: 950n })
		deps.copyItems.mockResolvedValue(QUOTA_REPORT)

		const job = await runCopyJob(deps, request())

		expect(deps.copyItems).toHaveBeenCalledTimes(1)
		expect(job?.outcome).toEqual({ status: "quotaExceeded", freeBytes: 50 })
		expect(row()?.status).toBe("error")
		expect(row()?.error?.label).toContain("50 B")
	})

	it("keeps the cached figure when the fresh read fails", async () => {
		const deps = makeDeps()

		deps.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 900n })
		deps.account.fetchFresh.mockRejectedValue(new Error("offline"))
		deps.copyItems.mockResolvedValue(QUOTA_REPORT)

		const job = await runCopyJob(deps, request())

		expect(job?.outcome).toEqual({ status: "quotaExceeded", freeBytes: 100 })
	})

	// Nothing was written and the user asked to stop: a storage error would quote a figure for a copy
	// the user no longer wants.
	it("settles a copy stopped during the fresh read as cancelled, without running again", async () => {
		for (const cancelRequest of ["keep", "trash"] as const) {
			useCopyJobsStore.setState({ jobs: {} })

			const deps = makeDeps()

			deps.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 900n })
			deps.account.fetchFresh.mockImplementation(() => {
				useCopyJobsStore.getState().update("job", job => ({ ...job, cancelRequest }))

				return Promise.resolve({ maxStorage: 1_000n, storageUsed: 0n })
			})
			deps.copyItems.mockResolvedValue(QUOTA_REPORT)

			const job = await runCopyJob(deps, request())

			expect(deps.copyItems).toHaveBeenCalledTimes(1)
			expect(job?.outcome).toEqual({ status: "cancelled" })
			expect(row()).toBeUndefined()
			expect(deps.trash).not.toHaveBeenCalled()
		}
	})

	it("settles a stop that reached the job while its refusal was on the way as cancelled, reading nothing", async () => {
		const deps = makeDeps()

		deps.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 900n })
		deps.copyItems.mockImplementation(id => {
			requestCopyCancel(id, { trashCopied: false })

			return Promise.resolve(QUOTA_REPORT)
		})

		const job = await runCopyJob(deps, request())

		expect(deps.account.fetchFresh).not.toHaveBeenCalled()
		expect(job?.outcome).toEqual({ status: "cancelled" })
		expect(row()).toBeUndefined()
	})

	it("still quotes the figure the SDK refused against when nothing stopped the copy", async () => {
		const deps = makeDeps()

		deps.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 900n })
		deps.account.fetchFresh.mockResolvedValue({ maxStorage: 1_000n, storageUsed: 900n })
		deps.copyItems.mockResolvedValue(QUOTA_REPORT)

		const job = await runCopyJob(deps, request())

		expect(job?.outcome).toEqual({ status: "quotaExceeded", freeBytes: 100 })
	})

	// Any account write cancels the account query's own read, which then resolves with the cached
	// figure; the fresh read must not be that read.
	it("runs again on the server's figure even when an account write lands during the fresh read", async () => {
		const deps = { ...makeDeps(), account: accountQuotaDeps }
		const fresh = deferred<UserInfo>()

		queryClient.setQueryData<Partial<UserInfo>>(ACCOUNT_QUERY_KEY, { maxStorage: 1_000n, storageUsed: 900n })
		getUserInfo.mockReturnValueOnce(fresh.promise)
		deps.copyItems.mockResolvedValueOnce(QUOTA_REPORT).mockResolvedValueOnce(report())

		const running = runCopyJob(deps, request())

		await vi.waitFor(() => {
			expect(getUserInfo).toHaveBeenCalledOnce()
		})

		addAccountStorageUsed(50n)
		fresh.resolve({ maxStorage: 1_000n, storageUsed: 0n } as UserInfo)

		const job = await running

		expect(deps.copyItems.mock.calls.map(call => call[3])).toEqual([100, 1_000])
		expect(job?.outcome).toEqual({ status: "done" })
	})

	// The worker keeps the job's stop and pause across its calls, so a pause made during the fresh read
	// holds for the retry; they go once no call runs again.
	it("releases the worker's stop and pause once, after the job's last call", async () => {
		const deps = makeDeps()

		deps.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 900n })
		deps.account.fetchFresh.mockResolvedValue({ maxStorage: 1_000n, storageUsed: 0n })
		deps.copyItems.mockResolvedValueOnce(QUOTA_REPORT).mockImplementationOnce(() => {
			expect(deps.release).not.toHaveBeenCalled()

			return Promise.resolve(report())
		})

		await runCopyJob(deps, request())

		expect(deps.copyItems).toHaveBeenCalledTimes(2)
		expect(deps.release).toHaveBeenCalledExactlyOnceWith("job")
	})
})

describe("cancel", () => {
	it("trashes exactly the created top-level items when asked to, and nothing when kept", async () => {
		const dir = mockDir("copied")

		for (const trashCopied of [true, false]) {
			useCopyJobsStore.setState({ jobs: {} })

			const deps = makeDeps()

			deps.copyItems.mockImplementation((id, _items, _dest, _max, onEvent) => {
				onEvent({ type: "created", item: created(dir) })
				requestCopyCancel(id, { trashCopied })

				return Promise.resolve(report({ error: { kind: "Cancelled", message: "copy cancelled", ...NO_SERVER } }))
			})

			const job = await runCopyJob(deps, request())

			expect(cancelCopy).toHaveBeenCalledWith("job")

			if (trashCopied) {
				expect(deps.trash).toHaveBeenCalledTimes(1)
				expect(deps.trash.mock.calls[0]?.[0].map(item => item.data.uuid)).toEqual([dir.uuid])
			} else {
				expect(deps.trash).not.toHaveBeenCalled()
			}

			expect(job?.created).toEqual([])
		}
	})

	// A store write per created item copied the whole list each time.
	it("writes nothing to the job store per created item, and still trashes every one on a stop", async () => {
		const deps = makeDeps()
		const dirs = Array.from({ length: 50 }, (_, index) => mockDir(`copied${String(index)}`))
		let writes = 0

		deps.copyItems.mockImplementation((id, _items, _dest, _max, onEvent) => {
			const unsubscribe = useCopyJobsStore.subscribe(() => {
				writes++
			})

			for (const dir of dirs) {
				onEvent({ type: "created", item: created(dir) })
			}

			unsubscribe()
			requestCopyCancel(id, { trashCopied: true })

			return Promise.resolve(report({ error: { kind: "Cancelled", message: "copy cancelled", ...NO_SERVER } }))
		})

		await runCopyJob(deps, request())

		expect(writes).toBe(0)
		expect(deps.patchCreated).toHaveBeenCalledTimes(dirs.length)
		expect(deps.trash.mock.calls[0]?.[0].map(item => item.data.uuid)).toEqual(dirs.map(dir => dir.uuid))
	})

	it("records how many copied items went to the trash", async () => {
		const deps = makeDeps()
		const dir = mockDir("copied")

		deps.trash.mockResolvedValue({ succeeded: [narrowItem(dir)], failed: [] })
		deps.copyItems.mockImplementation((id, _items, _dest, _max, onEvent) => {
			onEvent({ type: "created", item: created(dir) })
			requestCopyCancel(id, { trashCopied: true })

			return Promise.resolve(report({ error: { kind: "Cancelled", message: "copy cancelled", ...NO_SERVER } }))
		})

		const job = await runCopyJob(deps, request())

		expect(job?.trashResult).toEqual({ moved: 1, failed: 0 })
		expect(deps.settled.mock.calls[0]?.[0].trashResult).toEqual({ moved: 1, failed: 0 })
	})

	it("does not trash anything when the cancelled copy had created nothing", async () => {
		const deps = makeDeps()

		deps.copyItems.mockImplementation(id => {
			requestCopyCancel(id, { trashCopied: true })

			return Promise.resolve(report({ error: { kind: "Cancelled", message: "copy cancelled", ...NO_SERVER } }))
		})

		await runCopyJob(deps, request())

		expect(deps.trash).not.toHaveBeenCalled()
	})

	it("ignores a cancel for an unknown or finished job", async () => {
		requestCopyCancel("unknown", { trashCopied: true })

		const deps = makeDeps()

		deps.copyItems.mockResolvedValue(report())

		await runCopyJob(deps, request())
		requestCopyCancel("job", { trashCopied: true })

		expect(cancelCopy).not.toHaveBeenCalled()
		expect(getCopyJob("job")?.cancelRequest).toBeNull()
	})

	// Cancel all and sign-out ask to keep; they must not undo a "move to trash" still winding down.
	it("keeps the first stop's choice when a later one asks to keep", async () => {
		const deps = makeDeps()
		const dir = mockDir("copied")

		deps.copyItems.mockImplementation((id, _items, _dest, _max, onEvent) => {
			onEvent({ type: "created", item: created(dir) })
			requestCopyCancel(id, { trashCopied: true })
			requestCopyCancel(id, { trashCopied: false })

			return Promise.resolve(report({ error: CANCELLED }))
		})

		const job = await runCopyJob(deps, request())

		expect(cancelCopy).toHaveBeenCalledTimes(1)
		expect(job?.cancelRequest).toBe("trash")
		expect(deps.trash.mock.calls[0]?.[0].map(item => item.data.uuid)).toEqual([dir.uuid])
	})

	it("keeps a stopped copy's row active until its copies are in the trash, then removes it", async () => {
		const deps = makeDeps()
		const dir = mockDir("copied")
		const trash = deferred<{ succeeded: DriveItem[]; failed: [] }>()

		deps.trash.mockReturnValue(trash.promise)
		deps.copyItems.mockImplementation((id, _items, _dest, _max, onEvent) => {
			onEvent({ type: "created", item: created(dir) })
			requestCopyCancel(id, { trashCopied: true })

			return Promise.resolve(report({ error: CANCELLED }))
		})

		const running = runCopyJob(deps, request())

		await vi.waitFor(() => {
			expect(deps.trash).toHaveBeenCalledTimes(1)
		})

		expect(row()?.status).toBe("copying")
		expect(getCopyJob("job")?.outcome).toEqual({ status: "cancelled" })

		trash.resolve({ succeeded: [narrowItem(dir)], failed: [] })

		const job = await running

		expect(job?.trashResult).toEqual({ moved: 1, failed: 0 })
		expect(row()).toBeUndefined()
	})

	// The stop reached the job only after the SDK had finished it.
	it("still trashes what a copy made when it finished before its stop, and the card says what the trash did", async () => {
		const deps = makeDeps()
		const moved = mockDir("moved")
		const stuck = mockDir("stuck")

		deps.trash.mockResolvedValue({ succeeded: [narrowItem(moved)], failed: [{ item: narrowItem(stuck), error: new Error("offline") }] })
		deps.copyItems.mockImplementation((id, _items, _dest, _max, onEvent) => {
			onEvent({ type: "created", item: created(moved) })
			onEvent({ type: "created", item: created(stuck) })
			requestCopyCancel(id, { trashCopied: true })

			return Promise.resolve(report({ topLevel: [created(moved), created(stuck)] }))
		})

		const job = await runCopyJob(deps, request())

		if (job === undefined) {
			throw new Error("the job was dropped")
		}

		expect(job.outcome).toEqual({ status: "done" })
		expect(deps.trash.mock.calls[0]?.[0].map(item => item.data.uuid)).toEqual([moved.uuid, stuck.uuid])
		expect(row()).toMatchObject({ status: "error", error: { label: "1 copied item couldn't be moved to the trash" } })
		expect(copyJobTitle(job)).toEqual({ key: "transfersCopyCardTitleEnded", destination: DESTINATION.name })
		expect(copyJobStatus(job)).toEqual({ kind: "key", key: "transfersCopyTrashFailed" })
	})

	it("drops a finished copy's row once its stop moved all its copies to the trash, as a stopped copy's", async () => {
		for (const failures of [[], [copyFailure("failed")]]) {
			useTransfersStore.setState({ transfers: [], speedSamples: [] })
			useCopyJobsStore.setState({ jobs: {} })

			const deps = makeDeps()
			const dir = mockDir("copied")

			deps.trash.mockImplementation(items => Promise.resolve({ succeeded: items, failed: [] }))
			deps.copyItems.mockImplementation((id, _items, _dest, _max, onEvent) => {
				onEvent({ type: "created", item: created(dir) })
				requestCopyCancel(id, { trashCopied: true })

				return Promise.resolve(report({ topLevel: [created(dir)], failures }))
			})

			const job = await runCopyJob(deps, request())

			if (job === undefined) {
				throw new Error("the job was dropped")
			}

			expect(job.outcome.status).toBe(failures.length === 0 ? "done" : "doneWithFailures")
			expect(job.trashResult).toEqual({ moved: 1, failed: 0 })
			expect(row()).toBeUndefined()
			// The card, while it shows, says where the copies went.
			expect(copyJobStatus(job)).toEqual({ kind: "key", key: "transfersCopyTrashed", count: 1 })
		}
	})

	// A file saved as a new version is stored, not created, so the stop undid nothing.
	it("keeps a finished copy's row when its stop had nothing it could move to the trash", async () => {
		const deps = makeDeps()
		const versioned = mockFile("versioned")

		deps.copyItems.mockImplementation(id => {
			requestCopyCancel(id, { trashCopied: true })

			return Promise.resolve(
				report({
					topLevel: [createdFile(versioned)],
					failures: [copyFailure("existing", { type: "registeredAsVersion", existingFile: versioned.uuid })]
				})
			)
		})

		const job = await runCopyJob(deps, request())

		expect(job?.outcome).toEqual({ status: "done" })
		expect(deps.trash).not.toHaveBeenCalled()
		expect(row()?.status).toBe("done")
	})

	it("keeps a stopped copy's row, as an error, while copies it asked to trash are still there", async () => {
		const deps = makeDeps()
		const moved = mockDir("moved")
		const stuck = mockDir("stuck")

		deps.trash.mockResolvedValue({ succeeded: [narrowItem(moved)], failed: [{ item: narrowItem(stuck), error: new Error("offline") }] })
		deps.copyItems.mockImplementation((id, _items, _dest, _max, onEvent) => {
			onEvent({ type: "created", item: created(moved) })
			onEvent({ type: "created", item: created(stuck) })
			requestCopyCancel(id, { trashCopied: true })

			return Promise.resolve(report({ error: CANCELLED }))
		})

		const job = await runCopyJob(deps, request())

		expect(job?.trashResult).toEqual({ moved: 1, failed: 1 })
		expect(job?.cardVisible).toBe(false)
		expect(row()).toMatchObject({ status: "error", error: { label: "1 copied item couldn't be moved to the trash" } })

		pruneSettledCopyJobs()

		expect(getCopyJob("job")).toBeDefined()

		// Removing the row still takes the job with it.
		useTransfersStore.getState().remove("job")
		pruneSettledCopyJobs()

		expect(getCopyJob("job")).toBeUndefined()
	})

	// The trash can't be paused, so a pause made before the stop no longer shows on the row.
	it("clears a paused row's pause once the job ends, while its copies move to the trash", async () => {
		const deps = makeDeps()
		const dir = mockDir("copied")
		const trash = deferred<BulkOutcome<DriveItem>>()

		deps.trash.mockReturnValue(trash.promise)
		deps.copyItems.mockImplementation((id, _items, _dest, _max, onEvent) => {
			onEvent({ type: "created", item: created(dir) })
			useTransfersStore.getState().setPaused(id, true)
			requestCopyCancel(id, { trashCopied: true })

			return Promise.resolve(report({ error: CANCELLED }))
		})

		const running = runCopyJob(deps, request())

		await vi.waitFor(() => {
			expect(deps.trash).toHaveBeenCalledTimes(1)
		})

		expect(row()).toMatchObject({ status: "copying", paused: false })

		trash.resolve({ succeeded: [narrowItem(dir)], failed: [] })

		await running
	})
})

// Events and the result reach the main thread on different ports; the worker holds the result back
// until the last event is taken, and the job copes with one that still arrives after it.
describe("events after the result", () => {
	it("trashes a copy the report lists even if its event never came, but never a file saved as a new version", async () => {
		const deps = makeDeps()
		const delivered = mockDir("delivered")
		const listedOnly = mockFile("listed")
		const versioned = mockFile("versioned")

		deps.copyItems.mockImplementation((id, _items, _dest, _max, onEvent) => {
			onEvent({ type: "created", item: created(delivered) })
			requestCopyCancel(id, { trashCopied: true })

			return Promise.resolve(
				report({
					topLevel: [created(delivered), createdFile(listedOnly), createdFile(versioned)],
					failures: [copyFailure("existing", { type: "registeredAsVersion", existingFile: versioned.uuid })],
					error: CANCELLED
				})
			)
		})

		await runCopyJob(deps, request())

		expect(deps.trash).toHaveBeenCalledTimes(1)
		expect(deps.trash.mock.calls[0]?.[0].map(item => item.data.uuid).sort()).toEqual([delivered.uuid, listedOnly.uuid].sort())
	})

	it("takes the last update and a created item that arrive after the report without counting either twice", async () => {
		const deps = makeDeps()
		const early = mockDir("early")
		const late = mockDir("late")
		const failed = copyFailure("failed")
		const renamed = { sourceUuid: testUuid("renamed"), sourcePath: "x", name: "x (1)", reason: "duplicateName" } as const
		let deliverLate = (): void => undefined

		deps.trash.mockImplementation(items => Promise.resolve({ succeeded: items, failed: [] }))
		deps.copyItems.mockImplementation((id, _items, _dest, _max, onEvent) => {
			onEvent({ type: "created", item: created(early) })
			requestCopyCancel(id, { trashCopied: true })

			deliverLate = () => {
				onEvent({
					type: "update",
					update: update({
						phase: "cancelled",
						events: [
							{ type: "fileFailed", ...failed.info },
							{ type: "renamed", ...renamed },
							{ type: "propagationFailed", destUuid: testUuid("d"), error: failed.info.error }
						]
					})
				})
				onEvent({ type: "created", item: created(late) })
			}

			return Promise.resolve(
				report({ topLevel: [created(early), created(late)], failures: [failed], renamed: [renamed], error: CANCELLED })
			)
		})

		await runCopyJob(deps, request())
		deliverLate()

		const job = getCopyJob("job")

		expect(job?.failures.map(failure => failure.destName)).toEqual(["failed.txt"])
		expect(job?.renamedCount).toBe(1)
		expect(job?.propagationFailedCount).toBe(1)
		// Both went to the trash with the report's items, once.
		expect(deps.trash).toHaveBeenCalledTimes(1)
		expect(deps.trash.mock.calls[0]?.[0].map(item => item.data.uuid).sort()).toEqual([early.uuid, late.uuid].sort())
		expect(job?.trashResult).toEqual({ moved: 2, failed: 0 })
	})

	it("leaves the row to the stop's batch while it moves, whatever a late item's trash did first", async () => {
		const deps = makeDeps()
		const early = mockDir("early")
		const late = mockDir("late")
		const failed = copyFailure("failed")
		const batch = deferred<BulkOutcome<DriveItem>>()
		let deliverLate = (): void => undefined

		deps.trash
			.mockReturnValueOnce(batch.promise)
			.mockResolvedValueOnce({ succeeded: [], failed: [{ item: narrowItem(late), error: new Error("offline") }] })
		deps.copyItems.mockImplementation((id, _items, _dest, _max, onEvent) => {
			onEvent({ type: "created", item: created(early) })
			requestCopyCancel(id, { trashCopied: true })

			deliverLate = () => {
				onEvent({ type: "created", item: created(late) })
			}

			return Promise.resolve(report({ topLevel: [created(early)], failures: [failed], error: CANCELLED }))
		})

		const running = runCopyJob(deps, request())

		await vi.waitFor(() => {
			expect(deps.trash).toHaveBeenCalledTimes(1)
		})

		deliverLate()

		await vi.waitFor(() => {
			expect(getCopyJob("job")?.trashResult).toEqual({ moved: 0, failed: 1 })
		})

		const trashing = getCopyJob("job")

		if (trashing === undefined) {
			throw new Error("the job was dropped")
		}

		expect(row()?.status).toBe("copying")
		expect(copyJobStatus(trashing)).toEqual({ kind: "key", key: "transfersCopyMovingToTrash" })
		expect(retryFailedCopy("job")).toBeNull()

		batch.resolve({ succeeded: [narrowItem(early)], failed: [] })
		await running

		expect(getCopyJob("job")?.trashResult).toEqual({ moved: 1, failed: 1 })
		expect(row()).toMatchObject({ status: "error", error: { label: "1 copied item couldn't be moved to the trash" } })
	})

	// A call that rejected past its cancel grace has no report, and can still deliver what it queued.
	it("trashes an item delivered after a stop that ended without a report, and brings the row back if that fails", async () => {
		const deps = makeDeps()
		const late = mockDir("late")
		let deliverLate = (): void => undefined

		deps.trash.mockResolvedValue({ succeeded: [], failed: [{ item: narrowItem(late), error: new Error("offline") }] })
		deps.copyItems.mockImplementation((id, _items, _dest, _max, onEvent) => {
			requestCopyCancel(id, { trashCopied: true })

			deliverLate = () => {
				onEvent({ type: "created", item: created(late) })
			}

			// The worker rejects with its error's DTO.
			return Promise.reject(
				Object.assign(new Error("Error of kind Cancelled: error: grace exceeded"), { species: "sdk", kind: "Cancelled", label: "" })
			)
		})

		const job = await runCopyJob(deps, request())

		expect(job?.outcome).toEqual({ status: "cancelled" })
		expect(row()).toBeUndefined()

		useCopyJobsStore.getState().remove("job")
		deliverLate()

		await vi.waitFor(() => {
			expect(getCopyJob("job")?.trashResult).toEqual({ moved: 0, failed: 1 })
		})

		expect(deps.patchCreated.mock.calls.map(([item]) => item.data.uuid)).toEqual([late.uuid])
		expect(deps.trash.mock.calls[0]?.[0].map(item => item.data.uuid)).toEqual([late.uuid])
		expect(getCopyJob("job")?.cardVisible).toBe(false)
		expect(row()).toMatchObject({ status: "error", error: { label: "1 copied item couldn't be moved to the trash" } })
	})
})

describe("startCopy and retryFailedCopy", () => {
	beforeEach(() => {
		queryClient.setQueryData<Partial<UserInfo>>(ACCOUNT_QUERY_KEY, { rootDirUuid: ROOT, maxStorage: 10_000n, storageUsed: 0n })
	})

	it("returns null for an empty selection without touching the SDK", () => {
		expect(startCopy([], DESTINATION)).toBeNull()
		expect(copyItems).not.toHaveBeenCalled()
	})

	it("patches only an already-read destination listing, and only from the cache and the SDK copy call", async () => {
		const dir = mockDir("copied")
		const rootKey = driveListingQueryKey({ variant: "drive", uuid: null })
		const unreadKey = driveListingQueryKey({ variant: "drive", uuid: testUuid("unread") })
		const settled = new Promise<void>(resolve => {
			copyItems.mockImplementation(
				(_id: string, _items: unknown, _dest: unknown, _max: unknown, onEvent: (event: CopyJobEvent) => void) => {
					onEvent({ type: "created", item: created(dir) })
					onEvent({ type: "created", item: created(mockDir("nested", testUuid("unread"))) })
					resolve()

					return Promise.resolve(report())
				}
			)
		})

		queryClient.setQueryData<DriveItem[]>(rootKey, [])

		const id = startCopy([narrowItem(mockFile("a"))], DESTINATION)

		await settled
		await vi.waitFor(() => {
			expect(getCopyJob(id ?? "")?.outcome.status).toBe("done")
		})

		// Created items land in their listing once the batch window closes.
		flushListingCreates()

		expect(queryClient.getQueryData<DriveItem[]>(rootKey)?.map(item => item.data.uuid)).toEqual([dir.uuid])
		expect(queryClient.getQueryData(unreadKey)).toBeUndefined()
		expect(copyItems.mock.calls[0]?.[3]).toBe(10_000)
	})

	// The card, or the transfers row, is how a copy's end shows.
	it("announces no ending with a toast, whether the copy finished or failed", async () => {
		copyItems
			.mockResolvedValueOnce(report())
			.mockResolvedValueOnce(report({ error: { kind: "Server", message: "boom", ...NO_SERVER } }))

		for (const expected of ["done", "failed"]) {
			const id = startCopy([narrowItem(mockFile("a"))], DESTINATION) ?? ""

			await vi.waitFor(() => {
				expect(getCopyJob(id)?.outcome.status).toBe(expected)
			})
		}

		expect(toastSuccess).not.toHaveBeenCalled()
		expect(toastError).not.toHaveBeenCalled()
	})

	it("retries a job's failures as a new job into their own directories", async () => {
		const failure: CopyFailure = {
			item: mockFile("failed"),
			info: {
				sourceUuid: testUuid("failed"),
				sourcePath: "failed.txt",
				destParent: ROOT,
				destParentDir: { uuid: ROOT },
				destName: "failed.txt",
				stage: { type: "upload" },
				error: { kind: "Server", message: "x", ...NO_SERVER },
				affectedFiles: 1n,
				affectedBytes: 100n
			}
		}
		const deps = makeDeps()

		deps.copyItems.mockResolvedValue(report({ failures: [failure] }))
		await runCopyJob(deps, request())
		copyItemsTo.mockResolvedValue(report())

		const retryId = retryFailedCopy("job")

		expect(retryId).not.toBeNull()
		expect(copyItemsTo.mock.calls[0]?.[1]).toEqual([{ item: failure.item, destination: { uuid: ROOT }, name: "failed.txt" }])
		expect(row(retryId ?? "")).toMatchObject({ direction: "copy", name: "failed.txt" })
		expect(retryFailedCopy("unknown")).toBeNull()
	})

	// A second retry of the same job would copy the same items again, as "name (1)" duplicates.
	it("lets a retried job offer no retry again, and drops it with its row once its card is hidden", async () => {
		const deps = makeDeps()

		deps.copyItems.mockResolvedValue(report({ failures: [copyFailure("failed")] }))
		await runCopyJob(deps, request())
		useCopyJobsStore.getState().update("job", job => ({ ...job, cardVisible: true }))
		copyItemsTo.mockReturnValue(new Promise(() => undefined))

		expect(retryFailedCopy("job")).not.toBeNull()
		expect(getCopyJob("job")?.retryable).toEqual([])
		expect(row()).toBeUndefined()
		expect(retryFailedCopy("job")).toBeNull()
		expect(copyItemsTo).toHaveBeenCalledTimes(1)

		useCopyJobsStore.getState().update("job", job => ({ ...job, cardVisible: false }))
		pruneSettledCopyJobs()

		expect(getCopyJob("job")).toBeUndefined()
	})

	// A retry takes the job's row, which must first say where the copies a stop asked to trash ended up.
	it("retries nothing while a stop is still moving the copies to the trash", async () => {
		const deps = makeDeps()
		const stuck = mockDir("stuck")
		const trash = deferred<BulkOutcome<DriveItem>>()

		deps.trash.mockReturnValue(trash.promise)
		deps.copyItems.mockImplementation((id, _items, _dest, _max, onEvent) => {
			onEvent({ type: "created", item: created(stuck) })
			requestCopyCancel(id, { trashCopied: true })

			return Promise.resolve(report({ failures: [copyFailure("failed")], error: CANCELLED }))
		})

		const running = runCopyJob(deps, request())

		await vi.waitFor(() => {
			expect(deps.trash).toHaveBeenCalledTimes(1)
		})

		useCopyJobsStore.getState().update("job", job => ({ ...job, cardVisible: true }))
		copyItemsTo.mockReturnValue(new Promise(() => undefined))

		const retried = retryFailedCopy("job")

		// With the card gone, only the row keeps the job until the trash settles.
		useCopyJobsStore.getState().update("job", job => ({ ...job, cardVisible: false }))
		pruneSettledCopyJobs()

		expect(row()?.status).toBe("copying")

		trash.resolve({ succeeded: [], failed: [{ item: narrowItem(stuck), error: new Error("offline") }] })
		await running

		expect(row()).toMatchObject({ status: "error", error: { label: "1 copied item couldn't be moved to the trash" } })
		expect(getCopyJob("job")?.trashResult).toEqual({ moved: 0, failed: 1 })
		expect(retried).toBeNull()
		expect(copyItemsTo).not.toHaveBeenCalled()
	})

	it("keeps the row that reports copies left at the destination when the job's failures are retried", async () => {
		const deps = makeDeps()
		const stuck = mockDir("stuck")

		deps.trash.mockResolvedValue({ succeeded: [], failed: [{ item: narrowItem(stuck), error: new Error("offline") }] })
		deps.copyItems.mockImplementation((id, _items, _dest, _max, onEvent) => {
			onEvent({ type: "created", item: created(stuck) })
			requestCopyCancel(id, { trashCopied: true })

			return Promise.resolve(report({ failures: [copyFailure("failed")], error: CANCELLED }))
		})

		await runCopyJob(deps, request())
		useCopyJobsStore.getState().update("job", job => ({ ...job, cardVisible: true }))
		copyItemsTo.mockReturnValue(new Promise(() => undefined))

		expect(retryFailedCopy("job")).not.toBeNull()

		useCopyJobsStore.getState().update("job", job => ({ ...job, cardVisible: false }))
		pruneSettledCopyJobs()

		expect(row()).toMatchObject({ status: "error", error: { label: "1 copied item couldn't be moved to the trash" } })
		expect(getCopyJob("job")).toMatchObject({ retryable: [], trashResult: { moved: 0, failed: 1 } })
		expect(retryFailedCopy("job")).toBeNull()
		expect(copyItemsTo).toHaveBeenCalledTimes(1)
	})
})

describe("pruneSettledCopyJobs", () => {
	it("drops only settled jobs with neither a card nor a transfers row", () => {
		const settled = { outcome: { status: "done" as const } }

		useCopyJobsStore.setState({
			jobs: {
				running: createCopyJob("running", DESTINATION, 1),
				carded: { ...createCopyJob("carded", DESTINATION, 1), ...settled, cardVisible: true },
				rowed: { ...createCopyJob("rowed", DESTINATION, 1), ...settled },
				orphan: { ...createCopyJob("orphan", DESTINATION, 1), ...settled }
			}
		})
		useTransfersStore.setState({
			transfers: [
				{
					id: "rowed",
					direction: "copy",
					name: "x",
					size: 0,
					bytesTransferred: 0,
					status: "done",
					paused: false,
					parentUuid: null,
					startedAt: 0
				}
			]
		})

		pruneSettledCopyJobs()

		expect(Object.keys(useCopyJobsStore.getState().jobs).sort()).toEqual(["carded", "rowed", "running"])
	})
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type {
	CopiedTopLevelItem,
	CopyCounts,
	CopyFailure,
	CopyItem,
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

const { copyItems, copyItemsTo, cancelCopy } = vi.hoisted(() => ({
	copyItems: vi.fn<SdkCopyItems>(),
	copyItemsTo: vi.fn<(id: string, entries: unknown, maxBytes: number | undefined, onEvent: unknown) => Promise<CopyReport>>(),
	cancelCopy: vi.fn<(id: string) => void>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { copyItems, copyItemsTo, cancelCopy } }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { toastSuccess, toastError, toastCustom, toastDismiss } = vi.hoisted(() => ({
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastCustom: vi.fn(),
	toastDismiss: vi.fn()
}))

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError, custom: toastCustom, dismiss: toastDismiss } }))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import {
	pruneSettledCopyJobs,
	requestCopyCancel,
	retryFailedCopy,
	runCopyJob,
	startCopy,
	type RunCopyDeps
} from "@/features/drive/lib/copy"
import { createCopyJob } from "@/features/drive/lib/copy.logic"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { getCopyJob, useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { driveListingQueryKey } from "@/features/drive/queries/drive"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const ROOT = testUuid("root")
const DESTINATION = { uuid: null, name: "My Drive" }
const NO_SERVER = { serverMessage: undefined, serverCode: undefined }

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

function makeDeps() {
	return {
		copyItems: vi.fn<RunCopyDeps["copyItems"]>(),
		copyItemsTo: vi.fn<RunCopyDeps["copyItemsTo"]>(),
		transfers: useTransfersStore.getState(),
		jobs: { ...useCopyJobsStore.getState(), get: getCopyJob },
		account: {
			cached: vi.fn<RunCopyDeps["account"]["cached"]>(() => undefined),
			fetchFresh: vi.fn<RunCopyDeps["account"]["fetchFresh"]>()
		},
		seedThumbnail: vi.fn<RunCopyDeps["seedThumbnail"]>(),
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
		const linked = { dir: { inner: { uuid: "root" }, linkedTag: true }, link: { linkUuid: "link" } } as unknown as CopyItem

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

		deps.copyItems.mockImplementation((_id, _items, _dest, _max, onEvent) => {
			onEvent({ type: "update", update: update({ counts: counts({ bytesDone: 50n }) }) })
			onEvent({ type: "created", item: created(dir) })

			expect(getCopyJob("job")?.counts.bytesDone).toBe(50)
			expect(row()).toMatchObject({ size: 200, bytesTransferred: 50 })

			return Promise.resolve(report())
		})

		const job = await runCopyJob(deps, request())

		expect(deps.patchCreated).toHaveBeenCalledTimes(1)
		expect(deps.patchCreated.mock.calls[0]?.[0].data.uuid).toBe(dir.uuid)
		expect(deps.seedThumbnail).toHaveBeenCalledWith(testUuid("source"), deps.patchCreated.mock.calls[0]?.[0])
		expect(deps.seedThumbnail.mock.invocationCallOrder[0]).toBeLessThan(deps.patchCreated.mock.invocationCallOrder[0] ?? 0)
		expect(job?.created.map(item => item.data.uuid)).toEqual([dir.uuid])
	})

	it("settles a clean copy as done and hands the settled job to the announcer", async () => {
		const deps = makeDeps()

		deps.copyItems.mockResolvedValue(report())

		const job = await runCopyJob(deps, request())

		expect(job?.outcome).toEqual({ status: "done" })
		expect(row()).toMatchObject({ status: "done", size: 200, bytesTransferred: 200 })
		expect(deps.settled).toHaveBeenCalledWith(job, null)
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
				stage: "upload",
				error: { kind: "Server", message: "x", ...NO_SERVER },
				affectedFiles: 1n,
				affectedBytes: 100n,
				existingFile: undefined
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

	it("does not run again when the copy was cancelled during the fresh read", async () => {
		const deps = makeDeps()

		deps.account.cached.mockReturnValue({ maxStorage: 1_000n, storageUsed: 900n })
		deps.account.fetchFresh.mockImplementation(() => {
			useCopyJobsStore.getState().update("job", job => ({ ...job, cancelRequest: "keep" }))

			return Promise.resolve({ maxStorage: 1_000n, storageUsed: 0n })
		})
		deps.copyItems.mockResolvedValue(QUOTA_REPORT)

		await runCopyJob(deps, request())

		expect(deps.copyItems).toHaveBeenCalledTimes(1)
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
				expect(deps.trash).toHaveBeenCalledWith(job?.created)
				expect(job?.created.map(item => item.data.uuid)).toEqual([dir.uuid])
			} else {
				expect(deps.trash).not.toHaveBeenCalled()
			}
		}
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

		expect(queryClient.getQueryData<DriveItem[]>(rootKey)?.map(item => item.data.uuid)).toEqual([dir.uuid])
		expect(queryClient.getQueryData(unreadKey)).toBeUndefined()
		expect(copyItems.mock.calls[0]?.[3]).toBe(10_000)
		// Nobody showed a card for this job, so its end is announced with a toast.
		expect(toastSuccess).toHaveBeenCalledTimes(1)
	})

	it("leaves the end to the card while one shows", async () => {
		let release!: () => void
		const running = new Promise<void>(resolve => {
			release = resolve
		})

		copyItems.mockImplementation(async () => {
			await running

			return report()
		})

		const id = startCopy([narrowItem(mockFile("a"))], DESTINATION) ?? ""

		useCopyJobsStore.getState().update(id, job => ({ ...job, cardVisible: true }))
		release()
		await vi.waitFor(() => {
			expect(getCopyJob(id)?.outcome.status).toBe("done")
		})

		expect(toastSuccess).not.toHaveBeenCalled()
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
				stage: "upload",
				error: { kind: "Server", message: "x", ...NO_SERVER },
				affectedFiles: 1n,
				affectedBytes: 100n,
				existingFile: undefined
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

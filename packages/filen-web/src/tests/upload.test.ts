import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import type { Dir, File as SdkFile, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { RunFileFailure, RunFileStart, Transfer, TerminalStatus, UploadBatchRef } from "@/features/transfers/store/useTransfersStore"
import { makeTransfer } from "@/tests/fixtures/transfers"
import { applyProgressBatch } from "@/features/transfers/lib/progressChannel"

// The real sdk client/query client modules import a Vite `?worker` / touch an OPFS-backed
// persister, unresolvable/unwanted under node vitest — mock both down to what this module actually
// calls, mirroring drive/actions.test.ts's mock boundary. `sonner` is mocked to assert the summary
// toast's call args without a mounted <Toaster/>.
const { uploadFile, cancelTransfer, getUserInfo, setProgressSink } = vi.hoisted(() => ({
	uploadFile: vi.fn<(parentUuid: string | null, transferId: string, file: File, runId?: string) => Promise<SdkFile>>(),
	cancelTransfer: vi.fn(),
	getUserInfo: vi.fn(),
	setProgressSink: vi.fn<(sink: (bytesById: Record<string, number>) => void) => Promise<void>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { uploadFile, cancelTransfer, getUserInfo, setProgressSink } }))

// A bare, unconfigured QueryClient stands in for the real singleton — driveListingQueryUpdate only
// needs genuine setQueryData/getQueryData cache mechanics, never the production client's OPFS-backed
// persistence pipeline.
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }))

const { toastTransferStarted } = vi.hoisted(() => ({ toastTransferStarted: vi.fn() }))

vi.mock("@/features/transfers/lib/transferStartToast", () => ({ toastTransferStarted }))

// The convert-on-upload gate reads kv storage (features/drive/lib/heicUpload.ts -> storage/adapter.ts
// -> a real ?worker) — unresolvable under node vitest, same rationale as the sdk-client/query-client
// mocks above. Both cross-module imports startUploads makes are stubbed here so its own wiring (one
// gate call per batch, one conversion per file, upload whatever the conversion returned) is provable
// without ever touching real storage. The gate's own semantics are unit-tested against real DI in
// heicUpload.test.ts.
const { heicUploadConversionEnabledMock, maybeConvertHeicUploadMock } = vi.hoisted(() => ({
	heicUploadConversionEnabledMock: vi.fn<(deps: unknown, files: readonly File[]) => Promise<boolean>>(),
	maybeConvertHeicUploadMock: vi.fn<(deps: unknown, file: File, enabled: boolean) => Promise<File>>()
}))

vi.mock("@/features/drive/lib/heicUpload", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/drive/lib/heicUpload")>()
	return {
		...actual,
		heicUploadConversionEnabled: heicUploadConversionEnabledMock,
		maybeConvertHeicUpload: maybeConvertHeicUploadMock
	}
})

import {
	runUpload,
	startUploads,
	defaultUploadDeps,
	invalidateUploadedDirectorySizes,
	type RunUploadDeps
} from "@/features/drive/lib/upload"
import { warmUploadThumbnail } from "@/features/drive/lib/thumbGenerators"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { addAccountStorageUsed } from "@/features/drive/lib/quota"
import { directorySizeQueryKey, driveListingQueryKey, queueListingCreate } from "@/features/drive/queries/drive"
import { testUuid } from "@/tests/support/uuid"

function mockBrowserFile(name = "report.pdf", size = 1_024): File {
	return new File([new Uint8Array(size)], name)
}

function mockSdkFile(overrides: Partial<SdkFile> = {}): SdkFile {
	return {
		uuid: testUuid("uploaded"),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

function sdkDto(kind: string): ErrorDTO {
	return { species: "sdk", kind, message: `${kind} message`, label: `${kind} label` }
}

beforeEach(() => {
	vi.clearAllMocks()
	useTransfersStore.setState({ transfers: [] })
	heicUploadConversionEnabledMock.mockResolvedValue(false)
	maybeConvertHeicUploadMock.mockImplementation((_deps, file) => Promise.resolve(file))
	// A cached account with room to spare: the quota pre-flight passes without a read
	// (uploadQuota.test.ts covers the other branches).
	queryClient.setQueryData(ACCOUNT_QUERY_KEY, { storageUsed: 0n, maxStorage: 1n << 40n })
})

afterEach(() => {
	vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// runUpload — all collaborators injected, no worker or query client (mirrors
// createDirectory.test.ts's harness style).
// ---------------------------------------------------------------------------

describe("runUpload (injected deps, no worker or query client)", () => {
	function makeHarness() {
		const upload = vi.fn<(parentUuid: string | null, transferId: string, file: File, runId?: string) => Promise<SdkFile>>()
		const add = vi.fn<(t: Omit<Transfer, "paused">, counted?: number) => void>()
		const startRunFile = vi.fn<(file: RunFileStart) => void>()
		const settleRunFile =
			vi.fn<(id: string, status: "done" | "error" | "cancelled", error?: ErrorDTO, failure?: RunFileFailure) => void>()
		const settle = vi.fn<(id: string, status: TerminalStatus, error?: ErrorDTO) => void>()
		const remove = vi.fn<(id: string) => void>()
		const setItem = vi.fn<(id: string, item: DriveItem) => void>()
		const patchCreated = vi.fn<(parentUuid: string | null, item: DriveItem) => void>()
		const warmThumbnail = vi.fn<(uploaded: SdkFile, file: File) => void>()
		const markAccountStale = vi.fn<() => void>()
		const addStorageUsed = vi.fn<(bytes: bigint) => void>()
		const deps: RunUploadDeps = {
			upload,
			store: { add, startRunFile, settleRunFile, settle, setItem, remove },
			patchCreated,
			markAccountStale,
			addStorageUsed,
			warmThumbnail
		}
		return {
			deps,
			upload,
			add,
			startRunFile,
			settleRunFile,
			settle,
			setItem,
			remove,
			patchCreated,
			markAccountStale,
			addStorageUsed,
			warmThumbnail
		}
	}

	it("adds an uploading transfer before calling upload", async () => {
		const h = makeHarness()
		h.upload.mockResolvedValue(mockSdkFile())

		await runUpload(h.deps, { parentUuid: "parent-uuid", file: mockBrowserFile("report.pdf", 2_048) })

		expect(h.add).toHaveBeenCalledTimes(1)
		const added = h.add.mock.calls[0]?.[0]
		expect(added).toMatchObject({
			direction: "upload",
			name: "report.pdf",
			size: 2_048,
			bytesTransferred: 0,
			status: "uploading",
			parentUuid: "parent-uuid"
		})
		expect(h.upload).toHaveBeenCalledTimes(1)
	})

	it("settles done and patches the listing with the narrowed uploaded file on success", async () => {
		const h = makeHarness()
		const uploaded = mockSdkFile({ uuid: testUuid("new") })
		h.upload.mockResolvedValue(uploaded)

		const outcome = await runUpload(h.deps, { parentUuid: "parent-uuid", file: mockBrowserFile() })

		expect(outcome).toEqual({ status: "success" })
		expect(h.settle).toHaveBeenCalledWith(expect.any(String), "done")
		// Kept on the finished row, whose "Show in directory" reveals it.
		const [landedId, landed] = h.setItem.mock.calls[0] ?? []

		expect(landedId).toBe(h.add.mock.calls[0]?.[0].id)
		expect(landed).toMatchObject({ type: "file", data: { uuid: testUuid("new") } })
		expect(h.patchCreated).toHaveBeenCalledOnce()

		const [parentUuid, created] = h.patchCreated.mock.calls[0] ?? []

		expect(parentUuid).toBe("parent-uuid")
		// narrowItem routes the uploaded SDK file to the plain "file" arm (has `chunks`, and carries
		// `favorited` — see features/drive/lib/item.ts's narrowFile).
		expect(created).toMatchObject({ type: "file", data: { uuid: testUuid("new") } })
		// Storage used moved; the account read waits for the next focus or mount rather than one per file.
		expect(h.markAccountStale).toHaveBeenCalledOnce()
		// The uploaded size lands in the cached storage used for the next quota pre-flight.
		expect(h.addStorageUsed).toHaveBeenCalledExactlyOnceWith(1_024n)
	})

	// The upload's own bytes are the cheapest thumbnail source there will ever be — handing them over
	// is what stops the freshly-patched listing row from downloading the file straight back.
	it("hands the uploaded file and the local bytes to warmThumbnail on success", async () => {
		const h = makeHarness()
		const uploaded = mockSdkFile({ uuid: testUuid("new") })
		const file = mockBrowserFile("photo.jpg")
		h.upload.mockResolvedValue(uploaded)

		await runUpload(h.deps, { parentUuid: "parent-uuid", file })

		expect(h.warmThumbnail).toHaveBeenCalledWith(uploaded, file)
	})

	// Ordering pin, and the whole reason the call sits where it does: patching the row in makes its
	// tile ask for a thumbnail on the next commit, so the warm has to have claimed the uuid by then or
	// the tile starts downloading the file this upload just sent.
	it("warms BEFORE patching the listing", async () => {
		const h = makeHarness()
		const order: string[] = []
		h.upload.mockResolvedValue(mockSdkFile())
		h.warmThumbnail.mockImplementation(() => {
			order.push("warm")
		})
		h.patchCreated.mockImplementation(() => {
			order.push("patch")
		})

		await runUpload(h.deps, { parentUuid: null, file: mockBrowserFile() })

		expect(order).toEqual(["warm", "patch"])
	})

	it("never warms when the upload fails", async () => {
		const h = makeHarness()
		h.upload.mockRejectedValue(sdkDto("UploadFailed"))

		await runUpload(h.deps, { parentUuid: null, file: mockBrowserFile() })

		expect(h.warmThumbnail).not.toHaveBeenCalled()
	})

	it("never warms when the upload is cancelled", async () => {
		const h = makeHarness()
		h.upload.mockRejectedValue(sdkDto("Cancelled"))

		await runUpload(h.deps, { parentUuid: null, file: mockBrowserFile() })

		expect(h.warmThumbnail).not.toHaveBeenCalled()
	})

	// Optional in the same DI sense as `cancel` and `markAccountStale` — a harness that does not
	// care about the thumbnail path simply omits it, and the upload still completes.
	it("completes cleanly when no warmThumbnail is wired", async () => {
		const h = makeHarness()
		h.upload.mockResolvedValue(mockSdkFile())
		delete h.deps.warmThumbnail

		await expect(runUpload(h.deps, { parentUuid: null, file: mockBrowserFile() })).resolves.toEqual({ status: "success" })
		expect(h.patchCreated).toHaveBeenCalled()
	})

	it("uploads at the drive root when parentUuid is null", async () => {
		const h = makeHarness()
		h.upload.mockResolvedValue(mockSdkFile())

		await runUpload(h.deps, { parentUuid: null, file: mockBrowserFile() })

		expect(h.upload).toHaveBeenCalledWith(null, expect.any(String), expect.any(File))
		expect(h.patchCreated).toHaveBeenCalledWith(null, expect.objectContaining({ type: "file" }))
	})

	it("adds nothing for a row already added, and counts a row its run was sized for at that size", async () => {
		const h = makeHarness()
		const batch: UploadBatchRef = { id: "run", parentUuid: null }
		const row = { ...makeTransfer({ id: "pre-added", batch }) }
		h.upload.mockResolvedValue(mockSdkFile())

		await runUpload(h.deps, { parentUuid: null, file: mockBrowserFile(), batch, row })
		await runUpload(h.deps, { parentUuid: null, file: mockBrowserFile("photo.jpg", 700), batch, counted: 900 })

		expect(h.upload.mock.calls[0]?.[1]).toBe("pre-added")
		expect(h.add).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "photo.jpg", size: 700, batch }), 900)
	})

	// A directory run is one row: its files move it, and only a failed one leaves a row of its own.
	describe("a file of a directory run", () => {
		const run: UploadBatchRef = { id: "run", parentUuid: null, directoryName: "photos" }

		it("adds no row, sharing its run's stop and pause, and settles into the run", async () => {
			const h = makeHarness()
			h.upload.mockResolvedValue(mockSdkFile())

			const outcome = await runUpload(h.deps, { parentUuid: "sub", file: mockBrowserFile("a.txt", 64), batch: run, counted: 64 })

			expect(outcome).toEqual({ status: "success" })
			expect(h.add).not.toHaveBeenCalled()
			expect(h.settle).not.toHaveBeenCalled()

			const id = h.startRunFile.mock.calls[0]?.[0].id

			expect(h.startRunFile).toHaveBeenCalledExactlyOnceWith({ id, batchId: "run", size: 64, counted: 64 })
			expect(h.upload).toHaveBeenCalledExactlyOnceWith("sub", id, expect.any(File), "run")
			expect(h.settleRunFile).toHaveBeenCalledExactlyOnceWith(id, "done")
			expect(h.patchCreated).toHaveBeenCalledOnce()
		})

		it("leaves a failed row named by its path, and none for a cancelled one", async () => {
			const h = makeHarness()
			const dto = sdkDto("UploadFailed")
			h.upload.mockRejectedValueOnce(dto).mockRejectedValueOnce(sdkDto("Cancelled"))

			await expect(
				runUpload(h.deps, { parentUuid: "sub", file: mockBrowserFile("a.txt"), batch: run, name: "photos/sub/a.txt" })
			).resolves.toEqual({ status: "error", dto })
			await expect(runUpload(h.deps, { parentUuid: "sub", file: mockBrowserFile("b.txt"), batch: run })).resolves.toEqual({
				status: "cancelled"
			})

			expect(h.settleRunFile.mock.calls.map(call => call.slice(1))).toEqual([
				["error", dto, { name: "photos/sub/a.txt", parentUuid: "sub" }],
				["cancelled"]
			])
			expect(h.patchCreated).not.toHaveBeenCalled()
		})
	})

	it("returns an error outcome and settles error, without patching, when upload rejects", async () => {
		const h = makeHarness()
		const dto = sdkDto("UploadFailed")
		h.upload.mockRejectedValue(dto)

		const outcome = await runUpload(h.deps, { parentUuid: "parent-uuid", file: mockBrowserFile() })

		expect(outcome).toEqual({ status: "error", dto })
		expect(h.settle).toHaveBeenCalledWith(expect.any(String), "error", dto)
		expect(h.patchCreated).not.toHaveBeenCalled()
		expect(h.markAccountStale).not.toHaveBeenCalled()
		expect(h.addStorageUsed).not.toHaveBeenCalled()
	})

	it("normalizes a plain Error rejection through asErrorDTO", async () => {
		const h = makeHarness()
		h.upload.mockRejectedValue(new Error("network dropped"))

		const outcome = await runUpload(h.deps, { parentUuid: null, file: mockBrowserFile() })

		expect(outcome).toEqual({
			status: "error",
			dto: { species: "plain", message: "network dropped", label: "network dropped" }
		})
	})

	it("settles cancelled then removes the row on a Cancelled rejection, returning a cancelled outcome", async () => {
		const h = makeHarness()
		h.upload.mockRejectedValue(sdkDto("Cancelled"))

		const outcome = await runUpload(h.deps, { parentUuid: "parent-uuid", file: mockBrowserFile() })

		expect(outcome).toEqual({ status: "cancelled" })
		const id = h.settle.mock.calls[0]?.[0]
		expect(h.settle).toHaveBeenCalledWith(id, "cancelled")
		expect(h.remove).toHaveBeenCalledWith(id)
		expect(h.markAccountStale).not.toHaveBeenCalled()
		expect(h.addStorageUsed).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// startUploads — exercises the real runUpload + defaultUploadDeps wiring against the mocked
// sdk client / query client / sonner declared at the top of this file.
// ---------------------------------------------------------------------------

describe("startUploads (real runUpload + defaultUploadDeps, mocked sdk client/query client/sonner)", () => {
	it("is a no-op for an empty file list", async () => {
		await startUploads([], null)

		expect(uploadFile).not.toHaveBeenCalled()
		expect(toastSuccess).not.toHaveBeenCalled()
		expect(toastError).not.toHaveBeenCalled()
	})

	it("fans out every file and toasts a success summary when all succeed", async () => {
		uploadFile.mockImplementation(() => Promise.resolve(mockSdkFile()))

		await startUploads([mockBrowserFile("a.txt"), mockBrowserFile("b.txt"), mockBrowserFile("c.txt")], "parent-uuid")

		expect(uploadFile).toHaveBeenCalledTimes(3)
		expect(toastSuccess).toHaveBeenCalledTimes(1)
		expect(toastSuccess).toHaveBeenCalledWith(expect.any(String))
		expect(toastError).not.toHaveBeenCalled()
	})

	it("says once that the upload started, naming one file or counting several", async () => {
		uploadFile.mockImplementation(() => Promise.resolve(mockSdkFile()))

		await startUploads([mockBrowserFile("a.txt")], null)
		await startUploads([mockBrowserFile("a.txt"), mockBrowserFile("b.txt")], null)

		expect(toastTransferStarted.mock.calls).toEqual([
			[{ direction: "upload", name: "a.txt", count: 1, noun: "files" }],
			[{ direction: "upload", name: "a.txt", count: 2, noun: "files" }]
		])
	})

	it("attempts every file concurrently, not one at a time", async () => {
		const callOrder: string[] = []
		const resolvers: (() => void)[] = []

		uploadFile.mockImplementation(async (_parentUuid: string | null, _transferId: string, file: File) => {
			callOrder.push(`called:${file.name}`)
			await new Promise<void>(resolve => {
				resolvers.push(resolve)
			})
			callOrder.push(`resolved:${file.name}`)
			return mockSdkFile()
		})

		const promise = startUploads([mockBrowserFile("a.txt"), mockBrowserFile("b.txt")], null)

		// Both started while neither has resolved.
		await vi.waitFor(() => {
			expect(callOrder).toHaveLength(2)
		})

		expect(callOrder).toEqual(["called:a.txt", "called:b.txt"])

		resolvers.forEach(resolve => {
			resolve()
		})
		await promise
	})

	it("toasts a partial-failure summary reflecting the succeeded/failed counts", async () => {
		uploadFile.mockResolvedValueOnce(mockSdkFile()).mockRejectedValueOnce(sdkDto("QuotaExceeded")).mockResolvedValueOnce(mockSdkFile())

		await startUploads([mockBrowserFile("a.txt"), mockBrowserFile("b.txt"), mockBrowserFile("c.txt")], null)

		expect(toastError).toHaveBeenCalledTimes(1)
		expect(toastError).toHaveBeenCalledWith(expect.any(String))
		expect(toastSuccess).not.toHaveBeenCalled()
	})

	it("registers one done transfer per file in the real transfers store", async () => {
		uploadFile.mockImplementation(() => Promise.resolve(mockSdkFile()))

		await startUploads([mockBrowserFile("a.txt"), mockBrowserFile("b.txt")], null)

		const transfers = useTransfersStore.getState().transfers
		expect(transfers).toHaveLength(2)
		expect(transfers.every(transfer => transfer.status === "done")).toBe(true)
	})

	// Proves progress survives the real defaultUploadDeps wiring: the page's end of the worker's one progress
	// channel lands a batch naming the upload's row in the REAL store.
	it("delivers progress through the worker's progress channel into the real transfers store", async () => {
		let bytesTransferred: number | undefined

		uploadFile.mockImplementation((_parentUuid, transferId) => {
			applyProgressBatch({ [transferId]: 512 })
			bytesTransferred = useTransfersStore.getState().transfers.find(transfer => transfer.id === transferId)?.bytesTransferred

			return Promise.resolve(mockSdkFile())
		})

		await startUploads([mockBrowserFile("a.txt", 1_024)], null)

		expect(bytesTransferred).toBe(512)
	})

	it("sizes its run with every file from the start, and adds the rows in one store write", async () => {
		let writes = 0
		let sized: { files: number; bytes: number } | undefined
		const unsubscribe = useTransfersStore.subscribe((state, prev) => {
			if (state.transfers !== prev.transfers && state.transfers.length > prev.transfers.length) {
				writes++
			}
		})

		uploadFile.mockImplementation(() => {
			const [batch] = Object.values(useTransfersStore.getState().uploadBatches)

			sized ??= batch === undefined ? undefined : { files: batch.files, bytes: batch.bytes }

			return Promise.resolve(mockSdkFile())
		})

		await startUploads([mockBrowserFile("a.txt", 100), mockBrowserFile("b.txt", 200), mockBrowserFile("c.txt", 300)], null)
		unsubscribe()

		expect(sized).toEqual({ files: 3, bytes: 600 })
		expect(writes).toBe(1)
	})
})

// The run the target listing shows while the pick uploads (pendingUploads.logic.ts).
describe("startUploads — listing run", () => {
	it("tags every file with one run keyed to the listing, the root named null however the upload named it", async () => {
		const rootDirUuid = testUuid("root")
		const runs: (UploadBatchRef | undefined)[] = []

		queryClient.setQueryData(ACCOUNT_QUERY_KEY, { storageUsed: 0n, maxStorage: 1n << 40n, rootDirUuid })
		uploadFile.mockImplementation((_parentUuid, transferId) => {
			runs.push(useTransfersStore.getState().transfers.find(transfer => transfer.id === transferId)?.batch)

			return Promise.resolve(mockSdkFile())
		})

		await startUploads([mockBrowserFile("a.txt"), mockBrowserFile("b.txt")], rootDirUuid)

		expect(uploadFile).toHaveBeenCalledWith(rootDirUuid, expect.any(String), expect.anything(), undefined)
		expect(runs).toHaveLength(2)
		expect(runs[0]?.parentUuid).toBeNull()
		expect(runs[0]?.directoryName).toBeUndefined()
		expect(runs[1]).toBe(runs[0])
		// Ended clean: nothing left for the listing to show.
		expect(useTransfersStore.getState().uploadBatches).toEqual({})
	})

	it("starts no file of a run cancelled while it was still being prepared", async () => {
		heicUploadConversionEnabledMock.mockResolvedValue(true)
		maybeConvertHeicUploadMock.mockImplementation((_deps, file) => {
			const runIds = Object.keys(useTransfersStore.getState().uploadBatches)

			useTransfersStore.getState().cancelUploadBatches(new Set(runIds))

			return Promise.resolve(file)
		})

		await startUploads([mockBrowserFile("a.heic")], null)

		expect(uploadFile).not.toHaveBeenCalled()
		expect(toastSuccess).not.toHaveBeenCalled()
		expect(toastError).not.toHaveBeenCalled()
	})
})

describe("startUploads — cancelled files", () => {
	it("shows no summary when every file was cancelled", async () => {
		uploadFile.mockRejectedValue(sdkDto("Cancelled"))

		await startUploads([mockBrowserFile("a.txt"), mockBrowserFile("b.txt")], null)

		expect(toastSuccess).not.toHaveBeenCalled()
		expect(toastError).not.toHaveBeenCalled()
	})

	it("counts only the files that actually uploaded", async () => {
		uploadFile.mockResolvedValueOnce(mockSdkFile()).mockRejectedValueOnce(sdkDto("Cancelled")).mockResolvedValueOnce(mockSdkFile())

		await startUploads([mockBrowserFile("a.txt"), mockBrowserFile("b.txt"), mockBrowserFile("c.txt")], null)

		expect(toastSuccess).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("2"))
		expect(toastError).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// invalidateUploadedDirectorySizes — against the mocked module's real QueryClient.
// ---------------------------------------------------------------------------

describe("invalidateUploadedDirectorySizes", () => {
	function dirRow(uuid: UuidStr, parent: UuidStr): DriveItem {
		const dir: Dir = {
			uuid,
			parent,
			color: "default",
			timestamp: 1_700_000_000_000n,
			favorited: false,
			meta: { type: "decoded", data: { name: uuid } }
		}

		return narrowItem(dir)
	}

	// A cached size entry whose query function counts its fetches, the way useDriveDirectorySizes leaves
	// one: fetched once, with no observer.
	async function cacheSize(uuid: string): Promise<ReturnType<typeof vi.fn>> {
		const fetchSize = vi.fn(() => Promise.resolve({ size: 1n, files: 1n, dirs: 0n }))

		await queryClient.query({ queryKey: directorySizeQueryKey(uuid), queryFn: fetchSize, staleTime: Infinity })

		return fetchSize
	}

	function isInvalidated(uuid: string): boolean | undefined {
		return queryClient.getQueryCache().find({ queryKey: directorySizeQueryKey(uuid), exact: true })?.state.isInvalidated
	}

	beforeEach(() => {
		queryClient.clear()
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, { storageUsed: 0n, maxStorage: 1n << 40n })
	})

	it("stales the target and every ancestor a cached listing names, refetching only a row on screen", async () => {
		const root = testUuid("root")
		const grand = testUuid("grand")
		const parent = testUuid("parent")
		const target = testUuid("target")
		const unrelated = testUuid("unrelated")

		queryClient.setQueryData<DriveItem[]>(driveListingQueryKey({ variant: "drive", uuid: null }), [dirRow(grand, root)])
		queryClient.setQueryData<DriveItem[]>(driveListingQueryKey({ variant: "drive", uuid: grand }), [dirRow(parent, grand)])
		queryClient.setQueryData<DriveItem[]>(driveListingQueryKey({ variant: "drive", uuid: parent }), [
			dirRow(target, parent),
			dirRow(unrelated, parent)
		])

		// The user is looking at `parent`'s listing and dropped the files onto the `target` row.
		const unsubscribe = new QueryObserver(queryClient, {
			queryKey: driveListingQueryKey({ variant: "drive", uuid: parent }),
			queryFn: () => Promise.resolve([]),
			staleTime: Infinity
		}).subscribe(() => undefined)

		const targetFetch = await cacheSize(target)
		const parentFetch = await cacheSize(parent)
		const grandFetch = await cacheSize(grand)
		const unrelatedFetch = await cacheSize(unrelated)

		invalidateUploadedDirectorySizes(target)

		await vi.waitFor(() => {
			expect(targetFetch).toHaveBeenCalledTimes(2)
		})

		expect(isInvalidated(parent)).toBe(true)
		expect(isInvalidated(grand)).toBe(true)
		expect(parentFetch).toHaveBeenCalledTimes(1)
		expect(grandFetch).toHaveBeenCalledTimes(1)
		expect(isInvalidated(unrelated)).toBe(false)
		expect(unrelatedFetch).toHaveBeenCalledTimes(1)

		unsubscribe()
	})

	it("refetches a directory the batch created that is a row on screen", async () => {
		const root = testUuid("root")
		const created = testUuid("created")

		queryClient.setQueryData<DriveItem[]>(driveListingQueryKey({ variant: "drive", uuid: null }), [dirRow(created, root)])

		const unsubscribe = new QueryObserver(queryClient, {
			queryKey: driveListingQueryKey({ variant: "drive", uuid: null }),
			queryFn: () => Promise.resolve([]),
			staleTime: Infinity
		}).subscribe(() => undefined)

		// Prefetched the moment the create patched it in, while its files were still uploading.
		const createdFetch = await cacheSize(created)

		invalidateUploadedDirectorySizes(null, [created])

		await vi.waitFor(() => {
			expect(createdFetch).toHaveBeenCalledTimes(2)
		})

		unsubscribe()
	})

	it("is wired into defaultUploadDeps and runs once per startUploads batch", async () => {
		const target = testUuid("target")
		const targetFetch = await cacheSize(target)

		uploadFile.mockImplementation(() => Promise.resolve(mockSdkFile()))

		await startUploads([mockBrowserFile("a.txt"), mockBrowserFile("b.txt")], target)

		expect(defaultUploadDeps.invalidateDirectorySizes).toBe(invalidateUploadedDirectorySizes)
		expect(isInvalidated(target)).toBe(true)
		expect(targetFetch).toHaveBeenCalledTimes(1)
	})
})

// ---------------------------------------------------------------------------
// defaultUploadDeps.cancel — mirrors download.test.ts's own defaultDownloadDeps.cancel block.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// startUploads — HEIC/HEIF convert-on-upload wiring. The gate's own semantics (when the preference is
// read at all) are unit-tested against real DI in heicUpload.test.ts; this only proves startUploads
// consults it once per batch and hands every file the answer, uploading whatever comes back.
// ---------------------------------------------------------------------------

describe("startUploads — HEIC convert-on-upload gating", () => {
	it("uploads the original files of an all-non-HEIC batch, converting none", async () => {
		const first = mockBrowserFile("a.txt")
		const second = mockBrowserFile("b.pdf")
		uploadFile.mockResolvedValue(mockSdkFile())

		await startUploads([first, second], null)

		expect(heicUploadConversionEnabledMock).toHaveBeenCalledTimes(1)
		expect(heicUploadConversionEnabledMock).toHaveBeenCalledWith(expect.anything(), [first, second])
		expect(maybeConvertHeicUploadMock).not.toHaveBeenCalled()
		expect(uploadFile).toHaveBeenCalledWith(null, expect.any(String), first, undefined)
	})

	it("skips conversion when the gate resolves false with a HEIC present", async () => {
		heicUploadConversionEnabledMock.mockResolvedValue(false)
		const heicFile = mockBrowserFile("photo.heic")
		uploadFile.mockResolvedValue(mockSdkFile())

		await startUploads([heicFile], null)

		expect(maybeConvertHeicUploadMock).not.toHaveBeenCalled()
		expect(uploadFile).toHaveBeenCalledWith(null, expect.any(String), heicFile, undefined)
	})

	it("runs only the HEIC files through maybeConvertHeicUpload once the gate resolves true", async () => {
		heicUploadConversionEnabledMock.mockResolvedValue(true)
		const heicFile = mockBrowserFile("photo.heic")
		const otherFile = mockBrowserFile("report.pdf")
		uploadFile.mockResolvedValue(mockSdkFile())

		await startUploads([heicFile, otherFile], null)

		expect(maybeConvertHeicUploadMock).toHaveBeenCalledExactlyOnceWith(expect.anything(), heicFile, true)
		expect(uploadFile).toHaveBeenCalledWith(null, expect.any(String), otherFile, undefined)
	})

	it("uploads whatever maybeConvertHeicUpload returns, not the original picked file", async () => {
		heicUploadConversionEnabledMock.mockResolvedValue(true)
		const converted = mockBrowserFile("photo.jpg")
		maybeConvertHeicUploadMock.mockResolvedValue(converted)
		uploadFile.mockResolvedValue(mockSdkFile())

		await startUploads([mockBrowserFile("photo.heic")], null)

		expect(uploadFile).toHaveBeenCalledWith(null, expect.any(String), converted, undefined)
	})

	it("consults the gate exactly once for a multi-file batch", async () => {
		heicUploadConversionEnabledMock.mockResolvedValue(true)
		uploadFile.mockResolvedValue(mockSdkFile())

		await startUploads([mockBrowserFile("a.heic"), mockBrowserFile("b.heic"), mockBrowserFile("c.txt")], null)

		expect(heicUploadConversionEnabledMock).toHaveBeenCalledTimes(1)
	})
})

describe("defaultUploadDeps.cancel", () => {
	it("fires sdkApi.cancelTransfer for the given transferId", () => {
		defaultUploadDeps.cancel?.("transfer-id")

		expect(cancelTransfer).toHaveBeenCalledWith("transfer-id")
	})
})

describe("defaultUploadDeps.addStorageUsed", () => {
	it("is wired to the real addAccountStorageUsed", () => {
		expect(defaultUploadDeps.addStorageUsed).toBe(addAccountStorageUsed)
	})
})

describe("defaultUploadDeps.warmThumbnail", () => {
	it("is wired to the real warmUploadThumbnail", () => {
		expect(defaultUploadDeps.warmThumbnail).toBe(warmUploadThumbnail)
	})
})

describe("defaultUploadDeps.patchCreated", () => {
	it("queues the landed file with the other listing creates", () => {
		expect(defaultUploadDeps.patchCreated).toBe(queueListingCreate)
	})
})

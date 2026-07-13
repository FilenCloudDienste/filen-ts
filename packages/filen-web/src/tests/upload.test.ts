import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { File as SdkFile, UuidStr } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { Transfer, TerminalStatus } from "@/features/transfers/store/useTransfersStore"

// The real sdk client/query client modules import a Vite `?worker` / touch an OPFS-backed
// persister, unresolvable/unwanted under node vitest — mock both down to what this module actually
// calls, mirroring drive/actions.test.ts's mock boundary. `sonner` is mocked to assert the summary
// toast's call args without a mounted <Toaster/>.
const { uploadFile, cancelUpload } = vi.hoisted(() => ({
	uploadFile:
		vi.fn<(parentUuid: string | null, transferId: string, file: File, onProgress: (bytes: bigint) => void) => Promise<SdkFile>>(),
	cancelUpload: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { uploadFile, cancelUpload } }))

// A bare, unconfigured QueryClient stands in for the real singleton — driveListingQueryUpdate only
// needs genuine setQueryData/getQueryData cache mechanics, never the production client's OPFS-backed
// persistence pipeline.
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }))

// getHeicUploadConvertPreference touches kv storage (features/drive/lib/heicUpload.ts -> storage/
// adapter.ts -> a real ?worker) — unresolvable under node vitest, same rationale as the sdk-client/
// query-client mocks above. Stubbed here so startUploads' own gating (skip the read entirely for an
// all-non-HEIC batch) can be exercised without ever touching real storage; isHeicUploadCandidate stays
// real (importOriginal) since it's the pure extension check startUploads' own gate depends on.
const { getHeicUploadConvertPreferenceMock, maybeConvertHeicUploadMock } = vi.hoisted(() => ({
	getHeicUploadConvertPreferenceMock: vi.fn<() => Promise<boolean>>(),
	maybeConvertHeicUploadMock: vi.fn<(deps: unknown, file: File, enabled: boolean) => Promise<File>>()
}))

vi.mock("@/features/drive/lib/heicUpload", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/drive/lib/heicUpload")>()
	return {
		...actual,
		getHeicUploadConvertPreference: getHeicUploadConvertPreferenceMock,
		maybeConvertHeicUpload: maybeConvertHeicUploadMock
	}
})

import { runUpload, startUploads, throttle, defaultUploadDeps, type RunUploadDeps } from "@/features/drive/lib/upload"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a short
// readable test label into a shape that satisfies it, mirroring queries/drive.test.ts's own fixture.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockBrowserFile(name = "report.pdf", size = 1_024): File {
	return new File([new Uint8Array(size)], name)
}

function mockSdkFile(overrides: Partial<SdkFile> = {}): SdkFile {
	return {
		uuid: testUuid("uploaded"),
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
	getHeicUploadConvertPreferenceMock.mockResolvedValue(false)
	maybeConvertHeicUploadMock.mockImplementation((_deps, file) => Promise.resolve(file))
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
		const upload =
			vi.fn<(parentUuid: string | null, transferId: string, file: File, onProgress: (bytes: bigint) => void) => Promise<SdkFile>>()
		const add = vi.fn<(t: Omit<Transfer, "paused">) => void>()
		const setProgress = vi.fn<(id: string, bytesTransferred: number) => void>()
		const settle = vi.fn<(id: string, status: TerminalStatus, error?: ErrorDTO) => void>()
		const remove = vi.fn<(id: string) => void>()
		const patchListing = vi.fn<(parentUuid: string | null, updater: (prev: DriveItem[]) => DriveItem[]) => void>()
		const invalidateDirectorySize = vi.fn<(parentUuid: string | null) => void>()
		const deps: RunUploadDeps = { upload, store: { add, setProgress, settle, remove }, patchListing, invalidateDirectorySize }
		return { deps, upload, add, setProgress, settle, remove, patchListing, invalidateDirectorySize }
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
		expect(h.patchListing).toHaveBeenCalledWith("parent-uuid", expect.any(Function))
		// The destination directory's own cached recursive size is now stale (see queries/drive.ts's
		// invalidateDirectorySize) — the size-sort's async re-position depends on this firing.
		expect(h.invalidateDirectorySize).toHaveBeenCalledWith("parent-uuid")

		const updater = h.patchListing.mock.calls[0]?.[1]
		if (!updater) {
			throw new Error("expected patchListing to receive an updater")
		}
		const patched = updater([])
		expect(patched).toHaveLength(1)
		// narrowItem routes the uploaded SDK file to the plain "file" arm (has `chunks`, and carries
		// `favorited` — see features/drive/lib/item.ts's narrowFile).
		expect(patched[0]).toMatchObject({ type: "file", data: { uuid: testUuid("new") } })
	})

	it("uploads at the drive root when parentUuid is null", async () => {
		const h = makeHarness()
		h.upload.mockResolvedValue(mockSdkFile())

		await runUpload(h.deps, { parentUuid: null, file: mockBrowserFile() })

		expect(h.upload).toHaveBeenCalledWith(null, expect.any(String), expect.any(File), expect.any(Function))
		expect(h.patchListing).toHaveBeenCalledWith(null, expect.any(Function))
		expect(h.invalidateDirectorySize).toHaveBeenCalledWith(null)
	})

	it("reports the first progress notification through to store.setProgress, narrowed to a number", async () => {
		const h = makeHarness()
		h.upload.mockImplementation((_parentUuid, _transferId, _file, onProgress) => {
			onProgress(512n)
			return Promise.resolve(mockSdkFile())
		})

		await runUpload(h.deps, { parentUuid: null, file: mockBrowserFile() })

		expect(h.setProgress).toHaveBeenCalledWith(expect.any(String), 512)
	})

	it("throttles rapid progress callbacks, always delivering the final cumulative value", async () => {
		vi.useFakeTimers()
		const h = makeHarness()
		h.upload.mockImplementation((_parentUuid, _transferId, _file, onProgress) => {
			onProgress(100n) // leading edge -> fires immediately
			onProgress(200n) // buffered
			onProgress(300n) // buffered (overwrites 200n)
			vi.advanceTimersByTime(100) // trailing edge -> fires with the final value
			return Promise.resolve(mockSdkFile())
		})

		await runUpload(h.deps, { parentUuid: null, file: mockBrowserFile() })

		expect(h.setProgress).toHaveBeenCalledTimes(2)
		expect(h.setProgress).toHaveBeenNthCalledWith(1, expect.any(String), 100)
		expect(h.setProgress).toHaveBeenNthCalledWith(2, expect.any(String), 300)
	})

	it("returns an error outcome and settles error, without patching, when upload rejects", async () => {
		const h = makeHarness()
		const dto = sdkDto("UploadFailed")
		h.upload.mockRejectedValue(dto)

		const outcome = await runUpload(h.deps, { parentUuid: "parent-uuid", file: mockBrowserFile() })

		expect(outcome).toEqual({ status: "error", dto })
		expect(h.settle).toHaveBeenCalledWith(expect.any(String), "error", dto)
		expect(h.patchListing).not.toHaveBeenCalled()
		expect(h.invalidateDirectorySize).not.toHaveBeenCalled()
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

	it("settles cancelled then removes the row on a Cancelled rejection, returning a clean success", async () => {
		const h = makeHarness()
		h.upload.mockRejectedValue(sdkDto("Cancelled"))

		const outcome = await runUpload(h.deps, { parentUuid: "parent-uuid", file: mockBrowserFile() })

		expect(outcome).toEqual({ status: "success" })
		const id = h.settle.mock.calls[0]?.[0]
		expect(h.settle).toHaveBeenCalledWith(id, "cancelled")
		expect(h.remove).toHaveBeenCalledWith(id)
		expect(h.invalidateDirectorySize).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// throttle — standalone TDD (no upload involved).
// ---------------------------------------------------------------------------

describe("throttle", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	it("invokes immediately on the first call (leading edge)", () => {
		const fn = vi.fn()
		const throttled = throttle(fn, 100)

		throttled(1)

		expect(fn).toHaveBeenCalledTimes(1)
		expect(fn).toHaveBeenCalledWith(1)
	})

	it("buffers calls inside the window instead of invoking immediately", () => {
		const fn = vi.fn()
		const throttled = throttle(fn, 100)

		throttled(1)
		throttled(2)

		expect(fn).toHaveBeenCalledTimes(1)
	})

	it("delivers only the FINAL buffered value at the trailing edge", () => {
		const fn = vi.fn()
		const throttled = throttle(fn, 100)

		throttled(1)
		throttled(2)
		throttled(3)
		vi.advanceTimersByTime(100)

		expect(fn).toHaveBeenCalledTimes(2)
		expect(fn).toHaveBeenNthCalledWith(2, 3)
	})

	it("does not fire a trailing call when nothing happened after the leading edge", () => {
		const fn = vi.fn()
		const throttled = throttle(fn, 100)

		throttled(1)
		vi.advanceTimersByTime(100)

		expect(fn).toHaveBeenCalledTimes(1)
	})

	it("starts a fresh leading cycle once the window fully elapses with no pending call", () => {
		const fn = vi.fn()
		const throttled = throttle(fn, 100)

		throttled(1)
		vi.advanceTimersByTime(100)
		throttled(2)

		expect(fn).toHaveBeenCalledTimes(2)
		expect(fn).toHaveBeenNthCalledWith(2, 2)
	})

	it("keeps throttling across repeated windows (leading+trailing pair per window)", () => {
		const fn = vi.fn()
		const throttled = throttle(fn, 100)

		throttled(1) // t=0, leading, fires with 1
		throttled(2) // t=0, buffered
		vi.advanceTimersByTime(100) // t=100, trailing fires with 2

		vi.advanceTimersByTime(100) // t=200, window fully elapsed, nothing pending

		throttled(3) // t=200, fresh leading, fires immediately with 3
		throttled(4) // t=200, buffered
		vi.advanceTimersByTime(100) // t=300, trailing fires with 4

		expect(fn.mock.calls).toEqual([[1], [2], [3], [4]])
	})

	it("works with bigint args (the real onProgress shape)", () => {
		const fn = vi.fn<(bytes: bigint) => void>()
		const throttled = throttle(fn, 100)

		throttled(10n)
		throttled(20n)
		vi.advanceTimersByTime(100)

		expect(fn.mock.calls).toEqual([[10n], [20n]])
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

		await Promise.resolve()
		await Promise.resolve()

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

	// Proves progress survives the real defaultUploadDeps wiring — sdk/client.ts's onProgress crosses
	// through Comlink.proxy (upload.ts) before reaching this mocked uploadFile, so invoking the proxied
	// callback here and observing the REAL store exercises that wrap, not just the injected-deps harness
	// runUpload's own describe block already covers above.
	it("delivers progress through the Comlink.proxy wrap into the real transfers store", async () => {
		uploadFile.mockImplementation(
			(_parentUuid: string | null, _transferId: string, _file: File, onProgress: (bytes: bigint) => void) => {
				onProgress(512n) // leading edge -> throttle forwards it synchronously
				return Promise.resolve(mockSdkFile())
			}
		)

		await startUploads([mockBrowserFile("a.txt", 1_024)], null)

		expect(useTransfersStore.getState().transfers[0]?.bytesTransferred).toBe(512)
	})
})

// ---------------------------------------------------------------------------
// defaultUploadDeps.cancel — mirrors download.test.ts's own defaultDownloadDeps.cancel block.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// startUploads — HEIC/HEIF convert-on-upload wiring. The conversion logic itself is unit-tested
// in heicUpload.test.ts; this only proves startUploads' own gating (skip the kv read entirely for an
// all-non-HEIC batch) and that it threads the fetched preference through to every file.
// ---------------------------------------------------------------------------

describe("startUploads — HEIC convert-on-upload gating", () => {
	it("never reads the preference for a batch with no HEIC/HEIF candidate", async () => {
		uploadFile.mockResolvedValue(mockSdkFile())

		await startUploads([mockBrowserFile("a.txt"), mockBrowserFile("b.pdf")], null)

		expect(getHeicUploadConvertPreferenceMock).not.toHaveBeenCalled()
		expect(maybeConvertHeicUploadMock).not.toHaveBeenCalled()
	})

	it("reads the preference once a HEIC/HEIF candidate is present, and skips conversion when it's off", async () => {
		getHeicUploadConvertPreferenceMock.mockResolvedValue(false)
		uploadFile.mockResolvedValue(mockSdkFile())

		await startUploads([mockBrowserFile("photo.heic")], null)

		expect(getHeicUploadConvertPreferenceMock).toHaveBeenCalledTimes(1)
		expect(maybeConvertHeicUploadMock).not.toHaveBeenCalled()
	})

	it("runs every file (HEIC and non-HEIC alike) through maybeConvertHeicUpload once the preference is on", async () => {
		getHeicUploadConvertPreferenceMock.mockResolvedValue(true)
		const heicFile = mockBrowserFile("photo.heic")
		const otherFile = mockBrowserFile("report.pdf")
		uploadFile.mockResolvedValue(mockSdkFile())

		await startUploads([heicFile, otherFile], null)

		expect(maybeConvertHeicUploadMock).toHaveBeenCalledTimes(2)
		expect(maybeConvertHeicUploadMock).toHaveBeenCalledWith(expect.anything(), heicFile, true)
		expect(maybeConvertHeicUploadMock).toHaveBeenCalledWith(expect.anything(), otherFile, true)
	})

	it("uploads whatever maybeConvertHeicUpload returns, not the original picked file", async () => {
		getHeicUploadConvertPreferenceMock.mockResolvedValue(true)
		const converted = mockBrowserFile("photo.jpg")
		maybeConvertHeicUploadMock.mockResolvedValue(converted)
		uploadFile.mockResolvedValue(mockSdkFile())

		await startUploads([mockBrowserFile("photo.heic")], null)

		expect(uploadFile).toHaveBeenCalledWith(null, expect.any(String), converted, expect.any(Function))
	})
})

describe("defaultUploadDeps.cancel", () => {
	it("fires sdkApi.cancelUpload for the given transferId", () => {
		defaultUploadDeps.cancel?.("transfer-id")

		expect(cancelUpload).toHaveBeenCalledWith("transfer-id")
	})
})

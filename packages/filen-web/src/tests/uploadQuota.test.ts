import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File as SdkFile, UserInfo, UuidStr } from "@filen/sdk-rs"
import { formatBytes } from "@filen/shared"

// The quota pre-flight wired end to end: real startUploads/startDirectoryUpload, the real account
// query key on a bare QueryClient, only the worker boundary mocked — so getUserInfo's call count IS
// the pre-flight's request count.
const { createDirectory, uploadFile, getUserInfo } = vi.hoisted(() => ({
	createDirectory: vi.fn<(parentUuid: string | null, name: string) => Promise<Dir>>(),
	uploadFile:
		vi.fn<(parentUuid: string | null, transferId: string, file: File, onProgress: (bytes: bigint) => void) => Promise<SdkFile>>(),
	getUserInfo: vi.fn<() => Promise<UserInfo>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { createDirectory, uploadFile, getUserInfo } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { toastSuccess, toastError, toastLoading, toastDismiss } = vi.hoisted(() => ({
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastLoading: vi.fn(() => "scan-toast-id"),
	toastDismiss: vi.fn()
}))

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError, loading: toastLoading, dismiss: toastDismiss } }))

// The convert-on-upload gate reads kv storage (a real ?worker) — same stub as upload.test.ts.
vi.mock("@/features/drive/lib/heicUpload", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/drive/lib/heicUpload")>()

	return {
		...actual,
		heicUploadConversionEnabled: () => Promise.resolve(false),
		maybeConvertHeicUpload: (_deps: unknown, file: File) => Promise.resolve(file)
	}
})

import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY, markAccountStale } from "@/queries/account"
import { addAccountStorageUsed, checkUploadQuota } from "@/features/drive/lib/quota"
import { startUploads } from "@/features/drive/lib/upload"
import { startDirectoryUpload } from "@/features/drive/lib/uploadDirectory"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { i18n } from "@/lib/i18n"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// The pre-flight reads only the two storage counters.
function account(storageUsed: bigint, maxStorage: bigint): UserInfo {
	return { storageUsed, maxStorage } as UserInfo
}

function cachedAccount(): UserInfo | undefined {
	return queryClient.getQueryData<UserInfo>(ACCOUNT_QUERY_KEY)
}

function browserFile(name: string, size: number): File {
	return new File([new Uint8Array(size)], name)
}

function relFile(relPath: string, size: number): File {
	const file = browserFile(relPath.split("/").at(-1) ?? relPath, size)

	Object.defineProperty(file, "webkitRelativePath", { value: relPath })

	return file
}

function sdkFile(size: bigint): SdkFile {
	return {
		uuid: testUuid("uploaded"),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name: "a.bin", mime: "application/octet-stream", modified: 0n, size, key: "k", version: 2 } }
	}
}

function exceededMessage(needed: number, free: number): string {
	return i18n.t("transfers:transfersQuotaExceeded", { needed: formatBytes(needed), free: formatBytes(free) })
}

beforeEach(() => {
	queryClient.clear()
	useTransfersStore.setState({ transfers: [] })
	uploadFile.mockImplementation((_parent, _id, file) => Promise.resolve(sdkFile(BigInt(file.size))))
	createDirectory.mockImplementation((_parent, name) =>
		Promise.resolve({
			uuid: testUuid(name),
			parent: testUuid("parent"),
			color: "default",
			timestamp: 0n,
			favorited: false,
			meta: { type: "decoded", data: { name } }
		})
	)
})

describe("startUploads quota pre-flight", () => {
	it("makes no account request when the cached account says the upload fits", async () => {
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, account(0n, 10_000n))

		await startUploads([browserFile("a.bin", 1_000), browserFile("b.bin", 2_000)], null)

		expect(getUserInfo).not.toHaveBeenCalled()
		expect(uploadFile).toHaveBeenCalledTimes(2)
	})

	it("makes no account request for an unresolvable cached quota, leaving the decision to the server", async () => {
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, account(0n, 0n))

		await startUploads([browserFile("a.bin", 1_000)], null)

		expect(getUserInfo).not.toHaveBeenCalled()
		expect(uploadFile).toHaveBeenCalledOnce()
	})

	it("reads the account exactly once when the cached account says it does not fit, then starts if the fresh one does", async () => {
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, account(9_500n, 10_000n))
		getUserInfo.mockResolvedValue(account(1_000n, 10_000n))

		await startUploads([browserFile("a.bin", 3_000)], null)

		expect(getUserInfo).toHaveBeenCalledOnce()
		expect(uploadFile).toHaveBeenCalledOnce()
		expect(toastError).not.toHaveBeenCalled()
	})

	it("blocks the whole selection with one message when the fresh read still does not fit, starting no transfer", async () => {
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, account(9_500n, 10_000n))
		getUserInfo.mockResolvedValue(account(9_000n, 10_000n))

		// The first file alone would fit; the selection as a whole does not.
		await startUploads([browserFile("a.bin", 600), browserFile("b.bin", 600)], null)

		expect(getUserInfo).toHaveBeenCalledOnce()
		expect(uploadFile).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers).toEqual([])
		expect(toastError).toHaveBeenCalledExactlyOnceWith(exceededMessage(1_200, 1_000))
		expect(toastSuccess).not.toHaveBeenCalled()
	})

	it("reads the account exactly once when nothing is cached", async () => {
		getUserInfo.mockResolvedValue(account(0n, 10_000n))

		await startUploads([browserFile("a.bin", 1_000)], null)

		expect(getUserInfo).toHaveBeenCalledOnce()
		expect(uploadFile).toHaveBeenCalledOnce()
	})

	it("does not block when the fresh read fails", async () => {
		getUserInfo.mockRejectedValue(new Error("offline"))

		await startUploads([browserFile("a.bin", 1_000)], null)

		expect(uploadFile).toHaveBeenCalledOnce()
		expect(toastError).not.toHaveBeenCalled()
	})
})

// Any account write cancels the account query's own read, which then resolves with the cached figure;
// the pre-flight's fresh read must not be that read.
describe("the pre-flight's fresh read", () => {
	function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
		let resolve: (value: T) => void = () => undefined
		const promise = new Promise<T>(r => {
			resolve = r
		})

		return { promise, resolve }
	}

	it.each([
		[
			"a stale mark",
			() => {
				markAccountStale()
			}
		],
		[
			"an optimistic storage patch",
			() => {
				addAccountStorageUsed(50n)
			}
		]
	])("judges on the server's figure when %s lands during the read, and leaves the cache to that write", async (_, write) => {
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, account(9_900n, 10_000n))

		const fresh = deferred<UserInfo>()

		getUserInfo.mockReturnValueOnce(fresh.promise)

		const verdict = checkUploadQuota(3_000n)

		write()

		const written = cachedAccount()

		fresh.resolve(account(1_000n, 10_000n))

		await expect(verdict).resolves.toEqual({ status: "fits" })
		expect(cachedAccount()).toBe(written)
	})

	it("refreshes the cached account when nothing was written during the read", async () => {
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, account(9_900n, 10_000n))
		markAccountStale()
		getUserInfo.mockResolvedValue(account(1_000n, 10_000n))

		await expect(checkUploadQuota(3_000n)).resolves.toEqual({ status: "fits" })
		expect(cachedAccount()?.storageUsed).toBe(1_000n)
		expect(queryClient.getQueryState(ACCOUNT_QUERY_KEY)?.isInvalidated).toBe(false)
	})
})

describe("optimistic storage used after an upload", () => {
	it("adds the uploaded bytes to the cached account and keeps its refresh pending", async () => {
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, account(100n, 10_000n))

		await startUploads([browserFile("a.bin", 1_000), browserFile("b.bin", 2_000)], null)

		expect(cachedAccount()?.storageUsed).toBe(3_100n)
		expect(queryClient.getQueryState(ACCOUNT_QUERY_KEY)?.isInvalidated).toBe(true)
		expect(getUserInfo).not.toHaveBeenCalled()
	})

	it("keeps a refresh pending that was already pending before the upload", async () => {
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, account(0n, 10_000n))
		markAccountStale()

		await startUploads([browserFile("a.bin", 1_000)], null)

		expect(cachedAccount()?.storageUsed).toBe(1_000n)
		expect(queryClient.getQueryState(ACCOUNT_QUERY_KEY)?.isInvalidated).toBe(true)
	})

	it("lets a back-to-back upload pre-flight against the patched figure", async () => {
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, account(0n, 2_000n))

		await startUploads([browserFile("a.bin", 1_500)], null)

		expect(getUserInfo).not.toHaveBeenCalled()

		// 1 500 of 2 000 used now: the cache alone refuses this one, so it is checked against a read.
		getUserInfo.mockResolvedValue(account(1_500n, 2_000n))

		await startUploads([browserFile("b.bin", 1_000)], null)

		expect(getUserInfo).toHaveBeenCalledOnce()
		expect(uploadFile).toHaveBeenCalledOnce()
		expect(toastError).toHaveBeenCalledExactlyOnceWith(exceededMessage(1_000, 500))
	})
})

describe("startDirectoryUpload quota pre-flight", () => {
	it("makes no account request when the cached account says the tree fits", async () => {
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, account(0n, 10_000n))

		await startDirectoryUpload({ kind: "files", files: [relFile("dir/a.bin", 1_000), relFile("dir/sub/b.bin", 1_000)] }, null)

		expect(getUserInfo).not.toHaveBeenCalled()
		expect(uploadFile).toHaveBeenCalledTimes(2)
	})

	it("sums every file in the tree and, when refused, creates no directory and starts no transfer", async () => {
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, account(8_500n, 10_000n))
		getUserInfo.mockResolvedValue(account(8_500n, 10_000n))

		await startDirectoryUpload({ kind: "files", files: [relFile("dir/a.bin", 1_000), relFile("dir/sub/b.bin", 1_000)] }, null)

		expect(getUserInfo).toHaveBeenCalledOnce()
		expect(createDirectory).not.toHaveBeenCalled()
		expect(uploadFile).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers).toEqual([])
		// Swaps the scanning toast in place rather than stacking a second one.
		expect(toastError).toHaveBeenCalledExactlyOnceWith(exceededMessage(2_000, 1_500), { id: "scan-toast-id" })
		expect(toastDismiss).not.toHaveBeenCalled()
	})
})

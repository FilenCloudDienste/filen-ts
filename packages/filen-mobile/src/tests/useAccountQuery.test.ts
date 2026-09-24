// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook, cleanup, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const { mockGetUserInfo, holder } = vi.hoisted(() => ({
	mockGetUserInfo: vi.fn(),
	holder: { client: null as unknown as import("@tanstack/react-query").QueryClient }
}))

// The production defaults that matter here, and queryUpdater.set's restamp-unless-given contract.
vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {
		refetchOnMount: "always",
		staleTime: 0,
		retry: false
	},
	get queryClient() {
		return holder.client
	},
	queryUpdater: {
		set: (queryKey: unknown[], updater: (prev: unknown) => unknown, dataUpdatedAt?: number) => {
			holder.client.setQueryData(queryKey, updater, {
				updatedAt: typeof dataUpdatedAt === "number" ? dataUpdatedAt : Date.now()
			})
		}
	}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: async () => ({
			authedSdkClient: {
				getUserInfo: mockGetUserInfo
			}
		})
	}
}))

import useAccountQuery, {
	accountQueryPatch,
	accountQuotaDeps,
	addAccountStorageUsed,
	ACCOUNT_QUOTA_TRUST_MS,
	fetchFreshAccount,
	markAccountStale,
	BASE_QUERY_KEY,
	type Account
} from "@/queries/useAccount.query"

const account = {
	nickName: "old",
	versioningEnabled: true,
	storageUsed: 100n
} as unknown as Account

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: holder.client }, children)
}

async function mountAndSettle(): Promise<void> {
	const { result, unmount } = renderHook(() => useAccountQuery(), { wrapper })

	await waitFor(() => expect(result.current.fetchStatus).toBe("idle"))
	await waitFor(() => expect(result.current.data).toBeDefined())

	unmount()
}

beforeEach(() => {
	holder.client = new QueryClient()
	mockGetUserInfo.mockReset()
	mockGetUserInfo.mockResolvedValue(account)
})

afterEach(() => {
	cleanup()
	holder.client.clear()
	vi.useRealTimers()
})

describe("useAccountQuery — request count", () => {
	it("a settings drill-down (four screens within a minute) reads the account once", async () => {
		await mountAndSettle()
		await mountAndSettle()
		await mountAndSettle()
		await mountAndSettle()

		expect(mockGetUserInfo).toHaveBeenCalledTimes(1)
	})

	it("a persisted row older than a minute rereads on its first mount", async () => {
		holder.client.setQueryData([BASE_QUERY_KEY], account, { updatedAt: Date.now() - 61 * 1000 })

		await mountAndSettle()
		await mountAndSettle()

		expect(mockGetUserInfo).toHaveBeenCalledTimes(1)
	})

	it("rereads on the next mount after markAccountStale, without fetching for a mounted screen", async () => {
		const { result, unmount } = renderHook(() => useAccountQuery(), { wrapper })

		await waitFor(() => expect(result.current.data).toBeDefined())

		markAccountStale()

		await new Promise(resolve => setTimeout(resolve, 10))

		expect(mockGetUserInfo).toHaveBeenCalledTimes(1)

		unmount()

		await mountAndSettle()

		expect(mockGetUserInfo).toHaveBeenCalledTimes(2)
	})
})

describe("accountQueryPatch", () => {
	it("writes the fields and keeps the row's dataUpdatedAt, with no reread", async () => {
		const readAt = Date.now() - 30 * 1000

		holder.client.setQueryData([BASE_QUERY_KEY], account, { updatedAt: readAt })

		accountQueryPatch({ nickName: "new", versioningEnabled: false })

		const state = holder.client.getQueryState<Account>([BASE_QUERY_KEY])

		expect(state?.data?.nickName).toBe("new")
		expect(state?.data?.versioningEnabled).toBe(false)
		expect(state?.data?.storageUsed).toBe(100n)
		expect(state?.dataUpdatedAt).toBe(readAt)
		expect(mockGetUserInfo).not.toHaveBeenCalled()
	})

	it("does nothing before the account was ever read", () => {
		accountQueryPatch({ nickName: "new" })

		expect(holder.client.getQueryState([BASE_QUERY_KEY])).toBeUndefined()
	})
})

describe("accountQueryPatch while a read is out", () => {
	function deferred<T>() {
		let resolve: (value: T) => void = () => {}
		let reject: (error: unknown) => void = () => {}
		const promise = new Promise<T>((res, rej) => {
			resolve = res
			reject = rej
		})

		return { promise, resolve, reject }
	}

	function cachedAccount(): Account | undefined {
		return holder.client.getQueryData<Account>([BASE_QUERY_KEY])
	}

	// A stale row renders while the mount read is out, as on Settings > Account.
	async function mountReading(read: Promise<Account>) {
		holder.client.setQueryData([BASE_QUERY_KEY], account, { updatedAt: Date.now() - 61 * 1000 })
		mockGetUserInfo.mockImplementationOnce(() => read)

		const screen = renderHook(() => useAccountQuery(), { wrapper })

		await waitFor(() => expect(mockGetUserInfo).toHaveBeenCalledTimes(1))

		return screen
	}

	it("a switch flipped meanwhile survives the read's older answer, with no extra request", async () => {
		const read = deferred<Account>()
		const screen = await mountReading(read.promise)

		accountQueryPatch({ versioningEnabled: false })
		read.resolve({ ...account, storageUsed: 300n })

		await waitFor(() => expect(screen.result.current.fetchStatus).toBe("idle"))

		expect(cachedAccount()?.versioningEnabled).toBe(false)
		expect(cachedAccount()?.storageUsed).toBe(300n)
		expect(mockGetUserInfo).toHaveBeenCalledTimes(1)

		screen.unmount()
	})

	it("several writes during one read all survive it, the later one winning", async () => {
		const read = deferred<Account>()
		const screen = await mountReading(read.promise)

		accountQueryPatch({ nickName: "first", versioningEnabled: false })
		accountQueryPatch({ nickName: "second" })
		read.resolve(account)

		await waitFor(() => expect(screen.result.current.fetchStatus).toBe("idle"))

		expect(cachedAccount()?.nickName).toBe("second")
		expect(cachedAccount()?.versioningEnabled).toBe(false)

		screen.unmount()
	})

	it("a quota check that joined the read gets its answer, not a cancellation", async () => {
		const read = deferred<Account>()
		const screen = await mountReading(read.promise)
		const fresh = fetchFreshAccount()

		accountQueryPatch({ versioningEnabled: false })
		read.resolve({ ...account, storageUsed: 300n })

		expect((await fresh).storageUsed).toBe(300n)
		expect(mockGetUserInfo).toHaveBeenCalledTimes(1)

		screen.unmount()
	})

	it("a storage bump is not laid over the read: its figure is the server's own", async () => {
		const read = deferred<Account>()
		const screen = await mountReading(read.promise)

		addAccountStorageUsed(50n)

		expect(cachedAccount()?.storageUsed).toBe(150n)

		read.resolve({ ...account, storageUsed: 500n })

		await waitFor(() => expect(screen.result.current.fetchStatus).toBe("idle"))

		expect(cachedAccount()?.storageUsed).toBe(500n)

		screen.unmount()
	})

	it("a read that fails keeps the patch, and a later read is not overridden", async () => {
		const read = deferred<Account>()
		const screen = await mountReading(read.promise)

		accountQueryPatch({ versioningEnabled: false })
		read.reject(new Error("offline"))

		await waitFor(() => expect(screen.result.current.fetchStatus).toBe("idle"))

		expect(cachedAccount()?.versioningEnabled).toBe(false)

		// Switched back on another device since: a read that starts after the write has the server's value.
		mockGetUserInfo.mockResolvedValueOnce({ ...account, versioningEnabled: true })

		await screen.result.current.refetch()

		expect(cachedAccount()?.versioningEnabled).toBe(true)

		screen.unmount()
	})

	it("a reread that replaced the read out at the write has the server's value, and is not overridden", async () => {
		const read = deferred<Account>()
		const screen = await mountReading(read.promise)

		// 2FA turned on while the mount read is out, then off again: disabling rereads, cancelling that read.
		accountQueryPatch({ twoFactorEnabled: true, twoFactorKey: undefined })
		mockGetUserInfo.mockResolvedValueOnce({ ...account, twoFactorEnabled: false, twoFactorKey: "k2" })

		await screen.result.current.refetch()

		expect(cachedAccount()?.twoFactorEnabled).toBe(false)
		expect(cachedAccount()?.twoFactorKey).toBe("k2")
		expect(mockGetUserInfo).toHaveBeenCalledTimes(2)

		screen.unmount()
	})

	it("a write during the reread is laid over the reread; one made before it is not", async () => {
		const first = deferred<Account>()
		const screen = await mountReading(first.promise)

		accountQueryPatch({ nickName: "before the reread" })

		const second = deferred<Account>()

		mockGetUserInfo.mockImplementationOnce(() => second.promise)

		const reread = screen.result.current.refetch()

		await waitFor(() => expect(mockGetUserInfo).toHaveBeenCalledTimes(2))

		accountQueryPatch({ versioningEnabled: false })
		second.resolve({ ...account, nickName: "server" })

		await reread

		// The reread was sent after the nickname write, so its nickname stands; it may predate the versioning write.
		expect(cachedAccount()?.nickName).toBe("server")
		expect(cachedAccount()?.versioningEnabled).toBe(false)

		screen.unmount()
	})
})

describe("quota helpers", () => {
	it("trusts a cached account for ten minutes, then not; nothing cached is never fresh", () => {
		const now = Date.now()

		expect(accountQuotaDeps.isCachedFresh?.()).toBe(false)

		holder.client.setQueryData([BASE_QUERY_KEY], account, { updatedAt: now - ACCOUNT_QUOTA_TRUST_MS + 1000 })

		expect(accountQuotaDeps.isCachedFresh?.()).toBe(true)
		expect(accountQuotaDeps.cached()).toBe(account)

		holder.client.setQueryData([BASE_QUERY_KEY], account, { updatedAt: now - ACCOUNT_QUOTA_TRUST_MS - 1000 })

		expect(accountQuotaDeps.isCachedFresh?.()).toBe(false)
	})

	it("a fresh read goes through the query: concurrent callers share one request and the cache keeps it", async () => {
		const [first, second] = await Promise.all([fetchFreshAccount(), fetchFreshAccount()])

		expect(mockGetUserInfo).toHaveBeenCalledOnce()
		expect(first).toBe(account)
		expect(second).toBe(account)
		expect(holder.client.getQueryData([BASE_QUERY_KEY])).toBe(account)
	})

	it("adds copied or uploaded bytes to storageUsed, keeping the read's stamp", () => {
		const readAt = Date.now() - 5000

		holder.client.setQueryData([BASE_QUERY_KEY], account, { updatedAt: readAt })

		addAccountStorageUsed(50n)

		const state = holder.client.getQueryState<Account>([BASE_QUERY_KEY])

		expect(state?.data?.storageUsed).toBe(150n)
		expect(state?.dataUpdatedAt).toBe(readAt)
	})

	it("adds nothing without a cached account or bytes", () => {
		addAccountStorageUsed(50n)

		expect(holder.client.getQueryState([BASE_QUERY_KEY])).toBeUndefined()

		holder.client.setQueryData([BASE_QUERY_KEY], account)
		addAccountStorageUsed(0n)

		expect(holder.client.getQueryData<Account>([BASE_QUERY_KEY])?.storageUsed).toBe(100n)
	})
})

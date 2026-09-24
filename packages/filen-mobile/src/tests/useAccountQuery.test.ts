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

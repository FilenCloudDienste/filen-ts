import { describe, expect, it, vi } from "vitest"
import type { UserInfo } from "@filen/sdk-rs"

// The real sdk client module imports a Vite `?worker`, unresolvable under node vitest — mock it
// down to the one method this query calls, mirroring session.test.ts's mock boundary.
const { getUserInfo } = vi.hoisted(() => ({ getUserInfo: vi.fn<() => Promise<UserInfo>>() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getUserInfo } }))

import { queryClient } from "@/queries/client"
import { accountQueryUpdate, fetchAccount, markAccountStale, ACCOUNT_QUERY_KEY } from "@/queries/account"

describe("account query", () => {
	it("queryKey is the stable, exact tuple every consumer imports", () => {
		expect(ACCOUNT_QUERY_KEY).toEqual(["account"])
	})

	it("fetchAccount delegates to sdkApi.getUserInfo and returns its result verbatim", async () => {
		const info = { email: "user@example.com", twoFactorEnabled: false } as UserInfo
		getUserInfo.mockResolvedValueOnce(info)

		await expect(fetchAccount()).resolves.toBe(info)
		expect(getUserInfo).toHaveBeenCalledTimes(1)
		expect(getUserInfo).toHaveBeenCalledWith()
	})

	it("propagates a rejection from sdkApi.getUserInfo unchanged", async () => {
		const error = new Error("boom")
		getUserInfo.mockRejectedValueOnce(error)

		await expect(fetchAccount()).rejects.toBe(error)
	})
})

// An upload batch writes the account once per file.
describe("account writes", () => {
	it("find the cached account by its key's hash, never by scanning the query cache", () => {
		queryClient.clear()
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, { storageUsed: 1n })

		for (let i = 0; i < 20; i++) {
			queryClient.setQueryData(["other", i], i)
		}

		const scan = vi.spyOn(queryClient.getQueryCache(), "getAll")

		accountQueryUpdate(prev => ({ ...prev, storageUsed: prev.storageUsed + 1n }))
		markAccountStale()
		accountQueryUpdate(prev => ({ ...prev, storageUsed: prev.storageUsed + 1n }))

		expect(scan).not.toHaveBeenCalled()
		expect(queryClient.getQueryData<UserInfo>(ACCOUNT_QUERY_KEY)?.storageUsed).toBe(3n)
		// The patch after the mark keeps it.
		expect(queryClient.getQueryState(ACCOUNT_QUERY_KEY)?.isInvalidated).toBe(true)

		scan.mockRestore()
		queryClient.clear()
	})
})

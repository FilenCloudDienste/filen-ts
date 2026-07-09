import { describe, expect, it, vi } from "vitest"
import type { UserInfo } from "@filen/sdk-rs"

// The real sdk client module imports a Vite `?worker`, unresolvable under node vitest — mock it
// down to the one method this query calls, mirroring session.test.ts's mock boundary.
const { getUserInfo } = vi.hoisted(() => ({ getUserInfo: vi.fn<() => Promise<UserInfo>>() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getUserInfo } }))

import { fetchAccount, ACCOUNT_QUERY_KEY } from "@/queries/account"

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

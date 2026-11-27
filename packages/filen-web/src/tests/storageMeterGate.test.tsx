// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { UserInfo } from "@filen/sdk-rs"

// The sidebar meter gates on the cached account, not the query status: a failed background read keeps
// the account, and blanking the meter over it would drop a value that is still right.

const { getUserInfo } = vi.hoisted(() => ({ getUserInfo: vi.fn<() => Promise<UserInfo>>() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getUserInfo } }))
vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children }: { to: string; children: unknown }) => createElement("a", { href: to }, children as never)
}))
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
}))

import "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { StorageMeter } from "@/features/shell/components/storageMeter"
import { testUserInfo } from "@/tests/support/userInfo"

const ACCOUNT = testUserInfo({ storageUsed: 1024n, maxStorage: 1024n * 1024n })

function renderMeter(): void {
	render(createElement(QueryClientProvider, { client: queryClient }, createElement(StorageMeter)))
}

beforeEach(() => {
	queryClient.clear()
	getUserInfo.mockReset()
})

afterEach(() => {
	cleanup()
})

describe("StorageMeter", () => {
	it("keeps the last known usage when a background account read fails", async () => {
		getUserInfo.mockResolvedValueOnce(ACCOUNT)
		renderMeter()

		await screen.findByRole("progressbar")

		getUserInfo.mockRejectedValueOnce(new Error("transient"))
		await act(async () => {
			await queryClient.refetchQueries({ queryKey: ACCOUNT_QUERY_KEY })
			// The observer notifies subscribers on a later task, not when the fetch settles.
			await new Promise(resolve => setTimeout(resolve, 0))
		})

		expect(queryClient.getQueryState(ACCOUNT_QUERY_KEY)?.status).toBe("error")
		expect(screen.getByRole("progressbar")).toBeDefined()
	})

	it("links to the account settings' storage breakdown", async () => {
		getUserInfo.mockResolvedValueOnce(ACCOUNT)
		renderMeter()

		await screen.findByRole("progressbar")

		expect(screen.getByRole("link").getAttribute("href")).toBe("/settings/account")
	})

	it("renders no meter when the first read fails with nothing cached", async () => {
		getUserInfo.mockRejectedValueOnce(new Error("down"))
		renderMeter()

		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0))
		})

		expect(queryClient.getQueryState(ACCOUNT_QUERY_KEY)?.status).toBe("error")
		expect(screen.queryByRole("progressbar")).toBeNull()
	})
})

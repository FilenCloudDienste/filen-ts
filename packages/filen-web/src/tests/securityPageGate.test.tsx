// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, useEffect, type ComponentType } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { UserInfo } from "@filen/sdk-rs"
import type { AccountQuerySuccess } from "@/queries/account"

// The Security page gates on the cached account, not the query status: a failed background read keeps
// the account, and unmounting the rows over it would drop the 2FA row's one-time recovery key.

const { getUserInfo, twoFactorMounts } = vi.hoisted(() => ({
	getUserInfo: vi.fn<() => Promise<UserInfo>>(),
	twoFactorMounts: { count: 0 }
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getUserInfo } }))
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
}))
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("@/features/settings/components/security/changePassword", () => ({ ChangePasswordRow: () => null }))
vi.mock("@/features/settings/components/security/exportMasterKeys", () => ({ ExportMasterKeysRow: () => null }))
vi.mock("@/features/settings/components/security/deleteAccount", () => ({ DeleteAccountRow: () => null }))
vi.mock("@/features/settings/components/security/twoFactor", () => ({
	TwoFactorRow: ({ accountQuery }: { accountQuery: AccountQuerySuccess }) => {
		useEffect(() => {
			twoFactorMounts.count++
		}, [])

		return createElement("p", null, `2fa for ${accountQuery.data.email}`)
	}
}))

import "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { Route } from "@/routes/_app/settings/security"

const ACCOUNT = { email: "user@example.com" } as UserInfo
const SecurityPage = Route.options.component as ComponentType

function renderPage(): void {
	render(createElement(QueryClientProvider, { client: queryClient }, createElement(SecurityPage)))
}

beforeEach(() => {
	queryClient.clear()
	getUserInfo.mockReset()
	twoFactorMounts.count = 0
})

afterEach(() => {
	cleanup()
})

describe("SecurityPage", () => {
	it("keeps the rows mounted when a background account read fails", async () => {
		getUserInfo.mockResolvedValueOnce(ACCOUNT)
		renderPage()

		await screen.findByText("2fa for user@example.com")

		getUserInfo.mockRejectedValueOnce(new Error("transient"))
		await act(async () => {
			await queryClient.refetchQueries({ queryKey: ACCOUNT_QUERY_KEY })
			// The observer notifies subscribers on a later task, not when the fetch settles.
			await new Promise(resolve => setTimeout(resolve, 0))
		})

		expect(queryClient.getQueryState(ACCOUNT_QUERY_KEY)?.status).toBe("error")
		expect(screen.getByText("2fa for user@example.com")).toBeDefined()
		expect(screen.queryByText("Couldn't load your account")).toBeNull()
		expect(twoFactorMounts.count).toBe(1)
	})

	it("shows the error state when the first read fails with nothing cached", async () => {
		getUserInfo.mockRejectedValueOnce(new Error("down"))
		renderPage()

		await screen.findByText("Couldn't load your account")
		expect(screen.queryByText(/^2fa for/)).toBeNull()
	})
})

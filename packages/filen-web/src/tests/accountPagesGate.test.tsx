// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, useEffect, type ComponentType } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { UserInfo } from "@filen/sdk-rs"
import type { AccountQuerySuccess } from "@/queries/account"

// The Account and Billing pages gate on the cached account, not the query status: a failed background
// read keeps the account, and blanking the page over it would throw away what the user was looking at.

const { getUserInfo, probeMounts } = vi.hoisted(() => ({
	getUserInfo: vi.fn<() => Promise<UserInfo>>(),
	probeMounts: { count: 0 }
}))

// Stands in for one row per page, counting mounts so a remount shows up as well as an unmount.
function Probe({ accountQuery }: { accountQuery: AccountQuerySuccess }) {
	useEffect(() => {
		probeMounts.count++
	}, [])

	return createElement("p", null, `row for ${accountQuery.data.email}`)
}

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getUserInfo } }))
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
}))
vi.mock("@/features/settings/components/account/profileHeader", () => ({ ProfileHeader: () => null }))
vi.mock("@/features/settings/components/account/nicknameRow", () => ({ NicknameRow: Probe }))
vi.mock("@/features/settings/components/account/changeEmail", () => ({ ChangeEmailRow: () => null }))
vi.mock("@/features/settings/components/account/personalInfoRow", () => ({ PersonalInfoRow: () => null }))
vi.mock("@/features/settings/components/account/storageBreakdownRow", () => ({ StorageBreakdownRow: () => null }))
vi.mock("@/features/settings/components/account/gdprExportRow", () => ({ GdprExportRow: () => null }))
vi.mock("@/features/settings/components/account/accountPreferencesRows", () => ({ AccountPreferencesRows: () => null }))
vi.mock("@/features/settings/components/account/deleteAllVersionsRow", () => ({ DeleteAllVersionsRow: () => null }))
vi.mock("@/features/settings/components/account/deleteAllItemsRow", () => ({ DeleteAllItemsRow: () => null }))
vi.mock("@/features/settings/components/billing/currentPlanRow", () => ({ CurrentPlanRow: Probe }))
vi.mock("@/features/settings/components/billing/subscriptionsBlock", () => ({ SubscriptionsBlock: () => null }))
vi.mock("@/features/settings/components/billing/invoicesBlock", () => ({ InvoicesBlock: () => null }))
vi.mock("@/features/settings/components/billing/referralRow", () => ({ ReferralRow: () => null }))

import "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { Route as AccountRoute } from "@/routes/_app/settings/account"
import { Route as BillingRoute } from "@/routes/_app/settings/billing"

const ACCOUNT = { email: "user@example.com" } as UserInfo

function renderPage(page: ComponentType): void {
	render(createElement(QueryClientProvider, { client: queryClient }, createElement(page)))
}

beforeEach(() => {
	queryClient.clear()
	getUserInfo.mockReset()
	probeMounts.count = 0
})

afterEach(() => {
	cleanup()
})

describe.each([
	["AccountPage", AccountRoute.options.component as ComponentType],
	["BillingPage", BillingRoute.options.component as ComponentType]
])("%s", (_name, page) => {
	it("keeps the rows mounted when a background account read fails", async () => {
		getUserInfo.mockResolvedValueOnce(ACCOUNT)
		renderPage(page)

		await screen.findByText("row for user@example.com")

		getUserInfo.mockRejectedValueOnce(new Error("transient"))
		await act(async () => {
			await queryClient.refetchQueries({ queryKey: ACCOUNT_QUERY_KEY })
			// The observer notifies subscribers on a later task, not when the fetch settles.
			await new Promise(resolve => setTimeout(resolve, 0))
		})

		expect(queryClient.getQueryState(ACCOUNT_QUERY_KEY)?.status).toBe("error")
		expect(screen.getByText("row for user@example.com")).toBeDefined()
		expect(screen.queryByText("Couldn't load your account")).toBeNull()
		expect(probeMounts.count).toBe(1)
	})

	it("shows the error state when the first read fails with nothing cached", async () => {
		getUserInfo.mockRejectedValueOnce(new Error("down"))
		renderPage(page)

		await screen.findByText("Couldn't load your account")
		expect(screen.queryByText(/^row for/)).toBeNull()
	})
})

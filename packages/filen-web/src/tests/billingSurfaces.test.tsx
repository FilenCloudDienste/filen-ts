// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ComponentType, type ReactNode } from "react"
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react"
import { isRedirect } from "@tanstack/react-router"
import { onlineManager } from "@tanstack/react-query"
import type { UserAccountSubs, UserInfo } from "@filen/sdk-rs"
import type { AccountQuerySuccess } from "@/queries/account"

const { sdk, accountQueryUpdate, desktopBridge, masterKeys, accountQuery } = vi.hoisted(() => ({
	sdk: {
		setAppearOffline: vi.fn<(enabled: boolean) => Promise<void>>(),
		setVersioningEnabled: vi.fn(),
		setLoginAlertsEnabled: vi.fn()
	},
	accountQueryUpdate: vi.fn<(updater: (prev: UserInfo) => UserInfo) => void>(),
	desktopBridge: vi.fn<() => object | undefined>(() => undefined),
	masterKeys: { notExported: false },
	accountQuery: { current: null as AccountQuerySuccess | null }
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("@/queries/account", () => ({
	accountQueryUpdate,
	markAccountStale: vi.fn(),
	fetchAccountFresh: vi.fn(),
	useMasterKeysNotExported: () => masterKeys.notExported,
	useAccountQuery: () => accountQuery.current
}))
vi.mock("@/lib/desktop", () => ({ desktopBridge, desktopPlatform: () => undefined }))
vi.mock("@tanstack/react-router", async () => ({
	...(await vi.importActual<object>("@tanstack/react-router")),
	Link: ({ children, to, ...rest }: { children: ReactNode; to: string; "aria-label"?: string; "aria-describedby"?: string }) =>
		createElement("a", { href: to, "aria-label": rest["aria-label"], "aria-describedby": rest["aria-describedby"] }, children),
	useNavigate: () => vi.fn()
}))
vi.mock("@/features/settings/components/billing/subscriptionsBlock", () => ({
	SubscriptionsBlock: () => createElement("p", null, "subscriptions")
}))
vi.mock("@/features/settings/components/billing/invoicesBlock", () => ({ InvoicesBlock: () => createElement("p", null, "invoices") }))
vi.mock("@/features/settings/components/billing/plansView", () => ({
	PlansView: ({ planId }: { planId: number | undefined }) => createElement("p", null, `plans ${String(planId)}`)
}))
vi.mock("@/features/settings/components/billing/referralRow", () => ({ ReferralRow: () => null }))

import "@/lib/i18n"
import { settings as EN } from "@/locales/en/settings"
import { AccountPreferencesRows } from "@/features/settings/components/account/accountPreferencesRows"
import { SettingsSidebar } from "@/features/settings/components/settingsSidebar"
import { useWithdrawalNotice } from "@/features/settings/hooks/useWithdrawalNotice"
import { Route as BillingRoute } from "@/routes/_app/settings/billing"
import { Route as PlansRoute } from "@/routes/_app/settings/plans"
import { registerAllActions } from "@/lib/keymap/actions"

// The sidebar binds the section keys.
registerAllActions()

function info(overrides: Partial<UserInfo> = {}): UserInfo {
	return {
		email: "jane@example.com",
		subs: [],
		subsInvoices: [],
		storageUsed: 1n,
		maxStorage: 10n,
		versioningEnabled: false,
		loginAlertsEnabled: false,
		appearOffline: false,
		...overrides
	} as unknown as UserInfo
}

function query(data: UserInfo): AccountQuerySuccess {
	return { data, status: "success" } as unknown as AccountQuerySuccess
}

beforeEach(() => {
	onlineManager.setOnline(true)
	desktopBridge.mockReturnValue(undefined)
	masterKeys.notExported = false
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

describe("Appear offline", () => {
	it("sets the flag and patches the cached account without a read", async () => {
		sdk.setAppearOffline.mockResolvedValue(undefined)
		render(createElement(AccountPreferencesRows, { accountQuery: query(info()) }))

		await act(async () => {
			fireEvent.click(screen.getByRole("switch", { name: EN.settingsAppearOfflineTitle }))
			await Promise.resolve()
		})
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0))
		})

		expect(sdk.setAppearOffline).toHaveBeenCalledWith(true)

		const updater = accountQueryUpdate.mock.calls[0]?.[0]

		expect(updater?.(info()).appearOffline).toBe(true)
	})

	it("reads the current flag and is off offline", () => {
		onlineManager.setOnline(false)
		render(createElement(AccountPreferencesRows, { accountQuery: query(info({ appearOffline: true })) }))

		const toggle = screen.getByRole("switch", { name: EN.settingsAppearOfflineTitle })

		expect(toggle.getAttribute("aria-checked")).toBe("true")
		expect(toggle.hasAttribute("data-disabled") || toggle.getAttribute("aria-disabled") === "true").toBe(true)
	})
})

describe("Settings sidebar", () => {
	it("marks Security while the master keys are not exported, in words for screen readers", () => {
		masterKeys.notExported = true
		render(createElement(SettingsSidebar))

		expect(screen.getByRole("link", { name: "Security", description: "Master keys not exported" })).toBeDefined()
	})

	it("has no mark otherwise", () => {
		render(createElement(SettingsSidebar))

		expect(screen.queryByText(/Master keys not exported/)).toBeNull()
	})
})

describe("Billing page", () => {
	const page = BillingRoute.options.component as ComponentType

	function renderPage(): void {
		accountQuery.current = query(info())
		render(createElement(page))
	}

	it("shows subscriptions and invoices on the web", () => {
		renderPage()

		expect(screen.getByText("subscriptions")).toBeDefined()
		expect(screen.getByText("invoices")).toBeDefined()
		expect(screen.queryByText(EN.settingsBillingManageOnWeb)).toBeNull()
	})

	it("keeps only the plan display and a web billing link in the desktop app", () => {
		desktopBridge.mockReturnValue({})
		renderPage()

		expect(screen.getByRole("link", { name: EN.settingsBillingManageOnWeb }).getAttribute("href")).toBe(
			"https://app.filen.io/settings/billing"
		)
		expect(screen.queryByText("subscriptions")).toBeNull()
		expect(screen.queryByText("invoices")).toBeNull()
		expect(screen.queryByRole("link", { name: EN.settingsBillingSeePlans })).toBeNull()
	})
})

describe("Plans page", () => {
	const page = PlansRoute.options.component as ComponentType
	const beforeLoad = PlansRoute.options.beforeLoad as () => void

	it("renders the plans under its own heading, passing the preselected plan", () => {
		vi.spyOn(PlansRoute, "useSearch").mockReturnValue({ plan: 27 })
		accountQuery.current = query(info())
		render(createElement(page))

		expect(screen.getByRole("heading", { level: 1, name: EN.settingsSectionPlans })).toBeDefined()
		expect(screen.getByText("plans 27")).toBeDefined()
	})

	it("stays on the web and redirects to Billing in the desktop app", () => {
		expect(() => {
			beforeLoad()
		}).not.toThrow()

		desktopBridge.mockReturnValue({})

		let thrown: unknown

		try {
			beforeLoad()
		} catch (e) {
			thrown = e
		}

		expect(isRedirect(thrown)).toBe(true)
		expect((thrown as { options: { to: string } }).options.to).toBe("/settings/billing")
	})
})

describe("Settings sidebar entries", () => {
	it("lists Plans directly above Billing on the web", () => {
		render(createElement(SettingsSidebar))

		const labels = screen.getAllByRole("link").map(link => link.textContent)

		expect(labels.indexOf("Plans") + 1).toBe(labels.indexOf("Billing"))
	})

	it("has no Plans entry in the desktop app", async () => {
		desktopBridge.mockReturnValue({})
		vi.resetModules()

		;(await import("@/lib/keymap/actions")).registerAllActions()
		const fresh = await import("@/features/settings/components/settingsSidebar")

		render(createElement(fresh.SettingsSidebar))

		expect(screen.queryByRole("link", { name: "Plans" })).toBeNull()
		expect(screen.getByRole("link", { name: "Billing" })).toBeDefined()
	})
})

describe("useWithdrawalNotice", () => {
	function sub(start: number, overrides: Partial<UserAccountSubs> = {}): UserAccountSubs {
		return {
			id: `sub-${String(start)}`,
			planId: 1n,
			planName: "Pro",
			planCost: 1,
			gateway: "stripe",
			storage: 1n,
			activated: true,
			cancelled: false,
			startTimestamp: BigInt(start),
			...overrides
		}
	}

	it("picks the earliest-closing window and disappears when it closes", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date(2026, 10, 9, 12))

		const subs = [sub(new Date(2026, 10, 8, 9).getTime())]
		const { result } = renderHook(() => useWithdrawalNotice(subs))

		expect(result.current.notice?.sub.id).toBe(subs[0]?.id)

		act(() => {
			vi.advanceTimersByTime(new Date(2026, 10, 23).getTime() - new Date(2026, 10, 9, 12).getTime() + 1000)
		})

		expect(result.current.notice).toBeUndefined()
	})

	it("is absent with nothing eligible", () => {
		const { result } = renderHook(() => useWithdrawalNotice([sub(Date.now(), { withdrawRequested: 1n })]))

		expect(result.current.notice).toBeUndefined()
	})
})

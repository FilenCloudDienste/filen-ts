// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { onlineManager } from "@tanstack/react-query"
import type { UserAccountSubs, UserAccountSubsInvoices, UserInfo } from "@filen/sdk-rs"
import type { AccountQuerySuccess } from "@/queries/account"
import type { Pricing, PricingPlan } from "@/features/settings/lib/remoteConfig"

const { pricingQuery, createCheckout, withdrawSubscription, downloadInvoice, cancelSubscription, markAccountStale, desktopBridge, toast } =
	vi.hoisted(() => ({
		pricingQuery: { current: {} as { data: Pricing | null | undefined; isStale: boolean; isFetching: boolean; refetch: () => void } },
		createCheckout: vi.fn(),
		withdrawSubscription: vi.fn(),
		downloadInvoice: vi.fn(),
		cancelSubscription: vi.fn(),
		markAccountStale: vi.fn(),
		desktopBridge: vi.fn<() => object | undefined>(() => undefined),
		toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() }
	}))

vi.mock("@/features/settings/lib/remoteConfig", () => ({ useRemotePricingQuery: () => pricingQuery.current }))
vi.mock("@/features/settings/lib/billingActions", async () => ({
	...(await vi.importActual<object>("@/features/settings/lib/billingActions")),
	createCheckout,
	withdrawSubscription,
	downloadInvoice,
	cancelSubscription
}))
vi.mock("@/queries/account", () => ({ markAccountStale, accountQueryUpdate: vi.fn() }))
vi.mock("@/lib/desktop", () => ({ desktopBridge, desktopPlatform: () => undefined }))
vi.mock("sonner", () => ({ toast }))
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to, search }: { children: ReactNode; to: string; search?: Record<string, unknown> }) =>
		createElement(
			"a",
			{ href: `${to}${search === undefined ? "" : `?${new URLSearchParams(search as Record<string, string>).toString()}`}` },
			children
		),
	useNavigate: () => vi.fn()
}))

import "@/lib/i18n"
import { settings as EN } from "@/locales/en/settings"
import { PlansView } from "@/features/settings/components/billing/plansView"
import { WithdrawalDialog } from "@/features/settings/components/billing/withdrawalDialog"
import { InvoicesBlock } from "@/features/settings/components/billing/invoicesBlock"
import { SubscriptionsBlock } from "@/features/settings/components/billing/subscriptionsBlock"
import { CurrentPlanRow } from "@/features/settings/components/billing/currentPlanRow"

function plan(overrides: Partial<PricingPlan>): PricingPlan {
	return { termType: 2, id: 27, name: "Pro I", cost: 2, sale: 0, storage: 1e12, popular: false, term: "monthly", ...overrides }
}

const PRICING: Pricing = {
	lifetimeEnabled: false,
	saleEnabled: false,
	plans: [
		plan({ id: 27 }),
		plan({ id: 30, name: "Pro II", termType: 3, term: "annually", cost: 20 }),
		plan({ id: 90, termType: 4, term: "lifetime", name: "Pro lifetime" })
	]
}

function setPricing(data: Pricing | null | undefined, extra: { isStale?: boolean; isFetching?: boolean } = {}): void {
	pricingQuery.current = { data, isStale: extra.isStale ?? false, isFetching: extra.isFetching ?? false, refetch: vi.fn() }
}

const DAY = 24 * 60 * 60 * 1000

function sub(overrides: Partial<UserAccountSubs>): UserAccountSubs {
	return {
		id: "sub-aaaaaaaa-1",
		planId: 27n,
		planName: "Pro I",
		planCost: 1.99,
		gateway: "stripe",
		storage: 1n,
		activated: true,
		cancelled: false,
		startTimestamp: BigInt(Date.now() - 2 * DAY),
		...overrides
	}
}

function info(overrides: Partial<UserInfo> = {}): UserInfo {
	return {
		email: "jane@example.com",
		displayName: "",
		nickName: undefined,
		personal: { firstName: "Jane", lastName: "Doe", country: "Germany" },
		subs: [],
		subsInvoices: [],
		storageUsed: 1n,
		maxStorage: 10n,
		...overrides
	} as unknown as UserInfo
}

function query(data: UserInfo): AccountQuerySuccess {
	return { data, status: "success" } as unknown as AccountQuerySuccess
}

async function openMenu(trigger: HTMLElement): Promise<void> {
	await act(async () => {
		trigger.focus()
		fireEvent.keyDown(trigger, { key: "ArrowDown" })
		await Promise.resolve()
	})
}

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

// jsdom lays nothing out; the deep-linked card scrolls itself into view.
Element.prototype.scrollIntoView = vi.fn()

beforeEach(() => {
	onlineManager.setOnline(true)
	desktopBridge.mockReturnValue(undefined)
	setPricing(PRICING)
})

afterEach(() => {
	cleanup()
})

describe("PlansView", () => {
	function renderPlans(data: UserInfo = info(), planId?: number): void {
		render(createElement(PlansView, { accountQuery: query(data), planId }))
	}

	it("shows Monthly and Annually tabs, hides Lifetime while lifetime sales are off, and opens on Monthly", () => {
		renderPlans()

		const tabs = screen.getAllByRole("tab").map(tab => tab.textContent)

		expect(tabs).toEqual([EN.settingsBillingTabMonthly, EN.settingsBillingTabAnnually])
		expect(screen.getByRole("tab", { name: EN.settingsBillingTabMonthly }).getAttribute("aria-selected")).toBe("true")
		expect(screen.getByText("Pro I (Monthly)")).toBeDefined()
	})

	it("shows the Lifetime tab when enabled", () => {
		setPricing({ ...PRICING, lifetimeEnabled: true })
		renderPlans()

		expect(screen.getByRole("tab", { name: EN.settingsBillingTabLifetime })).toBeDefined()
	})

	it("opens on the deep-linked plan's tab and marks its card", () => {
		renderPlans(info(), 30)

		expect(screen.getByRole("tab", { name: EN.settingsBillingTabAnnually }).getAttribute("aria-selected")).toBe("true")
		expect(document.querySelector("[aria-current='true']")?.textContent).toContain("Pro II")
	})

	it("strikes the regular price through and shows the discount during a sale", () => {
		setPricing({ ...PRICING, saleEnabled: true, plans: [plan({ cost: 10, sale: 7.5 })] })
		renderPlans()

		expect(screen.getByText("−25%")).toBeDefined()
		expect(screen.getByText(/Regular price/)).toBeDefined()
		expect(screen.getByText(EN.settingsBillingLimited)).toBeDefined()
	})

	it("shows the renewal terms for recurring plans only", () => {
		renderPlans()

		expect(screen.getByText(EN.settingsBillingLegalRenewal)).toBeDefined()
		expect(screen.queryByText(EN.settingsBillingLegalOneTime)).toBeNull()
		expect(screen.getByText(/Terms of Service/)).toBeDefined()
	})

	it("shows the one-time terms without renewal wording on the Lifetime tab", async () => {
		setPricing({ ...PRICING, lifetimeEnabled: true })
		renderPlans(info(), 90)

		expect(screen.getByRole("tab", { name: EN.settingsBillingTabLifetime }).getAttribute("aria-selected")).toBe("true")
		expect(screen.getByText(EN.settingsBillingLegalOneTime)).toBeDefined()
		expect(screen.queryByText(EN.settingsBillingLegalRenewal)).toBeNull()
		expect(screen.getByText(/Terms of Service/)).toBeDefined()

		await act(async () => {
			fireEvent.click(screen.getByRole("tab", { name: EN.settingsBillingTabMonthly }))
			await Promise.resolve()
		})

		expect(screen.getByText(EN.settingsBillingLegalRenewal)).toBeDefined()
		expect(screen.queryByText(EN.settingsBillingLegalOneTime)).toBeNull()
	})

	it("shows both terms on a tab mixing recurring and lifetime-term plans", () => {
		setPricing({
			lifetimeEnabled: true,
			saleEnabled: false,
			plans: [
				plan({ id: 1, termType: 1, name: "Starter" }),
				plan({ id: 75, termType: 1, name: "Starter lifetime", term: "lifetime" })
			]
		})
		renderPlans()

		expect(screen.getByText(EN.settingsBillingLegalRenewal)).toBeDefined()
		expect(screen.getByText(EN.settingsBillingLegalOneTime)).toBeDefined()
	})

	it("marks a plan the account already holds", () => {
		renderPlans(info({ subs: [sub({ planId: 27n })] }))

		expect(screen.getByText(EN.settingsBillingCurrentPlanBadge)).toBeDefined()
	})

	it("keeps Buy off in development builds", () => {
		renderPlans()

		expect(screen.getByText(EN.settingsBillingBuyDevDisabled)).toBeDefined()
		expect(screen.getByRole<HTMLButtonElement>("button", { name: new RegExp(EN.settingsBillingBuy) }).disabled).toBe(true)
	})

	it("keeps Buy off while a stale config is being re-read", () => {
		vi.stubEnv("DEV", false)
		setPricing(PRICING, { isStale: true, isFetching: true })
		renderPlans()

		expect(screen.getByText(EN.settingsBillingBuyLoadingPrices)).toBeDefined()
		expect(screen.getByRole<HTMLButtonElement>("button", { name: new RegExp(EN.settingsBillingBuy) }).disabled).toBe(true)
	})

	it("shows an error with a retry when the config could not be read", () => {
		setPricing(null)
		renderPlans()

		expect(screen.getByText(EN.settingsBillingPlansLoadError)).toBeDefined()
	})

	it("creates a checkout for the chosen method and offers the payment link", async () => {
		vi.stubEnv("DEV", false)
		createCheckout.mockResolvedValue({ status: "success", item: "https://checkout.example/s" })
		renderPlans()

		await openMenu(screen.getByRole("button", { name: new RegExp(EN.settingsBillingBuy) }))
		expect(screen.queryByRole("menuitem", { name: EN.settingsBillingMethodCrypto })).toBeNull()

		await act(async () => {
			fireEvent.click(screen.getByRole("menuitem", { name: EN.settingsBillingMethodCard }))
			await Promise.resolve()
		})
		await settle()

		expect(createCheckout).toHaveBeenCalledWith(27, "stripe")

		const link = screen.getByRole("link", { name: new RegExp(EN.settingsBillingPayInvoice) })

		expect(link.getAttribute("href")).toBe("https://checkout.example/s")
		expect(link.getAttribute("rel")).toBe("noopener noreferrer")

		fireEvent.click(link)
		expect(markAccountStale).toHaveBeenCalled()
	})

	it("asks for a country first and names the VAT reason", async () => {
		vi.stubEnv("DEV", false)
		renderPlans(info({ personal: { firstName: "Jane", country: undefined } as UserInfo["personal"] }))

		await openMenu(screen.getByRole("button", { name: new RegExp(EN.settingsBillingBuy) }))
		await act(async () => {
			fireEvent.click(screen.getByRole("menuitem", { name: EN.settingsBillingMethodPaypal }))
			await Promise.resolve()
		})

		expect(screen.getByText(EN.settingsBillingCountryRequired)).toBeDefined()
		expect(createCheckout).not.toHaveBeenCalled()
	})
})

describe("WithdrawalDialog", () => {
	function renderDialog(data: UserInfo, subId?: string): { onOpenChange: ReturnType<typeof vi.fn> } {
		const onOpenChange = vi.fn()

		render(createElement(WithdrawalDialog, { open: true, account: data, now: Date.now(), subId, onOpenChange }))

		return { onOpenChange }
	}

	it("prefills name and email and shows the single contract without a chooser", () => {
		renderDialog(info({ subs: [sub({})] }))

		expect(screen.getByLabelText<HTMLInputElement>(EN.settingsBillingWithdrawName).value).toBe("Jane Doe")
		expect(screen.getByLabelText<HTMLInputElement>(EN.settingsBillingWithdrawEmail).value).toBe("jane@example.com")
		expect(screen.queryByRole("combobox")).toBeNull()
		expect(screen.getByText(/#sub-aaaa/)).toBeDefined()
	})

	it("offers a chooser when several contracts are open, preselecting the given one", () => {
		renderDialog(info({ subs: [sub({ id: "first-000" }), sub({ id: "second-00", planName: "Pro II" })] }), "second-00")

		expect(screen.getByRole("combobox").textContent).toContain("Pro II")
	})

	it("submits with the UI language's receipt language and confirms receipt", async () => {
		withdrawSubscription.mockResolvedValue({ status: "received", at: 1n })

		const { onOpenChange } = renderDialog(info({ subs: [sub({})] }))

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: EN.settingsBillingWithdrawConfirm }))
			await Promise.resolve()
		})
		await settle()

		expect(withdrawSubscription).toHaveBeenCalledWith({
			subId: "sub-aaaaaaaa-1",
			name: "Jane Doe",
			email: "jane@example.com",
			lang: "en"
		})
		expect(toast.success).toHaveBeenCalledWith(EN.settingsBillingWithdrawSuccess)
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it("warns when the receipt may be missing", async () => {
		withdrawSubscription.mockResolvedValue({ status: "unconfirmed", at: 1n })
		renderDialog(info({ subs: [sub({})] }))

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: EN.settingsBillingWithdrawConfirm }))
			await Promise.resolve()
		})
		await settle()

		expect(toast.warning).toHaveBeenCalledWith(EN.settingsBillingWithdrawReceiptMissing)
	})

	it("keeps the dialog open and words a server refusal", async () => {
		withdrawSubscription.mockResolvedValue({
			status: "error",
			dto: { species: "sdk", kind: "Server", label: "", message: "", serverCode: "cannot_withdraw_sub_now" }
		})

		const { onOpenChange } = renderDialog(info({ subs: [sub({})] }))

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: EN.settingsBillingWithdrawConfirm }))
			await Promise.resolve()
		})
		await settle()

		expect(toast.error).toHaveBeenCalledWith(EN.settingsBillingErrorCannotWithdraw)
		expect(onOpenChange).not.toHaveBeenCalled()
	})

	it("validates name and email before sending", async () => {
		renderDialog(info({ subs: [sub({})] }))

		fireEvent.change(screen.getByLabelText(EN.settingsBillingWithdrawName), { target: { value: "  " } })
		fireEvent.change(screen.getByLabelText(EN.settingsBillingWithdrawEmail), { target: { value: "nope" } })
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: EN.settingsBillingWithdrawConfirm }))
			await Promise.resolve()
		})

		expect(screen.getByText(EN.settingsBillingWithdrawNameRequired)).toBeDefined()
		expect(screen.getByText(EN.settingsBillingWithdrawEmailInvalid)).toBeDefined()
		expect(withdrawSubscription).not.toHaveBeenCalled()
	})

	it("says so when no contract is open", () => {
		renderDialog(info({ subs: [sub({ withdrawRequested: 1n })] }))

		expect(screen.getByText(EN.settingsBillingWithdrawNoneEligible)).toBeDefined()
	})
})

describe("SubscriptionsBlock", () => {
	it("offers withdrawal, billing details and cancel, and shows a received withdrawal", () => {
		render(
			createElement(SubscriptionsBlock, {
				accountQuery: query(info({ subs: [sub({}), sub({ id: "done", withdrawRequested: BigInt(Date.now()) })] }))
			})
		)

		expect(screen.getAllByRole("button", { name: new RegExp(EN.settingsBillingWithdraw) })).toHaveLength(1)
		expect(screen.getAllByRole("link", { name: new RegExp(EN.settingsBillingDetails) })[0]?.getAttribute("href")).toContain(
			"billing.stripe.com"
		)
		expect(screen.getAllByRole("button", { name: EN.settingsBillingCancelAction })).toHaveLength(2)
		expect(screen.getByText(/Withdrawal received on/)).toBeDefined()
	})

	it("holds cancel back within a day of the start and hides it for one-off purchases", () => {
		render(
			createElement(SubscriptionsBlock, {
				accountQuery: query(
					info({ subs: [sub({ startTimestamp: BigInt(Date.now() - 1000) }), sub({ id: "life", gateway: "stripe_sale" })] })
				)
			})
		)

		const buttons = screen.getAllByRole("button", { name: EN.settingsBillingCancelAction })

		expect(buttons).toHaveLength(1)
		expect(buttons[0]?.hasAttribute("disabled")).toBe(true)
		expect(screen.getByText(/Can be cancelled from/)).toBeDefined()
	})

	it("cancels after confirming", async () => {
		cancelSubscription.mockResolvedValue({ status: "success" })
		render(createElement(SubscriptionsBlock, { accountQuery: query(info({ subs: [sub({})] })) }))

		fireEvent.click(screen.getByRole("button", { name: EN.settingsBillingCancelAction }))

		const dialog = screen.getByRole("alertdialog")

		await act(async () => {
			fireEvent.click(within(dialog).getByRole("button", { name: EN.settingsBillingCancelConfirm }))
			await Promise.resolve()
		})
		await settle()

		expect(cancelSubscription).toHaveBeenCalledWith(expect.objectContaining({ id: "sub-aaaaaaaa-1" }))
		expect(toast.success).toHaveBeenCalledWith(EN.settingsBillingCancelSuccess)
	})
})

describe("InvoicesBlock", () => {
	const invoices = [
		{ id: "inv-1", gateway: "stripe", planCost: 1.99, planName: "Pro I", subId: "s", timestamp: 1_700_000_000_000n },
		{ id: "inv-2", gateway: "paypal", planCost: 1.99, planName: "Pro I", subId: "s", timestamp: 1_700_100_000_000n }
	] as UserAccountSubsInvoices[]

	it("downloads one invoice at a time", async () => {
		let finish: (value: { status: "success" }) => void = () => undefined

		downloadInvoice.mockReturnValue(
			new Promise(resolve => {
				finish = resolve
			})
		)
		render(createElement(InvoicesBlock, { accountQuery: query(info({ subsInvoices: invoices })) }))

		const [first] = screen.getAllByRole("button", { name: /Download invoice/ })

		if (first === undefined) {
			throw new Error("no download button")
		}

		fireEvent.click(first)

		expect(downloadInvoice).toHaveBeenCalledWith(invoices[0])
		expect(screen.getAllByRole("button", { name: /Download invoice/ }).every(button => button.hasAttribute("disabled"))).toBe(true)

		await act(async () => {
			finish({ status: "success" })
			await Promise.resolve()
		})

		expect(screen.getAllByRole("button", { name: /Download invoice/ }).some(button => button.hasAttribute("disabled"))).toBe(false)
	})

	it("is off offline", () => {
		onlineManager.setOnline(false)
		render(createElement(InvoicesBlock, { accountQuery: query(info({ subsInvoices: invoices })) }))

		expect(screen.getAllByRole("button", { name: /Download invoice/ }).every(button => button.hasAttribute("disabled"))).toBe(true)
	})
})

describe("CurrentPlanRow", () => {
	it("opens the plans on the web and shows the free-tier note", () => {
		render(createElement(CurrentPlanRow, { accountQuery: query(info()) }))

		expect(screen.getByRole("link", { name: EN.settingsBillingSeePlans }).getAttribute("href")).toBe("/settings/plans")
		expect(screen.getByText(EN.settingsBillingFreeTierNote)).toBeDefined()
	})

	it("has no plans link in the desktop app", () => {
		desktopBridge.mockReturnValue({})
		render(createElement(CurrentPlanRow, { accountQuery: query(info()) }))

		expect(screen.queryByRole("link", { name: EN.settingsBillingSeePlans })).toBeNull()
	})

	it("drops the free-tier note for a Pro account", () => {
		render(createElement(CurrentPlanRow, { accountQuery: query(info({ subs: [sub({})] })) }))

		expect(screen.queryByText(EN.settingsBillingFreeTierNote)).toBeNull()
	})
})

import type { UserAccountSubs } from "@filen/sdk-rs"
import type { SettingsKey } from "@/lib/i18n"
import type { Pricing, PricingPlan, PlanTerm } from "@/features/settings/lib/remoteConfig"

export type PlanTab = "monthly" | "annually" | "starter" | "lifetime"

// The config's termType: 1 Starter (any term, a lifetime Starter included), 2 monthly, 3 annually, 4 lifetime.
const TERM_TYPE_TABS: ReadonlyMap<number, PlanTab> = new Map([
	[1, "starter"],
	[2, "monthly"],
	[3, "annually"],
	[4, "lifetime"]
])

export const PLAN_TAB_ORDER: readonly PlanTab[] = ["monthly", "annually", "starter", "lifetime"]

export const DEFAULT_PLAN_TAB: PlanTab = "monthly"

// The short word after a price: "/month", "/year", "one-time".
export const PRICE_SUFFIX_KEYS: Record<PlanTerm, SettingsKey> = {
	monthly: "settingsBillingPricePerMonth",
	annually: "settingsBillingPricePerYear",
	lifetime: "settingsBillingPriceOnce"
}

export type PaymentMethod = "stripe" | "paypal" | "crypto"

export interface PlanCard {
	plan: PricingPlan
	// The price charged now: the sale price while a sale applies.
	price: number
	// Set only while a sale lowers the price.
	discountPercent: number | undefined
	limited: boolean
	methods: PaymentMethod[]
	// Annual plans only, when a monthly plan with the same storage exists: how much less a year costs than twelve
	// of its months, in whole percent (both at the price charged now).
	annualSavingsPercent: number | undefined
}

export interface PlanGroup {
	tab: PlanTab
	cards: PlanCard[]
}

function discountPercent(plan: PricingPlan, saleEnabled: boolean): number | undefined {
	if (!saleEnabled || !(plan.sale > 0 && plan.sale < plan.cost)) {
		return undefined
	}

	return Math.round(((plan.cost - plan.sale) / plan.cost) * 100)
}

// Crypto is offered for one-off purchases only; the backend refuses it for anything else.
function paymentMethods(plan: PricingPlan): PaymentMethod[] {
	return plan.term === "lifetime" ? ["stripe", "paypal", "crypto"] : ["stripe", "paypal"]
}

function chargedPrice(plan: PricingPlan, discount: number | undefined): number {
	return discount === undefined ? plan.cost : plan.sale
}

function annualSavingsPercent(price: number, monthlyPrice: number | undefined): number | undefined {
	if (monthlyPrice === undefined || !(monthlyPrice > 0)) {
		return undefined
	}

	const percent = Math.round((1 - price / (monthlyPrice * 12)) * 100)

	return percent > 0 ? percent : undefined
}

function toCard(plan: PricingPlan, saleEnabled: boolean, monthlyPriceByStorage: ReadonlyMap<number, number>): PlanCard {
	const discount = discountPercent(plan, saleEnabled)
	const price = chargedPrice(plan, discount)

	return {
		plan,
		price,
		discountPercent: discount,
		limited: plan.term === "lifetime" || discount !== undefined,
		methods: paymentMethods(plan),
		annualSavingsPercent: plan.term === "annually" ? annualSavingsPercent(price, monthlyPriceByStorage.get(plan.storage)) : undefined
	}
}

// What a monthly plan of each storage size charges now; the first one listed wins a tie.
function monthlyPrices(pricing: Pricing): Map<number, number> {
	const byStorage = new Map<number, number>()

	for (const plan of pricing.plans) {
		if (plan.term === "monthly" && !byStorage.has(plan.storage)) {
			byStorage.set(plan.storage, chargedPrice(plan, discountPercent(plan, pricing.saleEnabled)))
		}
	}

	return byStorage
}

// Tabs in display order, empty ones dropped. Lifetime-term plans are hidden in every tab while lifetime sales are off.
export function groupPlans(pricing: Pricing): PlanGroup[] {
	const byTab = new Map<PlanTab, PlanCard[]>()
	const monthlyPriceByStorage = monthlyPrices(pricing)

	for (const plan of pricing.plans) {
		const tab = TERM_TYPE_TABS.get(plan.termType)

		if (tab === undefined || (plan.term === "lifetime" && !pricing.lifetimeEnabled)) {
			continue
		}

		const cards = byTab.get(tab) ?? []

		cards.push(toCard(plan, pricing.saleEnabled, monthlyPriceByStorage))
		byTab.set(tab, cards)
	}

	return PLAN_TAB_ORDER.flatMap(tab => {
		const cards = byTab.get(tab)

		return cards === undefined ? [] : [{ tab, cards: cards.sort((a, b) => a.plan.storage - b.plan.storage) }]
	})
}

// A tab's "save x%" hint: the saving every annual plan in it shares, else the largest as "up to".
export function tabSavings(cards: readonly PlanCard[]): { percent: number; upTo: boolean } | undefined {
	const annual = cards.filter(card => card.plan.term === "annually")
	const percents = annual.flatMap(card => (card.annualSavingsPercent === undefined ? [] : [card.annualSavingsPercent]))

	if (percents.length === 0) {
		return undefined
	}

	const max = Math.max(...percents)

	return { percent: max, upTo: percents.length < annual.length || percents.some(percent => percent !== max) }
}

// The tab to open: the one holding a preselected plan, else Monthly, else the first there is.
export function initialPlanTab(groups: readonly PlanGroup[], planId: number | undefined): PlanTab | undefined {
	if (planId !== undefined) {
		const holding = groups.find(group => group.cards.some(card => card.plan.id === planId))

		if (holding !== undefined) {
			return holding.tab
		}
	}

	return groups.some(group => group.tab === DEFAULT_PLAN_TAB) ? DEFAULT_PLAN_TAB : groups[0]?.tab
}

// A subscription's term, read from the pricing already held; undefined for a plan no longer on offer.
export function planTermOf(pricing: Pricing | null | undefined, planId: bigint): PlanTerm | undefined {
	const id = Number(planId)

	return pricing?.plans.find(plan => plan.id === id)?.term
}

// Plan ids the account holds a live subscription for.
export function currentPlanIds(subs: readonly Pick<UserAccountSubs, "planId" | "activated" | "cancelled">[]): Set<number> {
	return new Set(subs.filter(sub => sub.activated && !sub.cancelled).map(sub => Number(sub.planId)))
}

// The dev build reads the test config, whose plan ids mean other plans (or none) on the production backend.
export function purchasesEnabled(): boolean {
	return !import.meta.env.DEV
}

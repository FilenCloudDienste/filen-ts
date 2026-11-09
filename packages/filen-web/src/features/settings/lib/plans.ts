import type { UserAccountSubs } from "@filen/sdk-rs"
import type { Pricing, PricingPlan } from "@/features/settings/lib/remoteConfig"

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

export type PaymentMethod = "stripe" | "paypal" | "crypto"

export interface PlanCard {
	plan: PricingPlan
	// The price charged now: the sale price while a sale applies.
	price: number
	// Set only while a sale lowers the price.
	discountPercent: number | undefined
	limited: boolean
	methods: PaymentMethod[]
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

function toCard(plan: PricingPlan, saleEnabled: boolean): PlanCard {
	const discount = discountPercent(plan, saleEnabled)

	return {
		plan,
		price: discount === undefined ? plan.cost : plan.sale,
		discountPercent: discount,
		limited: plan.term === "lifetime" || discount !== undefined,
		methods: paymentMethods(plan)
	}
}

// Tabs in display order, empty ones dropped. Lifetime-term plans are hidden in every tab while lifetime sales are off.
export function groupPlans(pricing: Pricing): PlanGroup[] {
	const byTab = new Map<PlanTab, PlanCard[]>()

	for (const plan of pricing.plans) {
		const tab = TERM_TYPE_TABS.get(plan.termType)

		if (tab === undefined || (plan.term === "lifetime" && !pricing.lifetimeEnabled)) {
			continue
		}

		const cards = byTab.get(tab) ?? []

		cards.push(toCard(plan, pricing.saleEnabled))
		byTab.set(tab, cards)
	}

	return PLAN_TAB_ORDER.flatMap(tab => {
		const cards = byTab.get(tab)

		return cards === undefined ? [] : [{ tab, cards: cards.sort((a, b) => a.plan.storage - b.plan.storage) }]
	})
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

// Plan ids the account holds a live subscription for.
export function currentPlanIds(subs: readonly Pick<UserAccountSubs, "planId" | "activated" | "cancelled">[]): Set<number> {
	return new Set(subs.filter(sub => sub.activated && !sub.cancelled).map(sub => Number(sub.planId)))
}

// The dev build reads the test config, whose plan ids mean other plans (or none) on the production backend.
export function purchasesEnabled(): boolean {
	return !import.meta.env.DEV
}

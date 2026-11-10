import { describe, expect, it, vi } from "vitest"
import type { Pricing, PricingPlan } from "@/features/settings/lib/remoteConfig"
import { currentPlanIds, groupPlans, initialPlanTab, planTermOf, purchasesEnabled, tabSavings } from "@/features/settings/lib/plans"

function plan(overrides: Partial<PricingPlan>): PricingPlan {
	return { termType: 2, id: 1, name: "Pro I", cost: 2, sale: 0, storage: 1e12, popular: false, term: "monthly", ...overrides }
}

function pricing(plans: PricingPlan[], overrides: Partial<Pricing> = {}): Pricing {
	return { lifetimeEnabled: false, saleEnabled: false, plans, ...overrides }
}

describe("groupPlans", () => {
	it("groups by termType into Monthly, Annually, Starter, Lifetime and drops empty tabs", () => {
		const groups = groupPlans(
			pricing(
				[
					plan({ id: 3, termType: 3, term: "annually" }),
					plan({ id: 1, termType: 1, name: "Starter" }),
					plan({ id: 2, termType: 2 }),
					plan({ id: 4, termType: 4, term: "lifetime" })
				],
				{ lifetimeEnabled: true }
			)
		)

		expect(groups.map(group => group.tab)).toEqual(["monthly", "annually", "starter", "lifetime"])
		expect(groupPlans(pricing([plan({ id: 3, termType: 3, term: "annually" })])).map(group => group.tab)).toEqual(["annually"])
	})

	it("hides every lifetime-term plan, the Starter lifetime one included, while lifetime sales are off", () => {
		const plans = [
			plan({ id: 1, termType: 1, name: "Starter" }),
			plan({ id: 75, termType: 1, term: "lifetime" }),
			plan({ id: 4, termType: 4, term: "lifetime" })
		]

		expect(groupPlans(pricing(plans)).flatMap(group => group.cards.map(card => card.plan.id))).toEqual([1])
		expect(groupPlans(pricing(plans, { lifetimeEnabled: true })).flatMap(group => group.cards.map(card => card.plan.id))).toEqual([
			1, 75, 4
		])
	})

	it("sorts a tab's cards by storage", () => {
		const [group] = groupPlans(pricing([plan({ id: 2, storage: 2e12 }), plan({ id: 1, storage: 1e12 })]))

		expect(group?.cards.map(card => card.plan.id)).toEqual([1, 2])
	})

	it("applies a sale only while sales are on and the sale price is below the cost", () => {
		const sale = plan({ cost: 10, sale: 7.5 })

		expect(groupPlans(pricing([sale]))[0]?.cards[0]).toMatchObject({ price: 10, discountPercent: undefined, limited: false })
		expect(groupPlans(pricing([sale], { saleEnabled: true }))[0]?.cards[0]).toMatchObject({
			price: 7.5,
			discountPercent: 25,
			limited: true
		})
		expect(groupPlans(pricing([plan({ cost: 10, sale: 10 })], { saleEnabled: true }))[0]?.cards[0]?.discountPercent).toBeUndefined()
		expect(groupPlans(pricing([plan({ cost: 10, sale: 0 })], { saleEnabled: true }))[0]?.cards[0]?.discountPercent).toBeUndefined()
	})

	it("marks lifetime plans limited and offers crypto for lifetime terms only", () => {
		const groups = groupPlans(
			pricing([plan({ id: 2 }), plan({ id: 75, termType: 1, term: "lifetime" }), plan({ id: 4, termType: 4, term: "lifetime" })], {
				lifetimeEnabled: true
			})
		)
		const cards = new Map(groups.flatMap(group => group.cards.map(card => [card.plan.id, card] as const)))

		expect(cards.get(2)).toMatchObject({ limited: false, methods: ["stripe", "paypal"] })
		expect(cards.get(75)).toMatchObject({ limited: true, methods: ["stripe", "paypal", "crypto"] })
		expect(cards.get(4)).toMatchObject({ limited: true, methods: ["stripe", "paypal", "crypto"] })
	})

	it("compares an annual plan with twelve months of the monthly plan of the same storage, at the prices charged now", () => {
		const plans = [
			plan({ id: 1, cost: 1.99, storage: 2e11 }),
			plan({ id: 2, cost: 8.99, sale: 6.99, storage: 2e12 }),
			plan({ id: 3, termType: 3, term: "annually", cost: 19.99, storage: 2e11 }),
			plan({ id: 4, termType: 3, term: "annually", cost: 89.99, sale: 69.99, storage: 2e12 }),
			plan({ id: 5, termType: 3, term: "annually", cost: 99, storage: 5e12 })
		]
		const savings = (groups: ReturnType<typeof groupPlans>) =>
			new Map(groups.flatMap(group => group.cards.map(card => [card.plan.id, card.annualSavingsPercent] as const)))

		expect(savings(groupPlans(pricing(plans)))).toEqual(
			new Map([
				[1, undefined],
				[2, undefined],
				[3, 16],
				[4, 17],
				[5, undefined]
			])
		)
		expect(savings(groupPlans(pricing(plans, { saleEnabled: true }))).get(4)).toBe(17)
	})
})

describe("tabSavings", () => {
	function annualCards(plans: PricingPlan[]) {
		return groupPlans(pricing(plans)).find(group => group.tab === "annually")?.cards ?? []
	}

	it("names the shared saving, or the largest as up to when annual plans differ or some have no monthly match", () => {
		const monthly = [plan({ id: 1, cost: 10, storage: 1 }), plan({ id: 2, cost: 20, storage: 2 })]

		expect(
			tabSavings(
				annualCards([
					...monthly,
					plan({ id: 3, termType: 3, term: "annually", cost: 100, storage: 1 }),
					plan({ id: 4, termType: 3, term: "annually", cost: 200, storage: 2 })
				])
			)
		).toEqual({ percent: 17, upTo: false })
		expect(
			tabSavings(
				annualCards([
					...monthly,
					plan({ id: 3, termType: 3, term: "annually", cost: 100, storage: 1 }),
					plan({ id: 4, termType: 3, term: "annually", cost: 120, storage: 2 })
				])
			)
		).toEqual({ percent: 50, upTo: true })
		expect(
			tabSavings(
				annualCards([
					...monthly,
					plan({ id: 3, termType: 3, term: "annually", cost: 100, storage: 1 }),
					plan({ id: 4, termType: 3, term: "annually", cost: 100, storage: 9 })
				])
			)
		).toEqual({ percent: 17, upTo: true })
		expect(tabSavings(annualCards([plan({ id: 3, termType: 3, term: "annually", cost: 100, storage: 9 })]))).toBeUndefined()
	})
})

describe("planTermOf", () => {
	it("reads a subscription's term from the pricing held, undefined for a plan no longer offered", () => {
		const held = pricing([plan({ id: 36, termType: 3, term: "annually" })])

		expect(planTermOf(held, 36n)).toBe("annually")
		expect(planTermOf(held, 99n)).toBeUndefined()
		expect(planTermOf(null, 36n)).toBeUndefined()
	})
})

describe("initialPlanTab", () => {
	const groups = groupPlans(pricing([plan({ id: 2 }), plan({ id: 3, termType: 3, term: "annually" })]))

	it("opens the tab holding a preselected plan", () => {
		expect(initialPlanTab(groups, 3)).toBe("annually")
	})

	it("falls back to Monthly for an unknown or hidden plan, else the first tab", () => {
		expect(initialPlanTab(groups, 999)).toBe("monthly")
		expect(initialPlanTab(groups, undefined)).toBe("monthly")
		expect(initialPlanTab(groupPlans(pricing([plan({ id: 3, termType: 3, term: "annually" })])), undefined)).toBe("annually")
		expect(initialPlanTab([], undefined)).toBeUndefined()
	})
})

describe("currentPlanIds", () => {
	it("holds the plans of live subscriptions only", () => {
		const ids = currentPlanIds([
			{ planId: 27n, activated: true, cancelled: false },
			{ planId: 30n, activated: true, cancelled: true },
			{ planId: 33n, activated: false, cancelled: false }
		])

		expect([...ids]).toEqual([27])
	})
})

describe("purchasesEnabled", () => {
	it("is off in development builds, whose test config ids are not production's", () => {
		vi.stubEnv("DEV", true)
		expect(purchasesEnabled()).toBe(false)

		vi.stubEnv("DEV", false)
		expect(purchasesEnabled()).toBe(true)
	})
})

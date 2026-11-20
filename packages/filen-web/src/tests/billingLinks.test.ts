// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest"
import { parsePlanId, plansTargetOfPath } from "@/features/settings/lib/billingLinks"
import { rememberPlansTarget, takePlansTarget } from "@/features/settings/lib/pendingPlans"

describe("plansTargetOfPath", () => {
	it("keeps a valid plan id from the path", () => {
		expect(plansTargetOfPath("/settings/plans/27")).toEqual({ plan: 27 })
		expect(plansTargetOfPath("/settings/plans/30/")).toEqual({ plan: 30 })
		expect(plansTargetOfPath("/settings/plans")).toEqual({})
		expect(plansTargetOfPath("/settings/plans/")).toEqual({})
	})

	it("drops a bad plan id, never the page", () => {
		expect(plansTargetOfPath("/settings/plans/1e3")).toEqual({})
		expect(plansTargetOfPath("/settings/plans/0")).toEqual({})
		expect(plansTargetOfPath("/settings/plans/1.5")).toEqual({})
		expect(plansTargetOfPath("/settings/plans/-3")).toEqual({})
	})

	it("is null for any other page", () => {
		expect(plansTargetOfPath("/settings/billing")).toBeNull()
		expect(plansTargetOfPath("/settings/plansx")).toBeNull()
		expect(plansTargetOfPath("/settings/plans/27/extra")).toBeNull()
	})

	it("parses plan ids strictly", () => {
		expect(parsePlanId("12")).toBe(12)
		expect(parsePlanId(" 12")).toBeUndefined()
		expect(parsePlanId(undefined)).toBeUndefined()
		expect(parsePlanId(Number.MAX_SAFE_INTEGER + 2)).toBeUndefined()
	})
})

describe("pending plans target", () => {
	beforeEach(() => {
		sessionStorage.clear()
	})

	it("carries a plan through sign-in once", () => {
		rememberPlansTarget(27)

		expect(takePlansTarget()).toEqual({ plan: 27 })
		expect(takePlansTarget()).toBeNull()
	})

	it("carries the plans page without a plan", () => {
		rememberPlansTarget(undefined)

		expect(takePlansTarget()).toEqual({})
	})

	it("is empty when nothing was remembered", () => {
		expect(takePlansTarget()).toBeNull()
	})
})

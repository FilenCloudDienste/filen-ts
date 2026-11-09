// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest"
import { parsePlanId, validatePlansSearch } from "@/features/settings/lib/billingLinks"
import { rememberPlansTarget, takePlansTarget } from "@/features/settings/lib/pendingPlans"

describe("validatePlansSearch", () => {
	it("keeps a valid plan id, numeric strings included", () => {
		expect(validatePlansSearch({ plan: 27 })).toEqual({ plan: 27 })
		expect(validatePlansSearch({ plan: "30" })).toEqual({ plan: 30 })
		expect(validatePlansSearch({})).toEqual({})
	})

	it("drops a bad plan id", () => {
		expect(validatePlansSearch({ plan: "1e3" })).toEqual({})
		expect(validatePlansSearch({ plan: 0 })).toEqual({})
		expect(validatePlansSearch({ plan: 1.5 })).toEqual({})
		expect(validatePlansSearch({ plan: null })).toEqual({})
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

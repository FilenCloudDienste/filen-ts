import { describe, it, expect } from "vitest"
import { isProAccount } from "@filen/shared"

// Mirrors filen-backend's isUserPro (subs WHERE activated = 1): the backend gates links and chat attachments by it.
describe("isProAccount", () => {
	it("is Free without subscriptions", () => {
		expect(isProAccount([])).toBe(false)
	})

	it("is Pro with an activated subscription", () => {
		expect(isProAccount([{ activated: false }, { activated: true }])).toBe(true)
	})

	it("stays Pro for a cancelled subscription that is still activated (paid period running)", () => {
		expect(isProAccount([{ activated: true, cancelled: true } as { activated: boolean }])).toBe(true)
	})

	it("is Free when every subscription has been deactivated", () => {
		expect(isProAccount([{ activated: false }, { activated: false }])).toBe(false)
	})
})

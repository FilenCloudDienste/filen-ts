import { describe, it, expect } from "vitest"
import { shouldRedact } from "@/components/privacyScreenLogic"

describe("shouldRedact (privacy cover decision)", () => {
	it("never redacts while the biometric lock is up — lock wins, it redacts itself", () => {
		expect(shouldRedact("background", false, true)).toBe(false)
		expect(shouldRedact("inactive", false, true)).toBe(false)
		expect(shouldRedact("active", false, true)).toBe(false)
		// even with a presentation flag set, the lock still wins
		expect(shouldRedact("inactive", true, true)).toBe(false)
	})

	it("never redacts while the app is active (foreground)", () => {
		expect(shouldRedact("active", false, false)).toBe(false)
		expect(shouldRedact("active", true, false)).toBe(false)
	})

	it("always redacts on a real background — snapshot-safe, ignores the presentation grace", () => {
		expect(shouldRedact("background", false, false)).toBe(true)
		expect(shouldRedact("background", true, false)).toBe(true)
	})

	it("redacts on inactive when no presentation is active/recent (e.g. a plain home-press)", () => {
		expect(shouldRedact("inactive", false, false)).toBe(true)
	})

	it("suppresses on inactive during / just-after an in-app presentation (no flicker around Face ID / PIN / pickers)", () => {
		expect(shouldRedact("inactive", true, false)).toBe(false)
	})
})

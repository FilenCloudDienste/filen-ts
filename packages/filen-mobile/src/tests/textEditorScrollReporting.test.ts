import { describe, it, expect } from "vitest"
import { isScrolled, SCROLLED_THRESHOLD_PX } from "@/components/textEditor/scrollReporting"

describe("isScrolled", () => {
	it("is false at rest", () => {
		expect(isScrolled(0)).toBe(false)
	})

	it("is false for overscroll above the top", () => {
		// iOS rubber-band reports a NEGATIVE scrollTop while the document is still resting at the top.
		// Treating that as scrolled would flash the scrim every time the user bounces the document.
		expect(isScrolled(-1)).toBe(false)
		expect(isScrolled(-120)).toBe(false)
	})

	it("does not trip at the threshold itself, only past it", () => {
		expect(isScrolled(SCROLLED_THRESHOLD_PX)).toBe(false)
		expect(isScrolled(SCROLLED_THRESHOLD_PX + 1)).toBe(true)
	})

	it("is true once the document is genuinely scrolled", () => {
		expect(isScrolled(40)).toBe(true)
		expect(isScrolled(5000)).toBe(true)
	})

	it("keeps the threshold small enough to fire before content clears the header", () => {
		// The scrim exists because content passes UNDER a transparent header, so it has to be on well
		// before a header's worth of document has scrolled past. Pinned so a future "less flicker"
		// tweak cannot quietly push it past the point where the title is already unreadable.
		expect(SCROLLED_THRESHOLD_PX).toBeGreaterThan(0)
		expect(SCROLLED_THRESHOLD_PX).toBeLessThan(20)
	})
})

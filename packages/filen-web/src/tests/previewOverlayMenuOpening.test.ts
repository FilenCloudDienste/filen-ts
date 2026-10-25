// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import { menuOpening } from "@/features/preview/components/previewOverlay.logic"

// The overlay leaves an Escape to a menu still opening (previewOverlay.tsx), which has not taken focus yet.
describe("menuOpening", () => {
	it("is true only while a menu trigger reports its menu open", () => {
		const root = document.createElement("div")
		const trigger = document.createElement("button")

		trigger.setAttribute("aria-haspopup", "menu")
		trigger.setAttribute("aria-expanded", "false")
		root.append(trigger)

		expect(menuOpening(root)).toBe(false)

		trigger.setAttribute("aria-expanded", "true")

		expect(menuOpening(root)).toBe(true)
	})
})

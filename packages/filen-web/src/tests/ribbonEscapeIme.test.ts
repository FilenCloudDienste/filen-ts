// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import { onRibbonEscape } from "@/features/office/components/ribbon/ribbonFocus"

// An Escape that ends an input method's composition in a ribbon field is the composition's: focus stays in the field.

describe("Escape on the ribbon while composing", () => {
	it("is left to the input method", () => {
		const root = document.createElement("div")
		const bar = document.createElement("div")
		const field = document.createElement("input")

		bar.setAttribute("data-office-ribbon", "")
		bar.append(field)
		root.append(bar)
		document.body.append(root)

		let focused = false
		let prevented = false
		const event = {
			key: "Escape",
			ctrlKey: false,
			metaKey: false,
			altKey: false,
			defaultPrevented: false,
			target: field,
			preventDefault: () => {
				prevented = true
			}
		}
		const focus = (): void => {
			focused = true
		}

		expect(onRibbonEscape({ ...event, isComposing: true }, root, focus, "bubble")).toBe(false)
		expect(onRibbonEscape({ ...event, nativeEvent: { isComposing: true } }, root, focus, "bubble")).toBe(false)
		expect([focused, prevented]).toEqual([false, false])
		// Not composing: the ribbon's Escape.
		expect(onRibbonEscape(event, root, focus, "bubble")).toBe(true)
		root.remove()
	})
})

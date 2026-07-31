// @vitest-environment happy-dom

// Guards the checklist checkbox's HIT TARGET, which is not the same box as the circle you see.
//
// Quill attaches the toggle handler to the `.ql-ui` span, positions it absolutely so it shrink-wraps
// its marker, and pulls the marker into the list item's gutter with `margin-left: -1.5em`. A negative
// margin SHRINKS a shrink-to-fit box, so a theme that sizes the marker without neutralizing that pull
// collapses the span to a few pixels sitting BESIDE the circle — measured at 4px wide against an 18px
// circle offset 21px to its left, in Chromium. Tapping the circle then only works where the engine
// happens to route the overflowing ::before back to its originating element, which is why it
// presented as "only the right-hand edge of the checkbox toggles".
//
// These assertions encode the two halves of the fix. They are deliberately about the checklist
// markers only: bullets and ordered numbers are not interactive and keep Quill's geometry.

import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("quill", () => ({
	default: class Quill {}
}))

import { QuillThemeCustomizer } from "@/components/textEditor/richText/quillTheme"
import type Quill from "quill"

function generatedCss(): string {
	const customizer = new QuillThemeCustomizer({})

	customizer.apply({} as Quill)

	return document.getElementById("quill-custom-styles")?.textContent ?? ""
}

/** Collapses whitespace so assertions do not depend on the template's indentation. */
function normalized(): string {
	return generatedCss().replace(/\s+/g, " ")
}

describe("checklist checkbox hit target", () => {
	beforeEach(() => {
		document.head.replaceChildren()
	})

	it("gives the toggle span a real box instead of letting it shrink-wrap", () => {
		const css = normalized()

		expect(css).toContain("li[data-list=unchecked] > .ql-ui, ")
		expect(css).toMatch(/li\[data-list=checked\] > \.ql-ui \{ margin-left: -1\.5em; width: 1\.5em; \}/)
	})

	it("keeps the pull-back as a margin so nested items track their indent", () => {
		// `left: 0` also produces a correctly-sized box, and is wrong: .ql-ui is positioned against
		// the list item, whose padding-left grows per indent level, so anchoring to the item's edge
		// drags every nested checkbox to the far left. Measured at 78px vs 36px for one indent.
		const css = normalized()
		const rule = css.slice(css.indexOf("li[data-list=unchecked] > .ql-ui, "))

		expect(rule.slice(0, rule.indexOf("}"))).not.toContain("left: 0")
	})

	it("neutralizes the marker pull-back on both checkbox states", () => {
		// Without this the span collapses and the circle drifts left of whatever receives the tap.
		// Both states need it — a checked item is just as tappable as an unchecked one.
		const css = normalized()
		const unchecked = css.slice(css.indexOf("li[data-list=unchecked] > .ql-ui:before"))
		const checked = css.slice(css.indexOf("li[data-list=checked] > .ql-ui:before"))

		expect(unchecked.slice(0, unchecked.indexOf("}"))).toContain("margin-left: 0")
		expect(checked.slice(0, checked.indexOf("}"))).toContain("margin-left: 0")
	})

	it("still draws both checkbox states at the same size", () => {
		// The fix must not move or resize the circle — it only changes which box receives the tap.
		const css = normalized()

		expect(css.match(/width: 16px; height: 16px;/g)?.length).toBe(2)
	})

	it("leaves bullet and ordered markers alone", () => {
		// They are not interactive, and Quill right-aligns them in the gutter using the very
		// margin-left this fix removes for checkboxes.
		const css = normalized()

		expect(css).not.toContain("li[data-list=bullet]")
		expect(css).not.toContain("li[data-list=ordered]")
	})
})

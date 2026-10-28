import { describe, expect, it } from "vitest"
import { slideRef } from "@filen/office/core/presentation"
import type { SlideRender } from "@filen/office/dom/presentation"
import { ribbonSlide } from "@/features/presentation/lib/ribbonSlide"

// The ribbon acts on the slide in view with nothing selected on it (the Transitions tab is the slide's), never on a
// slide the selection has not caught up with.

const ref = slideRef(10)
const render = { ref } as unknown as SlideRender

describe("the ribbon's slide", () => {
	it("is the slide in view with no shape selected", () => {
		expect(ribbonSlide(render, ref, { slide: undefined })).toBe(render)
		expect(ribbonSlide(render, ref, { slide: ref })).toBe(render)
	})

	it("is none while the selection names another slide or the render is another's", () => {
		expect(ribbonSlide(render, ref, { slide: slideRef(11) })).toBeUndefined()
		expect(ribbonSlide(render, slideRef(11), { slide: undefined })).toBeUndefined()
		expect(ribbonSlide(undefined, ref, { slide: ref })).toBeUndefined()
	})
})

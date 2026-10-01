// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import { Virtualizer, observeElementOffset, observeElementRect, elementScroll, type VirtualizerOptions } from "@tanstack/react-virtual"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

function scrollable(scrollTop: number): HTMLDivElement {
	const element = document.createElement("div")

	element.scrollTop = scrollTop
	document.body.append(element)

	return element
}

// A real virtualizer whose scroll element can be swapped, the way a listing's container remounts across a
// loading state.
function harness(observe: VirtualizerOptions<HTMLDivElement, HTMLDivElement>["observeElementOffset"]) {
	let current: HTMLDivElement | null = null
	const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
		count: 100,
		getScrollElement: () => current,
		estimateSize: () => 40,
		scrollToFn: elementScroll,
		observeElementRect,
		observeElementOffset: observe
	})

	return {
		virtualizer,
		attach: (element: HTMLDivElement | null) => {
			current = element
			virtualizer._willUpdate()
		}
	}
}

describe("observeElementOffsetFromAttach", () => {
	it("takes a replacement element's own offset instead of the old element's", () => {
		const { virtualizer, attach } = harness(observeElementOffsetFromAttach)
		const first = scrollable(0)

		attach(first)
		first.scrollTop = 1200
		first.dispatchEvent(new Event("scroll"))
		expect(virtualizer.scrollOffset).toBe(1200)

		attach(null)
		attach(scrollable(0))

		expect(virtualizer.scrollOffset).toBe(0)
	})

	it("is what the default observer gets wrong: it keeps the old element's offset", () => {
		const { virtualizer, attach } = harness(observeElementOffset)
		const first = scrollable(0)

		attach(first)
		first.scrollTop = 1200
		first.dispatchEvent(new Event("scroll"))

		attach(null)
		attach(scrollable(0))

		expect(virtualizer.scrollOffset).toBe(1200)
	})

	it("still follows scroll events after attaching", () => {
		const { virtualizer, attach } = harness(observeElementOffsetFromAttach)
		const element = scrollable(300)

		attach(element)
		expect(virtualizer.scrollOffset).toBe(300)

		element.scrollTop = 500
		element.dispatchEvent(new Event("scroll"))
		expect(virtualizer.scrollOffset).toBe(500)
	})
})

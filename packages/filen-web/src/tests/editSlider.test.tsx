// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { EditSlider } from "@/features/preview/imageEdit/components/editSlider"

// The editing slider's value pill and neutral mark: a "+" only on a slider running either side of 0, and the mark
// where `neutral` sits along the thumb's travel, none when it is an end.

class FakeResizeObserver {
	observe = vi.fn()
	unobserve = vi.fn()
	disconnect = vi.fn()
}

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

function slider(range: { min: number; max: number; neutral: number; value: number }) {
	vi.stubGlobal("ResizeObserver", FakeResizeObserver)

	const view = render(
		<EditSlider
			label="Size"
			step={1}
			onChange={() => undefined}
			onReset={() => undefined}
			{...range}
		/>
	)

	return view.container.querySelector<HTMLElement>('[data-slot="edit-slider-neutral"]')
}

describe("EditSlider", () => {
	it("shows a value off a neutral inside a positive range unsigned, marked where the neutral sits", () => {
		const mark = slider({ min: 2, max: 30, neutral: 8, value: 8 })

		expect(screen.getByText("8")).toBeTruthy()
		expect(screen.queryByText("+8")).toBeNull()
		expect(Number.parseFloat(mark?.style.left ?? "")).toBeCloseTo((6 / 28) * 100, 5)
	})

	it("signs a value on a slider centred on 0, marked in the middle", () => {
		const mark = slider({ min: -100, max: 100, neutral: 0, value: 8 })

		expect(screen.getByText("+8")).toBeTruthy()
		expect(mark?.style.left).toBe("50%")
	})

	it("marks no neutral at an end of the range", () => {
		const mark = slider({ min: 0, max: 100, neutral: 0, value: 20 })

		expect(mark).toBeNull()
		expect(screen.getByText("20")).toBeTruthy()
	})
})

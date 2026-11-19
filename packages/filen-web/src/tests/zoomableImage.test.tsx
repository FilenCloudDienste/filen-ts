// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ZoomableImage } from "@/features/preview/components/zoomableImage"
import "@/lib/i18n"

// Two fingers on the picture pinch it: their spread scales it, a single finger at 1x leaves it be.

beforeEach(() => {
	HTMLElement.prototype.setPointerCapture = vi.fn()
	HTMLElement.prototype.releasePointerCapture = vi.fn()
	HTMLElement.prototype.hasPointerCapture = vi.fn(() => true)
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 400))
})

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

function touch(type: "pointerDown" | "pointerMove" | "pointerUp", target: HTMLElement, pointerId: number, clientX: number): void {
	fireEvent[type](target, { pointerId, pointerType: "touch", button: 0, clientX, clientY: 200 })
}

function scaleOf(image: HTMLElement): number {
	return Number(/scale\(([^)]+)\)/.exec(image.style.transform)?.[1])
}

describe("ZoomableImage pinch", () => {
	it("scales the picture by the fingers' spread", () => {
		render(
			<ZoomableImage
				url="blob:a"
				alt="photo"
			/>
		)

		const image = screen.getByAltText("photo")

		touch("pointerDown", image, 1, 150)
		touch("pointerMove", image, 1, 120)
		expect(scaleOf(image)).toBe(1)

		touch("pointerDown", image, 2, 250)
		touch("pointerMove", image, 1, 100)
		touch("pointerMove", image, 2, 300)
		// 130 px apart at the start, 200 px now.
		expect(scaleOf(image)).toBeCloseTo(200 / 130)

		touch("pointerUp", image, 2, 300)
		// The finger left behind neither pinches nor jumps the picture.
		touch("pointerMove", image, 1, 50)
		expect(scaleOf(image)).toBeCloseTo(200 / 130)
	})
})

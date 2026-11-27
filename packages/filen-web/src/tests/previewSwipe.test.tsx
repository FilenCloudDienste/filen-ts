// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { swipePagesCategory, swipeStartsOn } from "@/features/preview/components/previewOverlay.logic"
import { usePreviewSwipe } from "@/features/preview/hooks/usePreviewSwipe"

// A touch swipe across a picture or a video pages the preview; a zoomed picture, a control or another viewer keeps the
// drag.

afterEach(() => {
	cleanup()
})

function Stage({ enabled, step, zoomed = false }: { enabled: boolean; step: (delta: 1 | -1) => void; zoomed?: boolean }) {
	const swipe = usePreviewSwipe(enabled, step)

	return (
		<div
			onPointerDown={swipe.onPointerDown}
			onPointerUp={swipe.onPointerUp}
			onPointerCancel={swipe.onPointerCancel}
			onClickCapture={swipe.onClickCapture}
		>
			<img
				alt="photo"
				data-zoomed={zoomed ? "" : undefined}
			/>
			<button type="button">control</button>
		</div>
	)
}

function drag(target: HTMLElement, dx: number, options: { pointerType?: string; dy?: number } = {}): void {
	const pointerType = options.pointerType ?? "touch"

	fireEvent.pointerDown(target, { pointerId: 1, pointerType, isPrimary: true, clientX: 200, clientY: 200 })
	fireEvent.pointerUp(target, { pointerId: 1, pointerType, isPrimary: true, clientX: 200 + dx, clientY: 200 + (options.dy ?? 0) })
}

describe("preview swipe", () => {
	it("pages on pictures and videos only", () => {
		expect(swipePagesCategory("image")).toBe(true)
		expect(swipePagesCategory("rawImage")).toBe(true)
		expect(swipePagesCategory("video")).toBe(true)
		expect(swipePagesCategory("text")).toBe(false)
		expect(swipePagesCategory("docx")).toBe(false)
		expect(swipePagesCategory("spreadsheet")).toBe(false)
		expect(swipePagesCategory(undefined)).toBe(false)
	})

	it("starts on the fitted picture, never a zoomed one, a control or a natively controlled video", () => {
		const img = document.createElement("img")
		const zoomed = document.createElement("img")
		const controlled = document.createElement("video")
		const picture = document.createElement("video")

		zoomed.setAttribute("data-zoomed", "")
		controlled.controls = true

		expect(swipeStartsOn(img)).toBe(true)
		expect(swipeStartsOn(picture)).toBe(true)
		expect(swipeStartsOn(zoomed)).toBe(false)
		expect(swipeStartsOn(controlled)).toBe(false)
		expect(swipeStartsOn(document.createElement("button"))).toBe(false)
		expect(swipeStartsOn(null)).toBe(false)
	})

	it("steps forward on a leftward swipe and back on a rightward one", () => {
		const step = vi.fn()

		render(
			<Stage
				enabled
				step={step}
			/>
		)
		drag(screen.getByAltText("photo"), -120)
		drag(screen.getByAltText("photo"), 120)

		expect(step.mock.calls).toEqual([[1], [-1]])
	})

	it("leaves a mouse drag, a short or vertical move, a control and a zoomed picture alone", () => {
		const step = vi.fn()
		const { rerender } = render(
			<Stage
				enabled
				step={step}
			/>
		)

		drag(screen.getByAltText("photo"), -120, { pointerType: "mouse" })
		drag(screen.getByAltText("photo"), -20)
		drag(screen.getByAltText("photo"), -60, { dy: 200 })
		drag(screen.getByRole("button"), -120)
		rerender(
			<Stage
				enabled
				step={step}
				zoomed
			/>
		)
		drag(screen.getByAltText("photo"), -120)

		expect(step).not.toHaveBeenCalled()
	})

	it("does nothing while disabled", () => {
		const step = vi.fn()

		render(
			<Stage
				enabled={false}
				step={step}
			/>
		)
		drag(screen.getByAltText("photo"), -120)

		expect(step).not.toHaveBeenCalled()
	})
})

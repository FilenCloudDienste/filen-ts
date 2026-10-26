// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { slideRef, type SlideRef } from "../core/presentation/model"
import { SlideRail } from "../react/presentation/rail/SlideRail"
import type { PresentationThumb } from "../react/presentation/store"
import { budget, cpuMs } from "./timing"

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const COUNT = 2000

it("scrolls a 2000-slide rail with a bounded window per step", { timeout: budget(30_000) }, async ({ task }) => {
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800)
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(220)

	const slides = Array.from({ length: COUNT }, (_, index) => ({ ref: slideRef(10 + index), hidden: index % 9 === 4 }))
	const thumbs = new Map<SlideRef, PresentationThumb>(
		slides.map(slide => [
			slide.ref,
			{ bitmap: { width: 192, height: 108, close: () => undefined }, revision: 0, width: 192, stale: false }
		])
	)
	const host = document.createElement("div")

	document.body.appendChild(host)

	const root = createRoot(host)
	const requestThumbnails = vi.fn()

	act(() =>
		root.render(
			<SlideRail
				slides={slides}
				thumbs={thumbs}
				aspect={0.5625}
				current={0}
				onSelect={() => undefined}
				requestThumbnails={requestThumbnails}
				label="Slides"
				slideLabel={index => `Slide ${String(index + 1)}`}
			/>
		)
	)

	const rail = host.querySelector<HTMLElement>("[role=listbox]")

	if (rail === null) throw new Error("no rail")

	const steps: number[] = []
	let mostMounted = 0

	// A fling through the whole rail in 400 steps of 255 px (about 2.5 items each).
	for (let step = 1; step <= 400; step++) {
		const start = cpuMs()

		rail.scrollTop = step * 255
		await act(async () => {
			rail.dispatchEvent(new Event("scroll"))
			await new Promise(resolve => requestAnimationFrame(resolve))
		})
		steps.push(cpuMs() - start)
		mostMounted = Math.max(mostMounted, host.querySelectorAll("[role=option]").length)
	}

	steps.sort((a, b) => a - b)

	const p95 = steps[Math.floor(steps.length * 0.95)] ?? 0
	const max = steps[steps.length - 1] ?? 0

	Object.assign(task.meta, {
		perf: { railScrollStepP95Ms: { value: p95, budget: 16 }, railMountedMax: { value: mostMounted, budget: 20 } }
	})

	// 800 px over 102 px items: 8 to 9 in view, 3 overscan each side, plus the current one.
	expect(mostMounted).toBeLessThanOrEqual(20)
	expect(p95).toBeLessThan(budget(16))
	expect(max).toBeLessThan(budget(50))

	act(() => root.unmount())
	host.remove()
})

import { describe, expect, it } from "vitest"
import {
	clampImageScale,
	containSize,
	clampPan,
	dragPan,
	wheelZoom,
	doubleClickZoom,
	pinchZoom,
	IMAGE_MIN_SCALE,
	IMAGE_MAX_SCALE,
	IMAGE_DOUBLE_CLICK_SCALE,
	type ZoomTransform
} from "@/features/preview/components/imageViewer.logic"

describe("clampImageScale", () => {
	it("clamps to the minimum", () => {
		expect(clampImageScale(0)).toBe(IMAGE_MIN_SCALE)
	})

	it("clamps to the maximum", () => {
		expect(clampImageScale(100)).toBe(IMAGE_MAX_SCALE)
	})

	it("passes through an in-range value", () => {
		expect(clampImageScale(2)).toBe(2)
	})
})

describe("containSize", () => {
	it("letterboxes a wider-than-container image on its height", () => {
		// natural 400x100 into a 200x200 container: fit = min(200/400, 200/100) = 0.5 -> 200x50
		expect(containSize({ width: 200, height: 200 }, { width: 400, height: 100 })).toEqual({ width: 200, height: 50 })
	})

	it("letterboxes a taller-than-container image on its width", () => {
		expect(containSize({ width: 200, height: 200 }, { width: 100, height: 400 })).toEqual({ width: 50, height: 200 })
	})

	// The <img> is never scaled up, so a small image's box is its own natural size.
	it("keeps an image smaller than the container at its natural size", () => {
		expect(containSize({ width: 1400, height: 800 }, { width: 300, height: 200 })).toEqual({ width: 300, height: 200 })
	})

	it("keeps a small image draggable only as far as its own zoomed edges", () => {
		// 300x200 at 8x is 2400x1600: at most (2400 - 1400) / 2 = 500 of horizontal pan.
		expect(dragPan({ x: 0, y: 0 }, { x: 5000, y: 5000 }, 8, { width: 1400, height: 800 }, { width: 300, height: 200 })).toEqual({
			x: 500,
			y: 400
		})
	})

	it("falls back to the container size when the natural size is degenerate", () => {
		expect(containSize({ width: 200, height: 200 }, { width: 0, height: 0 })).toEqual({ width: 200, height: 200 })
	})

	it("falls back to the container size when the container itself is degenerate (pre-layout)", () => {
		expect(containSize({ width: 0, height: 0 }, { width: 400, height: 100 })).toEqual({ width: 0, height: 0 })
	})
})

describe("clampPan", () => {
	it("allows no pan on an axis where the scaled content is smaller than the container", () => {
		const result = clampPan({ width: 200, height: 200 }, { width: 100, height: 100 }, 1, { x: 50, y: -50 })

		expect(result.x).toBe(0)
		// A -50 input clamped into a zero-width [-0, 0] range lands on -0 (Math.max/min's own IEEE-754
		// behavior) — toBeCloseTo (not toBe/toEqual, which use Object.is and would fail on -0 vs 0) is
		// the numerically-correct assertion: -0 === 0 for every purpose that matters here.
		expect(result.y).toBeCloseTo(0)
	})

	it("clamps so the content's own edge can reach the container's edge but no further", () => {
		// content 100x100 at scale 2 -> 200x200 in a 100x100 container: maxX = (200-100)/2 = 50
		const result = clampPan({ width: 100, height: 100 }, { width: 100, height: 100 }, 2, { x: 999, y: -999 })

		expect(result).toEqual({ x: 50, y: -50 })
	})

	it("passes through an offset already within bounds", () => {
		const result = clampPan({ width: 100, height: 100 }, { width: 100, height: 100 }, 2, { x: 10, y: -10 })

		expect(result).toEqual({ x: 10, y: -10 })
	})
})

describe("dragPan", () => {
	it("adds the drag delta to the pointerdown-time origin", () => {
		const result = dragPan({ x: 0, y: 0 }, { x: 20, y: -5 }, 1, { width: 500, height: 500 }, null)

		expect(result).toEqual({ x: 20, y: -5 })
	})

	it("clamps against the container once a natural size is known", () => {
		const result = dragPan({ x: 0, y: 0 }, { x: 500, y: 0 }, 2, { width: 100, height: 100 }, { width: 100, height: 100 })

		// Same bound as the clampPan test above: maxX = 50.
		expect(result.x).toBe(50)
	})
})

describe("wheelZoom", () => {
	const base: ZoomTransform = { scale: 1, x: 0, y: 0 }

	it("zooms in on a negative deltaY (wheel up)", () => {
		const result = wheelZoom(base, -100, { x: 0, y: 0 }, { width: 500, height: 500 }, null)

		expect(result.scale).toBeGreaterThan(1)
	})

	it("zooms out on a positive deltaY (wheel down)", () => {
		const zoomedIn: ZoomTransform = { scale: 2, x: 0, y: 0 }
		const result = wheelZoom(zoomedIn, 100, { x: 0, y: 0 }, { width: 500, height: 500 }, null)

		expect(result.scale).toBeLessThan(2)
	})

	it("resets pan to (0, 0) once zoomed back down to 1x or below", () => {
		const zoomedIn: ZoomTransform = { scale: 1.05, x: 40, y: -20 }
		const result = wheelZoom(zoomedIn, 1000, { x: 0, y: 0 }, { width: 500, height: 500 }, null)

		expect(result.scale).toBeLessThanOrEqual(1)
		expect(result).toEqual({ scale: result.scale, x: 0, y: 0 })
	})

	it("keeps the point under the cursor fixed on screen (zoom-toward-cursor)", () => {
		// Zooming from 1x to 2x around a cursor offset of (50, 0): translate' = pc + (translate - pc) * ratio
		// = 50 + (0 - 50) * 2 = -50.
		const result = wheelZoom({ scale: 1, x: 0, y: 0 }, -1 / 0.0015, { x: 50, y: 0 }, { width: 1000, height: 1000 }, null)

		expect(result.scale).toBeCloseTo(2, 5)
		expect(result.x).toBeCloseTo(-50, 5)
	})

	it("clamps the resulting pan once a natural size is known", () => {
		const result = wheelZoom(
			{ scale: 1, x: 0, y: 0 },
			-2000,
			{ x: 1000, y: 1000 },
			{ width: 100, height: 100 },
			{ width: 100, height: 100 }
		)

		expect(Math.abs(result.x)).toBeLessThanOrEqual((result.scale * 100 - 100) / 2 + 0.001)
	})
})

describe("pinchZoom", () => {
	const container = { width: 1000, height: 1000 }

	it("scales by the fingers' spread around their midpoint, keeping the point under it fixed", () => {
		const start: ZoomTransform = { scale: 1, x: 0, y: 0 }
		const mid = { x: 100, y: -50 }
		const result = pinchZoom(start, 100, mid, 200, mid, container, null)

		expect(result.scale).toBe(2)
		// The content point under the midpoint: (mid - translate) / scale, the same before and after.
		expect((mid.x - result.x) / result.scale).toBeCloseTo((mid.x - start.x) / start.scale)
		expect((mid.y - result.y) / result.scale).toBeCloseTo((mid.y - start.y) / start.scale)
	})

	it("pans with the midpoint as both fingers move", () => {
		const result = pinchZoom({ scale: 2, x: 0, y: 0 }, 100, { x: 0, y: 0 }, 100, { x: 30, y: 20 }, container, null)

		expect(result).toEqual({ scale: 2, x: 30, y: 20 })
	})

	it("clamps to the scale limits, resetting the pan at 1x or below", () => {
		expect(pinchZoom({ scale: 4, x: 10, y: 10 }, 10, { x: 0, y: 0 }, 1000, { x: 0, y: 0 }, container, null).scale).toBe(IMAGE_MAX_SCALE)
		expect(pinchZoom({ scale: 2, x: 40, y: 40 }, 1000, { x: 0, y: 0 }, 1, { x: 0, y: 0 }, container, null)).toEqual({
			scale: IMAGE_MIN_SCALE,
			x: 0,
			y: 0
		})
	})

	it("clamps the pan to the content once its size is known", () => {
		const result = pinchZoom(
			{ scale: 1, x: 0, y: 0 },
			100,
			{ x: 0, y: 0 },
			200,
			{ x: 5000, y: 0 },
			{ width: 100, height: 100 },
			{
				width: 100,
				height: 100
			}
		)

		expect(result.x).toBe(50)
	})

	it("keeps the start for fingers that started on one spot", () => {
		const start: ZoomTransform = { scale: 2, x: 5, y: 5 }

		expect(pinchZoom(start, 0, { x: 0, y: 0 }, 50, { x: 0, y: 0 }, container, null)).toBe(start)
	})
})

describe("doubleClickZoom", () => {
	it("zooms in from rest to IMAGE_DOUBLE_CLICK_SCALE, centered", () => {
		expect(doubleClickZoom({ scale: 1, x: 0, y: 0 })).toEqual({ scale: IMAGE_DOUBLE_CLICK_SCALE, x: 0, y: 0 })
	})

	it("zooms back out to 1x and resets pan when already zoomed in", () => {
		expect(doubleClickZoom({ scale: 3, x: 40, y: -10 })).toEqual({ scale: 1, x: 0, y: 0 })
	})
})

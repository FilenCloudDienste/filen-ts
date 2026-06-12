import { vi, describe, it, expect } from "vitest"

// ─── Module boundary mocks ───────────────────────────────────────────────────
// zoomableView.tsx imports gesture-handler/reanimated at module level; stub
// them so the pure math exports can be loaded in a node vitest environment.

vi.mock("react-native-gesture-handler", () => {
	const chainable = () => {
		const gesture: Record<string, (...args: unknown[]) => unknown> = {}
		const methods = [
			"enabled",
			"manualActivation",
			"minPointers",
			"maxPointers",
			"numberOfTaps",
			"maxDelay",
			"onBegin",
			"onStart",
			"onUpdate",
			"onEnd",
			"onFinalize",
			"onTouchesDown",
			"onTouchesMove",
			"requireExternalGestureToFail"
		]

		for (const method of methods) {
			gesture[method] = () => gesture
		}

		return gesture
	}

	return {
		GestureDetector: () => null,
		Gesture: {
			Pinch: chainable,
			Pan: chainable,
			Tap: chainable,
			Simultaneous: (...gestures: unknown[]) => gestures
		}
	}
})

vi.mock("react-native-reanimated", () => ({
	default: {
		View: () => null
	},
	useSharedValue: (v: unknown) => ({ value: v }),
	useAnimatedStyle: (fn: () => unknown) => fn,
	useAnimatedReaction: () => undefined,
	withSpring: (v: unknown) => v,
	withTiming: (v: unknown) => v,
	withDecay: () => 0,
	cancelAnimation: () => undefined
}))

vi.mock("react-native-worklets", () => ({
	runOnJS: (fn: unknown) => fn
}))

// ─── Actual import ───────────────────────────────────────────────────────────

import {
	getDisplayedContentSize,
	getPanBounds,
	rubberBandOffset,
	rubberBandClamp,
	rubberBandScale
} from "@/components/ui/zoomableView"

// ─── getDisplayedContentSize: "contain" letterbox math ───────────────────────

describe("getDisplayedContentSize", () => {
	it("falls back to the container when the content size is unknown", () => {
		expect(getDisplayedContentSize(390, 844, 0, 0)).toEqual({
			width: 390,
			height: 844
		})
	})

	it("falls back to the container when the container has not been measured yet", () => {
		expect(getDisplayedContentSize(0, 0, 4000, 3000)).toEqual({
			width: 0,
			height: 0
		})
	})

	it("fits a landscape photo to the container width (letterboxed vertically)", () => {
		const displayed = getDisplayedContentSize(390, 844, 4000, 3000)

		expect(displayed.width).toBeCloseTo(390)
		expect(displayed.height).toBeCloseTo(292.5)
	})

	it("fits a tall photo to the container height (letterboxed horizontally)", () => {
		const displayed = getDisplayedContentSize(844, 390, 3000, 4000)

		expect(displayed.height).toBeCloseTo(390)
		expect(displayed.width).toBeCloseTo(292.5)
	})
})

// ─── getPanBounds: per-axis locking until the content exceeds the viewport ───

describe("getPanBounds", () => {
	it("locks both axes at scale 1 for a letterboxed photo", () => {
		expect(getPanBounds(1, 390, 844, 4000, 3000)).toEqual({
			x: 0,
			y: 0
		})
	})

	it("keeps the letterboxed axis locked until the scaled content exceeds the container", () => {
		// Landscape photo displayed at 390x292.5: at 2x it is 585 tall — still
		// shorter than the 844 container, so vertical panning must stay locked.
		const bounds = getPanBounds(2, 390, 844, 4000, 3000)

		expect(bounds.x).toBeCloseTo(195)
		expect(bounds.y).toBe(0)
	})

	it("unlocks the letterboxed axis once the scaled content exceeds the container", () => {
		const bounds = getPanBounds(3, 390, 844, 4000, 3000)

		expect(bounds.x).toBeCloseTo(390)
		expect(bounds.y).toBeCloseTo((292.5 * 3 - 844) / 2)
	})

	it("matches the container-based bounds when the content size is unknown", () => {
		const bounds = getPanBounds(2, 390, 844, 0, 0)

		expect(bounds.x).toBeCloseTo((390 * (2 - 1)) / 2)
		expect(bounds.y).toBeCloseTo((844 * (2 - 1)) / 2)
	})
})

// ─── rubberBandOffset: UIScrollView resistance curve ─────────────────────────

describe("rubberBandOffset", () => {
	it("returns 0 for zero or negative distance", () => {
		expect(rubberBandOffset(0, 390)).toBe(0)
		expect(rubberBandOffset(-50, 390)).toBe(0)
	})

	it("returns 0 for a non-positive dimension", () => {
		expect(rubberBandOffset(100, 0)).toBe(0)
	})

	it("is monotonically increasing in distance", () => {
		const small = rubberBandOffset(50, 390)
		const medium = rubberBandOffset(150, 390)
		const large = rubberBandOffset(400, 390)

		expect(small).toBeGreaterThan(0)
		expect(medium).toBeGreaterThan(small)
		expect(large).toBeGreaterThan(medium)
	})

	it("never reaches the dimension (asymptote)", () => {
		expect(rubberBandOffset(1_000_000, 390)).toBeLessThan(390)
	})

	it("damps the offset below the raw distance", () => {
		expect(rubberBandOffset(100, 390)).toBeLessThan(100)
	})
})

// ─── rubberBandClamp: identity inside, damped overshoot outside ──────────────

describe("rubberBandClamp", () => {
	it("is the identity inside the bounds", () => {
		expect(rubberBandClamp(10, -195, 195, 390)).toBe(10)
		expect(rubberBandClamp(-195, -195, 195, 390)).toBe(-195)
		expect(rubberBandClamp(195, -195, 195, 390)).toBe(195)
	})

	it("is continuous at the boundary", () => {
		const justOutside = rubberBandClamp(195.001, -195, 195, 390)

		expect(justOutside).toBeGreaterThanOrEqual(195)
		expect(justOutside).toBeLessThan(195.01)
	})

	it("damps overshoot beyond max", () => {
		const clamped = rubberBandClamp(395, -195, 195, 390)

		expect(clamped).toBeGreaterThan(195)
		expect(clamped).toBeLessThan(395)
	})

	it("damps overshoot below min symmetrically", () => {
		const above = rubberBandClamp(395, -195, 195, 390)
		const below = rubberBandClamp(-395, -195, 195, 390)

		expect(below).toBeCloseTo(-above)
	})
})

// ─── rubberBandScale: damped zoom outside [min, max] ─────────────────────────

describe("rubberBandScale", () => {
	it("is the identity inside the bounds", () => {
		expect(rubberBandScale(1, 1, 5)).toBe(1)
		expect(rubberBandScale(3, 1, 5)).toBe(3)
		expect(rubberBandScale(5, 1, 5)).toBe(5)
	})

	it("damps over-zoom beyond max but still gives", () => {
		const damped = rubberBandScale(10, 1, 5)

		expect(damped).toBeGreaterThan(5)
		expect(damped).toBeLessThan(10)
	})

	it("damps under-zoom below min but still gives", () => {
		const damped = rubberBandScale(0.5, 1, 5)

		expect(damped).toBeGreaterThan(0.5)
		expect(damped).toBeLessThan(1)
	})

	it("tracks 1:1 between the dismiss floor and max (free pinch-to-dismiss shrink)", () => {
		// With a dismiss floor of 0.15 the scale must follow the fingers freely
		// below 1 — iOS Photos pinch-to-close behavior.
		expect(rubberBandScale(0.6, 0.15, 10)).toBe(0.6)
		expect(rubberBandScale(0.2, 0.15, 10)).toBe(0.2)
	})

	it("keeps damping monotonic across the max boundary", () => {
		const atMax = rubberBandScale(5, 1, 5)
		const justOver = rubberBandScale(5.1, 1, 5)
		const farOver = rubberBandScale(8, 1, 5)

		expect(justOver).toBeGreaterThan(atMax)
		expect(farOver).toBeGreaterThan(justOver)
	})

	it("passes a non-positive raw scale through unchanged", () => {
		expect(rubberBandScale(0, 1, 5)).toBe(0)
	})
})

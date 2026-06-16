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
	rubberBandScale,
	computePinchTransform,
	planAxisRelease,
	computePinchSettleTarget
} from "@/components/ui/zoomableView"

type Sv = Parameters<typeof computePinchTransform>[0]

// A SharedValues-like bag of { value } refs for the worklet under test. Only the
// fields computePinchTransform touches are populated; savedTranslateX/Y are the
// pinch's translate anchor (the Race composition stops the pan ever corrupting them).
function makeSv(values: {
	savedScale: number
	pinchBaseScale: number
	focalX: number
	focalY: number
	containerWidth: number
	containerHeight: number
	contentWidth: number
	contentHeight: number
	savedTranslateX: number
	savedTranslateY: number
}): Sv {
	return {
		savedScale: { value: values.savedScale },
		pinchBaseScale: { value: values.pinchBaseScale },
		focalX: { value: values.focalX },
		focalY: { value: values.focalY },
		containerWidth: { value: values.containerWidth },
		containerHeight: { value: values.containerHeight },
		contentWidth: { value: values.contentWidth },
		contentHeight: { value: values.contentHeight },
		savedTranslateX: { value: values.savedTranslateX },
		savedTranslateY: { value: values.savedTranslateY }
	} as unknown as Sv
}

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

// ─── computePinchTransform: two-finger focal anchoring ───────────────────────
// The pinch and pan run via Gesture.Simultaneous, so both fire onUpdate every
// frame while two fingers are down. The pan overwrites savedTranslateX/Y each
// frame (to stay ready for a one-finger handoff); the pinch must therefore read
// its OWN anchor. When it shared savedTranslateX/Y the pan corrupted the focal
// anchor mid-pinch and the content + focal jumped on any asymmetric finger move.

describe("computePinchTransform", () => {
	const BASE = {
		savedScale: 1,
		pinchBaseScale: 1,
		focalX: 260,
		focalY: 400,
		containerWidth: 400,
		containerHeight: 800,
		contentWidth: 0,
		contentHeight: 0
	}

	it("uses savedTranslateX/Y as the pinch anchor (focal glued from a non-zero start translate)", () => {
		// Start already panned (savedTranslate 30/-20) at scale 1, then pinch to
		// 1.5x at focal (275,405). The content point under the focal at start must
		// stay under the focal after scaling — proving the anchor IS read.
		const startTranslateX = 30
		const startTranslateY = -20
		const centerX = 200
		const centerY = 400
		const anchorPointX = (275 - centerX - startTranslateX) / 1
		const anchorPointY = (405 - centerY - startTranslateY) / 1

		const next = computePinchTransform(
			makeSv({ ...BASE, focalX: 275, focalY: 405, savedTranslateX: startTranslateX, savedTranslateY: startTranslateY }),
			1.5,
			275,
			405,
			false,
			1,
			5
		)

		expect(next.scale).toBeCloseTo(1.5)
		expect(next.translateX + next.scale * anchorPointX).toBeCloseTo(275 - centerX)
		expect(next.translateY + next.scale * anchorPointY).toBeCloseTo(405 - centerY)
	})

	it("keeps the content point under the focal glued to the moving focal", () => {
		// Off-center anchor focal (260,400) at scale 1, translate 0 → the content
		// point under the focal is 60px right of center. After an asymmetric pinch
		// to 1.5x with the focal drifting to (275,405), that same content point
		// must sit under the NEW focal — that is the whole job of the transform.
		const centerX = 200
		const centerY = 400
		const anchorPointX = (260 - centerX - 0) / 1
		const anchorPointY = (400 - centerY - 0) / 1

		const next = computePinchTransform(makeSv({ ...BASE, savedTranslateX: 0, savedTranslateY: 0 }), 1.5, 275, 405, false, 1, 5)

		expect(next.scale).toBeCloseTo(1.5)
		expect(next.translateX + next.scale * anchorPointX).toBeCloseTo(275 - centerX)
		expect(next.translateY + next.scale * anchorPointY).toBeCloseTo(405 - centerY)
	})

	it("tracks the focal across a multi-frame asymmetric pinch (scale + focal both moving)", () => {
		const sv = makeSv({ ...BASE, focalX: 250, savedTranslateX: 0, savedTranslateY: 0 })
		const centerX = 200
		const anchorPointX = (250 - centerX) / 1

		// Scale ramps 1→1.8 while the focal drifts 250→285 — the asymmetric case
		// that used to shift the content. The anchor (savedTranslateX 0) is fixed
		// for the whole gesture; the focal point must stay glued every frame.
		const frames = [
			{ scale: 1.2, focalX: 258 },
			{ scale: 1.4, focalX: 266 },
			{ scale: 1.6, focalX: 275 },
			{ scale: 1.8, focalX: 285 }
		]

		for (const frame of frames) {
			const next = computePinchTransform(sv, frame.scale, frame.focalX, 400, false, 1, 5)

			expect(next.translateX + next.scale * anchorPointX).toBeCloseTo(frame.focalX - centerX)
		}
	})
})

// ─── planAxisRelease: per-axis pan-release decision ──────────────────────────
// In-bounds → momentum decay that ARRESTS at the edge (no rubber-band bounce).
// Released past the edge (drag rubber-banded out) → a gentle spring back to the
// bound. This is the "subtle rubber-band while dragging, no over-bounce on
// release" feel — the old onEnd used withDecay({ rubberBandEffect: true }) which
// bounces over the limit (the reported over-bounce).

describe("planAxisRelease", () => {
	it("decays toward the edge when released in-bounds", () => {
		const r = planAxisRelease(40, 100, 1200)

		expect(r.type).toBe("decay")

		if (r.type === "decay") {
			expect(r.clamp).toEqual([-100, 100])
			expect(r.velocity).toBe(1200)
		}
	})

	it("springs back to the positive bound when released past it", () => {
		expect(planAxisRelease(140, 100, 800)).toEqual({
			type: "spring",
			to: 100
		})
	})

	it("springs back to the negative bound when released past it", () => {
		expect(planAxisRelease(-140, 100, -800)).toEqual({
			type: "spring",
			to: -100
		})
	})

	it("decays with a zero-width clamp on a non-pannable axis (bound 0)", () => {
		const r = planAxisRelease(0, 0, 500)

		expect(r.type).toBe("decay")

		if (r.type === "decay") {
			expect(r.clamp).toEqual([-0, 0])
		}
	})
})

// ─── computePinchSettleTarget: focal-anchored rest position on pinch release ──
// The rest position a pinch settles to: scale clamped into [minZoom, maxZoom],
// translation re-derived focal-anchored AT THE CLAMPED SCALE, then hard-clamped
// into pan bounds. Settling all three to this single target (one critically-
// damped spring) is what removes the snap-back.

type SettleSv = Parameters<typeof computePinchSettleTarget>[0]

function makeSettleSv(values: {
	scale: number
	translateX: number
	translateY: number
	focalX: number
	focalY: number
	containerWidth: number
	containerHeight: number
	contentWidth: number
	contentHeight: number
}): SettleSv {
	return {
		scale: { value: values.scale },
		translateX: { value: values.translateX },
		translateY: { value: values.translateY },
		focalX: { value: values.focalX },
		focalY: { value: values.focalY },
		containerWidth: { value: values.containerWidth },
		containerHeight: { value: values.containerHeight },
		contentWidth: { value: values.contentWidth },
		contentHeight: { value: values.contentHeight }
	} as unknown as SettleSv
}

const SETTLE_BASE = {
	translateX: 0,
	translateY: 0,
	focalX: 0,
	focalY: 0,
	containerWidth: 300,
	containerHeight: 600,
	contentWidth: 300,
	contentHeight: 600
}

describe("computePinchSettleTarget", () => {
	it("clamps an over-zoomed scale back to maxZoom", () => {
		const target = computePinchSettleTarget(makeSettleSv({ ...SETTLE_BASE, scale: 12 }), 1, 10)

		expect(target.scale).toBe(10)
	})

	it("clamps an under-zoomed scale back to minZoom and recenters (bounds collapse to 0)", () => {
		const target = computePinchSettleTarget(makeSettleSv({ ...SETTLE_BASE, scale: 0.8, translateX: 30, translateY: 40 }), 1, 10)

		expect(target.scale).toBe(1)
		expect(target.translateX).toBe(0)
		expect(target.translateY).toBe(0)
	})

	it("keeps an in-range scale and hard-clamps an over-panned translation into pan bounds", () => {
		const target = computePinchSettleTarget(makeSettleSv({ ...SETTLE_BASE, scale: 2, translateX: 99999, translateY: 99999 }), 1, 10)

		expect(target.scale).toBe(2)
		expect(target.translateX).toBe(150)
		expect(target.translateY).toBe(300)
	})
})

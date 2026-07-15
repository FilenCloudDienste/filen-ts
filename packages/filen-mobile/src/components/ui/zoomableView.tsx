import { useEffect } from "react"
import { type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native"
import { Gesture, GestureDetector } from "react-native-gesture-handler"
import Animated, {
	type SharedValue,
	useSharedValue,
	useAnimatedStyle,
	useAnimatedReaction,
	withSpring,
	withTiming,
	withDecay,
	cancelAnimation
} from "react-native-reanimated"
import { runOnJS } from "react-native-worklets"

const DEFAULT_MIN_ZOOM = 1
const DEFAULT_MAX_ZOOM = 5
const DEFAULT_DOUBLE_TAP_ZOOM = 2
const PINCH_DISMISS_THRESHOLD = 0.75
const PINCH_DISMISS_VELOCITY = -1.5
const PINCH_DISMISS_VELOCITY_MAX_SCALE = 0.95
const PINCH_DISMISS_SCALE_FLOOR = 0.15
const PINCH_DISMISS_FADE_DURATION = 160
const MAX_PAN_VELOCITY = 3000
const RUBBER_BAND_COEFFICIENT = 0.55
const OVERSCALE_RESISTANCE = 0.3
const UNDERSCALE_RESISTANCE = 0.45
const PAN_FAIL_SLOP_SQUARED = 64

// Settling into bounds after a gesture ends — critically damped (dampingRatio 1
// + overshootClamping) so the content arrives once and stays put. The old 0.9
// (underdamped, overshoots) applied through three independent springs that could
// desync was the jarring "snap back".
const SPRING_SETTLE = {
	duration: 350,
	dampingRatio: 1,
	overshootClamping: true
}

// Double-tap zoom toggle — fast and critically damped like iOS Photos.
const SPRING_TOGGLE = {
	duration: 320,
	dampingRatio: 1
}

const containerViewStyle: ViewStyle = {
	flex: 1,
	overflow: "hidden"
}

const innerViewStyle: ViewStyle = {
	flex: 1
}

function clampNumber(value: number, min: number, max: number): number {
	"worklet"

	return Math.max(min, Math.min(max, value))
}

// Size of the letterboxed ("contain"-fitted) content inside the container at
// scale 1. Falls back to the container itself when the content size is unknown.
export function getDisplayedContentSize(
	containerWidth: number,
	containerHeight: number,
	contentWidth: number,
	contentHeight: number
): {
	width: number
	height: number
} {
	"worklet"

	if (contentWidth <= 0 || contentHeight <= 0 || containerWidth <= 0 || containerHeight <= 0) {
		return {
			width: containerWidth,
			height: containerHeight
		}
	}

	const fit = Math.min(containerWidth / contentWidth, containerHeight / contentHeight)

	return {
		width: contentWidth * fit,
		height: contentHeight * fit
	}
}

// Per-axis pan limit: an axis only becomes pannable once the scaled content
// exceeds the container on that axis (so letterboxed photos cannot be dragged
// into the void on the letterboxed axis — iOS Photos behavior).
export function getPanBounds(
	scale: number,
	containerWidth: number,
	containerHeight: number,
	contentWidth: number,
	contentHeight: number
): {
	x: number
	y: number
} {
	"worklet"

	const displayed = getDisplayedContentSize(containerWidth, containerHeight, contentWidth, contentHeight)

	return {
		x: Math.max(0, (displayed.width * scale - containerWidth) / 2),
		y: Math.max(0, (displayed.height * scale - containerHeight) / 2)
	}
}

// UIScrollView's rubber-band curve: asymptotically approaches `dimension`,
// never reaches it. c = 0.55 is Apple's constant.
export function rubberBandOffset(distance: number, dimension: number): number {
	"worklet"

	if (dimension <= 0 || distance <= 0) {
		return 0
	}

	return (1 - 1 / ((distance * RUBBER_BAND_COEFFICIENT) / dimension + 1)) * dimension
}

export function rubberBandClamp(value: number, min: number, max: number, dimension: number): number {
	"worklet"

	if (value < min) {
		return min - rubberBandOffset(min - value, dimension)
	}

	if (value > max) {
		return max + rubberBandOffset(value - max, dimension)
	}

	return value
}

// Per-axis pan-release decision. In-bounds → a momentum decay clamped to the
// edge (no rubber-band bounce — that flag was the "bounces too much"). Released
// past the edge (the drag rubber-banded out) → a gentle critically-damped spring
// back to the bound. Pure so the decision is unit-testable; the caller turns it
// into withDecay / withSpring.
export function planAxisRelease(
	value: number,
	bound: number,
	velocity: number
): { type: "decay"; clamp: [number, number]; velocity: number } | { type: "spring"; to: number } {
	"worklet"

	if (value > bound) {
		return { type: "spring", to: bound }
	}

	if (value < -bound) {
		return { type: "spring", to: -bound }
	}

	return { type: "decay", clamp: [-bound, bound], velocity }
}

// Damped scale outside [min, max] — pinching past the limits gives with
// resistance instead of hitting a hard wall, then springs back on release.
export function rubberBandScale(raw: number, min: number, max: number): number {
	"worklet"

	if (raw > max) {
		return max * Math.pow(raw / max, OVERSCALE_RESISTANCE)
	}

	if (raw < min && raw > 0) {
		return min * Math.pow(raw / min, UNDERSCALE_RESISTANCE)
	}

	return raw
}

export type ZoomableViewProps = {
	children: React.ReactNode
	minZoom?: number
	maxZoom?: number
	doubleTapZoom?: number
	onZoomChange?: (zoom: number) => void
	onSingleTap?: () => void
	enabled?: boolean
	style?: StyleProp<ViewStyle>
	scaleValue?: SharedValue<number>
	onPinchDismiss?: () => void
	onPinchActiveChange?: (active: boolean) => void
	contentSize?: {
		width: number
		height: number
	}
}

type SharedValues = {
	scale: SharedValue<number>
	translateX: SharedValue<number>
	translateY: SharedValue<number>
	opacity: SharedValue<number>
	savedScale: SharedValue<number>
	// Translate captured at the start of the active gesture (pinch OR pan). The
	// Race composition means pinch and pan never run on the same touch stream, so
	// they safely share one anchor — no separate pinch anchor is needed anymore.
	savedTranslateX: SharedValue<number>
	savedTranslateY: SharedValue<number>
	// e.scale captured at pinch start, to normalise the recognizer's cumulative
	// scale to 1 at the moment the pinch activates.
	pinchBaseScale: SharedValue<number>
	panTouchStartX: SharedValue<number>
	panTouchStartY: SharedValue<number>
	// 1 while a pinch is active — drives the gallery pager-block + release re-align.
	pinchActive: SharedValue<number>
	// 0 until the pinch's first onUpdate re-captures the focal/scale baseline. The
	// activation (onStart) event is not trustworthy on Android: PinchGestureHandler
	// seeds its focal point with the FIRST pointer's position and the manual
	// activation races the ScaleGestureDetector's two-finger centroid, so anchoring
	// on onStart makes the first frame jump toward the first finger. Re-anchoring on
	// the first CHANGED event keeps baseline and deltas in the same event stream.
	pinchAnchored: SharedValue<number>
	dismissCommitted: SharedValue<number>
	focalX: SharedValue<number>
	focalY: SharedValue<number>
	containerWidth: SharedValue<number>
	containerHeight: SharedValue<number>
	contentWidth: SharedValue<number>
	contentHeight: SharedValue<number>
}

// One frame of the pinch transform, extracted as a pure UI-thread worklet so it
// is unit-testable. Anchors on savedTranslateX/Y (the translate captured at pinch
// start). With the Race composition the pan never runs during a pinch, so this
// anchor is stable for the whole gesture (no dual-anchor dance needed anymore).
//
// Glues the focal material point under the fingers (the two-finger model):
// t = focal - centerToContent · (newScale / savedScale). Equivalent algebra to
// the closed form below.
export function computePinchTransform(
	sv: SharedValues,
	eScale: number,
	eFocalX: number,
	eFocalY: number,
	hasDismiss: boolean,
	minZoom: number,
	maxZoom: number
): {
	scale: number
	translateX: number
	translateY: number
} {
	"worklet"

	const raw = (sv.savedScale.value * eScale) / sv.pinchBaseScale.value
	const newScale = rubberBandScale(raw, hasDismiss ? PINCH_DISMISS_SCALE_FLOOR : minZoom, maxZoom)
	const ratio = newScale / sv.savedScale.value
	const centerX = sv.containerWidth.value / 2
	const centerY = sv.containerHeight.value / 2
	const rawTx =
		sv.savedTranslateX.value + (sv.focalX.value - centerX - sv.savedTranslateX.value) * (1 - ratio) + (eFocalX - sv.focalX.value)
	const rawTy =
		sv.savedTranslateY.value + (sv.focalY.value - centerY - sv.savedTranslateY.value) * (1 - ratio) + (eFocalY - sv.focalY.value)

	if (newScale < minZoom) {
		// Shrinking towards dismissal — the image follows the fingers freely.
		return {
			scale: newScale,
			translateX: rawTx,
			translateY: rawTy
		}
	}

	const bounds = getPanBounds(newScale, sv.containerWidth.value, sv.containerHeight.value, sv.contentWidth.value, sv.contentHeight.value)

	return {
		scale: newScale,
		translateX: rubberBandClamp(rawTx, -bounds.x, bounds.x, sv.containerWidth.value),
		translateY: rubberBandClamp(rawTy, -bounds.y, bounds.y, sv.containerHeight.value)
	}
}

// The rest position a pinch settles to on release: scale clamped into
// [minZoom, maxZoom], translation re-derived focal-anchored AT THE CLAMPED SCALE
// (so the pinch origin stays put), then hard-clamped into pan bounds. Pure so
// the settle target is unit-testable and identical to the live math — settling
// scale + both axes to this single target with one critically-damped spring is
// what removes the snap-back.
export function computePinchSettleTarget(
	sv: SharedValues,
	minZoom: number,
	maxZoom: number
): {
	scale: number
	translateX: number
	translateY: number
} {
	"worklet"

	const targetScale = clampNumber(sv.scale.value, minZoom, maxZoom)
	const ratio = targetScale / sv.scale.value
	const centerX = sv.containerWidth.value / 2
	const centerY = sv.containerHeight.value / 2
	const bounds = getPanBounds(
		targetScale,
		sv.containerWidth.value,
		sv.containerHeight.value,
		sv.contentWidth.value,
		sv.contentHeight.value
	)

	return {
		scale: targetScale,
		translateX: clampNumber(sv.translateX.value + (sv.focalX.value - centerX - sv.translateX.value) * (1 - ratio), -bounds.x, bounds.x),
		translateY: clampNumber(sv.translateY.value + (sv.focalY.value - centerY - sv.translateY.value) * (1 - ratio), -bounds.y, bounds.y)
	}
}

function resetZoom(scale: SharedValue<number>, translateX: SharedValue<number>, translateY: SharedValue<number>) {
	scale.value = withSpring(1, SPRING_SETTLE)
	translateX.value = withSpring(0, SPRING_SETTLE)
	translateY.value = withSpring(0, SPRING_SETTLE)
}

// Module scope so the React Compiler does not analyse the shared-value write
// (mutating a hook argument inside a render-created closure is rejected).
function buildScaleMirror(scaleValue: SharedValue<number> | undefined) {
	return (current: number) => {
		"worklet"

		if (scaleValue) {
			scaleValue.value = current
		}
	}
}

// Module scope for the same reason: the compiler rejects writes to
// hook-returned values inside component-scope closures/effects.
function applyContainerLayout(containerWidth: SharedValue<number>, containerHeight: SharedValue<number>, e: LayoutChangeEvent) {
	containerWidth.value = e.nativeEvent.layout.width
	containerHeight.value = e.nativeEvent.layout.height
}

function applyContentSize(
	contentWidth: SharedValue<number>,
	contentHeight: SharedValue<number>,
	contentSize: { width: number; height: number } | undefined
) {
	contentWidth.value = contentSize?.width ?? 0
	contentHeight.value = contentSize?.height ?? 0
}

/**
 * Builds all gesture handlers at module scope so the React Compiler does not
 * analyse them.  The compiler only inspects React components and hooks — plain
 * functions are left alone, which avoids "Cannot access refs during render" and
 * "This value cannot be modified" diagnostics that fire when shared values are
 * mutated inside closures created during render.
 *
 * Reanimated's babel plugin still processes every `"worklet"` directive
 * regardless of where the enclosing function lives, so shared-value
 * serialisation for the UI thread works exactly as before.
 *
 * Transform model: the content is translated then scaled about the container
 * center. During gestures nothing is hard-clamped — out-of-bounds translation
 * and scale get rubber-band resistance and spring back into bounds on release,
 * matching the iOS scroll/zoom feel. Below minZoom (pinch-to-dismiss) the
 * content follows the fingers freely and the release either commits the
 * dismiss (shrink + fade, then notify) or springs back to rest.
 */
function buildComposedGesture(
	sv: SharedValues,
	enabled: boolean,
	minZoom: number,
	maxZoom: number,
	doubleTapZoom: number,
	notifyZoomChange: (zoom: number) => void,
	onSingleTap: (() => void) | undefined,
	notifySingleTap: () => void,
	onPinchDismiss: (() => void) | undefined,
	notifyPinchDismiss: () => void,
	notifyPinchActive: (active: boolean) => void
) {
	const pinchGesture = Gesture.Pinch()
		.enabled(enabled)
		.manualActivation(true)
		.onTouchesDown((e, stateManager) => {
			"worklet"

			// Two fingers = a pinch. Activate synchronously on the UI thread: this
			// starts the pinch AND cancels the parent FlashList's native scroll in
			// the same frame (a JS scrollEnabled toggle loses that race). One finger
			// keeps the pinch dormant so the pan / taps can win the Race.
			if (e.numberOfTouches >= 2) {
				stateManager.activate()
			}
		})
		.onTouchesUp((e, stateManager) => {
			"worklet"

			// Drop below two fingers → end the pinch (fires onEnd → the single
			// settle). Because the pinch holds the Race until it ends, a staggered
			// 2→1→0 lift can no longer hand a lone finger to the pan mid-release —
			// that handoff was the snap-back.
			if (e.numberOfTouches < 2) {
				stateManager.end()
			}
		})
		.onStart(e => {
			"worklet"

			// Catch a running settle/snap-back animation seamlessly instead of
			// fighting it (re-pinching mid-animation used to jump).
			cancelAnimation(sv.scale)
			cancelAnimation(sv.translateX)
			cancelAnimation(sv.translateY)

			sv.savedScale.value = sv.scale.value
			sv.savedTranslateX.value = sv.translateX.value
			sv.savedTranslateY.value = sv.translateY.value
			// Fallback baseline only (a pinch that ends without a single update, e.g.
			// computePinchSettleTarget reading focalX) — the authoritative anchor is
			// re-captured on the first onUpdate below (see SharedValues.pinchAnchored).
			sv.pinchBaseScale.value = e.scale
			sv.focalX.value = e.focalX
			sv.focalY.value = e.focalY
			sv.pinchAnchored.value = 0

			if (sv.pinchActive.value === 0) {
				sv.pinchActive.value = 1

				runOnJS(notifyPinchActive)(true)
			}
		})
		.onUpdate(e => {
			"worklet"

			if (sv.dismissCommitted.value === 1 || e.numberOfPointers < 2) {
				return
			}

			// First two-finger update: re-anchor the baseline from THIS event stream and
			// apply nothing this frame. The content has not moved since onStart, so
			// skipping one frame is invisible — while any mismatch between the activation
			// event's focal/scale and the update stream (Android's first-pointer focal
			// seed) would otherwise land as a jump toward the first finger.
			if (sv.pinchAnchored.value === 0) {
				sv.pinchAnchored.value = 1
				sv.pinchBaseScale.value = e.scale
				sv.focalX.value = e.focalX
				sv.focalY.value = e.focalY

				return
			}

			const next = computePinchTransform(sv, e.scale, e.focalX, e.focalY, !!onPinchDismiss, minZoom, maxZoom)

			sv.translateX.value = next.translateX
			sv.translateY.value = next.translateY
			sv.scale.value = next.scale
		})
		.onEnd(e => {
			"worklet"

			if (sv.dismissCommitted.value === 1) {
				return
			}

			if (
				onPinchDismiss &&
				(sv.scale.value < PINCH_DISMISS_THRESHOLD ||
					(sv.scale.value < PINCH_DISMISS_VELOCITY_MAX_SCALE && e.velocity < PINCH_DISMISS_VELOCITY))
			) {
				sv.dismissCommitted.value = 1

				// Keep shrinking along the gesture's trajectory while fading out,
				// so the route pops on an already-invisible view (no double
				// animation from the navigator).
				sv.scale.value = withTiming(sv.scale.value * 0.6, {
					duration: PINCH_DISMISS_FADE_DURATION
				})

				sv.opacity.value = withTiming(
					0,
					{
						duration: PINCH_DISMISS_FADE_DURATION
					},
					finished => {
						"worklet"

						if (finished) {
							runOnJS(notifyPinchDismiss)()
						}
					}
				)

				return
			}

			// Spring scale and translation back into bounds, anchored at the pinch
			// focal point so over-zoom releases zoom back where you pinched. One
			// critically-damped settle for all three values (SPRING_SETTLE) — the
			// underdamped, three-independent-spring version was the snap-back.
			const target = computePinchSettleTarget(sv, minZoom, maxZoom)

			if (target.scale !== sv.scale.value) {
				sv.scale.value = withSpring(target.scale, SPRING_SETTLE)
			}

			if (target.translateX !== sv.translateX.value) {
				sv.translateX.value = withSpring(target.translateX, SPRING_SETTLE)
			}

			if (target.translateY !== sv.translateY.value) {
				sv.translateY.value = withSpring(target.translateY, SPRING_SETTLE)
			}

			runOnJS(notifyZoomChange)(target.scale)
		})
		.onFinalize(() => {
			"worklet"

			if (sv.pinchActive.value === 1) {
				sv.pinchActive.value = 0

				runOnJS(notifyPinchActive)(false)
			}
		})

	const panGesture = Gesture.Pan()
		.enabled(enabled)
		.manualActivation(true)
		.maxPointers(1)
		.onTouchesDown(e => {
			"worklet"

			const touch = e.allTouches[0]

			if (touch) {
				sv.panTouchStartX.value = touch.x
				sv.panTouchStartY.value = touch.y
			}

			// Catch a decaying/settling image under the finger (iOS behavior:
			// touching a moving scroll view stops it immediately).
			if (sv.scale.value > minZoom) {
				cancelAnimation(sv.translateX)
				cancelAnimation(sv.translateY)
			}
		})
		.onTouchesMove((e, stateManager) => {
			"worklet"

			// Zoomed in → this single finger pans the image: activate (also blocks
			// the pager). maxPointers(1) makes a second finger FAIL this pan, handing
			// the stream to the pinch — that is the pan→pinch transition.
			if (sv.scale.value > minZoom && sv.dismissCommitted.value === 0) {
				stateManager.activate()

				return
			}

			// At rest a definite drag must FAIL so the FlashList pager and the
			// gallery swipe-down dismiss (both wait on this via UIKit failure
			// arbitration) can take over. Slop keeps it alive through landing jitter.
			const touch = e.allTouches[0]

			if (!touch) {
				return
			}

			const dx = touch.x - sv.panTouchStartX.value
			const dy = touch.y - sv.panTouchStartY.value

			if (dx * dx + dy * dy > PAN_FAIL_SLOP_SQUARED) {
				stateManager.fail()
			}
		})
		.onStart(() => {
			"worklet"

			sv.savedTranslateX.value = sv.translateX.value
			sv.savedTranslateY.value = sv.translateY.value
		})
		.onUpdate(e => {
			"worklet"

			if (sv.scale.value <= minZoom || sv.dismissCommitted.value === 1) {
				return
			}

			const bounds = getPanBounds(
				sv.scale.value,
				sv.containerWidth.value,
				sv.containerHeight.value,
				sv.contentWidth.value,
				sv.contentHeight.value
			)

			sv.translateX.value = rubberBandClamp(sv.savedTranslateX.value + e.translationX, -bounds.x, bounds.x, sv.containerWidth.value)
			sv.translateY.value = rubberBandClamp(sv.savedTranslateY.value + e.translationY, -bounds.y, bounds.y, sv.containerHeight.value)
		})
		.onEnd((e, success) => {
			"worklet"

			if (!success || sv.scale.value <= minZoom || sv.dismissCommitted.value === 1) {
				return
			}

			const bounds = getPanBounds(
				sv.scale.value,
				sv.containerWidth.value,
				sv.containerHeight.value,
				sv.contentWidth.value,
				sv.contentHeight.value
			)

			// In-bounds → momentum decay that ARRESTS at the edge (no rubber-band
			// bounce). Released past the edge → a gentle critically-damped spring
			// back. Decided per axis so a fling on one axis doesn't bounce the other.
			const relX = planAxisRelease(sv.translateX.value, bounds.x, clampNumber(e.velocityX, -MAX_PAN_VELOCITY, MAX_PAN_VELOCITY))
			const relY = planAxisRelease(sv.translateY.value, bounds.y, clampNumber(e.velocityY, -MAX_PAN_VELOCITY, MAX_PAN_VELOCITY))

			sv.translateX.value =
				relX.type === "decay" ? withDecay({ velocity: relX.velocity, clamp: relX.clamp }) : withSpring(relX.to, SPRING_SETTLE)
			sv.translateY.value =
				relY.type === "decay" ? withDecay({ velocity: relY.velocity, clamp: relY.clamp }) : withSpring(relY.to, SPRING_SETTLE)
		})

	const doubleTapGesture = Gesture.Tap()
		.enabled(enabled)
		.numberOfTaps(2)
		.maxDelay(300)
		.onEnd(e => {
			"worklet"

			if (sv.dismissCommitted.value === 1) {
				return
			}

			if (sv.scale.value > minZoom) {
				sv.scale.value = withSpring(minZoom, SPRING_TOGGLE)
				sv.translateX.value = withSpring(0, SPRING_TOGGLE)
				sv.translateY.value = withSpring(0, SPRING_TOGGLE)

				runOnJS(notifyZoomChange)(minZoom)

				return
			}

			const targetScale = doubleTapZoom
			const centerX = sv.containerWidth.value / 2
			const centerY = sv.containerHeight.value / 2
			const bounds = getPanBounds(
				targetScale,
				sv.containerWidth.value,
				sv.containerHeight.value,
				sv.contentWidth.value,
				sv.contentHeight.value
			)
			const targetTx = clampNumber((e.x - centerX) * (1 - targetScale), -bounds.x, bounds.x)
			const targetTy = clampNumber((e.y - centerY) * (1 - targetScale), -bounds.y, bounds.y)

			sv.scale.value = withSpring(targetScale, SPRING_TOGGLE)
			sv.translateX.value = withSpring(targetTx, SPRING_TOGGLE)
			sv.translateY.value = withSpring(targetTy, SPRING_TOGGLE)

			runOnJS(notifyZoomChange)(targetScale)
		})

	const singleTapGesture = Gesture.Tap()
		.enabled(enabled && !!onSingleTap)
		.numberOfTaps(1)
		.requireExternalGestureToFail(doubleTapGesture)
		.onEnd(() => {
			"worklet"

			if (onSingleTap) {
				runOnJS(notifySingleTap)()
			}
		})

	// Race (NOT Simultaneous): only one of pinch / pan / taps can be active on a
	// touch stream. The 2-finger-gated pinch holds the Race until it ends, so the
	// pan can never run alongside it and hijack the release — that dual-settle was
	// the snap-back. maxPointers(1) on the pan yields a 2nd finger to the pinch.
	return Gesture.Race(pinchGesture, panGesture, doubleTapGesture, singleTapGesture)
}

const ZoomableView = ({
	children,
	minZoom = DEFAULT_MIN_ZOOM,
	maxZoom = DEFAULT_MAX_ZOOM,
	doubleTapZoom = DEFAULT_DOUBLE_TAP_ZOOM,
	onZoomChange,
	onSingleTap,
	enabled = true,
	style,
	scaleValue,
	onPinchDismiss,
	onPinchActiveChange,
	contentSize
}: ZoomableViewProps) => {
	const scale = useSharedValue<number>(1)
	const translateX = useSharedValue<number>(0)
	const translateY = useSharedValue<number>(0)
	const opacity = useSharedValue<number>(1)
	const savedScale = useSharedValue<number>(1)
	const savedTranslateX = useSharedValue<number>(0)
	const savedTranslateY = useSharedValue<number>(0)
	const pinchBaseScale = useSharedValue<number>(1)
	const panTouchStartX = useSharedValue<number>(0)
	const panTouchStartY = useSharedValue<number>(0)
	const pinchActive = useSharedValue<number>(0)
	const pinchAnchored = useSharedValue<number>(0)
	const dismissCommitted = useSharedValue<number>(0)
	const focalX = useSharedValue<number>(0)
	const focalY = useSharedValue<number>(0)
	const containerWidth = useSharedValue<number>(0)
	const containerHeight = useSharedValue<number>(0)
	const contentWidth = useSharedValue<number>(contentSize?.width ?? 0)
	const contentHeight = useSharedValue<number>(contentSize?.height ?? 0)

	const onLayout = (e: LayoutChangeEvent) => {
		applyContainerLayout(containerWidth, containerHeight, e)
	}

	const notifyZoomChange = (zoom: number) => {
		onZoomChange?.(zoom)
	}

	const notifySingleTap = () => {
		onSingleTap?.()
	}

	const notifyPinchDismiss = () => {
		onPinchDismiss?.()
	}

	const notifyPinchActive = (active: boolean) => {
		onPinchActiveChange?.(active)
	}

	useEffect(() => {
		applyContentSize(contentWidth, contentHeight, contentSize)
	}, [contentSize, contentWidth, contentHeight])

	// Mirror the internal scale into the optional external shared value through
	// every path (gesture frames, springs, decay) — single source of truth.
	useAnimatedReaction(() => scale.value, buildScaleMirror(scaleValue), [scaleValue])

	const composed = buildComposedGesture(
		{
			scale,
			translateX,
			translateY,
			opacity,
			savedScale,
			savedTranslateX,
			savedTranslateY,
			pinchBaseScale,
			panTouchStartX,
			panTouchStartY,
			pinchActive,
			pinchAnchored,
			dismissCommitted,
			focalX,
			focalY,
			containerWidth,
			containerHeight,
			contentWidth,
			contentHeight
		},
		enabled,
		minZoom,
		maxZoom,
		doubleTapZoom,
		notifyZoomChange,
		onSingleTap,
		notifySingleTap,
		onPinchDismiss,
		notifyPinchDismiss,
		notifyPinchActive
	)

	const animatedStyle = useAnimatedStyle(() => {
		"worklet"

		return {
			opacity: opacity.value,
			transform: [
				{
					translateX: translateX.value
				},
				{
					translateY: translateY.value
				},
				{
					scale: scale.value
				}
			]
		}
	})

	useEffect(() => {
		if (!enabled && scale.value !== 1) {
			resetZoom(scale, translateX, translateY)
		}
	}, [enabled, scale, translateX, translateY])

	return (
		<GestureDetector gesture={composed}>
			<Animated.View
				style={[containerViewStyle, style]}
				onLayout={onLayout}
			>
				<Animated.View style={[innerViewStyle, animatedStyle]}>{children}</Animated.View>
			</Animated.View>
		</GestureDetector>
	)
}

export default ZoomableView

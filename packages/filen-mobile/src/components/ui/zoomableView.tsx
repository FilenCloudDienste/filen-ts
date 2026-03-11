import { memo, useCallback } from "@/lib/memo"
import { useEffect } from "react"
import type { LayoutChangeEvent, StyleProp, ViewStyle } from "react-native"
import { Gesture, GestureDetector } from "react-native-gesture-handler"
import { type SharedValue, useSharedValue, useAnimatedStyle, withTiming, withDecay } from "react-native-reanimated"
import { runOnJS } from "react-native-worklets"
import { AnimatedView } from "@/components/ui/animated"

const DEFAULT_MIN_ZOOM = 1
const DEFAULT_MAX_ZOOM = 5
const DEFAULT_DOUBLE_TAP_ZOOM = 2
const ANIMATION_DURATION = 300

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

function clampTranslation(
	tx: number,
	ty: number,
	s: number,
	w: number,
	h: number
): {
	x: number
	y: number
} {
	"worklet"

	if (s <= 1 || w === 0 || h === 0) {
		return {
			x: 0,
			y: 0
		}
	}

	const maxTx = (w * (s - 1)) / 2
	const maxTy = (h * (s - 1)) / 2

	return {
		x: clampNumber(tx, -maxTx, maxTx),
		y: clampNumber(ty, -maxTy, maxTy)
	}
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
}

type SharedValues = {
	scale: SharedValue<number>
	translateX: SharedValue<number>
	translateY: SharedValue<number>
	savedScale: SharedValue<number>
	savedTranslateX: SharedValue<number>
	savedTranslateY: SharedValue<number>
	focalX: SharedValue<number>
	focalY: SharedValue<number>
	containerWidth: SharedValue<number>
	containerHeight: SharedValue<number>
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
 */
function buildComposedGesture(
	sv: SharedValues,
	enabled: boolean,
	minZoom: number,
	maxZoom: number,
	doubleTapZoom: number,
	onZoomChange: ((zoom: number) => void) | undefined,
	notifyZoomChange: (zoom: number) => void,
	onSingleTap: (() => void) | undefined,
	notifySingleTap: () => void
) {
	const pinchGesture = Gesture.Pinch()
		.enabled(enabled)
		.onStart(e => {
			"worklet"

			sv.savedScale.value = sv.scale.value
			sv.savedTranslateX.value = sv.translateX.value
			sv.savedTranslateY.value = sv.translateY.value
			sv.focalX.value = e.focalX
			sv.focalY.value = e.focalY
		})
		.onUpdate(e => {
			"worklet"

			const newScale = clampNumber(sv.savedScale.value * e.scale, minZoom, maxZoom)
			const ratio = newScale / sv.savedScale.value
			const centerX = sv.containerWidth.value / 2
			const centerY = sv.containerHeight.value / 2

			const adjustX = (sv.focalX.value - centerX - sv.savedTranslateX.value) * (1 - ratio)
			const adjustY = (sv.focalY.value - centerY - sv.savedTranslateY.value) * (1 - ratio)

			const panX = e.focalX - sv.focalX.value
			const panY = e.focalY - sv.focalY.value

			const clamped = clampTranslation(
				sv.savedTranslateX.value + adjustX + panX,
				sv.savedTranslateY.value + adjustY + panY,
				newScale,
				sv.containerWidth.value,
				sv.containerHeight.value
			)

			sv.scale.value = newScale
			sv.translateX.value = clamped.x
			sv.translateY.value = clamped.y
		})
		.onEnd(() => {
			"worklet"

			if (sv.scale.value < minZoom) {
				sv.scale.value = withTiming(minZoom, {
					duration: ANIMATION_DURATION
				})

				sv.translateX.value = withTiming(0, {
					duration: ANIMATION_DURATION
				})

				sv.translateY.value = withTiming(0, {
					duration: ANIMATION_DURATION
				})

				if (onZoomChange) {
					runOnJS(notifyZoomChange)(minZoom)
				}

				return
			}

			const clamped = clampTranslation(
				sv.translateX.value,
				sv.translateY.value,
				sv.scale.value,
				sv.containerWidth.value,
				sv.containerHeight.value
			)

			if (clamped.x !== sv.translateX.value) {
				sv.translateX.value = withTiming(clamped.x, {
					duration: ANIMATION_DURATION
				})
			}

			if (clamped.y !== sv.translateY.value) {
				sv.translateY.value = withTiming(clamped.y, {
					duration: ANIMATION_DURATION
				})
			}

			if (onZoomChange) {
				runOnJS(notifyZoomChange)(sv.scale.value)
			}
		})

	const panGesture = Gesture.Pan()
		.enabled(enabled)
		.minPointers(1)
		.maxPointers(1)
		.manualActivation(true)
		.onTouchesDown((_e, stateManager) => {
			"worklet"

			if (sv.scale.value <= 1) {
				stateManager.fail()
			}
		})
		.onTouchesMove((_e, stateManager) => {
			"worklet"

			if (sv.scale.value > 1) {
				stateManager.activate()
			} else {
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

			const clamped = clampTranslation(
				sv.savedTranslateX.value + e.translationX,
				sv.savedTranslateY.value + e.translationY,
				sv.scale.value,
				sv.containerWidth.value,
				sv.containerHeight.value
			)

			sv.translateX.value = clamped.x
			sv.translateY.value = clamped.y
		})
		.onEnd(e => {
			"worklet"

			if (sv.scale.value <= 1) {
				return
			}

			const maxTx = (sv.containerWidth.value * (sv.scale.value - 1)) / 2
			const maxTy = (sv.containerHeight.value * (sv.scale.value - 1)) / 2

			sv.translateX.value = withDecay({
				velocity: e.velocityX,
				clamp: [-maxTx, maxTx]
			})

			sv.translateY.value = withDecay({
				velocity: e.velocityY,
				clamp: [-maxTy, maxTy]
			})
		})

	const doubleTapGesture = Gesture.Tap()
		.enabled(enabled)
		.numberOfTaps(2)
		.maxDelay(300)
		.onEnd(e => {
			"worklet"

			if (sv.scale.value > 1) {
				sv.scale.value = withTiming(1, {
					duration: ANIMATION_DURATION
				})

				sv.translateX.value = withTiming(0, {
					duration: ANIMATION_DURATION
				})

				sv.translateY.value = withTiming(0, {
					duration: ANIMATION_DURATION
				})

				if (onZoomChange) {
					runOnJS(notifyZoomChange)(1)
				}
			} else {
				const targetScale = doubleTapZoom
				const centerX = sv.containerWidth.value / 2
				const centerY = sv.containerHeight.value / 2

				const targetTx = (e.x - centerX) * (1 - targetScale)
				const targetTy = (e.y - centerY) * (1 - targetScale)

				const clamped = clampTranslation(targetTx, targetTy, targetScale, sv.containerWidth.value, sv.containerHeight.value)

				sv.scale.value = withTiming(targetScale, {
					duration: ANIMATION_DURATION
				})

				sv.translateX.value = withTiming(clamped.x, {
					duration: ANIMATION_DURATION
				})

				sv.translateY.value = withTiming(clamped.y, {
					duration: ANIMATION_DURATION
				})

				if (onZoomChange) {
					runOnJS(notifyZoomChange)(targetScale)
				}
			}
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

	return Gesture.Simultaneous(pinchGesture, panGesture, doubleTapGesture, singleTapGesture)
}

const ZoomableView = memo(
	({
		children,
		minZoom = DEFAULT_MIN_ZOOM,
		maxZoom = DEFAULT_MAX_ZOOM,
		doubleTapZoom = DEFAULT_DOUBLE_TAP_ZOOM,
		onZoomChange,
		onSingleTap,
		enabled = true,
		style
	}: ZoomableViewProps) => {
		const scale = useSharedValue(1)
		const translateX = useSharedValue(0)
		const translateY = useSharedValue(0)
		const savedScale = useSharedValue(1)
		const savedTranslateX = useSharedValue(0)
		const savedTranslateY = useSharedValue(0)
		const focalX = useSharedValue(0)
		const focalY = useSharedValue(0)
		const containerWidth = useSharedValue(0)
		const containerHeight = useSharedValue(0)

		const onLayout = useCallback(
			(e: LayoutChangeEvent) => {
				containerWidth.value = e.nativeEvent.layout.width
				containerHeight.value = e.nativeEvent.layout.height
			},
			[containerWidth, containerHeight]
		)

		const notifyZoomChange = useCallback(
			(zoom: number) => {
				onZoomChange?.(zoom)
			},
			[onZoomChange]
		)

		const notifySingleTap = useCallback(() => {
			onSingleTap?.()
		}, [onSingleTap])

		useEffect(() => {
			if (!enabled && scale.value !== 1) {
				scale.value = withTiming(1, {
					duration: ANIMATION_DURATION
				})

				translateX.value = withTiming(0, {
					duration: ANIMATION_DURATION
				})

				translateY.value = withTiming(0, {
					duration: ANIMATION_DURATION
				})
			}
		}, [enabled, scale, translateX, translateY])

		const composed = buildComposedGesture(
			{
				scale,
				translateX,
				translateY,
				savedScale,
				savedTranslateX,
				savedTranslateY,
				focalX,
				focalY,
				containerWidth,
				containerHeight
			},
			enabled,
			minZoom,
			maxZoom,
			doubleTapZoom,
			onZoomChange,
			notifyZoomChange,
			onSingleTap,
			notifySingleTap
		)

		const animatedStyle = useAnimatedStyle(() => {
			"worklet"

			return {
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

		return (
			<GestureDetector gesture={composed}>
				<AnimatedView
					style={[containerViewStyle, style]}
					onLayout={onLayout}
				>
					<AnimatedView style={[innerViewStyle, animatedStyle]}>{children}</AnimatedView>
				</AnimatedView>
			</GestureDetector>
		)
	}
)

export default ZoomableView

import { useEffect } from "react"
import { useSharedValue, useAnimatedStyle, withDelay, withTiming } from "react-native-reanimated"
import { useResolveClassNames } from "uniwind"
import { AnimatedView } from "@/components/ui/animated"
import { HIGHLIGHT_FADE_MS, HIGHLIGHT_HOLD_MS, HIGHLIGHT_TINT_OPACITY } from "@/features/drive/driveHighlight"

/**
 * Transient tint marking the row that "open containing directory" revealed. Mounted ONLY for the
 * highlighted row, as an absolutely positioned, non-interactive sibling — so it composes with
 * whatever background the row already resolves and needs no changes to it.
 *
 * The fade runs on the UI thread rather than off a React timer because the list is being scrolled
 * to this row at the same moment, and a JS-thread animation would stutter against it. Deliberately
 * NOT a reanimated `entering`/`exiting` layout animation: those are unsafe in recycled FlashList
 * rows.
 */
export default function HighlightOverlay() {
	const opacity = useSharedValue<number>(HIGHLIGHT_TINT_OPACITY)
	const primary = useResolveClassNames("bg-primary").backgroundColor as string

	useEffect(() => {
		opacity.value = withDelay(HIGHLIGHT_HOLD_MS, withTiming(0, { duration: HIGHLIGHT_FADE_MS }))
	}, [opacity])

	const animatedStyle = useAnimatedStyle(() => ({
		opacity: opacity.value
	}))

	return (
		<AnimatedView
			pointerEvents="none"
			className="absolute inset-0"
			style={[
				{
					backgroundColor: primary
				},
				animatedStyle
			]}
		/>
	)
}

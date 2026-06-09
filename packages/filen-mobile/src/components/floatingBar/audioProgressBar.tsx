import { useEffect } from "react"
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated"
import { useResolveClassNames } from "uniwind"
import { type AudioStatus } from "expo-audio"
import audio from "@/features/audio/audio"
import events from "@/lib/events"
import View from "@/components/ui/view"

const PROGRESS_BAR_HEIGHT = 3

const TIMING_CONFIG = {
	duration: 100,
	easing: Easing.linear
}

function statusToProgress(status: AudioStatus): number {
	if (!status.isLoaded || !Number.isFinite(status.duration) || status.duration <= 0) {
		return 0
	}

	return Math.min(Math.max(status.currentTime / status.duration, 0), 1)
}

// Playback-position bar for the floating bar's audio slot — the audio counterpart of
// AnimatedProgressBar (transfers). Subscribes to the audioStatus event directly and drives a
// worklet scaleX, so per-tick position updates never re-render the slot.
const AudioProgressBar = () => {
	// Seed from the cached status: a paused player emits no audioStatus events, so a 0 seed
	// would leave the bar empty after remounting (e.g. navigating back to a tab) until resume.
	const initialStatus = audio.getStatus()
	const progress = useSharedValue<number>(initialStatus ? statusToProgress(initialStatus) : 0)
	const textBlue500 = useResolveClassNames("text-blue-500")
	const bgBackgroundTertiary = useResolveClassNames("bg-background-tertiary")

	useEffect(() => {
		let last = progress.value

		const subscription = events.subscribe("audioStatus", status => {
			const next = statusToProgress(status)

			if (next !== last) {
				last = next
				progress.value = withTiming(next, TIMING_CONFIG)
			}
		})

		return () => {
			subscription.remove()
		}
	}, [progress])

	const animatedStyle = useAnimatedStyle(() => ({
		transform: [
			{
				scaleX: progress.value
			}
		]
	}))

	return (
		<View
			style={{
				height: PROGRESS_BAR_HEIGHT,
				width: "100%",
				overflow: "hidden",
				backgroundColor: bgBackgroundTertiary.color as string | undefined
			}}
		>
			<Animated.View
				style={[
					{
						height: PROGRESS_BAR_HEIGHT,
						width: "100%",
						backgroundColor: textBlue500.color as string | undefined,
						transformOrigin: "0% 50%"
					},
					animatedStyle
				]}
			/>
		</View>
	)
}

export default AudioProgressBar

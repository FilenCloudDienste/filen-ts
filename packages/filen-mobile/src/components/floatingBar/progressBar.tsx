import { useEffect } from "react"
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated"
import { useResolveClassNames } from "uniwind"
import View from "@/components/ui/view"

const PROGRESS_BAR_HEIGHT = 3

const TIMING_CONFIG = {
	duration: 100,
	easing: Easing.linear
}

// `subscribe` must be stable (module scope): it is an effect dependency.
export function useProgressValue(initial: number, subscribe: (onNext: (next: number) => void) => () => void): SharedValue<number> {
	const progress = useSharedValue<number>(initial)

	useEffect(() => {
		let last = progress.value

		return subscribe(next => {
			if (next !== last) {
				last = next
				progress.value = withTiming(next, TIMING_CONFIG)
			}
		})
	}, [progress, subscribe])

	return progress
}

// Drives a worklet scaleX so per-tick progress updates never re-render the host slot.
const ProgressBar = ({ progress }: { progress: SharedValue<number> }) => {
	const textBlue500 = useResolveClassNames("text-blue-500")
	const bgBackgroundTertiary = useResolveClassNames("bg-background-tertiary")

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

export default ProgressBar

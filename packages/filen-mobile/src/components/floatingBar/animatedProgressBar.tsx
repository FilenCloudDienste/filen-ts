import { useEffect } from "react"
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated"
import { useResolveClassNames } from "uniwind"
import useTransfersStore from "@/features/transfers/store/useTransfers.store"
import View from "@/components/ui/view"

const PROGRESS_BAR_HEIGHT = 3

const TIMING_CONFIG = {
	duration: 100,
	easing: Easing.linear
}

const AnimatedProgressBar = () => {
	const progress = useSharedValue(useTransfersStore.getState().stats.progress)
	const textBlue500 = useResolveClassNames("text-blue-500")
	const bgBackgroundTertiary = useResolveClassNames("bg-background-tertiary")

	useEffect(() => {
		let last = progress.value

		return useTransfersStore.subscribe(state => {
			const next = state.stats.progress

			if (next !== last) {
				last = next
				progress.value = withTiming(next, TIMING_CONFIG)
			}
		})
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

export default AnimatedProgressBar

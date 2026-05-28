import { memo } from "react"
import { useShallow } from "zustand/shallow"
import { router } from "expo-router"
import { ActivityIndicator } from "react-native"
import { bpsToReadable } from "@filen/utils"
import useTransfersStore from "@/stores/useTransfers.store"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import { useResolveClassNames } from "uniwind"
import AnimatedProgressBar from "@/components/floatingBar/animatedProgressBar"

const TransfersSlot = memo(() => {
	const transfersActive = useTransfersStore(useShallow(state => state.transfers.length > 0))
	const { count, speed } = useTransfersStore(
		useShallow(state => ({
			count: state.stats.count,
			speed: state.stats.speed
		}))
	)
	const textForeground = useResolveClassNames("text-foreground")

	if (!transfersActive) {
		return null
	}

	return (
		<PressableScale
			className="flex-1 flex-col overflow-hidden min-h-11"
			rippleColor="transparent"
			onPress={() => {
				router.push("/transfers")
			}}
		>
			<View className="flex-row items-center justify-between bg-transparent px-3 py-2 gap-3 flex-1">
				<Text
					className="text-xs shrink-0 flex-1"
					numberOfLines={1}
					ellipsizeMode="middle"
				>
					{count} tbd_active tbd_transfer{count !== 1 ? "s" : ""}
				</Text>
				{speed === 0 ? (
					<ActivityIndicator
						className="shrink-0"
						size="small"
						color={textForeground.color}
					/>
				) : (
					<Text
						className="text-xs shrink-0"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{bpsToReadable(speed)}
					</Text>
				)}
			</View>
			<AnimatedProgressBar />
		</PressableScale>
	)
})

export default TransfersSlot

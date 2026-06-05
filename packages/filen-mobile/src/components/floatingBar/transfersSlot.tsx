import { useShallow } from "zustand/shallow"
import { router } from "expo-router"
import { ActivityIndicator } from "react-native"
import { bpsToReadable } from "@filen/utils"
import { useTranslation } from "react-i18next"
import useTransfersStore from "@/features/transfers/store/useTransfers.store"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import { useResolveClassNames } from "uniwind"
import AnimatedProgressBar from "@/components/floatingBar/animatedProgressBar"

const TransfersSlot = () => {
	const { t } = useTranslation()
	const { transfersActive, count, speed } = useTransfersStore(
		useShallow(state => ({
			transfersActive: state.transfers.length > 0,
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
					{t("transfers_active", { count })}
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
}

export default TransfersSlot

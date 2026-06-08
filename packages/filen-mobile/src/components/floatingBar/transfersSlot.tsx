import { useShallow } from "zustand/shallow"
import { router } from "expo-router"
import { ActivityIndicator } from "react-native"
import { bpsToReadable } from "@filen/utils"
import { useTranslation } from "react-i18next"
import Ionicons from "@expo/vector-icons/Ionicons"
import useTransfersStore, { type Transfer } from "@/features/transfers/store/useTransfers.store"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import { useResolveClassNames } from "uniwind"
import AnimatedProgressBar from "@/components/floatingBar/animatedProgressBar"

/**
 * Returns true when at least one transfer is actively making progress
 * (i.e. not paused). Used to decide whether to show a spinner vs. a
 * paused indicator in SpeedDisplay.
 */
export function anyActiveTransfer(transfers: Transfer[]): boolean {
	return transfers.some(t => !t.paused)
}

const SpeedDisplay = () => {
	const { speed, hasActive } = useTransfersStore(
		useShallow(s => ({
			speed: s.stats.speed,
			hasActive: anyActiveTransfer(s.transfers)
		}))
	)
	const textForeground = useResolveClassNames("text-foreground")

	if (!hasActive) {
		return (
			<Ionicons
				name="pause-circle-outline"
				size={20}
				color={textForeground.color}
				style={{ flexShrink: 0 }}
			/>
		)
	}

	if (speed === 0) {
		return (
			<ActivityIndicator
				className="shrink-0"
				size="small"
				color={textForeground.color}
			/>
		)
	}

	return (
		<Text
			className="text-xs shrink-0"
			numberOfLines={1}
			ellipsizeMode="middle"
		>
			{bpsToReadable(speed)}
		</Text>
	)
}

const TransfersSlot = () => {
	const { t } = useTranslation()
	const { transfersActive, count } = useTransfersStore(
		useShallow(state => ({
			transfersActive: state.transfers.length > 0,
			count: state.stats.count
		}))
	)

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
				<SpeedDisplay />
			</View>
			<AnimatedProgressBar />
		</PressableScale>
	)
}

export default TransfersSlot

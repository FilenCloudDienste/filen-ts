import { memo } from "react"
import { useShallow } from "zustand/shallow"
import { router } from "expo-router"
import { ActivityIndicator } from "react-native"
import * as Progress from "react-native-progress"
import { bpsToReadable } from "@filen/utils"
import useTransfersStore from "@/stores/useTransfers.store"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import { useResolveClassNames } from "uniwind"

const TransfersSlot = memo(() => {
	const transfersActive = useTransfersStore(useShallow(state => state.transfers.length > 0))
	const { progress, speed, count } = useTransfersStore(useShallow(state => state.stats))
	const textBlue500 = useResolveClassNames("text-blue-500")
	const bgBackgroundTertiary = useResolveClassNames("bg-background-tertiary")
	const textForeground = useResolveClassNames("text-foreground")

	if (!transfersActive) {
		return null
	}

	const onPress = () => {
		router.push("/transfers")
	}

	return (
		<PressableScale
			className="flex-1 flex-col overflow-hidden"
			rippleColor="transparent"
			onPress={onPress}
		>
			<View className="flex-row items-center justify-between bg-transparent px-3 py-2 gap-3 flex-1">
				<Text
					className="text-sm shrink-0 flex-1"
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
						className="text-sm shrink-0"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{bpsToReadable(speed)}
					</Text>
				)}
			</View>
			<Progress.Bar
				width={null}
				height={3}
				progress={progress}
				color={textBlue500.color as string | undefined}
				borderWidth={0}
				borderRadius={0}
				unfilledColor={bgBackgroundTertiary.color as string | undefined}
				animated={false}
			/>
		</PressableScale>
	)
})

TransfersSlot.displayName = "TransfersSlot"

export default TransfersSlot

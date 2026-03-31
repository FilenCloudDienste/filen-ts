import useTransfersStore from "@/stores/useTransfers.store"
import { useShallow } from "zustand/shallow"
import { Fragment, memo } from "react"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import Text from "@/components/ui/text"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Platform, ActivityIndicator } from "react-native"
import * as Progress from "react-native-progress"
import { useResolveClassNames } from "uniwind"
import { bpsToReadable } from "@filen/utils"
import { PressableScale } from "@/components/ui/pressables"
import { router } from "expo-router"

const TransfersInner = memo(() => {
	const { progress, speed, count } = useTransfersStore(useShallow(state => state.stats))
	const textBlue500 = useResolveClassNames("text-blue-500")
	const bgBackgroundTertiary = useResolveClassNames("bg-background-tertiary")
	const textForeground = useResolveClassNames("text-foreground")

	return (
		<Fragment>
			<View className="flex-row items-center justify-between bg-transparent px-4 py-3 gap-4 flex-1">
				<Text
					className="shrink-0 flex-1"
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
						className="shrink-0"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{bpsToReadable(speed)}
					</Text>
				)}
			</View>
			<Progress.Bar
				width={null}
				height={4}
				progress={progress}
				color={textBlue500.color as string | undefined}
				borderWidth={0}
				borderRadius={0}
				unfilledColor={bgBackgroundTertiary.color as string | undefined}
				animated={false}
			/>
		</Fragment>
	)
})

const Transfers = memo(() => {
	const insets = useSafeAreaInsets()
	const transfersActive = useTransfersStore(useShallow(state => state.transfers.length > 0))

	if (!transfersActive) {
		return null
	}

	return (
		<View
			className="absolute left-0 right-0 bg-transparent"
			style={{
				bottom: Platform.select({
					ios: insets.bottom + 8,
					default: 8
				}),
				paddingLeft: insets.left > 0 ? insets.left : 16,
				paddingRight: insets.right > 0 ? insets.right : 16
			}}
		>
			<CrossGlassContainerView className="overflow-hidden">
				<PressableScale
					className="flex-col overflow-hidden flex-1"
					rippleColor="transparent"
					onPress={() => {
						router.push("/transfers")
					}}
				>
					<TransfersInner />
				</PressableScale>
			</CrossGlassContainerView>
		</View>
	)
})

export default Transfers

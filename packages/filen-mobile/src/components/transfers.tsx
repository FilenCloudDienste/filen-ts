import useTransfersStore from "@/stores/useTransfers.store"
import { useShallow } from "zustand/shallow"
import { memo, useCallback } from "@/lib/memo"
import { Fragment } from "react"
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
					{count} active transfer{count !== 1 ? "s" : ""}
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
						{bpsToReadable(speed)}/s
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
				animated={true}
			/>
		</Fragment>
	)
})

const Transfers = memo(() => {
	const insets = useSafeAreaInsets()
	const transfersActive = useTransfersStore(useShallow(state => state.transfers.some(t => !t.finishedAt)))

	const onPress = useCallback(() => {
		router.push("/transfers")
	}, [])

	if (!transfersActive) {
		return null
	}

	return (
		<View
			className="absolute left-0 right-0 bg-transparent px-4"
			style={{
				bottom:
					insets.bottom +
					Platform.select({
						ios: 60,
						default: 90
					})
			}}
		>
			<PressableScale
				rippleColor="transparent"
				onPress={onPress}
			>
				<CrossGlassContainerView
					disableBlur={Platform.OS === "android"}
					className="flex-col overflow-hidden"
				>
					<TransfersInner />
				</CrossGlassContainerView>
			</PressableScale>
		</View>
	)
})

export default Transfers

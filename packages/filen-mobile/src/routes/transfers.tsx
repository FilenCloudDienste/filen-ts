import { memo } from "react"
import Text from "@/components/ui/text"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Platform } from "react-native"
import { useShallow } from "zustand/shallow"
import useTransfersStore, { type Transfer } from "@/stores/useTransfers.store"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import { PressableScale } from "@/components/ui/pressables"

const Transfers = memo(() => {
	const transfers = useTransfersStore(useShallow(state => state.transfers))

	const keyExtractor = (item: Transfer) => item.id

	const renderItem = (info: ListRenderItemInfo<Transfer>) => {
		return (
			<View className="bg-transparent px-4 items-center justify-between flex-row">
				<Text className="text-foreground">{info.item.type}</Text>
				<PressableScale
					rippleColor="transparent"
					onPress={() => {
						info.item.abort()
					}}
				>
					<CrossGlassContainerView className="h-9 min-w-9 flex-row items-center justify-center">
						<Text className="text-foreground">stop</Text>
					</CrossGlassContainerView>
				</PressableScale>
			</View>
		)
	}

	return (
		<SafeAreaView
			className="flex-1 bg-background-secondary"
			edges={Platform.select({
				ios: ["left", "right"],
				default: ["left", "right", "top"]
			})}
		>
			<VirtualList
				className="flex-1 bg-background-secondary"
				contentInsetAdjustmentBehavior="automatic"
				contentContainerClassName="pb-40"
				keyExtractor={keyExtractor}
				data={transfers}
				renderItem={renderItem}
			/>
		</SafeAreaView>
	)
})

export default Transfers

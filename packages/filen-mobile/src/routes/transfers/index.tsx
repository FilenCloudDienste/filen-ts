import { memo, Fragment } from "react"
import Text from "@/components/ui/text"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Platform } from "react-native"
import { useShallow } from "zustand/shallow"
import useTransfersStore, { type Transfer as TTransfer } from "@/stores/useTransfers.store"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import View from "@/components/ui/view"
import { PressableScale } from "@/components/ui/pressables"
import Header, { type HeaderItem } from "@/components/ui/header"
import { useResolveClassNames } from "uniwind"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { router } from "expo-router"
import Ionicons from "@expo/vector-icons/Ionicons"

const Transfer = memo(({ info: { item: transfer } }: { info: ListRenderItemInfo<TTransfer> }) => {
	return (
		<View className="bg-red-500 px-4 items-center justify-between flex-row gap-4">
			<View className="flex-row items-center gap-2 bg-transparent">
				<Text className="text-foreground">
					{transfer.type === "uploadDirectory"
						? transfer.localFileOrDir.name
						: transfer.type === "uploadFile"
							? transfer.localFileOrDir.name
							: transfer.type === "downloadDirectory"
								? (transfer.item.decryptedMeta?.name ?? transfer.item.uuid)
								: (transfer.item.decryptedMeta?.name ?? transfer.item.uuid)}
				</Text>
			</View>
			<View className="flex-row items-center bg-transparent gap-2">
				{transfer.aborted ? (
					<Text>tbd_aborted</Text>
				) : transfer.finishedAt ? (
					<Text>tbd_finished</Text>
				) : (
					<Fragment>
						<PressableScale
							className="h-9 min-w-9 flex-row items-center justify-center px-3 py-2"
							onPress={() => {
								if (transfer.paused) {
									transfer.resume()

									return
								}

								transfer.pause()
							}}
						>
							<Text className="text-foreground">tbd_pause</Text>
						</PressableScale>
						<PressableScale
							className="h-9 min-w-9 flex-row items-center justify-center px-3 py-2"
							onPress={() => {
								if (transfer.aborted) {
									return
								}

								transfer.abort()
							}}
						>
							<Text className="text-foreground">tbd_stop</Text>
						</PressableScale>
					</Fragment>
				)}
			</View>
		</View>
	)
})

const Transfers = memo(() => {
	const transfers = useTransfersStore(useShallow(state => state.transfers))
	const insets = useSafeAreaInsets()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")

	return (
		<Fragment>
			<Header
				title="tbd_transfers"
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={Platform.select({
					ios: [
						{
							type: "button",
							icon: {
								name: "chevron-back-outline",
								color: textForeground.color,
								size: 20
							},
							props: {
								onPress: () => {
									router.back()
								}
							}
						}
					] satisfies HeaderItem[],
					default: undefined
				})}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<VirtualList
					className="flex-1 bg-transparent"
					contentInsetAdjustmentBehavior="automatic"
					keyExtractor={transfer => `${transfer.type}-${transfer.id}`}
					data={transfers}
					renderItem={info => <Transfer info={info} />}
					emptyComponent={() => {
						return (
							<View className="flex-1 items-center justify-center bg-transparent gap-2">
								<Ionicons
									name="sync-outline"
									size={64}
									color={textMutedForeground.color}
								/>
								<Text>tbd_no_transfers</Text>
							</View>
						)
					}}
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
				/>
			</SafeAreaView>
		</Fragment>
	)
})

export default Transfers

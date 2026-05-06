import { memo, Fragment, useState } from "react"
import Text from "@/components/ui/text"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Platform } from "react-native"
import { useShallow } from "zustand/shallow"
import useTransfersStore, { type Transfer as TTransfer } from "@/stores/useTransfers.store"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import { PressableScale } from "@/components/ui/pressables"
import Header, { type HeaderItem } from "@/components/ui/header"
import { useResolveClassNames } from "uniwind"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { router } from "expo-router"
import Ionicons from "@expo/vector-icons/Ionicons"
import Menu from "@/components/ui/menu"
import Thumbnail from "@/components/drive/item/thumbnail"
import { DirectoryIcon, FileIcon } from "@/components/itemIcons"
import { DirColor } from "@filen/sdk-rs"
import transfersLib from "@/lib/transfers"

const Transfer = memo(({ info: { item: transfer, target } }: { info: ListRenderItemInfo<TTransfer> }) => {
	const textForeground = useResolveClassNames("text-foreground")

	return (
		<View className="bg-transparent px-4 flex-col py-2">
			<View className="bg-transparent items-center justify-between flex-row gap-4">
				<View className="flex-row items-center gap-3 bg-transparent flex-1">
					{transfer.type === "uploadDirectory" || transfer.type === "uploadFile" ? (
						<Fragment>
							{transfer.type === "uploadDirectory" ? (
								<DirectoryIcon
									color={DirColor.Default.new()}
									width={32}
									height={32}
								/>
							) : (
								<FileIcon
									name={transfer.localFileOrDir.name}
									width={32}
									height={32}
								/>
							)}
						</Fragment>
					) : (
						<Thumbnail
							item={transfer.item}
							target={target}
							size={{
								icon: 32,
								thumbnail: 32
							}}
							contentFit="cover"
							className="rounded-lg"
						/>
					)}
					<Text
						className="text-foreground flex-1"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{transfer.type === "uploadDirectory" || transfer.type === "uploadFile"
							? transfer.localFileOrDir.name
							: (transfer.item.data.decryptedMeta?.name ?? transfer.item.data.uuid)}
					</Text>
				</View>
				<View className="flex-row items-center bg-transparent gap-3 shrink-0">
					{transfer.paused ? (
						<Ionicons
							name="pause-circle-outline"
							size={20}
							color={textForeground.color}
						/>
					) : (
						<Text>{Math.min(100, Math.max(0, (transfer.bytesTransferred / transfer.size) * 100)).toFixed(0)}%</Text>
					)}
					<Menu
						type="dropdown"
						buttons={[
							...(transfer.paused
								? [
										{
											id: "resume",
											title: "tbd_resume",
											onPress: () => {
												transfer.resume()
											}
										}
									]
								: [
										{
											id: "pause",
											title: "tbd_pause",
											onPress: () => {
												transfer.pause()
											}
										}
									]),
							{
								id: "cancel",
								title: "tbd_cancel",
								icon: "delete",
								onPress: () => {
									transfer.abort()
								}
							}
						]}
					>
						<CrossGlassContainerView>
							<PressableScale className="size-9 flex-row items-center justify-center">
								<Ionicons
									name="ellipsis-horizontal"
									size={20}
									color={textForeground.color}
								/>
							</PressableScale>
						</CrossGlassContainerView>
					</Menu>
				</View>
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
	const [allPaused, setAllPaused] = useState<boolean>(false)

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
				rightItems={
					transfers.length > 0
						? [
								{
									type: "menu",
									props: {
										type: "dropdown",
										hitSlop: 20,
										buttons: [
											...(allPaused
												? [
														{
															id: "resumeAll",
															title: "tbd_resume_all",
															onPress: () => {
																transfersLib.resumeAll()

																setAllPaused(false)
															}
														}
													]
												: [
														{
															id: "pauseAll",
															title: "tbd_pause_all",
															onPress: () => {
																transfersLib.pauseAll()

																setAllPaused(true)
															}
														}
													]),
											{
												id: "abortAll",
												title: "tbd_cancel_all",
												icon: "delete",
												onPress: () => {
													transfersLib.cancelAll()
												}
											}
										]
									},
									triggerProps: {
										hitSlop: 20
									},
									icon: {
										name: "ellipsis-horizontal",
										size: 24,
										color: textForeground.color
									}
								}
							]
						: undefined
				}
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

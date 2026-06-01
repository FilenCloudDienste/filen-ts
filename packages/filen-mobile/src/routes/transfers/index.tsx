import { memo, Fragment } from "react"
import Text from "@/components/ui/text"
import SafeAreaView from "@/components/ui/safeAreaView"
import ListEmpty from "@/components/ui/listEmpty"
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
import { useTranslation } from "react-i18next"
import Ionicons from "@expo/vector-icons/Ionicons"
import Menu from "@/components/ui/menu"
import Thumbnail from "@/components/drive/item/thumbnail"
import { DirectoryIcon, FileIcon } from "@/components/itemIcons"
import { DirColor } from "@filen/sdk-rs"
import transfersLib from "@/lib/transfers"
import { driveItemDisplayName } from "@/lib/decryption"
import { run } from "@filen/utils"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"

const Transfer = memo(({ info: { item: transfer, target } }: { info: ListRenderItemInfo<TTransfer> }) => {
	const { t } = useTranslation()
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
							: driveItemDisplayName(transfer.item)}
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
						<Text>
							{transfer.size > 0
								? `${Math.min(100, Math.max(0, (transfer.bytesTransferred / transfer.size) * 100)).toFixed(0)}%`
								: "0%"}
						</Text>
					)}
					<Menu
						type="dropdown"
						buttons={[
							...(transfer.paused
								? [
										{
											id: "resume",
											title: t("resume"),
											icon: "play" as const,
											onPress: () => {
												transfer.resume()
											}
										}
									]
								: [
										{
											id: "pause",
											title: t("pause"),
											icon: "pause" as const,
											onPress: () => {
												transfer.pause()
											}
										}
									]),
							{
								id: "cancel",
								title: t("cancel"),
								icon: "cancel",
								destructive: true,
								onPress: async () => {
									const promptResult = await run(async () => {
										return await prompts.alert({
											title: t("cancel_transfer"),
											message: t("confirm_cancel_transfer"),
											cancelText: t("cancel"),
											okText: t("cancel_transfer"),
											destructive: true
										})
									})

									if (!promptResult.success) {
										console.error(promptResult.error)
										alerts.error(promptResult.error)

										return
									}

									if (promptResult.data.cancelled) {
										return
									}

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
	const { t } = useTranslation()
	const transfers = useTransfersStore(useShallow(state => state.transfers))
	const insets = useSafeAreaInsets()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")

	// Derive the pause-all state from the live transfers array so that closing
	// and reopening the modal reflects truth — local component state would be
	// reset to false on remount even if every transfer is actually paused.
	const allPaused = transfers.length > 0 && transfers.every(t => t.paused)

	return (
		<Fragment>
			<Header
				title={t("transfers")}
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
								name: "close",
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
															title: t("resume_all"),
															icon: "play" as const,
															onPress: () => {
																// Iterate per-transfer instead of resuming the
																// global signal: the store's `paused` flag is
																// driven by the per-transfer signal, so a global
																// resume would leave individually-paused transfers
																// stuck (store says resumed, SDK still paused).
																for (const transfer of transfers) {
																	transfer.resume()
																}
															}
														}
													]
												: [
														{
															id: "pauseAll",
															title: t("pause_all"),
															icon: "pause" as const,
															onPress: () => {
																// Same reason — iterate per-transfer so the
																// per-transfer signal stays in sync with the store
																// and so the global pause signal doesn't stay
																// sticky and silently pause future uploads.
																for (const transfer of transfers) {
																	transfer.pause()
																}
															}
														}
													]),
											{
												id: "abortAll",
												title: t("cancel_all"),
												icon: "cancel",
												destructive: true,
												onPress: async () => {
													const promptResult = await run(async () => {
														return await prompts.alert({
															title: t("cancel_all_transfers"),
															message: t("confirm_cancel_all_transfers"),
															cancelText: t("cancel"),
															okText: t("cancel_all"),
															destructive: true
														})
													})

													if (!promptResult.success) {
														console.error(promptResult.error)
														alerts.error(promptResult.error)

														return
													}

													if (promptResult.data.cancelled) {
														return
													}

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
					emptyComponent={() => (
						<ListEmpty
							icon="sync-outline"
							title={t("no_transfers")}
						/>
					)}
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
				/>
			</SafeAreaView>
		</Fragment>
	)
})

export default Transfers

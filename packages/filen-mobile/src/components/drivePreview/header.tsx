import View, { CrossGlassContainerView } from "@/components/ui/view"
import { AnimatedView } from "@/components/ui/animated"
import Text from "@/components/ui/text"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import useViewLayout from "@/hooks/useViewLayout"
import { useRef, useEffect, memo, Fragment } from "react"
import { type View as TView, Platform } from "react-native"
import DriveItemMenu from "@/components/drive/item/menu"
import useDriveItemStoredOfflineQuery from "@/queries/useDriveItemStoredOffline.query"
import { useShallow } from "zustand/shallow"
import { getPreviewType } from "@/lib/utils"
import { cn, run } from "@filen/utils"
import { useResolveClassNames } from "uniwind"
import Menu from "@/components/ui/menu"
import { useSecureStore } from "@/lib/secureStore"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import * as Linking from "expo-linking"

const GalleryHeader = memo(
	({
		animatedStyle,
		goBack
	}: {
		animatedStyle: {
			opacity: number
		}
		goBack: () => void
	}) => {
		const insets = useSafeAreaInsets()
		const viewRef = useRef<TView>(null)
		const { onLayout, layout } = useViewLayout(viewRef)
		const textForeground = useResolveClassNames("text-foreground")
		const [openLinkTrustedDomains, setOpenLinkTrustedDomains] = useSecureStore<Record<string, boolean>>("openLinkTrustedDomains", {})
		const currentItem = useDrivePreviewStore(useShallow(state => state.currentItem))
		const drivePath = useDrivePreviewStore(useShallow(state => state.drivePath))

		const currentItemPreviewType = getPreviewType(
			currentItem ? (currentItem.type === "drive" ? (currentItem.data.data.decryptedMeta?.name ?? "") : currentItem.data.name) : ""
		)

		const solidHeader = currentItemPreviewType === "docx" || currentItemPreviewType === "pdf" || currentItemPreviewType === "video"

		const driveItemStoredOfflineQuery = useDriveItemStoredOfflineQuery(
			{
				uuid: currentItem && currentItem.type === "drive" ? currentItem.data.data.uuid : "",
				type: "file"
			},
			{
				enabled: currentItem?.type === "drive"
			}
		)

		useEffect(() => {
			useDrivePreviewStore.getState().setHeaderHeight(
				Platform.select({
					ios: layout.height,
					default: layout.height + insets.top // Adjust for Android status bar
				})
			)
		}, [layout.height, insets.top])

		return (
			<AnimatedView
				className={cn("absolute top-0 left-0 right-0 z-1000", solidHeader ? "bg-background" : "bg-transparent")}
				style={[
					{
						paddingTop: insets.top
					},
					animatedStyle
				]}
			>
				<View
					className={cn(
						"flex-row items-center px-4 py-3 pt-0 min-h-11 gap-10 justify-between",
						solidHeader ? "bg-background" : "bg-transparent"
					)}
					ref={viewRef}
					onLayout={onLayout}
				>
					<PressableScale
						className="size-11 items-center justify-center"
						onPress={goBack}
						hitSlop={10}
					>
						{currentItemPreviewType === "audio" ? (
							<View className="size-11 flex-row items-center justify-center bg-transparent rounded-full">
								<Ionicons
									name="close-outline"
									size={24}
									color="white"
								/>
							</View>
						) : (
							<CrossGlassContainerView className="size-11 flex-row items-center justify-center">
								<Ionicons
									name="close-outline"
									size={30}
									color={solidHeader ? textForeground.color : "white"}
								/>
							</CrossGlassContainerView>
						)}
					</PressableScale>
					<Text
						className={cn("flex-1 font-semibold text-base text-center", solidHeader ? "text-foreground" : "text-white")}
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{currentItem
							? currentItem.type === "drive"
								? (currentItem.data.data.decryptedMeta?.name ?? "")
								: currentItem.data.name
							: ""}
					</Text>
					{currentItem && !drivePath?.selectOptions ? (
						<Fragment>
							{currentItem.type === "drive" ? (
								<DriveItemMenu
									type="dropdown"
									item={currentItem.data}
									drivePath={
										drivePath ?? {
											type: "linked",
											uuid: null
										}
									}
									isStoredOffline={
										driveItemStoredOfflineQuery.status === "success" ? driveItemStoredOfflineQuery.data : false
									}
								>
									{currentItemPreviewType === "audio" ? (
										<View className="size-11 flex-row items-center justify-center bg-transparent rounded-full">
											<Ionicons
												name="ellipsis-horizontal"
												size={24}
												color="white"
											/>
										</View>
									) : (
										<CrossGlassContainerView className="size-11 flex-row items-center justify-center">
											<Ionicons
												name="ellipsis-horizontal"
												size={24}
												color={solidHeader ? textForeground.color : "white"}
											/>
										</CrossGlassContainerView>
									)}
								</DriveItemMenu>
							) : (
								<Menu
									type="dropdown"
									buttons={[
										{
											id: "openLink",
											title: "tbd_open_link",
											onPress: async () => {
												const parsedDomain = (() => {
													try {
														const url = new URL(currentItem.data.url)

														return url.hostname
													} catch {
														return null
													}
												})()

												if (!parsedDomain) {
													return
												}

												const canOpenResult = await run(async () => {
													return await Linking.canOpenURL(currentItem.data.url)
												})

												if (!canOpenResult.success) {
													console.error(canOpenResult.error)
													alerts.error(canOpenResult.error)

													return
												}

												if (!canOpenResult.data) {
													alerts.error("tbd_cannot_open_link")

													return
												}

												if (!openLinkTrustedDomains[parsedDomain]) {
													const promptResponse = await run(async () => {
														return await prompts.alert({
															title: "tbd_open_external_link",
															message: `tbd_open_external_link_message_${parsedDomain}`,
															cancelText: "tbd_cancel",
															okText: "tbd_open_trust"
														})
													})

													if (!promptResponse.success) {
														console.error(promptResponse.error)
														alerts.error(promptResponse.error)

														return
													}

													if (promptResponse.data.cancelled) {
														return
													}

													setOpenLinkTrustedDomains(prev => ({
														...prev,
														[parsedDomain]: true
													}))
												}

												const openResult = await run(async () => {
													return await Linking.openURL(currentItem.data.url)
												})

												if (!openResult.success) {
													console.error(openResult.error)
													alerts.error(openResult.error)

													return
												}
											}
										}
									]}
								>
									<CrossGlassContainerView className="size-11 flex-row items-center justify-center">
										<Ionicons
											name="ellipsis-horizontal"
											size={24}
											color={solidHeader ? textForeground.color : "white"}
										/>
									</CrossGlassContainerView>
								</Menu>
							)}
						</Fragment>
					) : (
						<View className="size-11 flex-row items-center justify-center bg-transparent" />
					)}
				</View>
			</AnimatedView>
		)
	}
)

export default GalleryHeader

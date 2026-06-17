import View, { CrossGlassContainerView } from "@/components/ui/view"
import { AnimatedView } from "@/components/ui/animated"
import { useAnimatedStyle } from "react-native-reanimated"
import Text from "@/components/ui/text"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import useViewLayout from "@/hooks/useViewLayout"
import { useRef, useEffect, Fragment } from "react"
import { useTranslation } from "react-i18next"
import { type View as TView, Platform } from "react-native"
import DriveItemMenu from "@/features/drive/components/item/menu"
import useDriveItemStoredOfflineQuery from "@/features/drive/queries/useDriveItemStoredOffline.query"
import { useShallow } from "zustand/shallow"
import { getPreviewType } from "@/lib/previewType"
import { driveItemDisplayName } from "@/lib/decryption"
import { cn, run } from "@filen/utils"
import { useResolveClassNames } from "uniwind"
import Menu from "@/components/ui/menu"
import { useSecureStore } from "@/lib/secureStore"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import * as Linking from "expo-linking"
import SafeAreaView from "@/components/ui/safeAreaView"
import logger from "@/lib/logger"

const GalleryHeader = ({
	animatedStyle,
	goBack
}: {
	animatedStyle: ReturnType<typeof useAnimatedStyle<{ opacity: number }>>
	goBack: () => void
}) => {
	const { t } = useTranslation()
	const insets = useSafeAreaInsets()
	const viewRef = useRef<TView>(null)
	const { onLayout, layout } = useViewLayout(viewRef)
	const textForeground = useResolveClassNames("text-foreground")
	const [openLinkTrustedDomains, setOpenLinkTrustedDomains] = useSecureStore<Record<string, boolean>>("openLinkTrustedDomains", {})
	const currentItem = useDrivePreviewStore(useShallow(state => state.currentItem))
	const drivePath = useDrivePreviewStore(useShallow(state => state.drivePath))

	const currentItemPreviewType = getPreviewType(
		currentItem ? (currentItem.type === "drive" ? driveItemDisplayName(currentItem.data) : currentItem.data.name) : ""
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
			style={animatedStyle}
		>
			<SafeAreaView
				edges={["top", "left", "right"]}
				className="bg-transparent"
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
						{currentItem ? (currentItem.type === "drive" ? driveItemDisplayName(currentItem.data) : currentItem.data.name) : ""}
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
									showSelectToggle={false}
									isPreview={true}
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
											title: t("open_link"),
											icon: "openExternal",
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
													logger.error("drivePreview", "canOpenURL failed for linked file", { error: canOpenResult.error })
													alerts.error(canOpenResult.error)

													return
												}

												if (!canOpenResult.data) {
													alerts.error(t("cannot_open_link"))

													return
												}

												if (!openLinkTrustedDomains[parsedDomain]) {
													const promptResponse = await run(async () => {
														return await prompts.alert({
															title: t("open_external_link"),
															message: t("open_external_link_message", {
																domain: parsedDomain
															}),
															cancelText: t("cancel"),
															okText: t("open_trust")
														})
													})

													if (!promptResponse.success) {
														logger.error("drivePreview", "trust-prompt failed", { error: promptResponse.error })
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
													logger.error("drivePreview", "openURL failed for linked file", { error: openResult.error })
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
			</SafeAreaView>
		</AnimatedView>
	)
}

export default GalleryHeader

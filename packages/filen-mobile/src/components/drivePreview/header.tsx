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
import Menu from "@/components/drive/item/menu"
import useDriveItemStoredOfflineQuery from "@/queries/useDriveItemStoredOffline.query"
import { useShallow } from "zustand/shallow"
import { getPreviewType } from "@/lib/utils"
import { cn } from "@filen/utils"
import { useResolveClassNames } from "uniwind"
import type { GalleryItemTagged, InitialItem } from "@/components/drivePreview/gallery"

const GalleryHeader = memo(
	({
		animatedStyle,
		goBack,
		initialItem,
		items
	}: {
		animatedStyle: {
			opacity: number
		}
		goBack: () => void
		initialItem: InitialItem
		items: GalleryItemTagged[]
	}) => {
		const insets = useSafeAreaInsets()
		const viewRef = useRef<TView>(null)
		const { onLayout, layout } = useViewLayout(viewRef)
		const textForeground = useResolveClassNames("text-foreground")

		const { currentItemId } = useDrivePreviewStore(
			useShallow(state => ({
				currentItemId:
					state.currentItem?.type === "drive" ? state.currentItem.data.data.uuid : (state.currentItem?.data.url ?? null)
			}))
		)

		const currentItem = items.find(item =>
			item.type === "drive" ? item.data.data.uuid === currentItemId : item.data.url === currentItemId
		)
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
				enabled: currentItem ? currentItem.type === "drive" : false
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
					{currentItem ? (
						<Fragment>
							{currentItem.type === "drive" ? (
								<Menu
									type="dropdown"
									item={currentItem.data}
									drivePath={
										initialItem.type === "drive"
											? initialItem.data.drivePath
											: {
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
								</Menu>
							) : (
								<CrossGlassContainerView className="size-11 flex-row items-center justify-center">
									<Ionicons
										name="ellipsis-horizontal"
										size={24}
										color={solidHeader ? textForeground.color : "white"}
									/>
								</CrossGlassContainerView>
							)}
						</Fragment>
					) : null}
				</View>
			</AnimatedView>
		)
	}
)

export default GalleryHeader

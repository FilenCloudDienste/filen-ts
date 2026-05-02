import View, { CrossGlassContainerView } from "@/components/ui/view"
import { AnimatedView } from "@/components/ui/animated"
import Text from "@/components/ui/text"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import useViewLayout from "@/hooks/useViewLayout"
import { useRef, useEffect, memo } from "react"
import { type View as TView, Platform } from "react-native"
import Menu from "@/components/drive/item/menu"
import useDriveItemStoredOfflineQuery from "@/queries/useDriveItemStoredOffline.query"
import { useShallow } from "zustand/shallow"
import { getPreviewType } from "@/lib/utils"
import { cn } from "@filen/utils"
import { useResolveClassNames } from "uniwind"
import useDriveItemsQuery from "@/queries/useDriveItems.query"
import type { InitialItem } from "@/components/drivePreview/gallery"

const GalleryHeader = memo(
	({
		animatedStyle,
		goBack,
		initialItem
	}: {
		animatedStyle: {
			opacity: number
		}
		goBack: () => void
		initialItem: InitialItem
	}) => {
		const insets = useSafeAreaInsets()
		const viewRef = useRef<TView>(null)
		const { onLayout, layout } = useViewLayout(viewRef)
		const textForeground = useResolveClassNames("text-foreground")

		const { currentItemUuid } = useDrivePreviewStore(
			useShallow(state => ({
				currentItemUuid: state.currentItem?.data.uuid
			}))
		)

		const driveItemsQuery = useDriveItemsQuery(
			{
				path:
					initialItem.type === "drive"
						? initialItem.data.drivePath
						: {
								type: "drive",
								uuid: ""
							}
			},
			{
				enabled: false
			}
		)

		const currentItem =
			initialItem.type === "drive"
				? driveItemsQuery.status === "success"
					? (driveItemsQuery.data.find(item => item.data.uuid === currentItemUuid) ?? null)
					: null
				: null
		const currentItemPreviewType = getPreviewType(currentItem?.data.decryptedMeta?.name ?? "")
		const solidHeader = currentItemPreviewType === "docx" || currentItemPreviewType === "pdf" || currentItemPreviewType === "video"

		const driveItemStoredOfflineQuery = useDriveItemStoredOfflineQuery({
			uuid: currentItem?.data.uuid ?? "",
			type: "file"
		})

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
						{initialItem.type === "external"
							? initialItem.data.name
							: (currentItem?.data.decryptedMeta?.name ?? currentItem?.data.uuid ?? "")}
					</Text>
					{currentItem && initialItem.type === "drive" ? (
						<Menu
							type="dropdown"
							item={currentItem}
							drivePath={initialItem.data.drivePath}
							isStoredOffline={driveItemStoredOfflineQuery.status === "success" ? driveItemStoredOfflineQuery.data : false}
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
							{/* TODO: menu for external items */}
							<Ionicons
								name="ellipsis-horizontal"
								size={24}
								color={solidHeader ? textForeground.color : "white"}
							/>
						</CrossGlassContainerView>
					)}
				</View>
			</AnimatedView>
		)
	}
)

export default GalleryHeader

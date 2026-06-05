import View from "@/components/ui/view"
import { type DriveItemFileExtracted } from "@/types"
import { type ListRenderItemInfo } from "@/components/ui/virtualList"
import { type ViewStyle } from "react-native"
import { cn } from "@filen/utils"
import { getPreviewType } from "@/lib/previewType"
import { driveItemDisplayName } from "@/lib/decryption"
import Thumbnail from "@/features/drive/components/item/thumbnail"
import Ionicons from "@expo/vector-icons/Ionicons"
import useDriveItemStoredOfflineQuery from "@/features/drive/queries/useDriveItemStoredOffline.query"
import { PressableOpacity } from "@/components/ui/pressables"
import { type DrivePath } from "@/hooks/useDrivePath"
import Menu from "@/features/drive/components/item/menu"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import useDriveStore from "@/features/drive/store/useDrive.store"

export const Photo = ({
	info,
	size,
	drivePath,
	getListItems
}: {
	info: ListRenderItemInfo<DriveItemFileExtracted>
	size: number
	drivePath: DrivePath
	getListItems: () => DriveItemFileExtracted[]
}) => {
	const previewType = getPreviewType(driveItemDisplayName(info.item))
	const isSelected = useDriveStore(useShallow(state => state.selectedItems.some(i => i.data.uuid === info.item.data.uuid)))
	const arePhotosSelected = useDriveStore(useShallow(state => state.selectedItems.length > 0))

	const driveItemStoredOfflineQuery = useDriveItemStoredOfflineQuery({
		uuid: info.item.data.uuid,
		type: info.item.type
	})

	const viewStyle: ViewStyle = {
		width: size,
		height: size
	}

	const onPress = () => {
		// In selection mode, tap toggles. Else open the preview.
		if (arePhotosSelected) {
			useDriveStore.getState().toggleSelectedItem(info.item)

			return
		}

		useDrivePreviewStore.getState().open({
			initialItem: {
				type: "drive",
				data: {
					item: info.item,
					drivePath
				}
			},
			items: getListItems().map(item => ({
				type: "drive",
				data: item
			}))
		})
	}

	return (
		<View
			style={viewStyle}
			className="p-px"
		>
			<Menu
				style={viewStyle}
				type="context"
				isAnchoredToRight={true}
				item={info.item}
				drivePath={drivePath}
				isStoredOffline={driveItemStoredOfflineQuery.status === "success" ? driveItemStoredOfflineQuery.data : false}
			>
				<View style={viewStyle}>
					<PressableOpacity
						className={cn("items-center justify-center flex-1 overflow-hidden", isSelected && "opacity-60")}
						onPress={onPress}
						style={viewStyle}
					>
						{previewType === "video" && (
							<View className="size-4 absolute bottom-0.5 right-0.5 z-10 flex-row items-center justify-center bg-white rounded-full p-px">
								<Ionicons
									name="play"
									size={13}
									color="black"
								/>
							</View>
						)}
						{info.item.type === "file" && info.item.data.favorited && (
							<View className="size-4 absolute bottom-0.5 left-0.5 z-10 flex-row items-center justify-center bg-red-500 rounded-full p-px">
								<Ionicons
									name="heart"
									size={13}
									color="white"
								/>
							</View>
						)}
						{driveItemStoredOfflineQuery.status === "success" && driveItemStoredOfflineQuery.data && (
							<View className="size-4 absolute top-0.5 right-0.5 z-10 flex-row items-center justify-center bg-green-500 rounded-full p-px">
								<Ionicons
									name="checkmark-done"
									size={13}
									color="white"
								/>
							</View>
						)}
						{arePhotosSelected && (
							<View
								className={cn(
									"size-5 absolute top-0.5 left-0.5 z-10 flex-row items-center justify-center rounded-full",
									isSelected ? "bg-blue-500" : "bg-black/40 border border-white"
								)}
							>
								{isSelected && (
									<Ionicons
										name="checkmark"
										size={14}
										color="white"
									/>
								)}
							</View>
						)}
						<Thumbnail
							item={info.item}
							target={info.target}
							contentFit="cover"
							size={{
								icon: size - 2,
								thumbnail: size - 2
							}}
						/>
					</PressableOpacity>
				</View>
			</Menu>
		</View>
	)
}

export default Photo

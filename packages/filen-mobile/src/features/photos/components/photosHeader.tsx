import StackHeader, { type HeaderItem } from "@/components/ui/header"
import { type DriveItemFileExtracted } from "@/types"
import { type DrivePath } from "@/hooks/useDrivePath"
import { Platform } from "react-native"
import { router } from "@/lib/router"
import { useResolveClassNames } from "uniwind"
import { useShallow } from "zustand/shallow"
import { useTranslation } from "react-i18next"
import useCameraUploadStore from "@/features/cameraUpload/store/useCameraUpload.store"
import useDriveStore from "@/features/drive/store/useDrive.store"
import { usePhotosGridTiles, PHOTOS_GRID_TILE_OPTIONS } from "@/features/photos/photosGridTiles"
import usePhotoBulkActions from "@/features/photos/hooks/usePhotoBulkActions"

export const Header = ({ items, drivePath }: { items: DriveItemFileExtracted[]; drivePath: DrivePath }) => {
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")
	const syncing = useCameraUploadStore(useShallow(state => state.syncing))
	// CU-09: open the issues modal when there are errors OR skipped assets, so a skipped-only state
	// (assets dropped after repeated upload failures, with no error currently in the list) is reachable.
	const hasIssues = useCameraUploadStore(useShallow(state => state.errors.length > 0 || state.skippedAssets.length > 0))
	const textRed500 = useResolveClassNames("text-red-500")
	const [photosGridTiles, setPhotosGridTiles] = usePhotosGridTiles()
	const selectedItems = useDriveStore(useShallow(state => state.selectedItems))
	const inSelectionMode = selectedItems.length > 0
	const bulkButtons = usePhotoBulkActions({ items, drivePath })

	const leftItems = ((): HeaderItem[] | undefined => {
		if (inSelectionMode) {
			return [
				{
					type: "clearSelection",
					onPress: () => useDriveStore.getState().clearSelectedItems()
				}
			]
		}

		if (hasIssues) {
			return [
				{
					type: "button",
					icon: {
						name: "warning-outline",
						color: textRed500.color,
						size: 20
					},
					props: {
						onPress: () => {
							router.push("/cameraUploadErrors")
						}
					}
				}
			]
		}

		if (syncing) {
			return [
				{
					type: "loader",
					props: {
						color: textForeground.color,
						size: "small"
					}
				}
			]
		}

		return undefined
	})()

	const rightItems = ((): HeaderItem[] => {
		if (inSelectionMode) {
			return [
				{
					type: "ellipsisMenu",
					buttons: bulkButtons
				}
			]
		}

		return [
			{
				type: "ellipsisMenu",
				buttons: [
					{
						id: "settings",
						title: t("settings"),
						onPress: () => router.push("/cameraUpload"),
						icon: "gear"
					},
					{
						id: "gridTiles",
						title: t("photos_per_row", { count: photosGridTiles }),
						icon: "grid",
						subButtons: PHOTOS_GRID_TILE_OPTIONS.map(tiles => ({
							id: `gridTiles${tiles}`,
							title: String(tiles),
							checked: photosGridTiles === tiles,
							onPress: () => setPhotosGridTiles(tiles)
						}))
					}
				]
			}
		]
	})()

	return (
		<StackHeader
			title={inSelectionMode ? t("selected", { count: selectedItems.length }) : t("photos")}
			transparent={Platform.OS === "ios"}
			leftItems={leftItems}
			rightItems={rightItems}
			shadowVisible={false}
		/>
	)
}

export default Header

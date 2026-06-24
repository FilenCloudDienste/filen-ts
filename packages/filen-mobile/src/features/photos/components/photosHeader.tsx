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
import { useSecureStore } from "@/lib/secureStore"
import usePhotoBulkActions from "@/features/photos/hooks/usePhotoBulkActions"

export const Header = ({ items, drivePath }: { items: DriveItemFileExtracted[]; drivePath: DrivePath }) => {
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")
	const syncing = useCameraUploadStore(useShallow(state => state.syncing))
	// CU-09: open the issues modal when there are errors OR skipped assets, so a skipped-only state
	// (assets dropped after repeated upload failures, with no error currently in the list) is reachable.
	const hasIssues = useCameraUploadStore(useShallow(state => state.errors.length > 0 || state.skippedAssets.length > 0))
	const textRed500 = useResolveClassNames("text-red-500")
	const [photosGridTiles, setPhotosGridTiles] = useSecureStore<number>("photosGridTiles", 4)
	const selectedItems = useDriveStore(useShallow(state => state.selectedItems))
	const inSelectionMode = selectedItems.length > 0
	const bulkButtons = usePhotoBulkActions({ items, drivePath })

	const leftItems = ((): HeaderItem[] | undefined => {
		if (inSelectionMode) {
			return [
				{
					type: "button",
					icon: {
						name: "close-outline",
						color: textForeground.color,
						size: 20
					},
					props: {
						onPress: () => {
							useDriveStore.getState().clearSelectedItems()
						}
					}
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
					type: "menu",
					props: {
						type: "dropdown",
						hitSlop: 20,
						buttons: bulkButtons
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
		}

		return [
			{
				type: "menu",
				props: {
					type: "dropdown",
					hitSlop: 20,
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
							subButtons: [
								{
									id: "gridTiles1",
									title: "1",
									checked: photosGridTiles === 1,
									onPress: () => setPhotosGridTiles(1)
								},
								{
									id: "gridTiles2",
									title: "2",
									checked: photosGridTiles === 2,
									onPress: () => setPhotosGridTiles(2)
								},
								{
									id: "gridTiles3",
									title: "3",
									checked: photosGridTiles === 3,
									onPress: () => setPhotosGridTiles(3)
								},
								{
									id: "gridTiles4",
									title: "4",
									checked: photosGridTiles === 4,
									onPress: () => setPhotosGridTiles(4)
								},
								{
									id: "gridTiles5",
									title: "5",
									checked: photosGridTiles === 5,
									onPress: () => setPhotosGridTiles(5)
								}
							]
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

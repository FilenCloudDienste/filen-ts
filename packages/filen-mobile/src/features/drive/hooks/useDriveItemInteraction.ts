import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { DriveItem } from "@/types"
import type { DrivePath } from "@/hooks/useDrivePath"
import useDriveStore from "@/features/drive/store/useDrive.store"
import useDriveSelectStore from "@/features/drive/store/useDriveSelect.store"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { getPreviewType } from "@/lib/previewType"
import { driveItemDisplayName } from "@/lib/decryption"
import { isDriveItemDisabled, isDriveItemNavigateOnly, resolveDriveNavigationTarget } from "@/features/drive/driveSelectors"
import { router } from "@/lib/router"

export default function useDriveItemInteraction({
	info,
	drivePath,
	getListItems
}: {
	info: ListRenderItemInfo<DriveItem>
	drivePath: DrivePath
	getListItems: () => DriveItem[]
}): {
	onPress: () => void
	disabled: boolean
	navigateOnly: boolean
	isSelected: boolean
	isSelecting: boolean
	areDriveItemsSelected: boolean
	isSelectedFromDriveSelect: boolean
	onPressSelectForDriveSelect: () => void
} {
	const isSelected = useDriveStore(
		useShallow(state => state.selectedItems.some(i => i.data.uuid === info.item.data.uuid && i.type === info.item.type))
	)
	const areDriveItemsSelected = useDriveStore(useShallow(state => state.selectedItems.length > 0))
	const isSelectedFromDriveSelect = useDriveSelectStore(
		useShallow(state => state.selectedItems.some(i => i.data.uuid === info.item.data.uuid && i.type === info.item.type))
	)
	const selectedItemsFromDriveSelectLength = useDriveSelectStore(useShallow(state => state.selectedItems.length))
	const previewType =
		info.item.type === "file" || info.item.type === "sharedFile" || info.item.type === "sharedRootFile"
			? getPreviewType(driveItemDisplayName(info.item))
			: null

	const disabled = isDriveItemDisabled({
		item: info.item,
		drivePath,
		previewType,
		selectedFromDriveSelectCount: selectedItemsFromDriveSelectLength,
		isSelectedFromDriveSelect
	})

	const navigateOnly = isDriveItemNavigateOnly({
		item: info.item,
		drivePath,
		disabled
	})

	const onPressSelectForDriveSelect = () => {
		if (disabled) {
			return
		}

		if (drivePath.selectOptions && drivePath.selectOptions.intention === "select") {
			useDriveSelectStore.getState().setSelectedItems(prev => {
				const prevSelected = prev.some(i => i.data.uuid === info.item.data.uuid && i.type === info.item.type)

				if (prevSelected) {
					return prev.filter(i => !(i.data.uuid === info.item.data.uuid && i.type === info.item.type))
				}

				return [...prev.filter(i => !(i.data.uuid === info.item.data.uuid && i.type === info.item.type)), info.item]
			})

			return
		}
	}

	const onPress = () => {
		// Undecryptable items have no meaningful preview or navigation target —
		// suppress the open intent so the row stays inert. Selection still works
		// because that path goes through the Checkbox / Menu Select button.
		if (info.item.data.undecryptable) {
			return
		}

		if (disabled && !navigateOnly) {
			return
		}

		if (!navigateOnly) {
			if (isSelectedFromDriveSelect) {
				onPressSelectForDriveSelect()

				return
			}

			// In a select-intention picker, tapping a file row/tile toggles the pick —
			// opening a preview here would hijack the selection flow. Must run before the
			// areDriveItemsSelected branch so a lingering in-drive multi-select can't
			// swallow picker taps into the wrong store. Directories keep navigating;
			// their pick affordance is the checkbox.
			if (
				drivePath.selectOptions?.intention === "select" &&
				(info.item.type === "file" || info.item.type === "sharedFile" || info.item.type === "sharedRootFile")
			) {
				onPressSelectForDriveSelect()

				return
			}

			if (areDriveItemsSelected) {
				useDriveStore.getState().setSelectedItems(prev => {
					const prevSelected = prev.some(i => i.data.uuid === info.item.data.uuid)

					if (prevSelected) {
						return prev.filter(i => i.data.uuid !== info.item.data.uuid)
					}

					return [...prev.filter(i => i.data.uuid !== info.item.data.uuid), info.item]
				})

				return
			}

			if (info.item.type === "file" || info.item.type === "sharedFile" || info.item.type === "sharedRootFile") {
				useDrivePreviewStore.getState().open({
					initialItem: {
						type: "drive",
						data: {
							item: info.item,
							drivePath
						}
					},
					items: getListItems()
						.filter(i => i.type === "file" || i.type === "sharedFile" || i.type === "sharedRootFile")
						.map(item => ({
							type: "drive",
							data: item
						}))
				})

				return
			}
		}

		const navigationTarget = resolveDriveNavigationTarget({
			item: info.item,
			drivePath
		})

		if (navigationTarget) {
			router.push(navigationTarget)

			return
		}
	}

	return {
		onPress,
		disabled,
		navigateOnly,
		isSelected,
		isSelecting: (areDriveItemsSelected && !drivePath.selectOptions) || drivePath.selectOptions?.intention === "select",
		areDriveItemsSelected,
		isSelectedFromDriveSelect,
		onPressSelectForDriveSelect
	}
}

import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { DriveItem } from "@/types"
import type { DrivePath } from "@/hooks/useDrivePath"
import useDriveStore, { isDriveItemInSelection } from "@/features/drive/store/useDrive.store"
import useDriveSelectStore, { selectDriveSelectSelection } from "@/features/drive/store/useDriveSelect.store"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { getDriveItemPreviewType } from "@/lib/previewType"
import {
	isDriveItemDisabled,
	isDriveItemNavigateOnly,
	nextDriveSelectSelection,
	resolveDriveNavigationTarget,
	isFileItem,
	driveItemHasLeadingCheckbox
} from "@/features/drive/driveSelectors"
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
	isSelected: boolean
	disabled: boolean
	navigateOnly: boolean
	areDriveItemsSelected: boolean
	hasCheckbox: boolean
	checkbox: {
		value: boolean
		onValueChange: (() => void) | undefined
		color: "transparent" | undefined
	}
} {
	const isSelected = useDriveStore(state => isDriveItemInSelection(state.selectedItems, info.item))
	const areDriveItemsSelected = useDriveStore(state => state.selectedItems.length > 0)
	const selectSessionId = drivePath.selectOptions?.id
	const isSelectedFromDriveSelect = useDriveSelectStore(state =>
		selectDriveSelectSelection(state, selectSessionId).some(i => i.data.uuid === info.item.data.uuid && i.type === info.item.type)
	)
	const previewType = isFileItem(info.item) ? getDriveItemPreviewType(info.item) : null

	const disabled = isDriveItemDisabled({
		item: info.item,
		drivePath,
		previewType
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
			const selectionType = drivePath.selectOptions.type

			useDriveSelectStore.getState().setSelectedItems(drivePath.selectOptions.id, prev =>
				nextDriveSelectSelection({
					prev,
					item: info.item,
					type: selectionType
				})
			)

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
			if (drivePath.selectOptions?.intention === "select" && isFileItem(info.item)) {
				onPressSelectForDriveSelect()

				return
			}

			if (areDriveItemsSelected) {
				useDriveStore.getState().toggleSelectedItem(info.item)

				return
			}

			if (isFileItem(info.item)) {
				useDrivePreviewStore.getState().open({
					initialItem: {
						type: "drive",
						data: {
							item: info.item,
							drivePath
						}
					},
					items: getListItems()
						.filter(isFileItem)
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

	// The picker's checkbox is disabled-gated in value, handler and colour; the bulk one is not.
	const checkbox = drivePath.selectOptions
		? {
				value: disabled ? false : isSelectedFromDriveSelect,
				onValueChange: disabled ? undefined : onPressSelectForDriveSelect,
				color: disabled ? ("transparent" as const) : undefined
			}
		: {
				value: isSelected,
				onValueChange: onPress,
				color: undefined
			}

	return {
		onPress,
		isSelected,
		disabled,
		navigateOnly,
		areDriveItemsSelected,
		hasCheckbox: driveItemHasLeadingCheckbox({ drivePath, areDriveItemsSelected }),
		checkbox
	}
}

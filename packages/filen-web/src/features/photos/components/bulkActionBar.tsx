import { useTranslation } from "react-i18next"
import { type DriveActionDescriptor, type DriveActionDialogKind } from "@/features/drive/lib/selectionActions"
import { startDownloads } from "@/features/drive/lib/download"
import { runPhotosBulkFavorite } from "@/features/photos/lib/bulkFavorite"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { photosActions, photosParentNaming } from "@/features/photos/lib/itemActions"
import { useIsOnline } from "@/lib/useIsOnline"
import { DROPDOWN_TREE_MENU_FAMILY } from "@/features/drive/components/directoryTreeSubmenu"
import { CompressMenuEntries } from "@/features/drive/components/archiveSubmenus"
import { BulkActionButton, BulkActionMenuButton, SelectionActionBar } from "@/components/selectionActionBar"

export interface PhotosBulkActionBarProps {
	rootUuids: readonly string[]
	selectedItems: PhotoItem[]
	onDialogAction: (kind: DriveActionDialogKind) => void
}

// Floating selection bar for the photos grid — drive's own descriptors and gates, against the
// photos-scoped selection store + cache-patching action wrappers instead of drive's own.
export function PhotosBulkActionBar({ rootUuids, selectedItems, onDialogAction }: PhotosBulkActionBarProps) {
	const { t } = useTranslation(["drive", "photos", "common"])
	const isOnline = useIsOnline()
	const descriptors = photosActions(selectedItems, isOnline)

	// download is checked first — startDownloads' FSA save picker needs this click's own live user
	// gesture (mirrors drive's identical ordering rationale), so nothing here may yield ahead of it.
	function runDescriptor(descriptor: DriveActionDescriptor): void {
		if (descriptor.id === "download") {
			void startDownloads(selectedItems)
			return
		}

		if (descriptor.id === "favorite") {
			void runPhotosBulkFavorite(rootUuids, selectedItems)
			return
		}

		if (descriptor.run === "dialog") {
			onDialogAction(descriptor.dialogKind)
		}
	}

	return (
		<SelectionActionBar
			count={selectedItems.length}
			clearKbdAction="photos.clearSelection"
			onClear={() => {
				usePhotosStore.getState().clearSelectedItems()
			}}
		>
			{descriptors.map(descriptor => {
				const disabled = descriptor.enabled === false
				const disabledReason = disabled && descriptor.disabledReasonKey !== undefined ? t(descriptor.disabledReasonKey) : undefined

				// Compress opens the same entries its submenu holds in the menus, like drive's bar.
				if (descriptor.id === "compress") {
					return (
						<BulkActionMenuButton
							key={descriptor.id}
							icon={descriptor.icon}
							label={t(descriptor.labelKey)}
							disabled={disabled}
							disabledReason={disabledReason}
						>
							<CompressMenuEntries
								family={DROPDOWN_TREE_MENU_FAMILY}
								items={selectedItems}
								variant="drive"
								parentNaming={photosParentNaming(rootUuids, t("common:modulePhotos"))}
								onMoreOptions={() => {
									onDialogAction("compress")
								}}
							/>
						</BulkActionMenuButton>
					)
				}

				return (
					<BulkActionButton
						key={descriptor.id}
						icon={descriptor.icon}
						label={t(descriptor.labelKey)}
						destructive={descriptor.destructive}
						disabled={disabled}
						disabledReason={disabledReason}
						kbdAction={descriptor.kbdAction}
						onClick={() => {
							runDescriptor(descriptor)
						}}
					/>
				)
			})}
		</SelectionActionBar>
	)
}

import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useDialogHost } from "@/lib/useDialogHost"
import { type ItemActionDialogKind } from "@/features/drive/components/itemMenu.logic"
import { type BulkDialogActionKind } from "@/features/drive/components/bulkActionBar.logic"
import { renamePhotoItem, trashPhotos } from "@/features/photos/lib/actions"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { toastBulkOutcome } from "@/features/drive/lib/bulkToast"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"
import { VersionsDialog } from "@/features/drive/components/versionsDialog"
import { InfoDialog } from "@/features/drive/components/infoDialog"
import { LinkDialog } from "@/features/drive/components/linkDialog"
import { ContactPickerDialog } from "@/features/drive/components/contactPickerDialog"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { InputDialog } from "@/components/dialogs/inputDialog"

// The photos surface's own dialog kind — narrower than drive's ActiveDialogKind (no move/color/
// unshare/delete/import/preview/emptyTrash/restoreSelected/disableLink: none of those ever reach a
// photos item — see itemActions.ts/bulkActions.ts's own doc comments on what's dropped and why).
type PhotosDialogKind = "rename" | "trash" | "versions" | "info" | "link" | "share"

interface ActivePhotosDialog {
	kind: PhotosDialogKind
	items: PhotoItem[]
}

export interface PhotosDialogHost {
	isDialogOpen: boolean
	handleItemAction: (kind: ItemActionDialogKind, item: PhotoItem) => void
	handleBulkDialogAction: (kind: BulkDialogActionKind) => void
	renderActiveDialog: () => ReactNode
}

interface UsePhotosDialogHostParams {
	rootUuid: string
	selectedItems: PhotoItem[]
}

// The photos-scoped counterpart of drive's useDriveDialogHost, trimmed to the six dialog kinds the
// photos menu/bar ever dispatch. rename/trash route through this file's own PhotoItem-cache-patching
// wrappers (features/photos/lib/actions.ts); versions/info/link/share reuse the EXACT same generic
// dialog components drive uses unchanged (none of them take a `variant` — they operate on a bare
// item/items, see each component's own props), so there is no photos-specific fork of any of them.
export function usePhotosDialogHost({ rootUuid, selectedItems }: UsePhotosDialogHostParams): PhotosDialogHost {
	const { t } = useTranslation(["drive", "photos", "common"])
	const { activeDialog, setActiveDialog, dialogPending, setDialogPending, isDialogOpen, closeActiveDialog } =
		useDialogHost<ActivePhotosDialog>()

	// itemMenu.logic.ts's ItemActionDialogKind is wider than PhotosDialogKind (drive's own menu can
	// dispatch move/color/unshare/delete/import too) — photosItemActions never produces a descriptor
	// carrying one of those, so this narrows defensively and no-ops rather than widening the type.
	function handleItemAction(kind: ItemActionDialogKind, item: PhotoItem): void {
		if (kind !== "rename" && kind !== "trash" && kind !== "versions" && kind !== "info" && kind !== "link" && kind !== "share") {
			return
		}

		setActiveDialog({ kind, items: [item] })
	}

	function handleBulkDialogAction(kind: BulkDialogActionKind): void {
		if (kind !== "trash" && kind !== "share") {
			return
		}

		setActiveDialog({ kind, items: selectedItems })
	}

	async function handleRenameSubmit(item: PhotoItem, value: string): Promise<void> {
		setDialogPending(true)
		const outcome = await renamePhotoItem(rootUuid, item, value.trim())
		setDialogPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		closeActiveDialog()
	}

	async function handleTrashConfirm(items: PhotoItem[]): Promise<void> {
		setDialogPending(true)
		const outcome = await trashPhotos(rootUuid, items)
		setDialogPending(false)
		closeActiveDialog()
		toastBulkOutcome(outcome)
		usePhotosStore.getState().removeFromSelection(outcome.succeeded.map(item => item.data.uuid))
	}

	function renderActiveDialog(): ReactNode {
		if (!activeDialog) {
			return null
		}

		switch (activeDialog.kind) {
			case "rename": {
				const item = activeDialog.items[0]

				if (!item) {
					return null
				}

				return (
					<InputDialog
						open
						pending={dialogPending}
						title={t("driveActionRename")}
						body={t("driveRenameDialogBody")}
						label={t("driveNewDirectoryLabel")}
						initialValue={item.data.decryptedMeta?.name ?? ""}
						submitLabel={t("driveActionRename")}
						validate={value => value.trim().length > 0}
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onSubmit={value => {
							void handleRenameSubmit(item, value)
						}}
					/>
				)
			}
			case "trash":
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("driveTrashConfirmTitle")}
						body={t("driveTrashConfirmBody", { count: activeDialog.items.length })}
						confirmLabel={t("driveActionTrash")}
						cancelLabel={t("common:cancel")}
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleTrashConfirm(activeDialog.items)
						}}
					/>
				)
			case "versions": {
				const item = activeDialog.items[0]

				if (!item) {
					return null
				}

				return (
					<VersionsDialog
						file={item}
						onClose={closeActiveDialog}
					/>
				)
			}
			case "info": {
				const item = activeDialog.items[0]

				if (!item) {
					return null
				}

				return (
					<InfoDialog
						item={item}
						remoteInfoEnabled
						onClose={closeActiveDialog}
					/>
				)
			}
			case "link": {
				const item = activeDialog.items[0]

				if (!item) {
					return null
				}

				return (
					<LinkDialog
						item={item}
						onClose={closeActiveDialog}
					/>
				)
			}
			case "share":
				return activeDialog.items.length > 0 ? (
					<ContactPickerDialog
						items={activeDialog.items}
						onClose={closeActiveDialog}
						onShared={succeededUuids => {
							usePhotosStore.getState().removeFromSelection(succeededUuids)
						}}
					/>
				) : null
		}
	}

	return { isDialogOpen, handleItemAction, handleBulkDialogAction, renderActiveDialog }
}

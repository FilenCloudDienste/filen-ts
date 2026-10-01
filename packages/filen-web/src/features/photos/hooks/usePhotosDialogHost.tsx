import { type ReactNode } from "react"
import { useDialogHost } from "@/lib/useDialogHost"
import { type ItemActionDialogKind } from "@/features/drive/components/itemMenu.logic"
import { type BulkDialogActionKind } from "@/features/drive/components/bulkActionBar.logic"
import { renamePhotoItem, trashPhotos, patchPhoto } from "@/features/photos/lib/actions"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { DRIVE_TRASH, driveActivity } from "@/features/drive/lib/activity"
import { prunePhotoSelection, usePhotosStore } from "@/features/photos/store/usePhotosStore"
import { type DriveItem } from "@/features/drive/lib/item"
import { keepPreviewOpenOnNavigate, usePreviewDialogState } from "@/features/preview/hooks/usePreviewDialogState"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"
import { PHOTOS_HIDDEN_ACTION_IDS } from "@/features/photos/lib/itemActions"
import { ItemDialog, RenameItemDialog, TrashConfirmDialog } from "@/features/drive/components/itemDialogs"

// The photos surface's own dialog kind — narrower than drive's ActiveDialogKind (no move/color/
// unshare/delete/import/emptyTrash/restoreSelected/disableLink: none of those ever reach a photos item
// — see itemActions.ts/bulkActions.ts's own doc comments on what's dropped and why). "preview" is the
// one addition beyond the per-item menu's own seven kinds — opened directly by a tile click, never via
// handleItemAction, mirroring useDriveDialogHost's identical split between menu-dispatched kinds and
// its own dedicated openPreview entry point.
type PhotosDialogKind = "rename" | "copy" | "trash" | "versions" | "info" | "link" | "share" | "preview"

// The preview arm holds the frozen pager snapshot + position usePreviewDialogState folds events into
// — a DriveItem[], since a reconciled rename re-narrows its item.
type ActivePhotosDialog =
	{ kind: Exclude<PhotosDialogKind, "preview">; items: PhotoItem[] } | { kind: "preview"; items: DriveItem[]; index: number }

export interface PhotosDialogHost {
	isDialogOpen: boolean
	handleItemAction: (kind: ItemActionDialogKind, item: PhotoItem) => void
	handleBulkDialogAction: (kind: BulkDialogActionKind) => void
	openPreview: (items: DriveItem[], index: number) => void
	renderActiveDialog: () => ReactNode
}

interface UsePhotosDialogHostParams {
	rootUuid: string
	selectedItems: PhotoItem[]
}

// The photos-scoped counterpart of drive's useDriveDialogHost, trimmed to the eight dialog kinds the
// photos menu/bar/grid ever dispatch. rename/trash route through this file's own PhotoItem-cache-
// patching wrappers (features/photos/lib/actions.ts); copy/versions/info/link/share/preview reuse the EXACT
// same generic dialog components drive uses unchanged (the two that take the `variant` the preview
// overlay does — the overlay itself and the info dialog — get "drive", see their render-site comments),
// so there is no photos-specific fork of any of them beyond the preview's one extra favorite-patch prop.
export function usePhotosDialogHost({ rootUuid, selectedItems }: UsePhotosDialogHostParams): PhotosDialogHost {
	const { activeDialog, setActiveDialog, dialogPending, isDialogOpen, closeActiveDialog, runDialogOutcome, runBulkDialogActivity } =
		useDialogHost<ActivePhotosDialog>({ keepOpenOnNavigate: keepPreviewOpenOnNavigate })

	// A removal from the preview patches no photos listing: a remote move can keep the photo under the
	// root, while the server's echo of a trash or delete drops it from the listing without a walk
	// (invalidatePhotosListing). Only the open pager itself converges here.
	const { stepPreview, removeCurrentPreviewItem } = usePreviewDialogState(setActiveDialog)

	// Opens the preview overlay for a frozen item snapshot at the given position — called from the
	// grid's own tile click handler with the whole sorted media set, never
	// scoped to a smaller sibling list the way drive's audio-exclusion dance needs (a photos listing is
	// already image/video-only by construction).
	function openPreview(items: DriveItem[], index: number): void {
		setActiveDialog({ kind: "preview", items, index })
	}

	// itemMenu.logic.ts's ItemActionDialogKind is wider than PhotosDialogKind (drive's own menu can
	// dispatch move/color/unshare/delete/import too) — a photos item under PHOTOS_HIDDEN_ACTION_IDS never
	// gets a descriptor carrying one of those, so this narrows defensively and no-ops rather than
	// widening the type.
	function handleItemAction(kind: ItemActionDialogKind, item: PhotoItem): void {
		if (
			kind !== "rename" &&
			kind !== "copy" &&
			kind !== "trash" &&
			kind !== "versions" &&
			kind !== "info" &&
			kind !== "link" &&
			kind !== "share"
		) {
			return
		}

		setActiveDialog({ kind, items: [item] })
	}

	function handleBulkDialogAction(kind: BulkDialogActionKind): void {
		if (kind !== "copy" && kind !== "trash" && kind !== "share") {
			return
		}

		setActiveDialog({ kind, items: selectedItems })
	}

	async function handleRenameSubmit(item: PhotoItem, value: string): Promise<void> {
		await runDialogOutcome(() => renamePhotoItem(rootUuid, item, value.trim()))
	}

	async function handleTrashConfirm(items: PhotoItem[]): Promise<void> {
		await runBulkDialogActivity(
			driveActivity(items, DRIVE_TRASH, (targets, onSettled) => trashPhotos(rootUuid, targets, onSettled), {
				prune: prunePhotoSelection
			})
		)
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
					<RenameItemDialog
						item={item}
						pending={dialogPending}
						onClose={closeActiveDialog}
						onSubmit={value => {
							void handleRenameSubmit(item, value)
						}}
					/>
				)
			}
			case "trash":
				return (
					<TrashConfirmDialog
						count={activeDialog.items.length}
						pending={dialogPending}
						onClose={closeActiveDialog}
						onConfirm={() => {
							void handleTrashConfirm(activeDialog.items)
						}}
					/>
				)
			case "copy":
			case "versions":
			case "info":
			case "link":
			case "share":
				return (
					<ItemDialog
						kind={activeDialog.kind}
						items={activeDialog.items}
						// A photos item is always an owned, non-trashed file under the user's own drive, so it
						// carries no sharing counterparty row.
						variant="drive"
						onClose={closeActiveDialog}
						onShared={succeededUuids => {
							usePhotosStore.getState().removeFromSelection(succeededUuids)
						}}
					/>
				)
			case "preview":
				return (
					<PreviewOverlay
						// A photos item is always an owned, non-trashed file under the user's own drive — the
						// same descriptor set + editable/download gating "drive" resolves for a normal listing
						// is exactly right here too (see PreviewOverlayProps' own doc comment: the overlay is
						// reused entirely as shipped, no photos-specific variant).
						variant="drive"
						items={activeDialog.items}
						index={activeDialog.index}
						onStep={stepPreview}
						onClose={closeActiveDialog}
						onItemRemoved={removeCurrentPreviewItem}
						onFavoriteToggled={item => {
							patchPhoto(rootUuid, item)
						}}
						hiddenMenuActionIds={PHOTOS_HIDDEN_ACTION_IDS}
					/>
				)
		}
	}

	return { isDialogOpen, handleItemAction, handleBulkDialogAction, openPreview, renderActiveDialog }
}

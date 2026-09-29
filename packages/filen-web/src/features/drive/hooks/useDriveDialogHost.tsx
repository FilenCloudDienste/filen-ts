import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useDialogHost } from "@/lib/useDialogHost"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { renameItem, trashItems, restoreItems, deleteItemsPermanently, disableLinks, emptyTrash } from "@/features/drive/lib/actions"
import { unshareItems } from "@/features/drive/lib/share/actions"
import { notifyIfNameIsHidden } from "@/features/drive/lib/hiddenNameNotice"
import { type BulkOutcome } from "@/lib/actions/bulk"
import { toastBulkOutcome } from "@/features/drive/lib/bulkToast"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { type ItemActionDialogKind } from "@/features/drive/components/itemMenu.logic"
import { type BulkDialogActionKind } from "@/features/drive/components/bulkActionBar.logic"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"
import { ColorDialog } from "@/features/drive/components/colorDialog"
import { ItemDialog, RenameItemDialog, TrashConfirmDialog } from "@/features/drive/components/itemDialogs"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"
import { keepPreviewOpenOnNavigate, usePreviewDialogState } from "@/features/preview/hooks/usePreviewDialogState"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { TypedConfirmDialog } from "@/components/dialogs/typedConfirmDialog"

// The listing-level dialog host's own state shape. Widens itemMenu.logic.ts's ItemActionDialogKind
// with two listing-level kinds neither dispatched by a per-item menu, so neither has a place in that
// narrower, per-item-scoped union: "emptyTrash" (the trash toolbar) and "restoreSelected" (the bulk
// bar's confirm — a single-item restore stays direct/unconfirmed, see itemMenu.logic.ts's RESTORE).
type ActiveDialogKind = ItemActionDialogKind | "emptyTrash" | "restoreSelected" | "disableLink" | "preview"

interface ActiveDialog {
	kind: ActiveDialogKind
	// For kind:"preview", the frozen pager snapshot taken at open time.
	items: DriveItem[]
	// Only meaningful for kind:"preview" — the opened slot's position within `items`. Every other kind
	// leaves this unset.
	index?: number
}

// Trash, delete, restore and disable-link take the whole item out of the listing, so every receiver row
// of it goes; unshare removes only its own receiver's row, so the item's other rows stay selected.
function pruneSelectionByUuid(succeeded: DriveItem[]): void {
	useDriveStore.getState().removeFromSelection(succeeded.map(item => item.data.uuid))
}

function pruneSelectionByRow(succeeded: DriveItem[]): void {
	useDriveStore.getState().removeRowsFromSelection(succeeded)
}

export interface DriveDialogHost {
	isDialogOpen: boolean
	handleItemAction: (kind: ItemActionDialogKind, item: DriveItem) => void
	handleBulkDialogAction: (kind: BulkDialogActionKind) => void
	handleEmptyTrash: () => void
	openPreview: (items: DriveItem[], index: number) => void
	renderActiveDialog: () => ReactNode
}

interface UseDriveDialogHostParams {
	variant: DriveVariant
	selectedItems: DriveItem[]
	// True when this listing would actually hide a dot-prefixed name (the preference AND
	// hiddenFilterAppliesTo) — computed once by the listing, since it already holds both halves.
	hiddenNoticeApplies: boolean
}

// One instance of whichever dialog activeDialog.kind names is rendered at a time (renderActiveDialog),
// never more than one. `dialogPending` is shared across the kinds whose async call the HOST itself owns
// (rename/trash/delete/emptyTrash/restoreSelected) — the move/color/versions/info dialogs run their own
// async calls internally and track their own pending state, since each needs more than one shared
// boolean can express (e.g. versions has an independent restore vs. delete-confirm flow).
export function useDriveDialogHost({ variant, selectedItems, hiddenNoticeApplies }: UseDriveDialogHostParams): DriveDialogHost {
	const { t } = useTranslation(["drive", "common"])
	const { activeDialog, setActiveDialog, dialogPending, isDialogOpen, closeActiveDialog, runDialogPending, runDialogOutcome } =
		useDialogHost<ActiveDialog>({ keepOpenOnNavigate: keepPreviewOpenOnNavigate })

	const { stepPreview, removeCurrentPreviewItem } = usePreviewDialogState(setActiveDialog)

	// Opens the preview overlay for a frozen item snapshot at the given position.
	function openPreview(items: DriveItem[], index: number): void {
		setActiveDialog({ kind: "preview", items, index })
	}

	// Threaded into DriveRow/DriveTile as onItemAction (consistent with onPointerSelect/onOpen) — every
	// "dialog"-run item-menu descriptor calls this with its own kind; "direct"-run ones (favorite/
	// restore) resolve fully inside itemMenu.tsx and never reach here.
	function handleItemAction(kind: ItemActionDialogKind, item: DriveItem): void {
		setActiveDialog({ kind, items: [item] })
	}

	async function handleRenameSubmit(item: DriveItem, value: string): Promise<void> {
		const trimmed = value.trim()

		if (!(await runDialogOutcome(() => renameItem(item, trimmed)))) {
			return
		}

		// A rename has no success feedback of its own either — see newDirectory.tsx's identical call.
		notifyIfNameIsHidden(trimmed, "renamed", hiddenNoticeApplies)
	}

	// Shared tail for every HOST-owned bulk-dialog confirm (trash/delete/restoreSelected): runs `op`
	// against `items`, tracks the shared dialogPending flag, closes the dialog, toasts the outcome,
	// and prunes succeeded items from the selection — a no-op for whichever failed (still visible,
	// correctly still selected, so the user can retry without re-selecting).
	async function runBulkDialogAction(
		items: DriveItem[],
		op: (items: DriveItem[]) => Promise<BulkOutcome<DriveItem>>,
		prune: (succeeded: DriveItem[]) => void = pruneSelectionByUuid
	): Promise<void> {
		const outcome = await runDialogPending(() => op(items))
		closeActiveDialog()
		toastBulkOutcome(outcome)
		prune(outcome.succeeded)
	}

	async function handleTrashConfirm(items: DriveItem[]): Promise<void> {
		await runBulkDialogAction(items, trashItems)
	}

	async function handleDeleteConfirm(items: DriveItem[]): Promise<void> {
		await runBulkDialogAction(items, deleteItemsPermanently)
	}

	// Bulk restore CONFIRMS (unlike a single item's direct, unconfirmed restore — see
	// itemMenu.logic.ts's RESTORE descriptor and driveRestoreSelectedConfirmTitle's own doc comment).
	async function handleRestoreSelectedConfirm(items: DriveItem[]): Promise<void> {
		await runBulkDialogAction(items, restoreItems)
	}

	// Root-only (see itemMenu.logic.ts's UNSHARE gate) — the sharedIn/sharedOut root-listing patch
	// lives inside unshareItems itself, keyed off the CURRENT variant (this listing's own).
	async function handleUnshareConfirm(items: DriveItem[]): Promise<void> {
		await runBulkDialogAction(items, targetItems => unshareItems(targetItems, variant), pruneSelectionByRow)
	}

	// Links-root only (see bulkActionBar.logic.ts's own variant gate) — revokes every selected item's
	// public link; disableLinks itself drops each succeeded item from the links listing.
	async function handleDisableLinkConfirm(items: DriveItem[]): Promise<void> {
		await runBulkDialogAction(items, disableLinks)
	}

	// Routes a bulk-action-bar click to the dialog host, dispatching against the CURRENT selection —
	// mirrors the drive.trash keymap command's identical setActiveDialog({kind:"trash", items:
	// selectedItems}).
	function handleBulkDialogAction(kind: BulkDialogActionKind): void {
		setActiveDialog({ kind, items: selectedItems })
	}

	// Trash toolbar's own trigger — targets the WHOLE trash, never a selection, so unlike
	// handleBulkDialogAction this carries no items (renderActiveDialog's "emptyTrash" arm never reads
	// activeDialog.items).
	function handleEmptyTrash(): void {
		setActiveDialog({ kind: "emptyTrash", items: [] })
	}

	async function handleEmptyTrashConfirm(): Promise<void> {
		await runDialogOutcome(emptyTrash)
	}

	// One instance of whichever dialog is active, switching on activeDialog.kind — never more than one
	// mounted at a time.
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
			case "delete":
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("driveDeletePermanentlyConfirmTitle")}
						body={t("driveDeletePermanentlyConfirmBody", { count: activeDialog.items.length })}
						confirmLabel={t("driveActionDeletePermanently")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleDeleteConfirm(activeDialog.items)
						}}
					/>
				)
			case "restoreSelected":
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("driveRestoreSelectedConfirmTitle")}
						body={t("driveRestoreSelectedConfirmBody", { count: activeDialog.items.length })}
						confirmLabel={t("driveActionRestore")}
						cancelLabel={t("common:cancel")}
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleRestoreSelectedConfirm(activeDialog.items)
						}}
					/>
				)
			case "emptyTrash": {
				const phrase = t("driveEmptyTrashTypedConfirmPhrase")

				return (
					<TypedConfirmDialog
						open
						pending={dialogPending}
						title={t("driveEmptyTrashConfirmTitle")}
						body={t("driveEmptyTrashConfirmBody", { phrase })}
						matchLabel={t("driveEmptyTrashTypedConfirmLabel")}
						matchValue={phrase}
						confirmLabel={t("driveActionEmptyTrash")}
						cancelLabel={t("common:cancel")}
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleEmptyTrashConfirm()
						}}
					/>
				)
			}
			case "move":
				return activeDialog.items.length > 0 ? (
					<MoveTargetDialog
						items={activeDialog.items}
						onClose={closeActiveDialog}
					/>
				) : null
			case "color": {
				const item = activeDialog.items[0]

				// The menu only ever offers Color for a directory (see itemMenu.logic.ts) — this narrows
				// that guarantee into a type, it doesn't impose a new one.
				if (item?.type !== "directory") {
					return null
				}

				return (
					<ColorDialog
						directory={item}
						onClose={closeActiveDialog}
					/>
				)
			}
			case "copy":
			case "versions":
			case "info":
			case "link":
			case "share":
				return (
					<ItemDialog
						kind={activeDialog.kind}
						items={activeDialog.items}
						variant={variant}
						onClose={closeActiveDialog}
					/>
				)
			case "unshare":
				// Reached from a per-item menu (items: [item]) or the bulk bar (items: selectedItems) — both
				// only ever dispatch this for sharedRootDirectory/sharedRootFile arms (itemMenu.logic.ts /
				// bulkActionBar.logic.ts's own root-only gate).
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("driveUnshareConfirmTitle")}
						body={t("driveUnshareConfirmBody", { count: activeDialog.items.length })}
						confirmLabel={t("driveActionUnshare")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleUnshareConfirm(activeDialog.items)
						}}
					/>
				)
			case "disableLink":
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("driveLinkDisableSelectedConfirmTitle")}
						body={t("driveLinkDisableSelectedConfirmBody", { count: activeDialog.items.length })}
						confirmLabel={t("driveLinkDisableAction")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleDisableLinkConfirm(activeDialog.items)
						}}
					/>
				)
			case "preview": {
				const previewIndex = activeDialog.index

				if (previewIndex === undefined) {
					return null
				}

				return (
					<PreviewOverlay
						variant={variant}
						items={activeDialog.items}
						index={previewIndex}
						onStep={stepPreview}
						onClose={closeActiveDialog}
						onItemRemoved={removeCurrentPreviewItem}
					/>
				)
			}
		}
	}

	return { isDialogOpen, handleItemAction, handleBulkDialogAction, handleEmptyTrash, openPreview, renderActiveDialog }
}

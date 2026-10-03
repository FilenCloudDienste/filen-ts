import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useDialogHost } from "@/lib/useDialogHost"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { renameItem, trashItems, restoreItems, deleteItemsPermanently, disableLinks, emptyTrash } from "@/features/drive/lib/actions"
import { unshareItems } from "@/features/drive/lib/share/actions"
import { notifyIfNameIsHidden } from "@/features/drive/lib/hiddenNameNotice"
import {
	DRIVE_DELETE_PERMANENTLY,
	DRIVE_DISABLE_LINK,
	DRIVE_RESTORE,
	DRIVE_TRASH,
	DRIVE_UNSHARE,
	driveActivity,
	pruneSelectionByRow
} from "@/features/drive/lib/activity"
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
// "openAsText" opens the preview instead (handleItemAction), so it is never a dialog kind of its own.
type ActiveDialogKind = Exclude<ItemActionDialogKind, "openAsText"> | "emptyTrash" | "restoreSelected" | "disableLink" | "preview"

interface ActiveDialog {
	kind: ActiveDialogKind
	// For kind:"preview", the frozen pager snapshot taken at open time.
	items: DriveItem[]
	// Only meaningful for kind:"preview" — the opened slot's position within `items`. Every other kind
	// leaves this unset.
	index?: number
	// kind:"preview" opened through "Open as text".
	asText?: boolean
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
	const { activeDialog, setActiveDialog, dialogPending, isDialogOpen, closeActiveDialog, runDialogOutcome, runBulkDialogActivity } =
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
		// Just this file, with no pager: the siblings it would page through are the previewable files,
		// which it is not one of.
		if (kind === "openAsText") {
			setActiveDialog({ kind: "preview", items: [item], index: 0, asText: true })

			return
		}

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

	// Every HOST-owned bulk-dialog confirm (trash/delete/restoreSelected/unshare/disable links) runs as an
	// activity (useDialogHost's runBulkDialogActivity) and prunes the succeeded items from the selection.
	async function handleTrashConfirm(items: DriveItem[]): Promise<void> {
		await runBulkDialogActivity(driveActivity(items, DRIVE_TRASH, trashItems))
	}

	async function handleDeleteConfirm(items: DriveItem[]): Promise<void> {
		await runBulkDialogActivity(driveActivity(items, DRIVE_DELETE_PERMANENTLY, deleteItemsPermanently))
	}

	// Bulk restore CONFIRMS (unlike a single item's direct, unconfirmed restore — see
	// itemMenu.logic.ts's RESTORE descriptor and driveRestoreSelectedConfirmTitle's own doc comment).
	async function handleRestoreSelectedConfirm(items: DriveItem[]): Promise<void> {
		await runBulkDialogActivity(driveActivity(items, DRIVE_RESTORE, restoreItems))
	}

	// Root-only (see itemMenu.logic.ts's UNSHARE gate) — the sharedIn/sharedOut root-listing patch
	// lives inside unshareItems itself, keyed off the CURRENT variant (this listing's own).
	async function handleUnshareConfirm(items: DriveItem[]): Promise<void> {
		await runBulkDialogActivity(
			driveActivity(items, DRIVE_UNSHARE, (targets, onSettled) => unshareItems(targets, variant, onSettled), {
				prune: pruneSelectionByRow
			})
		)
	}

	// Links-root only (see bulkActionBar.logic.ts's own variant gate) — revokes every selected item's
	// public link; disableLinks itself drops each succeeded item from the links listing.
	async function handleDisableLinkConfirm(items: DriveItem[]): Promise<void> {
		await runBulkDialogActivity(driveActivity(items, DRIVE_DISABLE_LINK, disableLinks))
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
						matchLabel={t("common:confirmationPhrase")}
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
			case "compress":
			case "extract":
			case "extractTo":
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
						asText={activeDialog.asText === true}
					/>
				)
			}
		}
	}

	return { isDialogOpen, handleItemAction, handleBulkDialogAction, handleEmptyTrash, openPreview, renderActiveDialog }
}

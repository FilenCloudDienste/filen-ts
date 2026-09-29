import { useEffect, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useDialogHost } from "@/lib/useDialogHost"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { stepPreviewIndex } from "@/features/drive/lib/preview.logic"
import { renameItem, trashItems, restoreItems, deleteItemsPermanently, disableLinks, emptyTrash } from "@/features/drive/lib/actions"
import { unshareItems } from "@/features/drive/lib/share/actions"
import { notifyIfNameIsHidden } from "@/features/drive/lib/hiddenNameNotice"
import { type BulkOutcome } from "@/features/drive/lib/bulk"
import { toastBulkOutcome } from "@/features/drive/lib/bulkToast"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { type ItemActionDialogKind } from "@/features/drive/components/itemMenu.logic"
import { type BulkDialogActionKind } from "@/features/drive/components/bulkActionBar.logic"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"
import { ContactPickerDialog } from "@/features/drive/components/contactPickerDialog"
import { ColorDialog } from "@/features/drive/components/colorDialog"
import { VersionsDialog } from "@/features/drive/components/versionsDialog"
import { InfoDialog } from "@/features/drive/components/infoDialog"
import { LinkDialog } from "@/features/drive/components/linkDialog"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"
import { previewProtectedUuid, reconcilePreviewSources, subscribePreviewReconcile } from "@/features/preview/lib/previewReconcile"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { TypedConfirmDialog } from "@/components/dialogs/typedConfirmDialog"
import { InputDialog } from "@/components/dialogs/inputDialog"

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

// The preview overlay owns its own navigation semantics: its dirty-buffer guard decides what a route
// change means for unsaved edits, and a same-route splat change deliberately keeps it mounted with the
// buffer intact. Closing it from the dialog host would silently discard exactly what that guard exists
// to protect.
function keepPreviewOpenOnNavigate(dialog: ActiveDialog): boolean {
	return dialog.kind === "preview"
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
	const { activeDialog, setActiveDialog, dialogPending, setDialogPending, isDialogOpen, closeActiveDialog } = useDialogHost<ActiveDialog>(
		{ keepOpenOnNavigate: keepPreviewOpenOnNavigate }
	)

	// Keeps an OPEN preview in sync with realtime drive mutations from ANOTHER device. The pager steps a
	// frozen items snapshot the socket handler's listing-cache patch can't reach, so the drive
	// handler emits a reconcile signal instead: a remote trash/move/delete advances the pager (or closes it
	// once the last slot goes) unless the slot on screen holds unsaved edits, which the overlay answers
	// itself, and a rename re-derives the header title — the remote-event twin of
	// removeCurrentPreviewItem's same-client sync. Newer versions are the overlay's alone. A no-op while no
	// preview is open (the updater short-circuits on any non-preview dialog). setActiveDialog is a stable
	// setState, so the subscription is set up once.
	useEffect(() => {
		return subscribePreviewReconcile(event => {
			setActiveDialog(prev => {
				if (prev?.kind !== "preview" || prev.index === undefined) {
					return prev
				}

				const state = { items: prev.items, index: prev.index }
				const next = reconcilePreviewSources(state, event, previewProtectedUuid(state))

				if (next === null) {
					return null
				}

				// Most events are about files the pager does not hold: no new dialog state, no re-render.
				if (next === state) {
					return prev
				}

				return { ...prev, items: next.items, index: next.index }
			})
		})
	}, [setActiveDialog])

	// Steps the open preview by one sibling (no wrap) — the single implementation behind PreviewOverlay's
	// onStep prop, which both the header's prev/next buttons AND its own local in-dialog arrow-key
	// handler call (previewOverlay.tsx — arrow keys can't reach a document-level keymap action while
	// the dialog traps focus, see that handler's own comment). A no-op outside kind:"preview".
	function stepPreview(delta: 1 | -1): void {
		setActiveDialog(prev => {
			if (prev?.kind !== "preview" || prev.index === undefined) {
				return prev
			}

			const current = prev.items[prev.index]

			if (!current) {
				return prev
			}

			return { ...prev, index: stepPreviewIndex(current.data.uuid, prev.items, delta) }
		})
	}

	// Opens the preview overlay for a frozen item snapshot at the given position.
	function openPreview(items: DriveItem[], index: number): void {
		setActiveDialog({ kind: "preview", items, index })
	}

	// Drops the acted-on slot out of the frozen pager snapshot — the preview header's own item menu
	// (previewOverlay.tsx) calls this after a successful trash/delete-permanently/restore-from-trash on
	// the previewed item, mirroring new mobile's driveItemRemoved gallery subscriber: stay on the same
	// visual position (which now shows the next sibling, clamped to the new last slot), or close outright
	// once the removed slot was the only one left. Routed through the SAME uuid-keyed reducer the socket
	// reconcile subscription uses ON PURPOSE: the server echoes this very mutation back over the socket,
	// and the echo can land before OR after this local call — remove-by-uuid makes the two arms converge
	// (whichever runs second finds nothing and no-ops), where the previous remove-by-index would race the
	// echo and drop the NEIGHBOUR's slot instead, collapsing a two-sibling pager to a spurious close.
	function removeCurrentPreviewItem(frozenUuid: string): void {
		setActiveDialog(prev => {
			if (prev?.kind !== "preview" || prev.index === undefined) {
				return prev
			}

			const next = reconcilePreviewSources({ items: prev.items, index: prev.index }, { type: "removed", uuid: frozenUuid })

			if (next === null) {
				return null
			}

			return { ...prev, items: next.items, index: next.index }
		})
	}

	// Threaded into DriveRow/DriveTile as onItemAction (consistent with onPointerSelect/onOpen) — every
	// "dialog"-run item-menu descriptor calls this with its own kind; "direct"-run ones (favorite/
	// restore) resolve fully inside itemMenu.tsx and never reach here.
	function handleItemAction(kind: ItemActionDialogKind, item: DriveItem): void {
		setActiveDialog({ kind, items: [item] })
	}

	async function handleRenameSubmit(item: DriveItem, value: string): Promise<void> {
		setDialogPending(true)
		const trimmed = value.trim()
		const outcome = await renameItem(item, trimmed)
		setDialogPending(false)

		if (outcome.status === "error") {
			// Dialog stays open on error (e.g. a name clash) so the user can fix the name and retry —
			// mirrors newDirectory.tsx's identical convention.
			toast.error(errorLabel(outcome.dto))
			return
		}

		closeActiveDialog()
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
		setDialogPending(true)
		const outcome = await op(items)
		setDialogPending(false)
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
		setDialogPending(true)
		const outcome = await emptyTrash()
		setDialogPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		closeActiveDialog()
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
			case "copy":
				return activeDialog.items.length > 0 ? (
					<MoveTargetDialog
						items={activeDialog.items}
						mode="copy"
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
			case "versions": {
				const item = activeDialog.items[0]

				if (item?.type !== "file") {
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
						variant={variant}
						remoteInfoEnabled={variant !== "trash"}
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
				// Reached from a per-item menu (items: [item]) or the bulk bar (items: selectedItems) — the
				// picker itself shares each item with every chosen contact.
				return activeDialog.items.length > 0 ? (
					<ContactPickerDialog
						items={activeDialog.items}
						onClose={closeActiveDialog}
					/>
				) : null
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

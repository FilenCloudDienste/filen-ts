import { useEffect, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useDialogHost } from "@/lib/useDialogHost"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { type PreviewSource, previewSourceKey, stepPreviewSourceIndex } from "@/features/preview/lib/previewSource"
import { renameItem, trashItems, restoreItems, deleteItemsPermanently, disableLinks, emptyTrash } from "@/features/drive/lib/actions"
import { unshareItems } from "@/features/drive/lib/share/actions"
import { type BulkOutcome } from "@/features/drive/lib/bulk"
import { toastBulkOutcome } from "@/features/drive/lib/bulkToast"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { type ItemActionDialogKind } from "@/features/drive/components/itemMenu.logic"
import { type BulkDialogActionKind } from "@/features/drive/components/bulkActionBar"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"
import { ContactPickerDialog } from "@/features/drive/components/contactPickerDialog"
import { ColorDialog } from "@/features/drive/components/colorDialog"
import { VersionsDialog } from "@/features/drive/components/versionsDialog"
import { InfoDialog } from "@/features/drive/components/infoDialog"
import { LinkDialog } from "@/features/drive/components/linkDialog"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"
import { reconcilePreviewSources, subscribePreviewReconcile } from "@/features/preview/lib/previewReconcile"
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
	items: DriveItem[]
	// Only meaningful for kind:"preview" — the opened slot's position within `previewSources` (the frozen
	// snapshot taken at open time). Every other kind leaves this unset.
	index?: number
	// Only meaningful for kind:"preview" — the frozen PreviewSource[] snapshot the pager steps through
	// (the shared `items` above stays the DriveItem[] the other dialog kinds use). Every other kind
	// leaves this unset.
	previewSources?: PreviewSource[]
}

export interface DriveDialogHost {
	isDialogOpen: boolean
	handleItemAction: (kind: ItemActionDialogKind, item: DriveItem) => void
	handleBulkDialogAction: (kind: BulkDialogActionKind) => void
	handleEmptyTrash: () => void
	openPreview: (sources: PreviewSource[], index: number) => void
	renderActiveDialog: () => ReactNode
}

interface UseDriveDialogHostParams {
	variant: DriveVariant
	selectedItems: DriveItem[]
}

// One instance of whichever dialog activeDialog.kind names is rendered at a time (renderActiveDialog),
// never more than one. `dialogPending` is shared across the kinds whose async call the HOST itself owns
// (rename/trash/delete/emptyTrash/restoreSelected) — the move/color/versions/info dialogs run their own
// async calls internally and track their own pending state, since each needs more than one shared
// boolean can express (e.g. versions has an independent restore vs. delete-confirm flow).
export function useDriveDialogHost({ variant, selectedItems }: UseDriveDialogHostParams): DriveDialogHost {
	const { t } = useTranslation(["drive", "common"])
	const { activeDialog, setActiveDialog, dialogPending, setDialogPending, isDialogOpen, closeActiveDialog } =
		useDialogHost<ActiveDialog>()

	// Keeps an OPEN preview in sync with realtime drive mutations from ANOTHER device. The pager steps a
	// frozen previewSources snapshot the socket handler's listing-cache patch can't reach, so the drive
	// handler emits a reconcile signal instead: a remote trash/move/delete advances the pager (or closes it
	// once the last slot goes), a version restore reseeds the slot, and a rename re-derives the header
	// title — the remote-event twin of removeCurrentPreviewItem's same-client sync. A no-op while no
	// preview is open (the updater short-circuits on any non-preview dialog). setActiveDialog is a stable
	// setState, so the subscription is set up once.
	useEffect(() => {
		return subscribePreviewReconcile(event => {
			setActiveDialog(prev => {
				if (prev?.kind !== "preview" || prev.index === undefined || prev.previewSources === undefined) {
					return prev
				}

				const next = reconcilePreviewSources({ sources: prev.previewSources, index: prev.index }, event)

				if (next === null) {
					return null
				}

				return { ...prev, previewSources: next.sources, index: next.index }
			})
		})
	}, [setActiveDialog])

	// Steps the open preview by one sibling (no wrap) — the single implementation behind PreviewOverlay's
	// onStep prop, which both the header's prev/next buttons AND its own local in-dialog arrow-key
	// handler call (previewOverlay.tsx — arrow keys can't reach a document-level keymap action while
	// the dialog traps focus, see that handler's own comment). A no-op outside kind:"preview".
	function stepPreview(delta: 1 | -1): void {
		setActiveDialog(prev => {
			if (prev?.kind !== "preview" || prev.index === undefined || prev.previewSources === undefined) {
				return prev
			}

			const current = prev.previewSources[prev.index]

			if (!current) {
				return prev
			}

			return { ...prev, index: stepPreviewSourceIndex(previewSourceKey(current), prev.previewSources, delta) }
		})
	}

	// Opens the preview overlay for a frozen source snapshot at the given position. The shared `items`
	// field stays empty for this kind — the pager reads `previewSources` (see ActiveDialog).
	function openPreview(sources: PreviewSource[], index: number): void {
		setActiveDialog({ kind: "preview", items: [], index, previewSources: sources })
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
			if (prev?.kind !== "preview" || prev.index === undefined || prev.previewSources === undefined) {
				return prev
			}

			const next = reconcilePreviewSources({ sources: prev.previewSources, index: prev.index }, { type: "removed", uuid: frozenUuid })

			if (next === null) {
				return null
			}

			return { ...prev, previewSources: next.sources, index: next.index }
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
		const outcome = await renameItem(item, value.trim())
		setDialogPending(false)

		if (outcome.status === "error") {
			// Dialog stays open on error (e.g. a name clash) so the user can fix the name and retry —
			// mirrors newDirectory.tsx's identical convention.
			toast.error(errorLabel(outcome.dto))
			return
		}

		closeActiveDialog()
	}

	// Shared tail for every HOST-owned bulk-dialog confirm (trash/delete/restoreSelected): runs `op`
	// against `items`, tracks the shared dialogPending flag, closes the dialog, toasts the outcome,
	// and prunes succeeded items from the selection — a no-op for whichever failed (still visible,
	// correctly still selected, so the user can retry without re-selecting).
	async function runBulkDialogAction(items: DriveItem[], op: (items: DriveItem[]) => Promise<BulkOutcome<DriveItem>>): Promise<void> {
		setDialogPending(true)
		const outcome = await op(items)
		setDialogPending(false)
		closeActiveDialog()
		toastBulkOutcome(outcome)
		useDriveStore.getState().removeFromSelection(outcome.succeeded.map(item => item.data.uuid))
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
		await runBulkDialogAction(items, targetItems => unshareItems(targetItems, variant))
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
						destructive
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
			case "import":
				// itemMenu.logic.ts's IMPORT gates sharedIn only, dispatched one item at a time (see
				// handleItemAction below) — reuses the same destination picker as Move, just against
				// importItems (features/drive/lib/import.ts) instead.
				return activeDialog.items.length > 0 ? (
					<MoveTargetDialog
						items={activeDialog.items}
						mode="import"
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
				const previewSources = activeDialog.previewSources

				if (previewIndex === undefined || previewSources === undefined) {
					return null
				}

				return (
					<PreviewOverlay
						variant={variant}
						items={previewSources}
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

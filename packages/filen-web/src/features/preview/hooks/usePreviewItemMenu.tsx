import { useState, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { renameItem, trashItems, deleteItemsPermanently } from "@/features/drive/lib/actions"
import { unshareItems } from "@/features/drive/lib/share/actions"
import { DRIVE_DELETE_PERMANENTLY, DRIVE_TRASH, DRIVE_UNSHARE, driveActivity } from "@/features/drive/lib/activity"
import type { ParentNaming } from "@/features/drive/lib/archiveTargets"
import type { DriveActionDialogKind } from "@/features/drive/lib/selectionActions"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"
import { ItemDialog, RenameItemDialog } from "@/features/drive/components/itemDialogs"
import { undoTrash } from "@/features/drive/lib/undo"
import type { usePreviewRemoteChanges } from "@/features/preview/hooks/usePreviewRemoteChanges"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { runBulkActivity, type BulkActivitySpec } from "@/lib/activity/activity"
import type { ActivityKeys } from "@/lib/activity/activity.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"

// A removal of `uuid` run as the user's own: its echo can beat the response back, and is no change made elsewhere.
// Outside the component: the React Compiler cannot lower a try without a catch, and would skip the whole overlay.
async function asOwnRemoval<T>(
	remote: Pick<ReturnType<typeof usePreviewRemoteChanges>, "expectOwnChange" | "forgetOwnChange">,
	uuid: string,
	run: () => Promise<T>
): Promise<T> {
	remote.expectOwnChange(uuid, "remove")

	try {
		return await run()
	} finally {
		remote.forgetOwnChange(uuid)
	}
}

interface UsePreviewItemMenuParams {
	variant: DriveVariant
	driveItem: DriveItem | undefined
	rawDriveItem: DriveItem | undefined
	saving: boolean
	remote: ReturnType<typeof usePreviewRemoteChanges>
	mountedRef: RefObject<boolean>
	commitSaved: (frozenUuid: string, item: DriveItem) => void
	onItemRemoved: (frozenUuid: string) => void
	onClose: () => void
	onFavoriteToggled: ((item: DriveItem) => void) | undefined
	onSourcesDisposing: ((uuids: string[]) => void) | undefined
	compressParentNaming: ParentNaming | undefined
}

// The preview header's item menu (PreviewOverlay): its dropdown, the secondary dialog an entry opened, and the
// actions those run on the slot on screen.
export function usePreviewItemMenu({
	variant,
	driveItem,
	rawDriveItem,
	saving,
	remote,
	mountedRef,
	commitSaved,
	onItemRemoved,
	onClose,
	onFavoriteToggled,
	onSourcesDisposing,
	compressParentNaming
}: UsePreviewItemMenuParams) {
	const { t } = useTranslation(["preview", "common", "drive"])
	// Which secondary dialog the header's item menu currently has open, if any — a single slot
	// since only ever one item (the currently-viewed one) is ever being acted on from in here, unlike
	// useDriveDialogHost's own activeDialog which also has to carry a whole bulk-selection items[].
	// "color" and "openAsText" are part of the shared DriveActionDialogKind union but unreachable here —
	// driveSelectionActions only ever offers Color for a directory, which never opens this overlay, and Open
	// as text only to a surface that opens items (this header menu has its item open already).
	const [menuDialogKind, setMenuDialogKind] = useState<DriveActionDialogKind | null>(null)
	// Where its destination picker (move, copy, extract to) opens: the tree menu level whose More… opened it.
	const [menuStartPath, setMenuStartPath] = useState<readonly string[] | undefined>(undefined)
	const [menuPending, setMenuPending] = useState(false)
	// The header item menu's dropdown. A save closes it and holds it shut (its trigger disabled, as its keys are):
	// the save writes by the item it read, so a rename, move or trash meanwhile would see the upload re-create the file.
	const [menuOpen, setMenuOpen] = useState(false)

	if (saving && menuOpen) {
		setMenuOpen(false)
	}
	// Header item-menu action handlers — every one below only ever runs against `driveItem`/`rawDriveItem`
	// at the CURRENT slot (the menu is only ever mounted for it, see the header JSX). Rename/favorite
	// write into the same per-slot `saved` override map performSave already uses, so the header title and
	// a reopened menu's own "Unfavorite"/"Favorite" label both reflect the change immediately, with no
	// dependency on the listing query refetching. Trash/delete/restore instead hand off to onItemRemoved
	// (the host's frozen-pager-list housekeeping) — see PreviewOverlayProps' own doc comment for why that
	// one lives on the host, not here.
	async function handleMenuRename(value: string): Promise<void> {
		if (driveItem === undefined || rawDriveItem === undefined) {
			return
		}

		setMenuPending(true)
		const outcome = await renameItem(driveItem, value.trim())
		setMenuPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		commitSaved(rawDriveItem.data.uuid, outcome.item)
		setMenuDialogKind(null)
	}

	// The menu's confirm dialog shows the run, so only its result toasts; with no dialog (a trash) the toast shows it.
	async function runMenuActivity(spec: BulkActivitySpec<DriveItem>, confirmed = true): Promise<void> {
		setMenuPending(true)
		await runBulkActivity(confirmed ? { ...spec, showRunning: false } : spec)
		setMenuPending(false)
		setMenuDialogKind(null)
	}

	// A trash runs at once, reversible from its toast's Undo; a permanent delete has confirmed first.
	async function removeCurrentItem(remove: BulkActivitySpec<DriveItem>["run"], keys: ActivityKeys, trash = false): Promise<void> {
		if (driveItem === undefined || rawDriveItem === undefined) {
			return
		}

		const frozenUuid = rawDriveItem.data.uuid

		await runMenuActivity(
			driveActivity(
				[driveItem],
				keys,
				(targets, onSettled, report) => asOwnRemoval(remote, driveItem.data.uuid, () => remove(targets, onSettled, report)),
				{
					onDone: outcome => {
						if (outcome.succeeded.length > 0) {
							onItemRemoved(frozenUuid)
						}
					},
					...(trash ? { undo: undoTrash } : {})
				}
			),
			!trash
		)
	}

	// Mirrors new mobile's removeShare/stopSharing dismissOnSuccess: isPreview === true — closes the
	// WHOLE preview immediately on success rather than stepping to a neighbour (unlike trash/delete
	// above), since new mobile's own gallery has no driveItemRemoved-driven "step past it" behavior for
	// this one.
	async function handleMenuUnshare(): Promise<void> {
		if (driveItem === undefined) {
			return
		}

		// Only this receiver's row leaves the listing, and no echo prunes a selected row the way trash and
		// delete echoes do.
		await runMenuActivity(
			driveActivity([driveItem], DRIVE_UNSHARE, (targets, onSettled) => unshareItems(targets, variant, onSettled), {
				prune: "row",
				onDone: outcome => {
					if (outcome.succeeded.length > 0 && mountedRef.current) {
						onClose()
					}
				}
			})
		)
	}

	// "favorite" descriptor's onFavoriteToggled — see itemMenu.tsx's own doc comment on why this extension
	// point exists only for the preview. Fans out to the optional host-level callback too — see
	// PreviewOverlayProps' own doc comment on onFavoriteToggled for why a photos-opened overlay needs it
	// and a drive-opened one doesn't.
	function handleMenuFavoriteToggled(item: DriveItem): void {
		if (rawDriveItem === undefined) {
			return
		}

		commitSaved(rawDriveItem.data.uuid, item)
		onFavoriteToggled?.(item)
	}

	// "restore" descriptor's onRestored (trash variant only) — a restored item leaves the trash listing
	// entirely, the same "gap in the pager" shape as trash/delete above.
	function handleMenuRestored(): void {
		if (rawDriveItem === undefined) {
			return
		}

		onItemRemoved(rawDriveItem.data.uuid)
	}

	function closeMenuDialog(): void {
		setMenuDialogKind(null)
	}

	// The header item-menu's secondary dialog, if any — nested inside the outer DialogPrimitive.Root
	// exactly like the overlay's unsaved-changes ConfirmDialog (Base UI supports nesting a dialog inside
	// another normally, see that one's own doc comment). Move/versions/info/link/share are entirely
	// self-contained dialog components (own state, own action calls) — reused completely unmodified,
	// mirroring useDriveDialogHost's identical per-kind dispatch for the row-level menu.
	function renderMenuDialog(): ReactNode {
		if (menuDialogKind === null || driveItem === undefined) {
			return null
		}

		switch (menuDialogKind) {
			case "rename":
				return (
					<RenameItemDialog
						item={driveItem}
						pending={menuPending}
						onClose={closeMenuDialog}
						onSubmit={value => {
							void handleMenuRename(value)
						}}
					/>
				)
			case "move":
				return (
					<MoveTargetDialog
						items={[driveItem]}
						initialPath={menuStartPath}
						onClose={closeMenuDialog}
					/>
				)
			case "copy":
			case "versions":
			case "info":
			case "link":
			case "share":
			case "compress":
			case "extract":
			case "extractTo":
			case "addToNewPlaylist":
				return (
					<ItemDialog
						kind={menuDialogKind}
						items={[driveItem]}
						startPath={menuStartPath}
						variant={variant}
						onClose={closeMenuDialog}
						onSourcesDisposing={onSourcesDisposing}
						compressParentNaming={compressParentNaming}
					/>
				)
			case "unshare":
				return (
					<ConfirmDialog
						open
						pending={menuPending}
						title={t("drive:driveUnshareConfirmTitle")}
						body={t("drive:driveUnshareConfirmBodySingle")}
						confirmLabel={t("drive:driveActionUnshare")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeMenuDialog()
							}
						}}
						onConfirm={() => {
							void handleMenuUnshare()
						}}
					/>
				)
			case "delete":
				return (
					<ConfirmDialog
						open
						pending={menuPending}
						title={t("drive:driveDeletePermanentlyConfirmTitle")}
						body={t("drive:driveDeletePermanentlyConfirmBodySingle")}
						confirmLabel={t("drive:driveActionDeletePermanently")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeMenuDialog()
							}
						}}
						onConfirm={() => {
							void removeCurrentItem(deleteItemsPermanently, DRIVE_DELETE_PERMANENTLY)
						}}
					/>
				)
			// Runs without a dialog (openMenuDialog).
			case "trash":
				return null
			case "color":
			case "openAsText":
				// Unreachable — see menuDialogKind's own doc comment.
				return null
		}
	}

	function openMenuDialog(kind: DriveActionDialogKind, startPath?: readonly string[]): void {
		if (kind === "trash") {
			void removeCurrentItem(trashItems, DRIVE_TRASH, true)

			return
		}

		setMenuStartPath(startPath)
		setMenuDialogKind(kind)
	}

	return {
		menuDialogKind,
		openMenuDialog,
		menuOpen,
		setMenuOpen,
		handleMenuFavoriteToggled,
		handleMenuRestored,
		renderMenuDialog
	}
}

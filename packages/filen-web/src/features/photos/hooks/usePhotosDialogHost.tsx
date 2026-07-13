import { useEffect, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useDialogHost } from "@/lib/useDialogHost"
import { type ItemActionDialogKind } from "@/features/drive/components/itemMenu.logic"
import { type BulkDialogActionKind } from "@/features/drive/components/bulkActionBar.logic"
import { renamePhotoItem, trashPhotos, patchPhotoFavoriteFromPreview } from "@/features/photos/lib/actions"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { toastBulkOutcome } from "@/features/drive/lib/bulkToast"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"
import { type PreviewSource, previewSourceKey, stepPreviewSourceIndex } from "@/features/preview/lib/previewSource"
import { reconcilePreviewSources, subscribePreviewReconcile } from "@/features/preview/lib/previewReconcile"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"
import { VersionsDialog } from "@/features/drive/components/versionsDialog"
import { InfoDialog } from "@/features/drive/components/infoDialog"
import { LinkDialog } from "@/features/drive/components/linkDialog"
import { ContactPickerDialog } from "@/features/drive/components/contactPickerDialog"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { InputDialog } from "@/components/dialogs/inputDialog"

// The photos surface's own dialog kind — narrower than drive's ActiveDialogKind (no move/color/
// unshare/delete/import/emptyTrash/restoreSelected/disableLink: none of those ever reach a photos item
// — see itemActions.ts/bulkActions.ts's own doc comments on what's dropped and why). "preview" is the
// one addition beyond the per-item menu's own six kinds — opened directly by a tile click, never via
// handleItemAction, mirroring useDriveDialogHost's identical split between menu-dispatched kinds and
// its own dedicated openPreview entry point.
type PhotosDialogKind = "rename" | "trash" | "versions" | "info" | "link" | "share" | "preview"

interface ActivePhotosDialog {
	kind: PhotosDialogKind
	items: PhotoItem[]
	// Only meaningful for kind:"preview" — mirrors useDriveDialogHost's identical ActiveDialog fields
	// (the frozen pager position + snapshot the reconcile subscription below folds events into).
	index?: number
	previewSources?: PreviewSource[]
}

export interface PhotosDialogHost {
	isDialogOpen: boolean
	handleItemAction: (kind: ItemActionDialogKind, item: PhotoItem) => void
	handleBulkDialogAction: (kind: BulkDialogActionKind) => void
	openPreview: (sources: PreviewSource[], index: number) => void
	renderActiveDialog: () => ReactNode
}

interface UsePhotosDialogHostParams {
	rootUuid: string
	selectedItems: PhotoItem[]
}

// The photos-scoped counterpart of drive's useDriveDialogHost, trimmed to the seven dialog kinds the
// photos menu/bar/grid ever dispatch. rename/trash route through this file's own PhotoItem-cache-
// patching wrappers (features/photos/lib/actions.ts); versions/info/link/share/preview reuse the EXACT
// same generic dialog components drive uses unchanged (none of them take a `variant` the preview
// overlay does, but it defaults photos to "drive" — see openPreview's own render-site comment), so
// there is no photos-specific fork of any of them beyond the preview's one extra favorite-patch prop.
export function usePhotosDialogHost({ rootUuid, selectedItems }: UsePhotosDialogHostParams): PhotosDialogHost {
	const { t } = useTranslation(["drive", "photos", "common"])
	const { activeDialog, setActiveDialog, dialogPending, setDialogPending, isDialogOpen, closeActiveDialog } =
		useDialogHost<ActivePhotosDialog>()

	// Keeps an OPEN photos preview in sync with realtime drive mutations — the same previewReconcile bus
	// useDriveDialogHost subscribes to, safe to share: at most one of the two hosts is ever mounted at a
	// time (drive's directory listing and the photos grid are different routes), and the bus tolerates
	// multiple subscribers by design (previewReconcile.ts's own Set). A no-op while no photos preview is
	// open (the updater short-circuits on any non-preview dialog).
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

	// Steps the open preview by one sibling (no wrap) — mirrors useDriveDialogHost's identical stepPreview,
	// the single implementation behind PreviewOverlay's onStep prop.
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

	// Opens the preview overlay for a frozen source snapshot at the given position — called from the
	// grid's own tile click handler with drivePreviewSources(items) (the whole sorted media set), never
	// scoped to a smaller sibling list the way drive's audio-exclusion dance needs (a photos listing is
	// already image/video-only by construction).
	function openPreview(sources: PreviewSource[], index: number): void {
		setActiveDialog({ kind: "preview", items: [], index, previewSources: sources })
	}

	// Drops the acted-on slot out of the frozen pager snapshot — mirrors useDriveDialogHost's identical
	// removeCurrentPreviewItem. No extra photos-listing patch here: fileTrash/folderTrash are BOTH in
	// socketHandlers.ts's PHOTOS_INVALIDATING_EVENT_TYPES set, so the server's echo of this same local
	// mutation already invalidates (and refetches) the photos listing on its own — this function only
	// ever needs to keep the OPEN pager itself converging, the same uuid-keyed race-proofing the drive
	// host's own doc comment explains.
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
			case "preview": {
				const previewIndex = activeDialog.index
				const previewSources = activeDialog.previewSources

				if (previewIndex === undefined || previewSources === undefined) {
					return null
				}

				return (
					<PreviewOverlay
						// A photos item is always an owned, non-trashed file under the user's own drive — the
						// same descriptor set + editable/download gating "drive" resolves for a normal listing
						// is exactly right here too (see PreviewOverlayProps' own doc comment: the overlay is
						// reused entirely as shipped, no photos-specific variant).
						variant="drive"
						items={previewSources}
						index={previewIndex}
						onStep={stepPreview}
						onClose={closeActiveDialog}
						onItemRemoved={removeCurrentPreviewItem}
						onFavoriteToggled={item => {
							patchPhotoFavoriteFromPreview(rootUuid, item)
						}}
					/>
				)
			}
		}
	}

	return { isDialogOpen, handleItemAction, handleBulkDialogAction, openPreview, renderActiveDialog }
}

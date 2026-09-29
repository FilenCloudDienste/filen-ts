import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { FolderPlusIcon } from "lucide-react"
import type { DriveItem } from "@/features/drive/lib/item"
import { moveItems } from "@/features/drive/lib/actions"
import { startCopyWithCard } from "@/features/transfers/lib/copyToast"
import { type CopyDestination } from "@/features/drive/lib/copy.logic"
import { toastBulkOutcome } from "@/features/drive/lib/bulkToast"
import { runCreateDirectory } from "@/features/drive/lib/createDirectory"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { driveListingQueryUpdate } from "@/features/drive/queries/drive"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { isCopyConfirmDisabled, isMoveConfirmDisabled, isMoveRowDisabled } from "@/features/drive/components/moveTargetDialog.logic"
import { filterDriveItemsByLocalSearch } from "@/features/drive/components/directoryListing.logic"
import { PickerBreadcrumb, PickerDirectoryRow, PickerListShell } from "@/features/drive/components/directoryPicker"
import { useDirectoryPicker, useDirectoryPickerFilter } from "@/features/drive/hooks/useDirectoryPicker"
import { ListFilterInput } from "@/components/listFilterInput"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { InputDialog } from "@/components/dialogs/inputDialog"

export interface MoveTargetDialogProps {
	items: DriveItem[]
	onClose: () => void
	// "move" (default) relocates the selection and, on success, clears it from the source listing's
	// selection (mirrors every other destructive-to-the-source bulk action's own cleanup). "copy" starts
	// a copy job into the chosen destination and closes at once — the job runs on with its own progress
	// card — leaving the source and the selection as they were.
	mode?: "move" | "copy"
	// Copy mode only: runs the copy instead of starting one over `items` (a public link's own source has
	// no DriveItem; `items` is then empty and gates nothing).
	onCopy?: (destination: CopyDestination) => void
}

// Destination-directory picker — mounted-when-active by the listing's dialog host. Navigation is LOCAL
// to this dialog (a uuid stack from root, not the "/drive/$" route) so browsing here never disturbs
// the app's own navigation history; it always browses the "drive" variant regardless of where the
// move/copy was dispatched from — recents/favorites/trash/sharedIn have no navigable tree of their
// own to land into (mirrors newDirectory.tsx's identical rule for creating a directory). `mode` is only
// ever compared against "copy" rather than given a destructuring default, which the React Compiler
// cannot lower.
export function MoveTargetDialog({ items, onClose, mode, onCopy }: MoveTargetDialogProps) {
	const { t } = useTranslation(["drive", "common"])
	const isOnline = useIsOnline()
	// Both writes in this dialog (the confirm and the in-place create) re-check connectivity here: the
	// entry point was gated when it was clicked, but the connection can drop while the picker is open.
	const offlineTitle = !isOnline ? t("common:offlineActionDisabled") : undefined
	const { pathStack, targetUuid, listingQuery, namesQuery, descend, goRoot, goTo } = useDirectoryPicker()
	const [filter, setFilter] = useDirectoryPickerFilter(pathStack)
	const [pending, setPending] = useState(false)
	const [newFolderOpen, setNewFolderOpen] = useState(false)
	const [newFolderPending, setNewFolderPending] = useState(false)
	const directories = (listingQuery.data ?? []).filter(item => item.type === "directory")
	// Same instant local name filter the non-"drive" listing variants use — this picker is a pure
	// breadcrumb browser (never wired to the cache-backed engine), so a filtered folder tree is the only
	// way to search it.
	const filteredDirectories = filterDriveItemsByLocalSearch(directories, filter)

	// Creates a destination directory in place, right inside whichever directory the picker is
	// currently browsing (targetUuid) — the same helper newDirectory.tsx's own toolbar trigger uses,
	// patching this picker's own listing query (variant "drive", the only variant this picker ever
	// browses) so the new row appears with no refetch and can be descended into or picked immediately.
	async function handleCreateFolder(name: string): Promise<void> {
		setNewFolderPending(true)
		const outcome = await runCreateDirectory(
			{ createDirectory: (parent, next) => sdkApi.createDirectory(parent, next), patchListing: driveListingQueryUpdate },
			targetUuid,
			name.trim()
		)
		setNewFolderPending(false)

		if (outcome.status === "error") {
			// Dialog stays open on error (e.g. a name clash) so the user can fix the name and retry —
			// mirrors newDirectory.tsx's identical convention.
			toast.error(errorLabel(outcome.dto))
			return
		}

		setNewFolderOpen(false)
	}

	const handleOpenChange = pendingGuardedOpenChange(pending, next => {
		if (!next) {
			onClose()
		}
	})

	async function handleConfirm(): Promise<void> {
		if (mode === "copy") {
			// Never awaited: a copy is a transfer, and transfers never sit behind a pending dialog.
			const destination = { uuid: targetUuid, name: targetUuid === null ? t("driveMyDrive") : (namesQuery.data?.[targetUuid] ?? "") }

			if (onCopy === undefined) {
				startCopyWithCard(items, destination)
			} else {
				onCopy(destination)
			}

			onClose()

			return
		}

		setPending(true)
		const outcome = await moveItems(items, targetUuid)
		setPending(false)
		onClose()
		toastBulkOutcome(outcome)

		// A moved item vanishes from whichever listing it was selected in (see actions.ts) — leaving it
		// selected would strand a phantom entry in the "N selected" count, same cleanup
		// directoryListing.tsx's own trash/delete confirms already do.
		useDriveStore.getState().removeFromSelection(outcome.succeeded.map(item => item.data.uuid))
	}

	return (
		<Dialog
			open
			onOpenChange={handleOpenChange}
		>
			<DialogContent
				closeButtonDisabled={pending}
				className="sm:max-w-lg"
			>
				<DialogHeader>
					<DialogTitle>{t(mode === "copy" ? "driveCopyDialogTitle" : "driveMoveDialogTitle")}</DialogTitle>
				</DialogHeader>
				<PickerBreadcrumb
					pathStack={pathStack}
					names={namesQuery.data}
					onRoot={goRoot}
					onJump={goTo}
				/>
				<div className="flex items-center gap-2">
					<div className="min-w-0 flex-1">
						{directories.length > 0 ? (
							<ListFilterInput
								value={filter}
								onChange={setFilter}
								placeholder={t("driveMoveDialogFilterPlaceholder")}
								ariaLabel={t("driveMoveDialogFilterPlaceholder")}
							/>
						) : null}
					</div>
					{/* Create-directory-in-place — lands inside whichever directory is currently open (targetUuid),
					so the new destination is immediately browsable/pickable without leaving the picker (mobile
					parity: driveSelectToolbar.tsx's own in-picker create). */}
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={pending || !isOnline}
						title={offlineTitle}
						onClick={() => {
							setNewFolderOpen(true)
						}}
					>
						<FolderPlusIcon />
						{t("driveMoveDialogNewDirectory")}
					</Button>
				</div>
				<PickerListShell
					listingQuery={listingQuery}
					isEmpty={filteredDirectories.length === 0}
					noResults={filter.trim().length > 0}
				>
					{filteredDirectories.map(directory => (
						<PickerDirectoryRow
							key={directory.data.uuid}
							directory={directory}
							disabled={isMoveRowDisabled(directory, pathStack, items)}
							onDescend={descend}
						/>
					))}
				</PickerListShell>
				<DialogFooter>
					<Button
						disabled={
							pending ||
							!isOnline ||
							listingQuery.status !== "success" ||
							(mode === "copy"
								? isCopyConfirmDisabled(pathStack, items)
								: isMoveConfirmDisabled(pathStack, items, listingQuery.data))
						}
						title={offlineTitle}
						onClick={() => {
							void handleConfirm()
						}}
					>
						{pending && <Spinner data-icon="inline-start" />}
						{t(mode === "copy" ? "driveCopyHereAction" : "driveMoveHereAction")}
					</Button>
				</DialogFooter>
			</DialogContent>
			{/* Nested inside the outer Dialog (Base UI's own "Nested dialogs" support — same pattern as
			versionsDialog.tsx's nested ConfirmDialog) rather than a sibling, for the stacked focus-trap/
			backdrop behavior. */}
			<InputDialog
				open={newFolderOpen}
				pending={newFolderPending}
				title={t("driveNewDirectoryTitle")}
				body={t("driveNewDirectoryBody")}
				label={t("driveNewDirectoryLabel")}
				placeholder={t("driveNewDirectoryPlaceholder")}
				submitLabel={t("driveNewDirectorySubmit")}
				validate={name => name.trim().length > 0}
				onOpenChange={setNewFolderOpen}
				onSubmit={value => {
					void handleCreateFolder(value)
				}}
			/>
		</Dialog>
	)
}

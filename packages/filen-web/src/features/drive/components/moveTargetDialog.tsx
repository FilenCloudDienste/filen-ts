import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { DriveItem } from "@/features/drive/lib/item"
import { moveActivity, performMove } from "@/features/drive/lib/dnd"
import { resolveMoveConflicts } from "@/features/drive/lib/moveConflicts"
import { confirmDotFilenOperation, includesRootDotFilen } from "@/features/drive/lib/dotFilenGuard"
import { runBulkActivity } from "@/lib/activity/activity"
import { startCopyWithCard } from "@/features/transfers/lib/copyToast"
import { type CopyDestination } from "@/features/drive/lib/copy.logic"
import type { JobDestination } from "@filen/shared"
import { useIsOnline } from "@/lib/useIsOnline"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { isCopyConfirmDisabled, isMoveConfirmDisabled, isMoveRowDisabled } from "@/features/drive/components/moveTargetDialog.logic"
import { filterDriveItemsByLocalSearch } from "@/features/drive/components/directoryListing.logic"
import { PickerBreadcrumb, PickerDirectoryRow, PickerListShell } from "@/features/drive/components/directoryPicker"
import { useDirectoryPicker, useDirectoryPickerFilter } from "@/features/drive/hooks/useDirectoryPicker"
import { usePickerNewDirectory } from "@/features/drive/hooks/usePickerNewDirectory"
import { ListFilterInput } from "@/components/listFilterInput"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { LIST_DIALOG_CLASS } from "@/components/dialogs/listDialog"

interface MoveTargetDialogBaseProps {
	items: DriveItem[]
	onClose: () => void
	// Root first, the directory to open last; the root when absent.
	initialPath?: readonly string[] | undefined
}

// "move" (default) relocates the selection and, on success, clears it from the source listing's
// selection (mirrors every other destructive-to-the-source bulk action's own cleanup). "copy" starts a
// copy job into the chosen destination and closes at once — the job runs on with its own progress card —
// leaving the source and the selection as they were. "pick" reports the chosen directory to its caller;
// `items` are the sources it must not land inside. A form that runs its job later (compress, extract)
// gates its own submit, so its pick works offline; a caller whose pick starts the job (`startsWork`)
// gets the confirm gated like a copy's.
export type MoveTargetDialogProps = MoveTargetDialogBaseProps &
	(
		| { mode?: "move" | undefined }
		| {
				mode: "copy"
				// Runs the copy instead of starting one over `items` (a public link's own source has no
				// DriveItem; `items` is then empty and gates nothing).
				onCopy?: ((destination: CopyDestination) => void) | undefined
		  }
		| {
				mode: "pick"
				pickLabels: { title: string; confirm: string }
				onPick: (destination: JobDestination) => void
				startsWork?: boolean | undefined
		  }
	)

// Destination-directory picker — mounted-when-active by the listing's dialog host. Navigation is LOCAL
// to this dialog (a uuid stack from root, not the "/drive/$" route) so browsing here never disturbs
// the app's own navigation history; it always browses the "drive" variant regardless of where the
// move/copy was dispatched from — recents/favorites/trash/sharedIn have no navigable tree of their
// own to land into (mirrors newDirectory.tsx's identical rule for creating a directory). `mode` is only
// ever compared rather than given a destructuring default, which the React Compiler cannot lower.
export function MoveTargetDialog(props: MoveTargetDialogProps) {
	const { items, onClose, mode, initialPath } = props
	const { t } = useTranslation(["drive", "common"])
	const isOnline = useIsOnline()
	// The confirm re-checks connectivity here (the in-place create hides itself offline): the entry point was
	// gated when it was clicked, but the connection can drop while the picker is open. A form's pick writes
	// nothing; the form gates its own submit.
	const offlineTitle = !isOnline ? t("common:offlineActionDisabled") : undefined
	const confirmOfflineGated = !isOnline && (props.mode !== "pick" || props.startsWork === true)
	const picker = useDirectoryPicker(initialPath)
	const { pathStack, targetUuid, listingQuery, items: rows, namesQuery, descend, goRoot, goTo } = picker
	const [filter, setFilter] = useDirectoryPickerFilter(pathStack)
	const [pending, setPending] = useState(false)
	// Lands inside whichever directory is open and opens it, so the new destination is the pick at once.
	const newDirectory = usePickerNewDirectory({ picker, available: true, disabled: pending })
	const directories = rows.filter(item => item.type === "directory")
	// Same instant local name filter the non-"drive" listing variants use — this picker is a pure
	// breadcrumb browser (never wired to the cache-backed engine), so a filtered folder tree is the only
	// way to search it.
	const filteredDirectories = filterDriveItemsByLocalSearch(directories, filter)

	const handleOpenChange = pendingGuardedOpenChange(pending, next => {
		if (!next) {
			onClose()
		}
	})

	async function handleConfirm(): Promise<void> {
		const destination = { uuid: targetUuid, name: targetUuid === null ? t("driveMyDrive") : (namesQuery.data?.[targetUuid] ?? "") }

		if (props.mode === "pick") {
			props.onPick(destination)
			onClose()

			return
		}

		if (props.mode === "copy") {
			// Never awaited: a copy is a transfer, and transfers never sit behind a pending dialog.
			if (props.onCopy === undefined) {
				startCopyWithCard(items, destination)
			} else {
				props.onCopy(destination)
			}

			onClose()

			return
		}

		// Moving the root `.filen` asks for its name first (lib/dotFilenGuard.ts); a cancel keeps the picker open.
		if (includesRootDotFilen(items) && !(await confirmDotFilenOperation("move", items))) {
			return
		}

		// The same hand-off as a bulk confirm (useDialogHost's runBulkDialogActivity): several items close
		// the picker and run as an activity toast, one keeps its spinner and toasts only its result.
		if (items.length > 1) {
			onClose()
			void performMove(items, destination, true)

			return
		}

		setPending(true)

		// Names the destination already holds are asked about first (the prompt opens over the picker); a skip closes it.
		const resolved = await resolveMoveConflicts(items, destination.uuid)

		if (resolved.items.length === 0) {
			setPending(false)
			onClose()

			return
		}

		const outcome = await runBulkActivity({ ...moveActivity(resolved.items, destination, resolved.renames), showRunning: false })

		setPending(false)

		// A failure keeps the picker open on the chosen target, to try again or pick another.
		if (outcome.failed.length === 0) {
			onClose()
		}
	}

	return (
		<Dialog
			open
			onOpenChange={handleOpenChange}
		>
			<DialogContent
				closeButtonDisabled={pending}
				className={LIST_DIALOG_CLASS}
			>
				<DialogHeader>
					<DialogTitle>
						{props.mode === "pick"
							? props.pickLabels.title
							: t(mode === "copy" ? "driveCopyDialogTitle" : "driveMoveDialogTitle")}
					</DialogTitle>
				</DialogHeader>
				<PickerBreadcrumb
					pathStack={pathStack}
					names={namesQuery.data}
					onRoot={goRoot}
					onJump={goTo}
				/>
				{directories.length > 0 ? (
					<ListFilterInput
						value={filter}
						onChange={setFilter}
						placeholder={t("driveMoveDialogFilterPlaceholder")}
						ariaLabel={t("driveMoveDialogFilterPlaceholder")}
					/>
				) : null}
				<PickerListShell
					listingQuery={listingQuery}
					noResults={filter.trim().length > 0}
					filteredOutMessage={rows.length > 0 ? t("driveTreeMenuNoDirectories") : undefined}
					count={filteredDirectories.length}
					leading={newDirectory.leading}
					rowKey={index => filteredDirectories[index]?.data.uuid ?? String(index)}
					renderRow={index => {
						const directory = filteredDirectories[index]

						return directory === undefined ? null : (
							<PickerDirectoryRow
								directory={directory}
								disabled={isMoveRowDisabled(directory, pathStack, items)}
								onDescend={descend}
							/>
						)
					}}
				/>
				<DialogFooter>
					{newDirectory.button}
					<Button
						disabled={
							pending ||
							newDirectory.pending ||
							confirmOfflineGated ||
							listingQuery.status !== "success" ||
							(mode === "copy" || mode === "pick"
								? isCopyConfirmDisabled(pathStack, items)
								: isMoveConfirmDisabled(pathStack, items, listingQuery.data))
						}
						title={confirmOfflineGated ? offlineTitle : undefined}
						onClick={() => {
							void handleConfirm()
						}}
					>
						{pending && <Spinner data-icon="inline-start" />}
						{props.mode === "pick"
							? props.pickLabels.confirm
							: t(mode === "copy" ? "driveCopyHereAction" : "driveMoveHereAction")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

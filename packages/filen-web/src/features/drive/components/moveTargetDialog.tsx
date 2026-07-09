import { Fragment, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronRightIcon, FolderIcon } from "lucide-react"
import type { DialogRoot } from "@base-ui/react/dialog"
import type { DriveItem } from "@/features/drive/lib/item"
import { moveItems } from "@/features/drive/lib/actions"
import { toastBulkOutcome } from "@/features/drive/lib/bulkToast"
import { useDriveStore } from "@/stores/drive"
import { useDirectoryListingQuery, useDirectoryNamesQuery } from "@/queries/drive"
import { asErrorDTO } from "@/lib/sdk/errors"
import { cn } from "@/lib/utils"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"
import { isMoveConfirmDisabled, isMoveRowDisabled } from "@/features/drive/components/moveTargetDialog.logic"
import { EmptyState } from "@/features/drive/components/emptyState"
import { ListingSkeleton } from "@/features/drive/components/listingSkeleton"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export interface MoveTargetDialogProps {
	items: DriveItem[]
	onClose: () => void
}

// Destination-directory picker — mounted-when-active by the listing's dialog host. Navigation is LOCAL
// to this dialog (a uuid stack from root, not the "/drive/$" route) so browsing here never disturbs
// the app's own navigation history; it always browses the "drive" variant regardless of where the
// move was dispatched from — recents/favorites/trash have no navigable tree of their own to move into
// (mirrors new-directory.tsx's identical rule for creating a directory).
export function MoveTargetDialog({ items, onClose }: MoveTargetDialogProps) {
	const { t } = useTranslation("drive")
	const [pathStack, setPathStack] = useState<string[]>([])
	const [pending, setPending] = useState(false)
	const targetUuid = pathStack.at(-1) ?? null

	const listingQuery = useDirectoryListingQuery("drive", targetUuid)
	const namesQuery = useDirectoryNamesQuery(pathStack)
	const directories = (listingQuery.data ?? []).filter(item => item.type === "directory")

	function descend(uuid: string): void {
		setPathStack(prev => [...prev, uuid])
	}

	function handleOpenChange(next: boolean, details: DialogRoot.ChangeEventDetails): void {
		if (!shouldForwardOpenChange(next, pending)) {
			// Also stops Base UI's own store from flipping (it closes itself after this callback
			// unless the event is canceled) — see dismissal.logic.ts.
			details.cancel()
			return
		}

		if (!next) {
			onClose()
		}
	}

	async function handleMoveHere(): Promise<void> {
		setPending(true)
		const outcome = await moveItems(items, targetUuid)
		setPending(false)
		onClose()
		toastBulkOutcome(outcome)
		// A moved item vanishes from whichever listing it was selected in (see actions.ts) — leaving it
		// selected would strand a phantom entry in the "N selected" count, same cleanup
		// directory-listing.tsx's own trash/delete confirms already do.
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
					<DialogTitle>{t("driveMoveDialogTitle")}</DialogTitle>
				</DialogHeader>
				<nav
					aria-label={t("driveBreadcrumbLabel")}
					className="flex items-center gap-1.5 overflow-x-auto text-sm"
				>
					<button
						type="button"
						disabled={pathStack.length === 0}
						onClick={() => {
							setPathStack([])
						}}
						className={cn(
							"shrink-0 disabled:cursor-default",
							pathStack.length === 0
								? "font-medium text-foreground"
								: "text-muted-foreground hover:text-foreground hover:underline"
						)}
					>
						{t("driveMyDrive")}
					</button>
					{pathStack.map((uuid, index) => {
						const isLast = index === pathStack.length - 1

						return (
							<Fragment key={uuid}>
								<ChevronRightIcon
									aria-hidden="true"
									className="size-3.5 shrink-0 text-muted-foreground"
								/>
								<button
									type="button"
									disabled={isLast}
									onClick={() => {
										setPathStack(prev => prev.slice(0, index + 1))
									}}
									className={cn(
										"min-w-0 shrink-0 truncate disabled:cursor-default",
										isLast
											? "font-medium text-foreground"
											: "text-muted-foreground hover:text-foreground hover:underline"
									)}
								>
									{namesQuery.data?.[uuid] ?? uuid}
								</button>
							</Fragment>
						)
					})}
				</nav>
				<div className="h-72 overflow-y-auto rounded-xl border border-border">
					{listingQuery.status === "pending" ? (
						<ListingSkeleton viewMode="list" />
					) : listingQuery.status === "error" ? (
						<EmptyState
							variant="error"
							error={asErrorDTO(listingQuery.error)}
							onRetry={() => {
								void listingQuery.refetch()
							}}
						/>
					) : directories.length === 0 ? (
						<EmptyState variant="empty" />
					) : (
						<ul className="flex flex-col gap-0.5 p-2">
							{directories.map(directory => {
								const disabled = isMoveRowDisabled(directory, pathStack, items)

								return (
									<li key={directory.data.uuid}>
										<button
											type="button"
											disabled={disabled}
											onDoubleClick={() => {
												if (!disabled) {
													descend(directory.data.uuid)
												}
											}}
											onKeyDown={event => {
												if (event.key === "Enter" && !disabled) {
													event.preventDefault()
													descend(directory.data.uuid)
												}
											}}
											className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
										>
											<FolderIcon
												aria-hidden="true"
												className="size-4 shrink-0 text-muted-foreground"
											/>
											<span className="min-w-0 flex-1 truncate">
												{directory.data.decryptedMeta?.name ?? directory.data.uuid}
											</span>
										</button>
									</li>
								)
							})}
						</ul>
					)}
				</div>
				<DialogFooter>
					<Button
						disabled={
							pending || listingQuery.status !== "success" || isMoveConfirmDisabled(pathStack, items, listingQuery.data)
						}
						onClick={() => {
							void handleMoveHere()
						}}
					>
						{pending && <Spinner data-icon="inline-start" />}
						{t("driveMoveHereAction")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

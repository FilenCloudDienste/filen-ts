import { Fragment, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ChevronRightIcon } from "lucide-react"
import type { DialogRoot } from "@base-ui/react/dialog"
import { attachExistingDriveItem } from "@/features/chats/lib/attachments"
import { type DriveItem } from "@/features/drive/lib/item"
import { useDirectoryListingQuery, useDirectoryNamesQuery } from "@/features/drive/queries/drive"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { cn } from "@/lib/utils"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"
import { ItemIcon } from "@/features/drive/components/itemIcon"
import { EmptyState } from "@/features/drive/components/emptyState"
import { ListingSkeleton } from "@/features/drive/components/listingSkeleton"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"

export interface AttachDriveDialogProps {
	onClose: () => void
	// Fired once a click-to-attach resolves to a usable public-link url — the caller (composer.tsx)
	// inserts it and closes the dialog itself (this component never touches the composer's draft).
	onAttached: (url: string) => void
}

// Drive-file picker for the composer's attach flow (synthesis §3 wave-C6 spec item 4: "reuse the
// move-dialog's tree/picker machinery ... do NOT build a second tree"). Reuses the SAME tree-fetching
// hooks moveTargetDialog.tsx does (useDirectoryListingQuery/useDirectoryNamesQuery, local uuid path
// stack, "My Drive" breadcrumb) — there is exactly one directory-tree data source in this app and this
// is it. The SELECTION semantics differ from move on purpose: a directory row descends (browsing), a
// FILE row is clickable and immediately attaches (no separate confirm step — a picker with one purpose
// per row needs no "select then confirm" ceremony move's multi-item flow does). An item that already
// carries a public link reuses it (attachExistingDriveItem's own get-then-create) rather than erroring.
export function AttachDriveDialog({ onClose, onAttached }: AttachDriveDialogProps) {
	const { t } = useTranslation(["chats", "drive"])
	const [pathStack, setPathStack] = useState<string[]>([])
	const [attachingUuid, setAttachingUuid] = useState<string | null>(null)
	const targetUuid = pathStack.at(-1) ?? null

	const listingQuery = useDirectoryListingQuery("drive", targetUuid)
	const namesQuery = useDirectoryNamesQuery(pathStack)
	const rows = listingQuery.data ?? []

	function descend(uuid: string): void {
		setPathStack(prev => [...prev, uuid])
	}

	function handleOpenChange(next: boolean, details: DialogRoot.ChangeEventDetails): void {
		if (!shouldForwardOpenChange(next, attachingUuid !== null)) {
			details.cancel()
			return
		}

		if (!next) {
			onClose()
		}
	}

	async function handleAttach(item: DriveItem): Promise<void> {
		if (item.data.undecryptable) {
			return
		}

		setAttachingUuid(item.data.uuid)
		const outcome = await attachExistingDriveItem(item)
		setAttachingUuid(null)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		onAttached(outcome.url)
	}

	return (
		<Dialog
			open
			onOpenChange={handleOpenChange}
		>
			<DialogContent
				closeButtonDisabled={attachingUuid !== null}
				className="sm:max-w-lg"
			>
				<DialogHeader>
					<DialogTitle>{t("chatAttachDriveDialogTitle")}</DialogTitle>
				</DialogHeader>
				<nav
					aria-label={t("drive:driveBreadcrumbLabel")}
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
						{t("drive:driveMyDrive")}
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
				<p className="text-xs text-muted-foreground">{t("chatAttachDriveDialogHint")}</p>
				<div className="h-72 overflow-y-auto rounded-xl ring-1 ring-foreground/5 dark:ring-foreground/10">
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
					) : rows.length === 0 ? (
						<EmptyState variant="empty" />
					) : (
						<ul className="flex flex-col gap-0.5 p-2">
							{rows.map(item => {
								const disabled = item.data.undecryptable || attachingUuid !== null
								const isAttaching = attachingUuid === item.data.uuid

								return (
									<li key={item.data.uuid}>
										<button
											type="button"
											disabled={disabled}
											onClick={() => {
												if (item.type === "directory") {
													descend(item.data.uuid)
													return
												}

												void handleAttach(item)
											}}
											className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
										>
											<ItemIcon
												item={item}
												className="size-4 shrink-0"
											/>
											<span className="min-w-0 flex-1 truncate">
												{item.data.decryptedMeta?.name ?? item.data.uuid}
											</span>
											{isAttaching ? <Spinner className="size-3.5 shrink-0" /> : null}
										</button>
									</li>
								)
							})}
						</ul>
					)}
				</div>
			</DialogContent>
		</Dialog>
	)
}

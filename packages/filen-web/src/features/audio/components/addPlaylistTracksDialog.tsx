import { Fragment, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CheckIcon, ChevronRightIcon } from "lucide-react"
import type { DialogRoot } from "@base-ui/react/dialog"
import { addTracksToPlaylistAction } from "@/features/audio/lib/playlists"
import { isAudioItem } from "@/features/audio/lib/handoff"
import { type DriveItem } from "@/features/drive/lib/item"
import { useDirectoryListingQuery, useDirectoryNamesQuery } from "@/features/drive/queries/drive"
import { filterDriveItemsByLocalSearch } from "@/features/drive/components/directoryListing.logic"
import type { Playlist } from "@/features/audio/lib/playlistSchema"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { cn } from "@/lib/utils"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"
import { ItemIcon, DirectoryGlyph } from "@/features/drive/components/itemIcon"
import { EmptyState } from "@/features/drive/components/emptyState"
import { ListingSkeleton } from "@/features/drive/components/listingSkeleton"
import { ListFilterInput } from "@/components/listFilterInput"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export interface AddPlaylistTracksDialogProps {
	playlist: Playlist
	onClose: () => void
}

// Drive audio-file picker for "Add tracks" — reuses the exact browse/filter machinery
// moveTargetDialog.tsx and attachDriveDialog.tsx already established (useDirectoryListingQuery/
// useDirectoryNamesQuery, a local uuid path stack, ListFilterInput's local search) rather than
// building a third tree. Unlike those two single-purpose pickers, selection here is MULTI and persists
// across navigation — a directory row descends, an audio-file row toggles into a Map keyed by uuid (not
// a Set: the actual DriveItem is needed at submit time, and a Set would lose it the moment the user
// navigates away from the directory it came from). A track already in the target playlist renders
// disabled with an inline hint instead of being hidden — addTracksToPlaylistAction's own dedup against
// the freshest copy would silently no-op it anyway, so this is purely a click-saving affordance.
export function AddPlaylistTracksDialog({ playlist, onClose }: AddPlaylistTracksDialogProps) {
	const { t } = useTranslation(["audio", "drive"])
	const [pathStack, setPathStack] = useState<string[]>([])
	const [filter, setFilter] = useState("")
	const [selected, setSelected] = useState<Map<string, DriveItem>>(new Map())
	const [pending, setPending] = useState(false)
	const targetUuid = pathStack.at(-1) ?? null

	const listingQuery = useDirectoryListingQuery("drive", targetUuid)
	const namesQuery = useDirectoryNamesQuery(pathStack)
	const rows = listingQuery.data ?? []
	const browsable = rows.filter(item => item.type === "directory" || isAudioItem(item))
	const filtered = filterDriveItemsByLocalSearch(browsable, filter)
	const existingUuids = new Set(playlist.files.map(file => file.uuid))

	const pathKey = pathStack.join("/")
	const [filterPathKey, setFilterPathKey] = useState(pathKey)

	if (pathKey !== filterPathKey) {
		setFilterPathKey(pathKey)
		setFilter("")
	}

	function descend(uuid: string): void {
		setPathStack(prev => [...prev, uuid])
	}

	function toggle(item: DriveItem): void {
		setSelected(prev => {
			const next = new Map(prev)

			if (next.has(item.data.uuid)) {
				next.delete(item.data.uuid)
			} else {
				next.set(item.data.uuid, item)
			}

			return next
		})
	}

	function handleOpenChange(next: boolean, details: DialogRoot.ChangeEventDetails): void {
		if (!shouldForwardOpenChange(next, pending)) {
			details.cancel()
			return
		}

		if (!next) {
			onClose()
		}
	}

	async function handleAdd(): Promise<void> {
		if (selected.size === 0) {
			return
		}

		setPending(true)

		try {
			const added = await addTracksToPlaylistAction(playlist, [...selected.values()])

			if (added > 0) {
				toast.success(t("tracksAddedToast", { count: added }))
			}

			onClose()
		} catch (error) {
			toast.error(errorLabel(asErrorDTO(error)))
		} finally {
			setPending(false)
		}
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
					<DialogTitle>{t("addTracksDialogTitle")}</DialogTitle>
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
				{rows.length > 0 ? (
					<ListFilterInput
						value={filter}
						onChange={setFilter}
						placeholder={t("addTracksFilterPlaceholder")}
						ariaLabel={t("addTracksFilterPlaceholder")}
					/>
				) : null}
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
					) : filtered.length === 0 ? (
						<EmptyState
							variant="empty"
							driveVariant="drive"
						/>
					) : (
						<ul className="flex flex-col gap-0.5 p-2">
							{filtered.map(item => {
								const alreadyAdded = item.type === "file" && existingUuids.has(item.data.uuid)
								const isSelected = selected.has(item.data.uuid)
								const disabled = item.data.undecryptable || alreadyAdded

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

												toggle(item)
											}}
											aria-pressed={item.type === "file" ? isSelected : undefined}
											className={cn(
												"flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
												isSelected && "bg-accent/70 text-accent-foreground"
											)}
										>
											{item.type === "directory" ? (
												<DirectoryGlyph
													color={item.data.color}
													className="size-4 shrink-0"
												/>
											) : (
												<ItemIcon
													item={item}
													className="size-4 shrink-0"
												/>
											)}
											<span className="min-w-0 flex-1 truncate">
												{item.data.decryptedMeta?.name ?? item.data.uuid}
											</span>
											{alreadyAdded ? (
												<span className="shrink-0 text-xs text-muted-foreground">{t("alreadyInPlaylist")}</span>
											) : isSelected ? (
												<CheckIcon className="size-4 shrink-0 text-primary" />
											) : null}
										</button>
									</li>
								)
							})}
						</ul>
					)}
				</div>
				<DialogFooter>
					<Button
						disabled={pending || selected.size === 0}
						onClick={() => {
							void handleAdd()
						}}
					>
						{pending && <Spinner data-icon="inline-start" />}
						{t("addTracksSubmit", { count: selected.size })}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

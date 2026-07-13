import { Fragment, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronRightIcon, SearchXIcon } from "lucide-react"
import type { DialogRoot } from "@base-ui/react/dialog"
import { useDirectoryListingQuery, useDirectoryNamesQuery } from "@/features/drive/queries/drive"
import { asErrorDTO } from "@/lib/sdk/errors"
import { cn } from "@/lib/utils"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"
import {
	isPhotosChooserConfirmDisabled,
	isPhotosChooserRowDisabled,
	photosChooserDirectories
} from "@/features/photos/components/directoryChooserDialog.logic"
import { filterDriveItemsByLocalSearch } from "@/features/drive/components/directoryListing.logic"
import { DirectoryGlyph } from "@/features/drive/components/itemIcon"
import { EmptyState } from "@/features/drive/components/emptyState"
import { ListingSkeleton } from "@/features/drive/components/listingSkeleton"
import { ListFilterInput } from "@/components/listFilterInput"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

export interface DirectoryChooserDialogProps {
	pending: boolean
	onChoose: (rootUuid: string) => void
	onClose: () => void
}

// Photos' own root-directory picker — a COMPOSITION of the same generic pieces moveTargetDialog.tsx
// browses with (useDirectoryListingQuery("drive", …), useDirectoryNamesQuery, ListFilterInput,
// filterDriveItemsByLocalSearch, EmptyState, ListingSkeleton, DirectoryGlyph), not a lift of that
// component itself: moveTargetDialog's row/confirm gating is inherently move-specific (it forbids a
// target that is the moved selection's own ancestry, and its confirm calls moveItems/importItems),
// so extracting a shared shell would need a generic-enough gating callback threaded through both
// call sites for very little real duplication saved — this picker's own gating
// (directoryChooserDialog.logic.ts) is a handful of lines. Local navigation only (a uuid pathStack,
// never the "/drive/$" route), same as moveTargetDialog's own rationale for why browsing here never
// disturbs app navigation history. No create-folder-in-place: unlike a move/import destination, a
// photos root doesn't need one carved out on the spot.
export function DirectoryChooserDialog({ pending, onChoose, onClose }: DirectoryChooserDialogProps) {
	const { t } = useTranslation(["photos", "drive"])
	const [pathStack, setPathStack] = useState<string[]>([])
	const [filter, setFilter] = useState("")
	const targetUuid = pathStack.at(-1) ?? null

	const listingQuery = useDirectoryListingQuery("drive", targetUuid)
	const namesQuery = useDirectoryNamesQuery(pathStack)
	const directories = photosChooserDirectories(listingQuery.data ?? [])
	// Resets on every descend/breadcrumb-jump (pathStack change) — mirrors moveTargetDialog.tsx's
	// identical in-render reset (react.dev's "adjusting state when a prop changes" pattern, not a
	// useEffect — see directoryListing.tsx's own listingKey comment for why).
	const filteredDirectories = filterDriveItemsByLocalSearch(directories, filter)
	const pathKey = pathStack.join("/")
	const [filterPathKey, setFilterPathKey] = useState(pathKey)

	if (pathKey !== filterPathKey) {
		setFilterPathKey(pathKey)
		setFilter("")
	}

	function descend(uuid: string): void {
		setPathStack(prev => [...prev, uuid])
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
					<DialogTitle>{t("photosChooserTitle")}</DialogTitle>
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
				{directories.length > 0 ? (
					<ListFilterInput
						value={filter}
						onChange={setFilter}
						placeholder={t("photosChooserFilterPlaceholder")}
						ariaLabel={t("photosChooserFilterPlaceholder")}
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
					) : filteredDirectories.length === 0 ? (
						filter.trim().length > 0 ? (
							<Empty>
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<SearchXIcon />
									</EmptyMedia>
									<EmptyTitle>{t("drive:driveSearchNoResults")}</EmptyTitle>
								</EmptyHeader>
							</Empty>
						) : (
							<EmptyState
								variant="empty"
								driveVariant="drive"
							/>
						)
					) : (
						<ul className="flex flex-col gap-0.5 p-2">
							{filteredDirectories.map(directory => {
								const disabled = isPhotosChooserRowDisabled(directory)

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
											<DirectoryGlyph
												color={directory.data.color}
												className="size-4 shrink-0"
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
						disabled={pending || isPhotosChooserConfirmDisabled(targetUuid)}
						onClick={() => {
							if (targetUuid !== null) {
								onChoose(targetUuid)
							}
						}}
					>
						{pending && <Spinner data-icon="inline-start" />}
						{t("photosChooserConfirmAction")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

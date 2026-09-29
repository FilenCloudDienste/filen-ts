import { useTranslation } from "react-i18next"
import { useAccountQuery } from "@/queries/account"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { photosChooserChoice } from "@/features/photos/components/directoryChooserDialog.logic"
import { filterDriveItemsByLocalSearch } from "@/features/drive/components/directoryListing.logic"
import { PickerBreadcrumb, PickerDirectoryRow, PickerListShell } from "@/features/drive/components/directoryPicker"
import { useDirectoryPicker, useDirectoryPickerFilter } from "@/features/drive/hooks/useDirectoryPicker"
import { ListFilterInput } from "@/components/listFilterInput"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export interface DirectoryChooserDialogProps {
	pending: boolean
	onChoose: (rootUuid: string) => void
	onClose: () => void
}

// Photos' own root-directory picker — composed from directoryPicker.tsx's gating-free pieces, not a
// lift of moveTargetDialog: that dialog's row/confirm gating is move-specific (it forbids the moved
// selection's own ancestry), while this picker's (directoryChooserDialog.logic.ts) is a handful of
// lines. No create-folder-in-place: unlike a move destination, a photos root doesn't need one carved
// out on the spot.
export function DirectoryChooserDialog({ pending, onChoose, onClose }: DirectoryChooserDialogProps) {
	const { t } = useTranslation("photos")
	const { pathStack, targetUuid, listingQuery, namesQuery, descend, goRoot, goTo } = useDirectoryPicker()
	const [filter, setFilter] = useDirectoryPickerFilter(pathStack)
	const accountQuery = useAccountQuery()
	const choice = photosChooserChoice(targetUuid, accountQuery.data?.rootDirUuid)
	const directories = (listingQuery.data ?? []).filter(item => item.type === "directory")
	const filteredDirectories = filterDriveItemsByLocalSearch(directories, filter)

	const handleOpenChange = pendingGuardedOpenChange(pending, next => {
		if (!next) {
			onClose()
		}
	})

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
						placeholder={t("photosChooserFilterPlaceholder")}
						ariaLabel={t("photosChooserFilterPlaceholder")}
					/>
				) : null}
				<PickerListShell
					listingQuery={listingQuery}
					isEmpty={filteredDirectories.length === 0}
					noResults={filter.trim().length > 0}
				>
					{filteredDirectories.map(directory => (
						<PickerDirectoryRow
							key={directory.data.uuid}
							directory={directory}
							disabled={directory.data.undecryptable}
							onDescend={descend}
						/>
					))}
				</PickerListShell>
				<DialogFooter>
					<Button
						disabled={pending || choice === null}
						onClick={() => {
							if (choice !== null) {
								onChoose(choice)
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

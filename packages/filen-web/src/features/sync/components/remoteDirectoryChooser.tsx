import { useTranslation } from "react-i18next"
import { driveItemName } from "@filen/shared"
import { filterDriveItemsByLocalSearch } from "@/features/drive/components/directoryListing.logic"
import { PickerBreadcrumb, PickerDirectoryRow, PickerListShell } from "@/features/drive/components/directoryPicker"
import { useDirectoryPickerFilter, type useDirectoryPicker } from "@/features/drive/hooks/useDirectoryPicker"
import { ListFilterInput } from "@/components/listFilterInput"
import { isHiddenRemoteRow } from "@/features/sync/components/addPairDialog.logic"

export type DirectoryPicker = ReturnType<typeof useDirectoryPicker>

// The add-pair dialog's remote step: the shared drive picker pieces over the own drive. The directory open in it
// is the pick, the top level picking the account's root; Filen's own `.filen` directory, which the engine reserves,
// is hidden. The picker state lives in the dialog, so going back to this step keeps the path.
export function RemoteDirectoryChooser({ picker, disabled }: { picker: DirectoryPicker; disabled: boolean }) {
	const { t } = useTranslation("sync")
	const { pathStack, listingQuery, items, namesQuery, descend, goRoot, goTo } = picker
	const [filter, setFilter] = useDirectoryPickerFilter(pathStack)
	const atDriveRoot = pathStack.length === 0
	const directories = items.filter(item => item.type === "directory" && !isHiddenRemoteRow(driveItemName(item), atDriveRoot))
	const filteredDirectories = filterDriveItemsByLocalSearch(directories, filter)

	return (
		<>
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
					placeholder={t("addRemoteFilter")}
					ariaLabel={t("addRemoteFilter")}
				/>
			) : null}
			<PickerListShell
				listingQuery={listingQuery}
				isEmpty={filteredDirectories.length === 0}
				noResults={filter.trim().length > 0}
			>
				{filteredDirectories.map(directory =>
					directory.type === "directory" ? (
						<PickerDirectoryRow
							key={directory.data.uuid}
							directory={directory}
							disabled={directory.data.undecryptable || disabled}
							onDescend={descend}
						/>
					) : null
				)}
			</PickerListShell>
		</>
	)
}

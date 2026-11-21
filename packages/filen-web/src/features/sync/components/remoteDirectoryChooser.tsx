import { useTranslation } from "react-i18next"
import { driveItemName } from "@filen/shared"
import { filterDriveItemsByLocalSearch } from "@/features/drive/components/directoryListing.logic"
import { PickerBreadcrumb, PickerDirectoryRow, PickerListShell, type PickerLeading } from "@/features/drive/components/directoryPicker"
import { useDirectoryPickerFilter, type DirectoryPicker } from "@/features/drive/hooks/useDirectoryPicker"
import { ListFilterInput } from "@/components/listFilterInput"
import { isHiddenRemoteRow } from "@/features/sync/components/addPairDialog.logic"

// The add-pair dialog's remote step: the shared drive picker pieces over the own drive. The directory open in it
// is the pick (the whole drive only when the dialog's switch says so); Filen's own `.filen` directory, which the
// engine reserves, is hidden. The picker state lives in the dialog, so going back to this step keeps the path; so
// does its new-directory row (`leading`), whose button sits in the dialog's footer.
export function RemoteDirectoryChooser({
	picker,
	disabled,
	leading
}: {
	picker: DirectoryPicker
	disabled: boolean
	leading?: PickerLeading | undefined
}) {
	const { t } = useTranslation(["sync", "drive"])
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
				noResults={filter.trim().length > 0}
				filteredOutMessage={items.length > 0 ? t("drive:driveTreeMenuNoDirectories") : undefined}
				count={filteredDirectories.length}
				leading={leading}
				rowKey={index => filteredDirectories[index]?.data.uuid ?? String(index)}
				renderRow={index => {
					const directory = filteredDirectories[index]

					return directory?.type === "directory" ? (
						<PickerDirectoryRow
							directory={directory}
							disabled={directory.data.undecryptable || disabled}
							onDescend={descend}
						/>
					) : null
				}}
			/>
		</>
	)
}

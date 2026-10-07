import { useContext } from "react"
import { useTranslation } from "react-i18next"
import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import { EntryMenuContext } from "@/features/archive/lib/entryMenu"
import { ArchiveExtractItems } from "@/features/archive/components/archiveExtractMenu"
import {
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger
} from "@/components/ui/dropdown-menu"

// A file row's ⋯ menu: Open where the entry previews, Download where it can be saved alone, and Extract
// with the footer's destinations for that entry. Mounted only while open.
export function ArchiveEntryMenuContent({ slot }: { slot: number }) {
	const { t } = useTranslation("drive")
	const host = useContext(EntryMenuContext)

	if (host === null) {
		return null
	}

	const offers = host.offers(slot)
	const OpenIcon = ACTION_DEFS.openFile.icon
	const DownloadIcon = ACTION_DEFS.download.icon
	const ExtractIcon = ACTION_DEFS.extract.icon

	return (
		<DropdownMenuContent align="end">
			{offers.open ? (
				<DropdownMenuItem
					onClick={() => {
						host.onAction(slot, { type: "open" })
					}}
				>
					<OpenIcon aria-hidden="true" />
					{t(ACTION_DEFS.openFile.labelKey)}
				</DropdownMenuItem>
			) : null}
			{offers.download ? (
				<DropdownMenuItem
					onClick={() => {
						host.onAction(slot, { type: "download" })
					}}
				>
					<DownloadIcon aria-hidden="true" />
					{t(ACTION_DEFS.download.labelKey)}
				</DropdownMenuItem>
			) : null}
			<DropdownMenuSub>
				<DropdownMenuSubTrigger disabled={host.extractDisabled}>
					<ExtractIcon aria-hidden="true" />
					{t(ACTION_DEFS.extract.labelKey)}
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent className="max-w-80">
					<ArchiveExtractItems
						source={host.source}
						newFolderName={host.newFolderName}
						onPick={target => {
							host.onAction(slot, { type: "extract", target })
						}}
						onChooseDestination={() => {
							host.onAction(slot, { type: "chooseDestination" })
						}}
					/>
				</DropdownMenuSubContent>
			</DropdownMenuSub>
		</DropdownMenuContent>
	)
}

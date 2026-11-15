import { useContext } from "react"
import { useTranslation } from "react-i18next"
import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import {
	CONTEXT_TREE_MENU_FAMILY,
	DROPDOWN_TREE_MENU_FAMILY,
	type DirectoryTreeMenuFamily
} from "@/features/drive/components/directoryTreeSubmenu"
import { EntryMenuContext, type EntryMenuHost, type RowMenu } from "@/features/archive/lib/entryMenu"
import type { ExtractTarget } from "@/features/archive/lib/extractSelection"
import { ArchiveExtractItems } from "@/features/archive/components/archiveExtractMenu"
import { ContextMenuContent } from "@/components/ui/context-menu"
import { DropdownMenuContent } from "@/components/ui/dropdown-menu"

interface ExtractSubmenuProps {
	family: DirectoryTreeMenuFamily
	host: EntryMenuHost
	disabled: boolean
	onPick: (target: ExtractTarget) => void
	onChooseDestination: () => void
}

// Extract, with the footer's destinations.
function ExtractSubmenu({ family, host, disabled, onPick, onChooseDestination }: ExtractSubmenuProps) {
	const { t } = useTranslation("drive")
	const { Sub, SubTrigger, SubContent } = family
	const ExtractIcon = ACTION_DEFS.extract.icon

	return (
		<Sub>
			<SubTrigger disabled={disabled}>
				<ExtractIcon aria-hidden="true" />
				{t(ACTION_DEFS.extract.labelKey)}
			</SubTrigger>
			<SubContent className="max-w-80">
				<ArchiveExtractItems
					family={family}
					source={host.source}
					newFolderName={host.newFolderName}
					onPick={onPick}
					onChooseDestination={onChooseDestination}
				/>
			</SubContent>
		</Sub>
	)
}

// A file's entries: Open where the entry previews, Download where it can be saved alone, and Extract for
// that entry.
function EntryMenuEntries({ family, host, slot }: { family: DirectoryTreeMenuFamily; host: EntryMenuHost; slot: number }) {
	const { t } = useTranslation("drive")
	const { Item } = family
	const offers = host.offers(slot)
	const OpenIcon = ACTION_DEFS.openFile.icon
	const DownloadIcon = ACTION_DEFS.download.icon

	return (
		<>
			{offers.open ? (
				<Item
					onClick={() => {
						host.onAction(slot, { type: "open" })
					}}
				>
					<OpenIcon aria-hidden="true" />
					{t(ACTION_DEFS.openFile.labelKey)}
				</Item>
			) : null}
			{offers.download ? (
				<Item
					onClick={() => {
						host.onAction(slot, { type: "download" })
					}}
				>
					<DownloadIcon aria-hidden="true" />
					{t(ACTION_DEFS.download.labelKey)}
				</Item>
			) : null}
			<ExtractSubmenu
				family={family}
				host={host}
				disabled={host.extractDisabled}
				onPick={target => {
					host.onAction(slot, { type: "extract", target })
				}}
				onChooseDestination={() => {
					host.onAction(slot, { type: "chooseDestination" })
				}}
			/>
		</>
	)
}

// A file row's ⋯ menu. Mounted only while open.
export function ArchiveEntryMenuContent({ slot }: { slot: number }) {
	const host = useContext(EntryMenuContext)

	if (host === null) {
		return null
	}

	return (
		<DropdownMenuContent align="end">
			<EntryMenuEntries
				family={DROPDOWN_TREE_MENU_FAMILY}
				host={host}
				slot={slot}
			/>
		</DropdownMenuContent>
	)
}

// A row's right-click menu (RowMenu): a file's ⋯ items, a directory's Open, and the selection's Extract.
// Mounted only while open.
export function ArchiveRowContextMenuContent({ menu }: { menu: RowMenu }) {
	const { t } = useTranslation("drive")
	const host = useContext(EntryMenuContext)

	if (host === null) {
		return null
	}

	const { Item } = CONTEXT_TREE_MENU_FAMILY
	const OpenDirIcon = ACTION_DEFS.openDirectory.icon
	const selectionExtract = (
		<ExtractSubmenu
			family={CONTEXT_TREE_MENU_FAMILY}
			host={host}
			disabled={host.selectionExtractDisabled}
			onPick={target => {
				host.onSelectionAction({ type: "extract", target })
			}}
			onChooseDestination={() => {
				host.onSelectionAction({ type: "chooseDestination" })
			}}
		/>
	)

	return (
		<ContextMenuContent>
			{menu.type === "entry" ? (
				<EntryMenuEntries
					family={CONTEXT_TREE_MENU_FAMILY}
					host={host}
					slot={menu.slot}
				/>
			) : menu.type === "dir" ? (
				<>
					<Item
						onClick={() => {
							host.onOpenDir(menu.dir)
						}}
					>
						<OpenDirIcon aria-hidden="true" />
						{t(ACTION_DEFS.openDirectory.labelKey)}
					</Item>
					{menu.extract ? selectionExtract : null}
				</>
			) : (
				selectionExtract
			)}
		</ContextMenuContent>
	)
}

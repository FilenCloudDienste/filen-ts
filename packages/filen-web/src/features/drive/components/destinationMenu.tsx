import { useTranslation } from "react-i18next"
import { ClipboardPasteIcon, ClipboardXIcon, FilePlusIcon, FolderPlusIcon, FolderUpIcon, PlusIcon, UploadIcon } from "lucide-react"
import { type PasteDirectory } from "@/features/drive/lib/directoryPaste"
import { stopRowPropagation } from "@/features/drive/lib/rowPropagation"
import { useDirectoryPaste } from "@/features/drive/hooks/useDirectoryPaste"
import { type DirectoryTreeMenuFamily } from "@/features/drive/components/directoryTreeSubmenu"
import { useIsOnline } from "@/lib/useIsOnline"
import { Kbd } from "@/lib/keymap/kbd"

// What can be put into a directory. newDirectory is absent where a surface has its own New directory
// control beside the menu (the toolbar's Upload menu).
export interface DestinationActions {
	newDirectory?: (() => void) | undefined
	newTextFile: () => void
	pickFiles: () => void
	pickDirectory: () => void
}

export interface DestinationPaste {
	enabled: boolean
	run: () => void
	// Shown only where mod+v pastes into the same directory the entry does.
	shortcut: boolean
}

export interface DestinationClear {
	enabled: boolean
	run: () => void
}

interface DestinationEntriesProps {
	family: DirectoryTreeMenuFamily
	actions: DestinationActions
	paste?: DestinationPaste | undefined
	clear?: DestinationClear | undefined
	// Shown disabled, like the other network actions, where the menu itself stays open offline.
	offline?: boolean | undefined
}

// The one list of what a directory offers as a destination — the toolbar's Upload menu, a listing's
// empty-space menu, the sidebar tree root's menu, and (without Paste) the New submenu below.
export function DestinationEntries({ family, actions, paste, clear, offline = false }: DestinationEntriesProps) {
	const { t } = useTranslation(["drive", "common"])
	const { Item, Separator } = family
	const title = offline ? t("common:offlineActionDisabled") : undefined

	return (
		<>
			{actions.newDirectory === undefined ? null : (
				<Item
					disabled={offline}
					title={title}
					onClick={actions.newDirectory}
				>
					<FolderPlusIcon aria-hidden="true" />
					{t("driveNewDirectoryTitle")}
				</Item>
			)}
			<Item
				disabled={offline}
				title={title}
				onClick={actions.newTextFile}
			>
				<FilePlusIcon aria-hidden="true" />
				{t("driveNewTextFile")}
			</Item>
			<Separator />
			<Item
				disabled={offline}
				title={title}
				onClick={actions.pickFiles}
			>
				<UploadIcon aria-hidden="true" />
				{t("driveUploadFiles")}
			</Item>
			<Item
				disabled={offline}
				title={title}
				onClick={actions.pickDirectory}
			>
				<FolderUpIcon aria-hidden="true" />
				{t("driveUploadDirectory")}
			</Item>
			{paste === undefined ? null : (
				<>
					<Separator />
					<DestinationPasteItem
						family={family}
						paste={paste}
					/>
				</>
			)}
			{clear === undefined ? null : (
				<Item
					disabled={!clear.enabled}
					onClick={clear.run}
				>
					<ClipboardXIcon aria-hidden="true" />
					{t("driveClipboardClear")}
				</Item>
			)}
		</>
	)
}

export function DestinationPasteItem({ family, paste }: { family: DirectoryTreeMenuFamily; paste: DestinationPaste }) {
	const { t } = useTranslation("drive")
	const { Item } = family

	return (
		<Item
			disabled={!paste.enabled}
			onClick={event => {
				// A row's ⋯ dropdown is a React descendant of the row — see stopRowPropagation.
				event.stopPropagation()
				paste.run()
			}}
		>
			<ClipboardPasteIcon aria-hidden="true" />
			{t("driveClipboardPaste")}
			{paste.shortcut ? (
				<span className="ml-auto pl-4">
					<Kbd action="drive.paste" />
				</span>
			) : null}
		</Item>
	)
}

interface DirectoryDestinationEntriesProps {
	family: DirectoryTreeMenuFamily
	directory: PasteDirectory
	actions: DestinationActions
	// mod+v pastes into this directory from where the menu was opened (a focused tree node), not into
	// the listing on screen (a row).
	pasteShortcut: boolean
}

// A directory's own item menu, under Open: the create and upload entries collapsed into a New submenu,
// and Paste beside it. Offline the submenu stays, disabled, like the other network actions.
export function DirectoryDestinationEntries({ family, directory, actions, pasteShortcut }: DirectoryDestinationEntriesProps) {
	const { t } = useTranslation(["drive", "common"])
	const isOnline = useIsOnline()
	const paste = useDirectoryPaste(directory, pasteShortcut)
	const { Sub, SubTrigger, SubContent } = family

	return (
		<>
			<Sub>
				<SubTrigger
					disabled={!isOnline}
					title={isOnline ? undefined : t("common:offlineActionDisabled")}
					onClick={stopRowPropagation}
					onDoubleClick={stopRowPropagation}
				>
					<PlusIcon aria-hidden="true" />
					{t("driveNew")}
				</SubTrigger>
				<SubContent
					onClick={stopRowPropagation}
					onDoubleClick={stopRowPropagation}
				>
					<DestinationEntries
						family={family}
						actions={actions}
					/>
				</SubContent>
			</Sub>
			<DestinationPasteItem
				family={family}
				paste={paste}
			/>
		</>
	)
}

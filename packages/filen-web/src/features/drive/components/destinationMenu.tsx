import { useTranslation } from "react-i18next"
import {
	ClipboardPasteIcon,
	ClipboardXIcon,
	FilePlusIcon,
	FileSpreadsheetIcon,
	FileTextIcon,
	FilesIcon,
	FolderPlusIcon,
	FolderUpIcon,
	PlusIcon,
	PresentationIcon,
	UploadIcon
} from "lucide-react"
import { type PasteDirectory } from "@/features/drive/lib/directoryPaste"
import { useDirectoryPaste } from "@/features/drive/hooks/useDirectoryPaste"
import { type DirectoryTreeMenuFamily } from "@/features/drive/components/directoryTreeSubmenu"
import { type NewOfficeKind } from "@/features/drive/lib/createOfficeFile"
import { useIsOnline } from "@/lib/useIsOnline"
import { MenuKbd } from "@/lib/keymap/kbdHints"

// What can be put into a directory. newDirectory is absent where a surface has its own New directory
// control beside the menu (the toolbar's Upload menu).
export interface DestinationActions {
	newDirectory?: (() => void) | undefined
	newTextFile: () => void
	newOffice: (kind: NewOfficeKind) => void
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
export function DestinationEntries({ family, actions, paste, clear, offline: offlineProp }: DestinationEntriesProps) {
	// Not a destructuring default, which the React Compiler cannot lower.
	const offline = offlineProp ?? false
	const { t } = useTranslation(["drive", "common"])
	const { Item, Separator, Sub, SubTrigger, SubContent } = family
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
			<Sub>
				<SubTrigger
					disabled={offline}
					title={title}
				>
					<FilesIcon aria-hidden="true" />
					{t("driveNewOffice")}
				</SubTrigger>
				<SubContent>
					<Item
						onClick={() => {
							actions.newOffice("docx")
						}}
					>
						<FileTextIcon aria-hidden="true" />
						{t("driveNewOfficeDocx")}
					</Item>
					<Item
						onClick={() => {
							actions.newOffice("xlsx")
						}}
					>
						<FileSpreadsheetIcon aria-hidden="true" />
						{t("driveNewOfficeXlsx")}
					</Item>
					<Item
						onClick={() => {
							actions.newOffice("pptx")
						}}
					>
						<PresentationIcon aria-hidden="true" />
						{t("driveNewOfficePptx")}
					</Item>
					<Separator />
					<Sub>
						<SubTrigger>
							<FilesIcon aria-hidden="true" />
							{t("driveNewOfficeOpenDocument")}
						</SubTrigger>
						<SubContent>
							<Item
								onClick={() => {
									actions.newOffice("odt")
								}}
							>
								<FileTextIcon aria-hidden="true" />
								{t("driveNewOfficeOdt")}
							</Item>
							<Item
								onClick={() => {
									actions.newOffice("ods")
								}}
							>
								<FileSpreadsheetIcon aria-hidden="true" />
								{t("driveNewOfficeOds")}
							</Item>
							<Item
								onClick={() => {
									actions.newOffice("odp")
								}}
							>
								<PresentationIcon aria-hidden="true" />
								{t("driveNewOfficeOdp")}
							</Item>
						</SubContent>
					</Sub>
				</SubContent>
			</Sub>
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
			onClick={() => {
				paste.run()
			}}
		>
			<ClipboardPasteIcon aria-hidden="true" />
			{t("driveClipboardPaste")}
			<MenuKbd action={paste.shortcut ? "drive.paste" : undefined} />
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
				>
					<PlusIcon aria-hidden="true" />
					{t("driveNew")}
				</SubTrigger>
				<SubContent>
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

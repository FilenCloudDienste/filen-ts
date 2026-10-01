import { useTranslation } from "react-i18next"
import { ClipboardCopyIcon, FolderSearchIcon, ScissorsIcon } from "lucide-react"
import { type DriveItem } from "@/features/drive/lib/item"
import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import { copyToClipboard, cutToClipboard } from "@/features/drive/lib/clipboard"
import { Kbd } from "@/lib/keymap/kbd"
import { performMove } from "@/features/drive/lib/dnd"
import { cachedDirectoryName, cachedListing } from "@/features/drive/queries/drive"
import { useIsOnline } from "@/lib/useIsOnline"
import { startCopyWithCard } from "@/features/transfers/lib/copyToast"
import { type CopyDestination } from "@/features/drive/lib/copy.logic"
import { createMoveTreeGates } from "@/features/drive/components/moveTargetDialog.logic"
import {
	DirectoryTreeSubmenu,
	type DirectoryTreeMenuFamily,
	type DirectoryTreeTarget
} from "@/features/drive/components/directoryTreeSubmenu"

export type TransferMode = "move" | "copy"

export interface TransferSubmenuProps {
	mode: TransferMode
	family: DirectoryTreeMenuFamily
	// The whole selection for the bulk menu, the one item otherwise.
	items: DriveItem[]
	// Opens the full destination picker (moveTargetDialog.tsx) in this mode on the same items.
	onChooseDestination: (mode: TransferMode) => void
}

// The picked directory's name for the move's activity and the copy's card, from the listing its level
// was built from.
function targetName(target: DirectoryTreeTarget, rootName: string): string {
	return target.uuid === null ? rootName : (cachedDirectoryName(target.uuid) ?? "")
}

// A pick runs the drop-to-move path (moveItems as an activity, selection prune), which is what the
// dialog's own confirm runs too. A copy goes through the copy card instead.
const MODES = {
	move: {
		def: ACTION_DEFS.move,
		toClipboard: cutToClipboard,
		ClipboardIcon: ScissorsIcon,
		clipboardLabelKey: "driveClipboardCut",
		kbdAction: "drive.cut",
		actionLabelKey: "driveMoveHereAction",
		select: (items: DriveItem[], destination: CopyDestination) => {
			void performMove(items, destination)
		}
	},
	copy: {
		def: ACTION_DEFS.copy,
		toClipboard: copyToClipboard,
		ClipboardIcon: ClipboardCopyIcon,
		clipboardLabelKey: "driveClipboardCopy",
		kbdAction: "drive.copy",
		actionLabelKey: "driveCopyHereAction",
		select: (items: DriveItem[], destination: CopyDestination) => {
			startCopyWithCard(items, destination)
		}
	}
} as const

// The tree only ever browses My Drive, whose listings live under the "drive" variant — the same
// entries its levels just read, so this is a cache read, never a fetch.
function readDriveListing(uuid: string | null): DriveItem[] | undefined {
	return cachedListing("drive", uuid)
}

// "Move" or "Copy" as a submenu: the clipboard entry (for a later paste), the destination picker, then
// the Cloud Drive tree for moving or copying in one pick. The tree greys out exactly what the dialog
// would; unlike a move, a copy may land in the source's own directory (the copy gets a free name there).
export function TransferSubmenu({ mode, family, items, onChooseDestination }: TransferSubmenuProps) {
	const { t } = useTranslation(["drive", "common"])
	// Offline the submenu still opens for its clipboard entry; only the destinations need the network.
	const isOnline = useIsOnline()
	const gates = createMoveTreeGates(items, readDriveListing, mode)
	const config = MODES[mode]
	const { Item } = family

	return (
		<DirectoryTreeSubmenu
			family={family}
			label={t(config.def.labelKey)}
			icon={config.def.icon}
			leading={
				<>
					<Item
						onClick={() => {
							config.toClipboard(items)
						}}
					>
						<config.ClipboardIcon aria-hidden="true" />
						{t(config.clipboardLabelKey)}
						<span className="ml-auto pl-4">
							<Kbd action={config.kbdAction} />
						</span>
					</Item>
					<Item
						disabled={!isOnline}
						title={isOnline ? undefined : t("common:offlineActionDisabled")}
						onClick={() => {
							onChooseDestination(mode)
						}}
					>
						<FolderSearchIcon aria-hidden="true" />
						{t("driveMoveChooseDestination")}
					</Item>
				</>
			}
			actionLabel={t(config.actionLabelKey)}
			actionIcon={config.def.icon}
			isBrowseDisabled={target => !isOnline || gates.isBrowseDisabled(target)}
			isTargetDisabled={target => !isOnline || gates.isTargetDisabled(target)}
			onSelect={target => {
				config.select(items, { uuid: target.uuid, name: targetName(target, t("driveMyDrive")) })
			}}
		/>
	)
}

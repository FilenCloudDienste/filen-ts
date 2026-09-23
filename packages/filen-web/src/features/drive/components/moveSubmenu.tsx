import { useTranslation } from "react-i18next"
import { ScissorsIcon, FolderSearchIcon } from "lucide-react"
import { type DriveItem } from "@/features/drive/lib/item"
import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import { cutToClipboard } from "@/features/drive/lib/clipboard"
import { Kbd } from "@/lib/keymap/kbd"
import { performMove } from "@/features/drive/lib/dnd"
import { driveListingQueryKey } from "@/features/drive/queries/drive"
import { queryClient } from "@/queries/client"
import { useIsOnline } from "@/lib/useIsOnline"
import { createMoveTreeGates } from "@/features/drive/components/moveTargetDialog.logic"
import { DirectoryTreeSubmenu, type DirectoryTreeMenuFamily } from "@/features/drive/components/directoryTreeSubmenu"

export interface MoveSubmenuProps {
	family: DirectoryTreeMenuFamily
	// The whole selection for the bulk menu, the one item otherwise.
	items: DriveItem[]
	// Opens the full destination picker (moveTargetDialog.tsx) on the same items.
	onChooseDestination: () => void
}

// The tree only ever browses My Drive, whose listings live under the "drive" variant — the same
// entries its levels just read, so this is a cache read, never a fetch.
function readDriveListing(uuid: string | null): DriveItem[] | undefined {
	return queryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "drive", uuid }))
}

// "Move" as a submenu: Cut (for a later paste), the destination picker, then the Cloud Drive tree for
// moving in one pick.
// A pick runs the drop-to-move path (moveItems, bulk toast, selection prune), which is what the
// dialog's own confirm runs too, and the tree greys out exactly what the dialog would.
export function MoveSubmenu({ family, items, onChooseDestination }: MoveSubmenuProps) {
	const { t } = useTranslation(["drive", "common"])
	// Offline the submenu still opens for its clipboard entry; only the destinations need the network.
	const isOnline = useIsOnline()
	const gates = createMoveTreeGates(items, readDriveListing)
	const { Item } = family

	return (
		<DirectoryTreeSubmenu
			family={family}
			label={t(ACTION_DEFS.move.labelKey)}
			icon={ACTION_DEFS.move.icon}
			leading={
				<>
					<Item
						onClick={() => {
							cutToClipboard(items)
						}}
					>
						<ScissorsIcon aria-hidden="true" />
						{t("driveClipboardCut")}
						<span className="ml-auto pl-4">
							<Kbd action="drive.cut" />
						</span>
					</Item>
					<Item
						disabled={!isOnline}
						title={isOnline ? undefined : t("common:offlineActionDisabled")}
						onClick={onChooseDestination}
					>
						<FolderSearchIcon aria-hidden="true" />
						{t("driveMoveChooseDestination")}
					</Item>
				</>
			}
			actionLabel={t("driveMoveHereAction")}
			actionIcon={ACTION_DEFS.move.icon}
			isBrowseDisabled={target => !isOnline || gates.isBrowseDisabled(target)}
			isTargetDisabled={target => !isOnline || gates.isTargetDisabled(target)}
			onSelect={target => {
				void performMove(items, target.uuid)
			}}
		/>
	)
}

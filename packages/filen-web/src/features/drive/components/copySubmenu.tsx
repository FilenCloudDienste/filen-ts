import { useTranslation } from "react-i18next"
import { FolderSearchIcon } from "lucide-react"
import { type DriveItem } from "@/features/drive/lib/item"
import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import { cachedDirectoryName, driveListingQueryKey } from "@/features/drive/queries/drive"
import { queryClient } from "@/queries/client"
import { useIsOnline } from "@/lib/useIsOnline"
import { startCopyWithCard } from "@/features/transfers/lib/copyToast"
import { createMoveTreeGates } from "@/features/drive/components/moveTargetDialog.logic"
import {
	DirectoryTreeSubmenu,
	type DirectoryTreeMenuFamily,
	type DirectoryTreeTarget
} from "@/features/drive/components/directoryTreeSubmenu"

export interface CopySubmenuProps {
	family: DirectoryTreeMenuFamily
	// The whole selection for the bulk menu, the one item otherwise.
	items: DriveItem[]
	disabled?: boolean | undefined
	title?: string | undefined
	// Opens the full destination picker (moveTargetDialog.tsx) in its copy mode on the same items.
	onChooseDestination: () => void
}

// The tree only ever browses My Drive, whose listings live under the "drive" variant — the same
// entries its levels just read, so this is a cache read, never a fetch.
function readDriveListing(uuid: string | null): DriveItem[] | undefined {
	return queryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "drive", uuid }))
}

// The picked directory's name for the copy's card, from the listing its level was built from.
function targetName(target: DirectoryTreeTarget, rootName: string): string {
	return target.uuid === null ? rootName : (cachedDirectoryName(target.uuid) ?? "")
}

// "Copy" as a submenu, the Move submenu's twin: the destination picker first, then the Cloud Drive tree
// for copying in one pick. Unlike a move, the source's own directory is a valid target (the copy gets
// a free name there); only the copied directories themselves and their descendants are not.
export function CopySubmenu({ family, items, disabled, title, onChooseDestination }: CopySubmenuProps) {
	const { t } = useTranslation("drive")
	// The trigger was gated when the menu opened; the connection can drop while the tree is open.
	const isOnline = useIsOnline()
	const gates = createMoveTreeGates(items, readDriveListing, "copy")
	const { Item } = family

	return (
		<DirectoryTreeSubmenu
			family={family}
			label={t(ACTION_DEFS.copy.labelKey)}
			icon={ACTION_DEFS.copy.icon}
			disabled={disabled}
			title={title}
			leading={
				<Item onClick={onChooseDestination}>
					<FolderSearchIcon aria-hidden="true" />
					{t("driveMoveChooseDestination")}
				</Item>
			}
			actionLabel={t("driveCopyHereAction")}
			actionIcon={ACTION_DEFS.copy.icon}
			isBrowseDisabled={gates.isBrowseDisabled}
			isTargetDisabled={target => !isOnline || gates.isTargetDisabled(target)}
			onSelect={target => {
				startCopyWithCard(items, { uuid: target.uuid, name: targetName(target, t("driveMyDrive")) })
			}}
		/>
	)
}

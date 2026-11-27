import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { MoreHorizontalIcon } from "lucide-react"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { DRIVE_ACTION_SHORTCUTS, type DriveActionDescriptor } from "@/features/drive/lib/selectionActions"
import { runDriveAction, type DriveDialogAction } from "@/features/drive/lib/selectionDispatch"
import { DROPDOWN_TREE_MENU_FAMILY } from "@/features/drive/components/directoryTreeSubmenu"
import { TransferMenuEntries } from "@/features/drive/components/transferSubmenu"
import { BulkExtractMenuEntries, CompressMenuEntries, ExtractMenuEntries } from "@/features/drive/components/archiveSubmenus"
import { DownloadAsEntries } from "@/features/drive/components/downloadAsSubmenu"
import { DriveActionMenuEntries, type ItemDestination } from "@/features/drive/components/itemMenu"
import { useDriveMenuActions } from "@/features/drive/hooks/useDriveMenuActions"
import { DriveDetailsToggle } from "@/features/drive/components/detailsPanel"
import { BulkActionButton, BulkActionMenuButton, MenuShortcut, SelectionActionBar } from "@/components/selectionActionBar"

export interface BulkActionBarProps {
	variant: DriveVariant
	selectedItems: DriveItem[]
	onDialogAction: DriveDialogAction
	// One item only, as its row's menu has them: its open, whether it is a cross-directory search hit, and its directory's
	// create/upload host.
	onOpen: (item: DriveItem) => void
	searchHit: (item: DriveItem) => boolean
	destination: (item: DriveItem) => ItemDestination
}

// What the overflow menu holds: everything not pinned, or the one submenu a key opened it on.
type OverflowContent = "all" | "compress" | "extract" | "downloadAs"

const OVERFLOW_KEYS = ["compress", "extract", "downloadAs"] as const

// Floating selection bar (directoryListing.tsx portals it into the shell's window bar slot while a selection exists):
// the selection's menu, exactly as a right-click on it lists it. The pinned entries are buttons on the bar's face (Move
// and Copy open their transfer menus), the rest sit in its ⋯ menu, submenus included.
export function BulkActionBar({ variant, selectedItems, onDialogAction, onOpen, searchHit, destination }: BulkActionBarProps) {
	const { t } = useTranslation(["drive", "common"])
	const navigate = useNavigate()
	const [overflowOpen, setOverflowOpen] = useState(false)
	const [overflowContent, setOverflowContent] = useState<OverflowContent>("all")
	const [only] = selectedItems
	const single = selectedItems.length === 1 ? only : undefined
	const menuProps = {
		items: selectedItems,
		variant,
		onDialogAction,
		searchHit: single !== undefined && searchHit(single),
		onOpen:
			single === undefined
				? undefined
				: () => {
						onOpen(single)
					},
		destination: single === undefined ? undefined : destination(single),
		shortcuts: DRIVE_ACTION_SHORTCUTS
	}
	const descriptors = useDriveMenuActions(menuProps)
	const pinned = descriptors.filter(descriptor => descriptor.pinned === true)
	const overflow = descriptors.filter(descriptor => descriptor.pinned !== true)

	function reasonOf(descriptor: DriveActionDescriptor): string | undefined {
		return descriptor.enabled === false && descriptor.disabledReasonKey !== undefined ? t(descriptor.disabledReasonKey) : undefined
	}

	function openOverflow(content: OverflowContent): void {
		setOverflowContent(content)
		setOverflowOpen(true)
	}

	function overflowEntries() {
		switch (overflowContent) {
			case "compress":
				return (
					<CompressMenuEntries
						family={DROPDOWN_TREE_MENU_FAMILY}
						items={selectedItems}
						variant={variant}
						onMoreOptions={() => {
							onDialogAction("compress", selectedItems)
						}}
					/>
				)
			case "extract":
				return single !== undefined ? (
					<ExtractMenuEntries
						family={DROPDOWN_TREE_MENU_FAMILY}
						item={single}
						variant={variant}
						onChooseDestination={startPath => {
							onDialogAction("extractTo", selectedItems, startPath)
						}}
						onOptions={() => {
							onDialogAction("extract", selectedItems)
						}}
						onBrowse={menuProps.onOpen}
					/>
				) : (
					<BulkExtractMenuEntries
						family={DROPDOWN_TREE_MENU_FAMILY}
						items={selectedItems}
						variant={variant}
						onChooseDestination={startPath => {
							onDialogAction("extractTo", selectedItems, startPath)
						}}
					/>
				)
			case "downloadAs":
				return (
					<DownloadAsEntries
						family={DROPDOWN_TREE_MENU_FAMILY}
						items={selectedItems}
					/>
				)
			case "all":
				return (
					<DriveActionMenuEntries
						{...menuProps}
						descriptors={overflow}
						family={DROPDOWN_TREE_MENU_FAMILY}
					/>
				)
		}
	}

	return (
		<SelectionActionBar
			count={selectedItems.length}
			clearKbdAction="drive.clearSelection"
			onClear={() => {
				useDriveStore.getState().clearSelectedItems()
			}}
		>
			{pinned.map(descriptor =>
				descriptor.id === "move" || descriptor.id === "copy" ? (
					// Open offline too, for their clipboard entries; their keys open the destination picker (the listing's).
					<BulkActionMenuButton
						key={descriptor.id}
						icon={descriptor.icon}
						label={t(descriptor.labelKey)}
						kbdAction={descriptor.kbdAction}
						kbdOpensMenu={false}
					>
						<TransferMenuEntries
							mode={descriptor.id}
							family={DROPDOWN_TREE_MENU_FAMILY}
							items={selectedItems}
							onChooseDestination={(mode, startPath) => {
								onDialogAction(mode, selectedItems, startPath)
							}}
							destinationShortcut={descriptor.kbdAction}
						/>
					</BulkActionMenuButton>
				) : (
					<BulkActionButton
						key={descriptor.id}
						icon={descriptor.icon}
						label={t(descriptor.labelKey)}
						destructive={descriptor.destructive}
						disabled={descriptor.enabled === false}
						disabledReason={reasonOf(descriptor)}
						kbdAction={descriptor.kbdAction}
						onClick={() => {
							runDriveAction(descriptor, selectedItems, {
								variant,
								onDialogAction,
								navigate: target => {
									void navigate(target)
								}
							})
						}}
					/>
				)
			)}
			{overflow.length > 0 ? (
				<BulkActionMenuButton
					icon={MoreHorizontalIcon}
					label={t("driveItemMenuTrigger")}
					open={overflowOpen}
					onOpenChange={next => {
						// The trigger opens the whole list; a key opens it on its own submenu (openOverflow).
						if (next) {
							setOverflowContent("all")
						}

						setOverflowOpen(next)
					}}
				>
					{overflowEntries()}
				</BulkActionMenuButton>
			) : null}
			<DriveDetailsToggle />
			{/* The keys of the submenus the menus list, opening their entries from the bar as before. */}
			{OVERFLOW_KEYS.map(id => {
				const descriptor = overflow.find(candidate => candidate.id === id)

				return descriptor?.kbdAction === undefined || descriptor.enabled === false ? null : (
					<MenuShortcut
						key={id}
						action={descriptor.kbdAction}
						onPress={() => {
							openOverflow(id)
						}}
					/>
				)
			})}
		</SelectionActionBar>
	)
}

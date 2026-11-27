import { createElement, Fragment } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { driveItemName } from "@filen/shared"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { type ParentNaming } from "@/features/drive/lib/archiveTargets"
import { useDriveMenuActions } from "@/features/drive/hooks/useDriveMenuActions"
import {
	canWriteIntoItem,
	separatorBefore,
	type DriveActionDescriptor,
	type DriveActionId,
	type DriveActionShortcuts
} from "@/features/drive/lib/selectionActions"
import { runDriveAction, type DriveDialogAction } from "@/features/drive/lib/selectionDispatch"
import {
	CONTEXT_TREE_MENU_FAMILY,
	DROPDOWN_TREE_MENU_FAMILY,
	type DirectoryTreeMenuFamily
} from "@/features/drive/components/directoryTreeSubmenu"
import { TransferSubmenu } from "@/features/drive/components/transferSubmenu"
import { BulkExtractSubmenu, CompressSubmenu, ExtractSubmenu } from "@/features/drive/components/archiveSubmenus"
import { DownloadAsSubmenu } from "@/features/drive/components/downloadAsSubmenu"
import { AddToPlaylistSubmenu } from "@/features/drive/components/addToPlaylistSubmenu"
import { DirectoryDestinationEntries, type DestinationActions } from "@/features/drive/components/destinationMenu"
import { ContextMenuContent } from "@/components/ui/context-menu"
import { DropdownMenuContent } from "@/components/ui/dropdown-menu"
import { MenuKbd } from "@/lib/keymap/kbdHints"

export interface DriveActionMenuProps {
	// One item for its own menu, the selection for a right-click inside it or the selection bar.
	items: DriveItem[]
	variant: DriveVariant
	// Every "dialog" entry, on these items — the surface's dialog host turns it into an open dialog.
	onDialogAction: DriveDialogAction
	// For a surface whose items live outside the drive listings: the preview overlay (its own per-slot
	// item override map) and photos (its own listing cache) need the updated item the instant a
	// favorite or restore of one item resolves.
	onFavoriteToggled?: ((item: DriveItem) => void) | undefined
	onRestored?: ((item: DriveItem) => void) | undefined
	// Ids to omit — the preview drops "download" (its header has its own button), photos drops "move".
	hiddenActionIds?: ReadonlySet<DriveActionId> | undefined
	// The Compress presets' directory names where a surface knows its own (photos).
	compressParentNaming?: ParentNaming | undefined
	// One item only: a search hit whose parent is not the directory on screen, the only case "Open containing
	// directory" is offered for.
	searchHit?: boolean | undefined
	// One item only: the surface's own open (a row's double-click, a tree node's navigation). Present, it puts Open at the
	// top for an item that opens; the preview overlay omits it.
	onOpen?: (() => void) | undefined
	// One item only: the surface's create/upload host. Present, a directory the variant can write into gets a New submenu
	// and Paste right under Open.
	destination?: ItemDestination | undefined
	// The keys the surface's keymap runs each entry with; none where the surface has no keys for its items (the tree).
	shortcuts?: DriveActionShortcuts | undefined
}

export interface ItemDestination {
	actionsFor: (uuid: string | null) => DestinationActions
	// The directory's root-to-directory uuid chain as far as the route proves it, itself last.
	ancestry: readonly string[]
	// mod+v pastes into this directory where the menu was opened (a focused tree node), not into the
	// listing on screen (a row).
	pasteShortcut: boolean
}

// One mapping from descriptor to menu row, rendered by the right-click context menu, the ⋯ dropdown, the preview
// header and the selection bar's overflow alike. Base UI's ContextMenu and DropdownMenu are separate Root families with
// their own parts, so each caller supplies the family to render with. Move and Copy (transferSubmenu.tsx), Compress and
// Extract (archiveSubmenus.tsx), Download as and Add to playlist are submenus.
export function DriveActionMenuEntries({
	descriptors,
	family,
	items,
	variant,
	onDialogAction,
	onFavoriteToggled,
	onRestored,
	compressParentNaming,
	onOpen,
	destination,
	shortcuts
}: DriveActionMenuProps & { descriptors: readonly DriveActionDescriptor[]; family: DirectoryTreeMenuFamily }) {
	const { t } = useTranslation(["drive", "common"])
	const navigate = useNavigate()
	const { Item, Separator } = family
	const [only] = items
	const single = items.length === 1 ? only : undefined
	const writableDestination =
		single !== undefined && destination !== undefined && canWriteIntoItem(single, variant) ? destination : undefined

	function run(descriptor: DriveActionDescriptor): void {
		runDriveAction(descriptor, items, {
			variant,
			onDialogAction,
			onOpen,
			onFavoriteToggled,
			onRestored,
			navigate: target => {
				void navigate(target)
			}
		})
	}

	function entry(descriptor: DriveActionDescriptor) {
		const disabled = descriptor.enabled === false

		switch (descriptor.id) {
			// They open offline too, for their clipboard entries; each gates its own destinations.
			case "move":
			case "copy":
				return (
					<TransferSubmenu
						mode={descriptor.id}
						family={family}
						items={items}
						onChooseDestination={(mode, startPath) => {
							onDialogAction(mode, items, startPath)
						}}
						clipboardShortcut={descriptor.id === "copy" ? shortcuts?.copyToClipboard : undefined}
						destinationShortcut={descriptor.kbdAction}
					/>
				)
			case "compress":
				return (
					<CompressSubmenu
						family={family}
						disabled={disabled}
						items={items}
						variant={variant}
						parentNaming={compressParentNaming}
						onMoreOptions={() => {
							onDialogAction("compress", items)
						}}
					/>
				)
			case "downloadAs":
				return (
					<DownloadAsSubmenu
						family={family}
						disabled={disabled}
						items={items}
					/>
				)
			case "addToPlaylist":
				return (
					<AddToPlaylistSubmenu
						family={family}
						disabled={disabled}
						items={items}
						onNewPlaylist={() => {
							onDialogAction("addToNewPlaylist", items)
						}}
					/>
				)
			case "extract":
				return single !== undefined ? (
					<ExtractSubmenu
						family={family}
						disabled={disabled}
						item={single}
						variant={variant}
						onChooseDestination={startPath => {
							onDialogAction("extractTo", items, startPath)
						}}
						onOptions={() => {
							onDialogAction("extract", items)
						}}
						// An archive opens into its browser, so browsing is the surface's own Open.
						onBrowse={onOpen}
					/>
				) : (
					<BulkExtractSubmenu
						family={family}
						disabled={disabled}
						items={items}
						variant={variant}
						onChooseDestination={startPath => {
							onDialogAction("extractTo", items, startPath)
						}}
					/>
				)
			default:
				return (
					<Item
						variant={descriptor.destructive ? "destructive" : "default"}
						disabled={disabled}
						title={disabled && descriptor.disabledReasonKey !== undefined ? t(descriptor.disabledReasonKey) : undefined}
						onClick={() => {
							run(descriptor)
						}}
					>
						{createElement(descriptor.icon, { "aria-hidden": true })}
						{t(descriptor.labelKey)}
						<MenuKbd action={descriptor.kbdAction} />
					</Item>
				)
		}
	}

	return (
		<>
			{descriptors.map((descriptor, index) => (
				<Fragment key={descriptor.id}>
					{separatorBefore(descriptors, index) ? <Separator /> : null}
					{entry(descriptor)}
					{descriptor.id === "open" && single !== undefined && writableDestination !== undefined ? (
						<DirectoryDestinationEntries
							family={family}
							directory={{
								variant,
								uuid: single.data.uuid,
								ancestry: writableDestination.ancestry,
								name: driveItemName(single)
							}}
							actions={writableDestination.actionsFor(single.data.uuid)}
							pasteShortcut={writableDestination.pasteShortcut}
						/>
					) : null}
				</Fragment>
			))}
		</>
	)
}

// Right-click surface — a row's or tile's <ContextMenu> (driveRow.tsx/driveTile.tsx), inside a selection the whole
// selection's, and the sidebar tree's one menu (directoryTreeMenu.tsx). Content mounts only while open (Base UI portal),
// so the hooks cost nothing per row.
export function DriveContextMenuContent(props: DriveActionMenuProps) {
	const descriptors = useDriveMenuActions(props)

	return (
		<ContextMenuContent>
			<DriveActionMenuEntries
				{...props}
				descriptors={descriptors}
				family={CONTEXT_TREE_MENU_FAMILY}
			/>
		</ContextMenuContent>
	)
}

// ⋯ trigger surface — a row's or tile's <DropdownMenu> (driveRow.tsx/driveTile.tsx/photoTile.tsx), and the preview
// header's item menu (previewOverlay.tsx).
export function DriveDropdownMenuContent(props: DriveActionMenuProps) {
	const descriptors = useDriveMenuActions(props)

	return (
		<DropdownMenuContent align="end">
			<DriveActionMenuEntries
				{...props}
				descriptors={descriptors}
				family={DROPDOWN_TREE_MENU_FAMILY}
			/>
		</DropdownMenuContent>
	)
}

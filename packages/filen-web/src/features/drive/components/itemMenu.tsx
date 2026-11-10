import { createElement, Fragment } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { driveItemName } from "@filen/shared"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { type ParentNaming } from "@/features/drive/lib/archiveTargets"
import { restoreItems } from "@/features/drive/lib/actions"
import { toggleItemFavorite } from "@/features/drive/lib/favorite"
import { defaultRevealDeps, runOpenContainingDirectory } from "@/features/drive/lib/reveal"
import { copyItemLink } from "@/features/drive/lib/copyLink"
import { DRIVE_RESTORE, driveActivity } from "@/features/drive/lib/activity"
import { runBulkActivity } from "@/lib/activity/activity"
import { startDownloads } from "@/features/drive/lib/download"
import { useIsOnline } from "@/lib/useIsOnline"
import {
	applyOfflineGate,
	canWriteIntoItem,
	driveItemActions,
	separatorBefore,
	type ItemActionDescriptor,
	type ItemActionDialogKind,
	type ItemActionId
} from "@/features/drive/components/itemMenu.logic"
import {
	CONTEXT_TREE_MENU_FAMILY,
	DROPDOWN_TREE_MENU_FAMILY,
	type DirectoryTreeMenuFamily
} from "@/features/drive/components/directoryTreeSubmenu"
import { TransferSubmenu } from "@/features/drive/components/transferSubmenu"
import { CompressSubmenu, ExtractSubmenu } from "@/features/drive/components/archiveSubmenus"
import { DownloadAsSubmenu } from "@/features/drive/components/downloadAsSubmenu"
import { DirectoryDestinationEntries, type DestinationActions } from "@/features/drive/components/destinationMenu"
import { ContextMenuContent } from "@/components/ui/context-menu"
import { DropdownMenuContent } from "@/components/ui/dropdown-menu"

export interface ItemMenuContentProps {
	item: DriveItem
	variant: DriveVariant
	// Fires for every "dialog"-run descriptor (rename/move/color/versions/info/link/trash/delete) —
	// the listing-level dialog host (directoryListing.tsx) owns turning this into an open dialog.
	// "direct"-run descriptors (favorite/restore) never call this — they resolve fully in place below.
	onItemAction: (kind: ItemActionDialogKind, item: DriveItem) => void
	// For a surface whose items live outside the drive listings: the preview overlay (its own per-slot
	// item override map) and photos (its own listing cache) need the updated item the instant a
	// "direct" descriptor resolves.
	onFavoriteToggled?: ((item: DriveItem) => void) | undefined
	onRestored?: ((item: DriveItem) => void) | undefined
	// Descriptor ids to omit from the rendered list — the preview drops "download" (its header has its
	// own download button), photos drops "move" (photos/lib/itemActions.ts).
	hiddenActionIds?: ReadonlySet<ItemActionId> | undefined
	// The Compress presets' directory names where a surface knows its own (photos).
	compressParentNaming?: ParentNaming | undefined
	// True for a search hit whose parent is not the directory on screen — the only case
	// "Open containing directory" is offered for. Omitted by every non-listing caller.
	searchHit?: boolean | undefined
	// The surface's own open (a row's double-click, a tree node's navigation). Present, it puts Open at
	// the top for any item that opens; the preview overlay omits it.
	onOpen?: (() => void) | undefined
	// The surface's create/upload host. Present, a directory the variant can write into gets a New
	// submenu and Paste right under Open; the preview overlay omits it.
	destination?: ItemDestination | undefined
}

export interface ItemDestination {
	actionsFor: (uuid: string | null) => DestinationActions
	// The directory's root-to-directory uuid chain as far as the route proves it, itself last.
	ancestry: readonly string[]
	// mod+v pastes into this directory where the menu was opened (a focused tree node), not into the
	// listing on screen (a row).
	pasteShortcut: boolean
}

// Shared per-item action list, rendered by BOTH the right-click context menu and the ⋯ dropdown (see
// DriveContextMenuContent/DriveDropdownMenuContent below) — one descriptor list (driveItemActions),
// one mapping from descriptor to menu row. Base UI's ContextMenu and DropdownMenu are separate Root
// families with their own Item/Separator primitives (not interchangeable across triggers even though
// their props are structurally identical), so the one piece each caller supplies is which family to
// render rows with. Move and Copy (transferSubmenu.tsx), Compress and Extract (archiveSubmenus.tsx) are
// submenus that also need the family's submenu parts.
function ItemMenuEntries({
	item,
	variant,
	onItemAction,
	onFavoriteToggled,
	onRestored,
	hiddenActionIds,
	compressParentNaming,
	searchHit,
	onOpen,
	destination,
	family
}: ItemMenuContentProps & { family: DirectoryTreeMenuFamily }) {
	const { t } = useTranslation(["drive", "common"])
	const navigate = useNavigate()
	const isOnline = useIsOnline()
	const descriptors = applyOfflineGate(
		driveItemActions(item, variant, { searchHit: searchHit === true, open: onOpen !== undefined }),
		isOnline
	).filter(descriptor => !hiddenActionIds?.has(descriptor.id))
	const { Item, Separator } = family
	const writableDestination = destination !== undefined && canWriteIntoItem(item, variant) ? destination : undefined

	async function runDirect(descriptor: Extract<ItemActionDescriptor, { run: "direct" }>): Promise<void> {
		// Checked FIRST, before any `await` below — startDownloads' FSA save picker needs this
		// click's own live user gesture (see download.ts), so nothing here may yield to the event loop
		// ahead of it. disabled=false is already guaranteed by the Item's own `disabled` prop below (a
		// disabled MenuItem never fires onClick at all), so this never runs for a directory.
		if (descriptor.id === "download") {
			void startDownloads([item])
			return
		}

		if (descriptor.id === "favorite") {
			await toggleItemFavorite(item, variant, onFavoriteToggled)

			return
		}

		if (descriptor.id === "openContainingDirectory") {
			await runOpenContainingDirectory(defaultRevealDeps, item, target => {
				void navigate(target)
			})

			return
		}

		// Restore is the remaining direct id. A restored item always vanishes from the trash listing it
		// was selected in (see actions.ts), so a successful outcome also drops it from selection —
		// mirrors the dialog host's identical cleanup after a trash/delete confirm.
		await runBulkActivity(
			driveActivity([item], DRIVE_RESTORE, restoreItems, {
				onDone: outcome => {
					if (outcome.succeeded.length > 0) {
						onRestored?.(item)
					}
				}
			})
		)
	}

	// Copy-link's own dispatch — intercepted here, BEFORE the run==="dialog" branch below, since its
	// real behavior (copy straight to the clipboard when a link already exists) depends on data this
	// synchronous click handler doesn't have yet (copyItemLink, shared with drive.copyLink).
	async function runCopyLink(): Promise<void> {
		await copyItemLink(item, t("driveLinkUrlCopiedToast"), () => {
			onItemAction("link", item)
		})
	}

	return (
		<>
			{descriptors.map((descriptor, index) => (
				<Fragment key={descriptor.id}>
					{separatorBefore(descriptors, index) ? <Separator /> : null}
					{/* The Move and Copy submenus open offline too, for their clipboard entries; each gates its own
					    destinations, so their descriptors' offline flag is not applied to the trigger. */}
					{descriptor.id === "move" || descriptor.id === "copy" ? (
						<TransferSubmenu
							mode={descriptor.id}
							family={family}
							items={[item]}
							onChooseDestination={mode => {
								onItemAction(mode, item)
							}}
						/>
					) : descriptor.id === "compress" ? (
						<CompressSubmenu
							family={family}
							disabled={descriptor.enabled === false}
							items={[item]}
							variant={variant}
							parentNaming={compressParentNaming}
							onMoreOptions={() => {
								onItemAction("compress", item)
							}}
						/>
					) : descriptor.id === "downloadAs" ? (
						<DownloadAsSubmenu
							family={family}
							disabled={descriptor.enabled === false}
							items={[item]}
						/>
					) : descriptor.id === "extract" ? (
						<ExtractSubmenu
							family={family}
							disabled={descriptor.enabled === false}
							item={item}
							variant={variant}
							onChooseDestination={() => {
								onItemAction("extractTo", item)
							}}
							onOptions={() => {
								onItemAction("extract", item)
							}}
							// An archive opens into its browser, so browsing is the surface's own Open.
							onBrowse={onOpen}
						/>
					) : (
						<Item
							variant={descriptor.destructive ? "destructive" : "default"}
							disabled={descriptor.enabled === false}
							title={descriptor.enabled === false && !isOnline ? t("common:offlineActionDisabled") : undefined}
							onClick={() => {
								// Synchronous off the click, like the double-click it mirrors: audio starts
								// playback from here.
								if (descriptor.id === "open") {
									onOpen?.()
									return
								}

								if (descriptor.id === "copyLink") {
									void runCopyLink()
									return
								}

								if (descriptor.run === "direct") {
									void runDirect(descriptor)
									return
								}

								onItemAction(descriptor.dialogKind, item)
							}}
						>
							{createElement(descriptor.icon, { "aria-hidden": true })}
							{t(descriptor.labelKey)}
						</Item>
					)}
					{descriptor.id === "open" && writableDestination !== undefined ? (
						<DirectoryDestinationEntries
							family={family}
							directory={{ variant, uuid: item.data.uuid, ancestry: writableDestination.ancestry, name: driveItemName(item) }}
							actions={writableDestination.actionsFor(item.data.uuid)}
							pasteShortcut={writableDestination.pasteShortcut}
						/>
					) : null}
				</Fragment>
			))}
		</>
	)
}

// Right-click surface — rendered inside a per-row/tile <ContextMenu> (see driveRow.tsx/driveTile.tsx)
// and the sidebar tree's one menu (directoryTreeMenu.tsx), which gives a node exactly its row's menu.
export function DriveContextMenuContent({
	item,
	variant,
	onItemAction,
	onFavoriteToggled,
	onRestored,
	hiddenActionIds,
	compressParentNaming,
	searchHit,
	onOpen,
	destination
}: ItemMenuContentProps) {
	return (
		<ContextMenuContent>
			<ItemMenuEntries
				item={item}
				variant={variant}
				onItemAction={onItemAction}
				onFavoriteToggled={onFavoriteToggled}
				onRestored={onRestored}
				hiddenActionIds={hiddenActionIds}
				compressParentNaming={compressParentNaming}
				searchHit={searchHit}
				onOpen={onOpen}
				destination={destination}
				family={CONTEXT_TREE_MENU_FAMILY}
			/>
		</ContextMenuContent>
	)
}

// ⋯ trigger surface — rendered inside a per-row/tile <DropdownMenu> (see driveRow.tsx/driveTile.tsx/
// photoTile.tsx), and by the preview header's own item menu (previewOverlay.tsx).
export function DriveDropdownMenuContent({
	item,
	variant,
	onItemAction,
	onFavoriteToggled,
	onRestored,
	hiddenActionIds,
	compressParentNaming,
	searchHit,
	onOpen,
	destination
}: ItemMenuContentProps) {
	return (
		<DropdownMenuContent align="end">
			<ItemMenuEntries
				item={item}
				variant={variant}
				onItemAction={onItemAction}
				onFavoriteToggled={onFavoriteToggled}
				onRestored={onRestored}
				hiddenActionIds={hiddenActionIds}
				compressParentNaming={compressParentNaming}
				searchHit={searchHit}
				onOpen={onOpen}
				destination={destination}
				family={DROPDOWN_TREE_MENU_FAMILY}
			/>
		</DropdownMenuContent>
	)
}

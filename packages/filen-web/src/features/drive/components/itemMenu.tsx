import { createElement, Fragment } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { toggleFavorite, restoreItems } from "@/features/drive/lib/actions"
import { driveItemLinkStatusQueryKey, fetchDriveItemLinkStatus } from "@/features/drive/queries/drive"
import { queryClient } from "@/queries/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { toastBulkOutcome } from "@/features/drive/lib/bulkToast"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { useIsOnline } from "@/lib/useIsOnline"
import {
	applyOfflineGate,
	driveItemActions,
	resolveCopyLinkAction,
	startItemDownload,
	type ItemActionDescriptor,
	type ItemActionDialogKind,
	type ItemActionId
} from "@/features/drive/components/itemMenu.logic"
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu"
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"

export interface ItemMenuContentProps {
	item: DriveItem
	variant: DriveVariant
	// Fires for every "dialog"-run descriptor (rename/move/color/versions/info/link/trash/delete) —
	// the listing-level dialog host (directoryListing.tsx) owns turning this into an open dialog.
	// "direct"-run descriptors (favorite/restore) never call this — they resolve fully in place below.
	onItemAction: (kind: ItemActionDialogKind, item: DriveItem) => void
	// Preview-only extension points (both omitted by every row/tile caller — current behavior there is
	// unchanged). The preview overlay keeps its own per-slot item override map instead of relying on a
	// listing refetch, so it needs the updated item the instant a "direct" descriptor resolves.
	onFavoriteToggled?: ((item: DriveItem) => void) | undefined
	onRestored?: ((item: DriveItem) => void) | undefined
	// Preview-only: descriptor ids to omit from the rendered list — the preview drops "download" since
	// its header already has its own dedicated download button (previewOverlay.tsx).
	hiddenActionIds?: ReadonlySet<ItemActionId> | undefined
}

interface MenuItemFamily {
	Item: typeof DropdownMenuItem
	Separator: typeof DropdownMenuSeparator
}

// Groups the flat descriptor list for readability: a rule before the reference/reveal action (info)
// and before whichever removal action closes the list (trash in the normal menu, deletePermanently in
// the trash/undecryptable-reduced menus) — a pure presentation concern the gating builder itself
// shouldn't own.
const SEPARATOR_BEFORE = new Set<ItemActionId>(["info", "trash", "deletePermanently"])

// Shared per-item action list, rendered by BOTH the right-click context menu and the ⋯ dropdown (see
// DriveContextMenuContent/DriveDropdownMenuContent below) — one descriptor list (driveItemActions),
// one mapping from descriptor to menu row. Base UI's ContextMenu and DropdownMenu are separate Root
// families with their own Item/Separator primitives (not interchangeable across triggers even though
// their props are structurally identical), so the one piece each caller supplies is which family to
// render rows with.
function ItemMenuEntries({
	item,
	variant,
	onItemAction,
	onFavoriteToggled,
	onRestored,
	hiddenActionIds,
	family
}: ItemMenuContentProps & { family: MenuItemFamily }) {
	const { t } = useTranslation(["drive", "common"])
	const isOnline = useIsOnline()
	const descriptors = applyOfflineGate(driveItemActions(item, variant), isOnline).filter(
		descriptor => !hiddenActionIds?.has(descriptor.id)
	)
	const { Item, Separator } = family

	async function runDirect(descriptor: Extract<ItemActionDescriptor, { run: "direct" }>): Promise<void> {
		// Checked FIRST, before any `await` below — startItemDownload's FSA save picker needs this
		// click's own live user gesture (see download.ts), so nothing here may yield to the event loop
		// ahead of it. disabled=false is already guaranteed by the Item's own `disabled` prop below (a
		// disabled MenuItem never fires onClick at all), so this never runs for a directory.
		if (descriptor.id === "download") {
			startItemDownload(item)
			return
		}

		if (descriptor.id === "favorite") {
			const outcome = await toggleFavorite(item)

			if (outcome.status === "error") {
				toast.error(errorLabel(outcome.dto))
				return
			}

			// Unfavoriting while the favorites listing is open drops the row from that listing (cache
			// patch in actions.ts) — mirrors the restore/trash cleanup below so its uuid doesn't linger
			// in the selection store as a ghost "N selected" count. Favoriting-ON and any non-favorites
			// variant leave the item visible, so selection is left untouched in both of those cases.
			if (variant === "favorites" && !outcome.item.data.favorited) {
				useDriveStore.getState().removeFromSelection([outcome.item.data.uuid])
			}

			onFavoriteToggled?.(outcome.item)

			return
		}

		// "favorite" and "restore" are the only ids the builder ever marks "direct" — restore is the
		// remaining case. A restored item always vanishes from the trash listing it was selected in
		// (see actions.ts), so a successful outcome also drops it from selection — mirrors
		// directoryListing.tsx's identical cleanup after a trash/delete confirm.
		const outcome = await restoreItems([item])
		toastBulkOutcome(outcome)
		useDriveStore.getState().removeFromSelection(outcome.succeeded.map(succeededItem => succeededItem.data.uuid))

		if (outcome.succeeded.some(succeededItem => succeededItem.data.uuid === item.data.uuid)) {
			onRestored?.(item)
		}
	}

	// Copy-link's own dispatch — intercepted here, BEFORE the run==="dialog" branch below, since its
	// real behavior (copy straight to the clipboard when a link already exists) depends on data this
	// synchronous click handler doesn't have yet. `ensureQueryData` reuses the link dialog's own cache
	// entry (same query key) rather than always re-fetching — opening the dialog moments earlier for
	// this same item already primed it. A free-tier account can never have an existing link (public
	// links are premium-only), so `status` naturally resolves null there too — no separate premium
	// check needed, it degrades to `onItemAction("link", item)` exactly like an item with no link at
	// all, which is where the dialog's own subscription gate lives (see linkDialog.tsx).
	async function runCopyLink(): Promise<void> {
		const status = await queryClient.ensureQueryData({
			queryKey: driveItemLinkStatusQueryKey(item.data.uuid),
			queryFn: () => fetchDriveItemLinkStatus(item)
		})
		const outcome = await resolveCopyLinkAction(item, status, url => navigator.clipboard.writeText(url))

		if (outcome.action === "copied") {
			toast.success(t("driveLinkUrlCopiedToast"))
			return
		}

		if (outcome.action === "clipboardError") {
			toast.error(errorLabel(asErrorDTO(outcome.error)))
			return
		}

		onItemAction("link", item)
	}

	return (
		<>
			{descriptors.map((descriptor, index) => (
				<Fragment key={descriptor.id}>
					{index > 0 && SEPARATOR_BEFORE.has(descriptor.id) ? <Separator /> : null}
					<Item
						variant={descriptor.destructive ? "destructive" : "default"}
						disabled={descriptor.enabled === false}
						title={descriptor.enabled === false && !isOnline ? t("common:offlineActionDisabled") : undefined}
						onClick={event => {
							// The ⋯ dropdown is mounted as a React descendant of the row's own clickable div
							// (needed so the trigger button sits visually inside the row) — Base UI's MenuItem
							// itself never stops propagation, and a portaled popup's synthetic events still
							// bubble through the REACT tree (not the DOM tree), so without this an item click
							// would also fire the row's onClick and reselect it.
							event.stopPropagation()

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
				</Fragment>
			))}
		</>
	)
}

// Right-click surface — rendered inside a per-row/tile <ContextMenu> (see driveRow.tsx/driveTile.tsx).
export function DriveContextMenuContent({
	item,
	variant,
	onItemAction,
	onFavoriteToggled,
	onRestored,
	hiddenActionIds
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
				family={{ Item: ContextMenuItem, Separator: ContextMenuSeparator }}
			/>
		</ContextMenuContent>
	)
}

// ⋯ trigger surface — rendered inside a per-row/tile <DropdownMenu> (see driveRow.tsx/driveTile.tsx),
// and by the preview header's own item menu (previewOverlay.tsx).
export function DriveDropdownMenuContent({
	item,
	variant,
	onItemAction,
	onFavoriteToggled,
	onRestored,
	hiddenActionIds
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
				family={{ Item: DropdownMenuItem, Separator: DropdownMenuSeparator }}
			/>
		</DropdownMenuContent>
	)
}

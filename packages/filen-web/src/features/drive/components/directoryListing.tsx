import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { useShallow } from "zustand/shallow"
import { CircleAlertIcon, EyeOffIcon } from "lucide-react"
import {
	resolveEffectiveSort,
	resolveEffectiveViewMode,
	withSortSelection,
	withSortCleared,
	withViewModeSelection,
	setSortPreferences,
	setViewModePreferences,
	setHideHiddenItems,
	isSortableVariant,
	canWriteVariant,
	DEFAULT_SORT_PREFERENCES,
	DEFAULT_VIEW_MODE_PREFERENCES,
	DEFAULT_HIDE_HIDDEN_ITEMS,
	getPerDirectoryKey,
	type DriveVariant,
	type DriveLocation,
	type DriveViewMode
} from "@/features/drive/lib/preferences"
import { hiddenFilterAppliesTo } from "@/features/drive/lib/hiddenItems"
import { type DriveSortBy } from "@/features/drive/lib/sort"
import { resolveDriveNavigationTarget, splatToUuids } from "@/features/drive/lib/navigate"
import { isDirectoryItem, type DriveItem } from "@/features/drive/lib/item"
import { previewableSiblings } from "@/features/drive/lib/preview.logic"
import { aggregateDriveSelectionFlags, selectableForSelectAll } from "@/features/drive/lib/selectionFlags"
import { driveRowKey } from "@/features/drive/lib/rowKey"
import { deriveAudioHandoff, isAudioItem } from "@/features/audio/lib/handoff"
import { audioEngine } from "@/features/audio/lib/audioEngine"
import { startDownloads } from "@/features/drive/lib/download"
import {
	useDirectoryListingQuery,
	useHideHiddenItemsPreferenceQuery,
	useSortPreferencesQuery,
	useViewModePreferencesQuery
} from "@/features/drive/queries/drive"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { GRID_INSET, ROW_HEIGHT, TILE_ROW_HEIGHT, TILE_WIDTH } from "@/features/drive/lib/gridLayout"
import { isAnyDialogOpen, isAnyMenuOpen } from "@/lib/keymap/dialogGuard"
import { asErrorDTO } from "@/lib/sdk/errors"
import { useAction } from "@/lib/keymap/useAction"
import { useBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import { canOpenItem, driveItemActions } from "@/features/drive/components/itemMenu.logic"
import { driveBulkActions, isBulkDownloadEnabled } from "@/features/drive/components/bulkActionBar.logic"
import {
	filterDriveItemsByLocalSearch,
	filterSharedInByBlocked,
	isBlockingListingError,
	isEmptyTrashTriggerVisible,
	isVisibleSharedInItem,
	reconcileSelectedItems,
	resolveListingDisplayItems
} from "@/features/drive/components/directoryListing.logic"
import { Breadcrumb } from "@/features/drive/components/breadcrumb"
import { SortMenu } from "@/features/drive/components/sortMenu"
import { ListColumnHeader } from "@/features/drive/components/listColumnHeader"
import { ViewModeToggle } from "@/features/drive/components/viewModeToggle"
import { NewDirectory } from "@/features/drive/components/newDirectory"
import { EmptyTrashButton } from "@/features/drive/components/emptyTrashButton"
import { UploadContextMenu, UploadMenu } from "@/features/drive/components/uploadMenu"
import { UploadDropzone } from "@/features/drive/components/uploadDropzone"
import { BulkActionBar } from "@/features/drive/components/bulkActionBar"
import { EmptyState } from "@/features/drive/components/emptyState"
import { LoadingState } from "@/components/loadingState"
import { DriveRow } from "@/features/drive/components/driveRow"
import { DriveTile } from "@/features/drive/components/driveTile"
import { SearchInput } from "@/features/drive/components/searchInput"
import { useDriveSearch } from "@/features/drive/hooks/useDriveSearch"
import { searchHitNavigationTarget } from "@/features/drive/hooks/useDriveSearch.logic"
import { isSearchConverging } from "@/features/drive/lib/searchStatus.logic"
import { useDriveVirtualizer } from "@/features/drive/hooks/useDriveVirtualizer"
import { useDriveDirectorySizes } from "@/features/drive/hooks/useDriveDirectorySizes"
import { useDriveListboxNav } from "@/features/drive/hooks/useDriveListboxNav"
import { useMarqueeSelection } from "@/features/drive/hooks/useMarqueeSelection"
import { MarqueeRect } from "@/features/drive/components/marqueeRect"
import { useClickAwayDeselect } from "@/features/drive/hooks/useClickAwayDeselect"
import { useDriveDialogHost } from "@/features/drive/hooks/useDriveDialogHost"
import { useDriveClipboard } from "@/features/drive/hooks/useDriveClipboard"
import { useDirectoryDestination } from "@/features/drive/hooks/useDirectoryDestination"
import { useIsOnline } from "@/lib/useIsOnline"
import { Spinner } from "@/components/ui/spinner"
import { EmptyMessage, NoResultsMessage } from "@/components/emptyMessage"
import { reroutedRoute, subscribeBranchChanges } from "@/features/drive/lib/branchChanges"
import { cachedOwnParents } from "@/features/drive/lib/ownAncestry"
import { canDragVariant } from "@/features/drive/lib/dnd.logic"
import { ListingDropSurface } from "@/features/drive/components/listingDropSurface"

// Grid-view inset between the tiles and the pane's edges. A CSS padding on the listbox, not a
// virtualizer padding, because the marquee reads the listbox's computed paddings for its hit math.
const GRID_LISTBOX_STYLE = { padding: GRID_INSET }

const EMPTY_LISTING: DriveItem[] = []

// Stable identity so a disabled/empty directorySizes read never re-triggers row renders — module scope,
// not recreated per render (a fresh `new Map()` every render would defeat DriveRow's memoization).
const EMPTY_DIRECTORY_SIZES: ReadonlyMap<string, number> = new Map()

export interface DirectoryListingProps {
	variant: DriveVariant
	// The full "/drive/$" splat path ("" for root, else a "/"-joined ancestor-uuid chain) — recents/
	// favorites/trash pass "" (they're flat, never nested). The current directory is the last segment.
	splat: string
}

// Every drive route (drive.$.tsx, recents/favorites/trash.tsx) renders this one container with its
// own {variant,splat} — the single place the placeholder body is swapped for the real virtualized
// list, so no route needs to change again when it does. The current directory's own uuid is always
// the splat's last segment (null at the root, where the splat is empty).
export function DirectoryListing({ variant, splat }: DirectoryListingProps) {
	// Kept out of the React Compiler: the TanStack virtualizers reached through useDriveVirtualizer return
	// one mutable instance, so row JSX memoized on it would go stale on scroll. The listing re-renders as it
	// scrolls and on every cursor move and marquee frame, so its derivations below are memoized by hand.
	"use no memo"

	const { t } = useTranslation(["drive", "common"])
	const navigate = useNavigate()
	// The full ancestor-uuid chain, current directory last. Also handed to the listing query as the
	// shared variants' cold-worker resolution hint (see fetchSharedListing).
	const pathUuids = splatToUuids(splat)
	const uuid = pathUuids.at(-1) ?? null
	const driveLocation: DriveLocation = { variant, uuid }

	const listingQuery = useDirectoryListingQuery(variant, uuid, pathUuids)
	const sortPrefsQuery = useSortPreferencesQuery()
	const viewModePrefsQuery = useViewModePreferencesQuery()
	const hiddenPrefQuery = useHideHiddenItemsPreferenceQuery()
	const isOnline = useIsOnline()
	// Rows on screen, whether from a successful fetch or kept through a failed background refetch (which
	// leaves status "error" with its data, and the listing keeps rendering it). A still-loading or
	// never-loaded listing has none.
	const listingReady = listingQuery.data !== undefined
	// New directory / upload make sense in the navigable "drive" variant AND inside an owned nested
	// sharedOut directory (canWriteVariant) — recents/favorites/trash/links/sharedIn/the sharedOut ROOT
	// have no directory to write into, and a still-loading listing has no confirmed uuid to target yet.
	// Shared by NewDirectory, UploadMenu and UploadDropzone below (all three write into the same
	// `uuid`). Offline folds in here too: all three write to the SDK, which has nothing to reach while
	// offline.
	const writeDisabled = !canWriteVariant(variant, uuid) || !listingReady || !isOnline
	// Gates the underlying contacts/blocked fetch itself (see useBlockedUsers.ts) — only sharedIn
	// filters by it, so the other 5 variants skip the getContacts/getBlockedContacts worker round trip
	// on every mount and window refocus.
	const blocked = useBlockedUsers(variant === "sharedIn")

	const sortPrefs = sortPrefsQuery.data ?? DEFAULT_SORT_PREFERENCES
	const viewModePrefs = viewModePrefsQuery.data ?? DEFAULT_VIEW_MODE_PREFERENCES
	const effectiveSort = resolveEffectiveSort(sortPrefs, driveLocation)
	const effectiveViewMode = resolveEffectiveViewMode(viewModePrefs, driveLocation)
	// The stored polarity is HIDE (mobile parity); the Display menu below phrases it as SHOW, and this
	// is the single inversion site. The preference resolves async, so the first frames of a mount
	// render the default (show everything) and then hide — the same first-paint behavior the sort and
	// view-mode preferences already have on this screen.
	const hiddenPref = hiddenPrefQuery.data ?? DEFAULT_HIDE_HIDDEN_ITEMS
	const hiddenFilterApplies = hiddenFilterAppliesTo(variant)
	const hideHidden = hiddenPref && hiddenFilterApplies

	// sharedIn ONLY: hide items shared by a blocked user (fail-open — see directoryListing.logic.ts).
	// Every other variant's listing data passes straight through, untouched.
	const visibleItems = useMemo(
		() =>
			variant === "sharedIn"
				? filterSharedInByBlocked(listingQuery.data ?? EMPTY_LISTING, blocked)
				: (listingQuery.data ?? EMPTY_LISTING),
		[variant, listingQuery.data, blocked]
	)
	// Subtree search rooted at the CURRENT directory (uuid), gated to the "drive" variant — recents/
	// favorites/trash/shared have no navigable subtree of their own for it to search. While active,
	// search results stand in for the normal listing query everywhere below: selection, the listbox's
	// keyboard nav, context menus, the bulk bar, and preview siblings all read `sortedItems` alone, so
	// swapping its one source here is what makes every one of them inherited for free.
	const search = useDriveSearch(uuid, variant === "drive")

	// Local-substring fallback for every non-"drive" variant (favorites/recents/trash/sharedIn/
	// sharedOut/links) — those have no navigable subtree of their own for the cache-backed engine above,
	// so they get an instant, already-loaded-only name filter instead (filterDriveItemsByLocalSearch's
	// own doc comment). Reset whenever the listing itself changes (variant or the current directory) —
	// mirrors useDriveSearch's own root/enabled reset, so a stale query never survives a navigation into
	// a sibling sharedIn/sharedOut folder. Reset IN RENDER (react.dev's "adjusting state when a prop
	// changes" pattern), not a useEffect — a synchronous setState inside an effect body is a React
	// Compiler lint error (cascading-render risk) here, and this needs no external system either way.
	const listingKey = getPerDirectoryKey(driveLocation)
	const [localFilter, setLocalFilter] = useState("")
	const [localFilterListingKey, setLocalFilterListingKey] = useState(listingKey)

	if (listingKey !== localFilterListingKey) {
		setLocalFilterListingKey(listingKey)
		setLocalFilter("")
	}

	const localSearchActive = variant !== "drive" && localFilter.trim().length > 0
	const locallyFilteredItems = useMemo(
		() => (variant === "drive" ? visibleItems : filterDriveItemsByLocalSearch(visibleItems, localFilter)),
		[variant, visibleItems, localFilter]
	)
	const sourceItems = search.active ? search.results : locallyFilteredItems

	// Threaded ONCE here (not per-row — see driveRow.tsx's own comment) and read down into every row's
	// size column AND the size sort below. Fed the PRE-sort item set (uuid-keyed, order-independent —
	// see useDriveDirectorySizes.logic.ts), not sortedItems: sortedItems below depends on this map, so
	// feeding it sortedItems would be circular. Gated to list view: DriveTile shows no size at all
	// (mirrors filen-mobile's grid item, which never mounts a size query either), so prefetching while
	// the grid is showing would pay for recursive server-side size walks nothing on screen reads. Search
	// hits span the whole subtree, so they show the sizes already cached and warm none.
	const directorySizes =
		useDriveDirectorySizes({ items: sourceItems, enabled: effectiveViewMode === "list", prefetch: !search.active }) ??
		EMPTY_DIRECTORY_SIZES
	// Order is resolved BEFORE anything is hidden (see resolveListingDisplayItems) — everything
	// downstream keeps reading `sortedItems` and now sees the post-hide set.
	const display = useMemo(
		() =>
			resolveListingDisplayItems({
				items: sourceItems,
				sortBy: effectiveSort,
				directorySizes,
				hide: hideHidden,
				...(search.active ? { search: { total: search.total, parentPaths: search.parentPaths } } : {})
			}),
		[sourceItems, effectiveSort, directorySizes, hideHidden, search.active, search.total, search.parentPaths]
	)
	const sortedItems = display.items
	const hiddenCount = display.hiddenCount
	const resolvedCount = display.resolvedCount

	const selectedItems = useDriveStore(useShallow(state => state.selectedItems))
	// Bulk consumers (the dialog host, the floating bulk bar, the menus and the clipboard below) always
	// read the freshest metadata for a still-selected row or search hit, not the possibly-stale object
	// captured at select time: writes and socket events replace a row in its listing, never in the
	// selection — see reconcileSelectedItems' own doc comment. Against the listing's unfiltered rows, so a
	// row the local filter hides is kept current too.
	const reconciledSelectedItems = useMemo(
		() => reconcileSelectedItems(selectedItems, search.active ? search.results : visibleItems),
		[selectedItems, search.active, search.results, visibleItems]
	)
	// Each row/tile's membership check is an O(1) `.has()` instead of an O(selected) `.some()` — select-all
	// in a large directory would otherwise make every render O(visible * selected). Keyed by row, so one
	// Shared by me receiver's row being selected never highlights another receiver's.
	const selectedRowKeys = useMemo(() => new Set(selectedItems.map(driveRowKey)), [selectedItems])

	const { isDialogOpen, handleItemAction, handleBulkDialogAction, handleEmptyTrash, openPreview, renderActiveDialog } =
		useDriveDialogHost({
			variant,
			selectedItems: reconciledSelectedItems,
			hiddenNoticeApplies: hideHidden
		})

	// What the empty-space menu and every directory row's New submenu create or upload into. Only offline
	// disables its pickers: the current directory may not be writable while its rows are (a sharedOut
	// root), and each menu gates its own entries.
	const destination = useDirectoryDestination({
		disabled: !isOnline,
		openPreview,
		hiddenNotice: hideHidden,
		testIdPrefix: "drive-listing-upload"
	})

	const { setScrollElement, scrollElement, columns, listVirtualizer, gridVirtualizer, activeVirtualizer, registerRef, itemRefs } =
		useDriveVirtualizer(sortedItems, effectiveViewMode)

	function handleOpen(index: number) {
		const item = sortedItems[index]

		// The same gate the item menu's Open is offered by: a file without a preview, an undecryptable or
		// trashed directory and a trashed audio file all open to nothing.
		if (!item || !canOpenItem(item, variant)) {
			return
		}

		// A file opens the preview overlay; a directory falls through to the navigation path below.
		if (!isDirectoryItem(item)) {
			// Drive-hosted audio hands off to the persistent player instead of the preview overlay: opening
			// one audio file enqueues the folder's audio siblings (in this listing's current sort order,
			// positioned at the opened track) and starts playback. A trashed/undecryptable track stays
			// non-playable, like mobile — canOpenItem already turned those away, and deriveAudioHandoff
			// agrees (audio never opens the overlay, whose pager already excludes it via previewableSiblings).
			if (isAudioItem(item)) {
				const handoff = deriveAudioHandoff(sortedItems, item.data.uuid, variant === "trash")

				if (handoff) {
					void audioEngine.enqueueAndPlay(handoff.tracks, handoff.startIndex)
				}

				return
			}

			const siblings = previewableSiblings(sortedItems)
			const siblingIndex = siblings.findIndex(sibling => sibling.data.uuid === item.data.uuid)

			openPreview(siblings, siblingIndex === -1 ? 0 : siblingIndex)

			return
		}

		// A search hit is found via a subtree search rooted at the CURRENT directory, but the hit itself
		// can be anywhere under it — searchHitNavigationTarget rebuilds a fresh, root-relative target
		// from the hit's own uuid (never appended to `splat`); the in-place open below stays unchanged
		// for the normal (non-search) listing.
		const target = search.active ? searchHitNavigationTarget(item, variant) : resolveDriveNavigationTarget(item, variant, splat)

		if (target) {
			void navigate(target)

			// Old-web parity: opening a directory hit always leaves search (the destination is a normal
			// listing, not another search).
			if (search.active) {
				search.clear()
			}
		}
	}

	const { safeActiveIndex, handleKeyDown, handlePointerSelect, setCursor } = useDriveListboxNav({
		items: sortedItems,
		viewMode: effectiveViewMode,
		columns,
		virtualizer: activeVirtualizer,
		itemRefs,
		variant,
		splat,
		onOpen: handleOpen
	})

	// Rubber-band selection over blank listbox space (list + grid). Owns its own pointer/keyboard/rAF
	// listeners; renders the rectangle returned below inside the scrolled content layer.
	const marquee = useMarqueeSelection({
		items: sortedItems,
		keyOf: driveRowKey,
		viewMode: effectiveViewMode,
		columns,
		geometry: {
			rowHeight: effectiveViewMode === "list" ? ROW_HEIGHT : TILE_ROW_HEIGHT,
			tileWidth: TILE_WIDTH
		},
		selection: {
			read: () => useDriveStore.getState().selectedItems,
			write: items => {
				useDriveStore.getState().setSelectedItems(items)
			}
		},
		scrollElement,
		setCursor
	})

	function clearSelection(): void {
		useDriveStore.getState().clearSelectedItems()
	}

	// A plain click on empty space anywhere in the window drops the selection, as in a file manager.
	useClickAwayDeselect(selectedItems.length > 0, clearSelection)

	// A directory on the route moved or went to the trash (from the sidebar tree, or on another device):
	// the route follows it rather than keep naming a chain that no longer exists. Only My Drive and Shared
	// by me routes are chains of the user's own directories (reroutedRoute).
	useEffect(() => {
		if (variant !== "drive" && variant !== "sharedOut") {
			return
		}

		const path = splatToUuids(splat)

		return subscribeBranchChanges(change => {
			const next = reroutedRoute(variant, path, change, cachedOwnParents)

			if (next === null) {
				return
			}

			const params = { _splat: next.path.join("/") }

			if (next.to === "/drive/$") {
				void navigate({ to: "/drive/$", params, replace: true })
			} else {
				void navigate({ to: "/shared-out/$", params, replace: true })
			}
		})
	}, [variant, splat, navigate])

	// Stale-selection purge (sharedIn only): drops any selected item that just became blocked (the
	// user blocked its sharer while viewing this listing) so the bulk bar can never target a
	// now-hidden item. Fail-open, same predicate as the display filter above — an item whose sharer
	// identity doesn't resolve is never purged.
	useEffect(() => {
		if (variant !== "sharedIn") {
			return
		}

		useDriveStore.getState().pruneSelection(item => isVisibleSharedInItem(item, blocked))
	}, [variant, blocked])

	// Ghost-selection purge (search only): search results are PUSH-FED — a live resync can drop a
	// selected hit with no navigation involved — so nothing else intersects `selectedItems` with the
	// live result set ([variant, splat] in useDriveListboxNav only resets on navigation; SearchInput's
	// own onKeyDown consumes Escape locally to clear the query, so drive.clearSelection never reaches
	// the store either). Mirrors the sharedIn purge above. `sortedItems` is memoized above, so this
	// re-runs when a push, the sort, a size or the hide filter changes it, never on an unrelated
	// re-render. The normal listing's own rarer refetch-drop case stays out of scope.
	useEffect(() => {
		if (!search.active) {
			return
		}

		const live = new Set(sortedItems.map(item => item.data.uuid))

		useDriveStore.getState().pruneSelection(item => live.has(item.data.uuid))
	}, [search.active, sortedItems])

	// Hidden-selection purge: a row the display filter removed must not stay selected, or the floating
	// bulk bar keeps offering Trash/Move/Delete over rows the user can neither see nor verify (its
	// confirms count rows, they don't name them). Keyed by the display pipeline's own output, not the
	// selection's names: the store holds the pre-rename snapshot of a row just renamed to a dot-name.
	const hiddenUuids = display.hiddenUuids

	useEffect(() => {
		if (hiddenUuids.length === 0) {
			return
		}

		const hidden = new Set(hiddenUuids)

		useDriveStore.getState().pruneSelection(item => !hidden.has(item.data.uuid))
	}, [hiddenUuids])

	// null (a column header's third click) clears this location back to the default order.
	async function applySortChange(next: DriveSortBy | null): Promise<void> {
		await setSortPreferences(
			next === null ? withSortCleared(sortPrefs, driveLocation) : withSortSelection(sortPrefs, driveLocation, next)
		)
		await sortPrefsQuery.refetch()
	}

	async function applyViewModeChange(next: DriveViewMode): Promise<void> {
		await setViewModePreferences(withViewModeSelection(viewModePrefs, driveLocation, next))
		await viewModePrefsQuery.refetch()
	}

	async function applyHideHiddenItemsChange(next: boolean): Promise<void> {
		await setHideHiddenItems(next)
		await hiddenPrefQuery.refetch()
	}

	// Registered above at module scope. Browser default for mod+a is "select all page text" — must
	// preventDefault or the native selection would visibly compete with the drive-item selection.
	// Stands down while a dialog is open so a background Cmd+A can't select items behind it — returns
	// before preventDefault, so the browser default runs instead in that case.
	// Withheld (preventDefault still runs, so the browser default stays suppressed either way)
	// while the cache-backed search is still converging (warming/searching-empty/background) — only
	// offered once the result set has settled, so the user can't "select all" a partial/still-growing
	// window (mirrors mobile's own gate, searchStatus.logic.ts's isSearchConverging).
	useAction(
		"drive.selectAll",
		keyboardEvent => {
			if (isAnyDialogOpen()) {
				return
			}

			keyboardEvent.preventDefault()

			if (search.active && isSearchConverging(search.status)) {
				return
			}

			// Undecryptable items are excluded from the selection set itself (not just gated out of bulk
			// actions later): every bulk action needs decrypted metadata, so an undecryptable row could
			// never be acted on — mirrors mobile's select-all, which builds its set from decryptable items
			// only (selectableForSelectAll).
			useDriveStore.getState().setSelectedItems(selectableForSelectAll(sortedItems))
		},
		undefined,
		[sortedItems, search.active, search.status]
	)

	// Registered above at module scope. No preventDefault — bare Escape has no disruptive browser
	// default, matching the hand-rolled handler this replaced. Guarded on isDialogOpen so Escape closes
	// the dialog (its own onOpenChange handling) without also clearing the background selection, and on
	// an open menu for the same reason — a bulk context menu whose selection vanishes mid-open swaps its
	// content component underneath Base UI and is then stuck open.
	useAction(
		"drive.clearSelection",
		() => {
			if (isDialogOpen || isAnyMenuOpen()) {
				return
			}

			useDriveStore.getState().clearSelectedItems()
		},
		undefined,
		[isDialogOpen]
	)

	// Registered above at module scope. Net-new shortcut — no listbox handling to reconcile. Guarded
	// so it can't flip the background view mode while a dialog is open.
	useAction(
		"drive.toggleView",
		() => {
			if (isAnyDialogOpen()) {
				return
			}

			void applyViewModeChange(effectiveViewMode === "list" ? "grid" : "list")
		},
		undefined,
		[effectiveViewMode, applyViewModeChange]
	)

	// Registered above at module scope. No preventDefault — F2 has no disruptive browser default.
	// Reuses driveItemActions' own gating (rather than re-deriving "not in trash, not undecryptable"
	// here) so this can never open a rename the item menu itself wouldn't offer for the same item.
	useAction(
		"drive.rename",
		() => {
			if (isAnyDialogOpen()) {
				return
			}

			const item = sortedItems[safeActiveIndex]

			if (!isOnline || !item || !driveItemActions(item, variant).some(descriptor => descriptor.id === "rename")) {
				return
			}

			handleItemAction("rename", item)
		},
		undefined,
		[sortedItems, safeActiveIndex, variant, isOnline]
	)

	// Registered above at module scope. preventDefault unconditionally — Backspace's browser default
	// (navigate back) must never fire while this listing has focus, guarded case or not. Guards: empty
	// selection, a dialog already open, and every surface the
	// bulk bar offers no Trash on: trash itself (permanent delete stays menu-only + explicitly confirmed,
	// never a bare keypress) and Shared with me (items someone else owns).
	useAction(
		"drive.trash",
		keyboardEvent => {
			keyboardEvent.preventDefault()

			if (
				reconciledSelectedItems.length === 0 ||
				isAnyDialogOpen() ||
				!isOnline ||
				!driveBulkActions(variant, aggregateDriveSelectionFlags(reconciledSelectedItems)).some(
					descriptor => descriptor.id === "trash"
				)
			) {
				return
			}

			handleBulkDialogAction("trash")
		},
		undefined,
		[reconciledSelectedItems, variant, isOnline]
	)

	// Registered above at module scope. preventDefault unconditionally — mod+s's browser default
	// (Save Page As) must never fire while this listing has focus. Guards mirror drive.trash's own
	// (an open dialog, the trash variant — download isn't offered there, matching item-menu/bulk-bar's
	// own trash exclusion) plus isBulkDownloadEnabled (bulkActionBar.logic.ts) — the single unifying
	// ENABLED gate every download entry point shares, empty selection included (false for []), plus
	// offline — a download has nothing to fetch from without a connection. Also inert
	// when the selection includes an undecryptable item — its meta is ciphertext with no content key,
	// so it can never decrypt (mirrors item-menu/bulk-bar's own undecryptable exclusion) — void, not
	// awaited, so the FSA save picker inside startDownloads keeps this keydown's own live user gesture.
	useAction(
		"drive.download",
		keyboardEvent => {
			keyboardEvent.preventDefault()

			if (
				isAnyDialogOpen() ||
				variant === "trash" ||
				!isOnline ||
				!isBulkDownloadEnabled(reconciledSelectedItems) ||
				reconciledSelectedItems.some(item => item.data.undecryptable)
			) {
				return
			}

			void startDownloads(reconciledSelectedItems)
		},
		undefined,
		[reconciledSelectedItems, variant, isOnline]
	)

	// mod+c/x/v and the Paste entry in the upload menus. A paste always lands in the directory on
	// screen, whatever is selected.
	const paste = useDriveClipboard({
		variant,
		uuid,
		ancestry: pathUuids,
		listing: listingQuery.data,
		selectedItems: reconciledSelectedItems,
		isOnline
	})

	const isSearchTruncated = search.active && search.total > BigInt(resolvedCount)
	const searchFooterVisible = search.active && (search.status === "background" || isSearchTruncated)
	// Every row that exists here was removed by the display filter — the "No matches"/"Nothing here
	// yet" states below would both lie, so this one takes their place and names the way back.
	const allHidden = sortedItems.length === 0 && hiddenCount > 0

	function renderAllHiddenEmpty(): ReactNode {
		return (
			<EmptyMessage
				icon={EyeOffIcon}
				title={t("driveHiddenItemsAllHiddenTitle")}
				description={t("driveHiddenItemsAllHiddenBody", { setting: t("driveShowHiddenItems"), display: t("driveDisplay") })}
			/>
		)
	}

	// Right-clicking the listing's own empty space — between tiles, below the last row, an empty
	// directory's placeholder — opens what the directory offers as a destination (destinationMenu.tsx) and
	// drops the selection, as a file manager's background menu does. Rows and tiles keep their own item menu.
	function withBackgroundMenu(surface: ReactElement): ReactNode {
		return (
			<UploadContextMenu
				actions={destination.actionsFor(uuid)}
				disabled={writeDisabled}
				paste={paste}
				onOpen={clearSelection}
				render={surface}
			/>
		)
	}

	function renderEmptyListing(): ReactNode {
		return allHidden ? (
			renderAllHiddenEmpty()
		) : localSearchActive ? (
			// The local-filter empty state — a non-matching query on a non-empty listing reads as "no matches", never
			// the generic "nothing here yet" onboarding copy (same distinction the contacts list makes for its own search).
			<NoResultsMessage />
		) : (
			<EmptyState
				variant="empty"
				driveVariant={variant}
				// Inline "+ Add" affordance for an empty, writable location — reuses the exact same New-directory/Upload
				// controls the toolbar above already renders (not a third create/upload implementation), so this can never
				// drift from what the toolbar itself offers. Hidden wherever the toolbar's own two buttons are too
				// (writeDisabled already covers non-writable variants, a still-loading listing and offline — see its own
				// doc comment above).
				action={
					writeDisabled ? undefined : (
						<>
							{/* The toolbar's copy owns the shortcut: both registering it would open two dialogs. */}
							<NewDirectory
								parentUuid={uuid}
								hiddenNotice={hideHidden}
								shortcut={false}
							/>
							<UploadMenu
								parentUuid={uuid}
								openPreview={openPreview}
								hiddenNotice={hideHidden}
								paste={paste}
							/>
						</>
					)
				}
			/>
		)
	}

	// The column header + virtualized listbox — identical shape whether sortedItems is the normal
	// listing or (search.active) the search results; only the per-row/tile searchParentPath and the
	// trailing footer differ. Kept as one render function rather than duplicated JSX in both branches
	// below.
	function renderListboxContent(): ReactNode {
		return (
			<>
				{effectiveViewMode === "list" ? (
					<ListColumnHeader
						sort={effectiveSort}
						onSortChange={next => {
							void applySortChange(next)
						}}
						disabled={!isSortableVariant(variant)}
					/>
				) : null}
				{withBackgroundMenu(
					<div
						ref={setScrollElement}
						role="listbox"
						aria-multiselectable="true"
						aria-label={t("driveListLabel")}
						tabIndex={-1}
						onKeyDown={handleKeyDown}
						onPointerDown={marquee.onPointerDown}
						className="min-h-0 flex-1 overflow-y-auto"
						style={effectiveViewMode === "grid" ? GRID_LISTBOX_STYLE : undefined}
					>
						{/* Generic layout wrappers between the listbox and its options: role="presentation" keeps
						    the owned-element relationship intact (an unlabelled generic in between breaks it). */}
						<div
							role="presentation"
							style={{ position: "relative", width: "100%", height: activeVirtualizer.getTotalSize() }}
						>
							<MarqueeRect rect={marquee.rect} />
							{effectiveViewMode === "list"
								? listVirtualizer.getVirtualItems().map(virtualRow => {
										const item = sortedItems[virtualRow.index]

										if (!item) {
											return null
										}

										// exactOptionalPropertyTypes forbids passing searchParentPath={undefined} outright (a distinct
										// state from "omitted") — spread it in only when there's a real string to show.
										const parentPath = search.active ? search.parentPaths.get(item.data.uuid) : undefined

										return (
											<DriveRow
												key={virtualRow.key}
												item={item}
												index={virtualRow.index}
												total={sortedItems.length}
												selected={selectedRowKeys.has(driveRowKey(item))}
												active={virtualRow.index === safeActiveIndex}
												variant={variant}
												splat={splat}
												style={{
													position: "absolute",
													top: 0,
													left: 0,
													width: "100%",
													transform: `translateY(${String(virtualRow.start)}px)`
												}}
												{...(parentPath !== undefined ? { searchParentPath: parentPath } : {})}
												directorySizes={directorySizes}
												selectedItems={reconciledSelectedItems}
												onPointerSelect={handlePointerSelect}
												onCursorMove={setCursor}
												onOpen={handleOpen}
												onItemAction={handleItemAction}
												destinationActions={destination.actionsFor}
												onBulkAction={handleBulkDialogAction}
												registerRef={registerRef}
											/>
										)
									})
								: gridVirtualizer.getVirtualItems().map(virtualRow => (
										<div
											key={virtualRow.key}
											role="presentation"
											style={{
												position: "absolute",
												top: 0,
												left: 0,
												width: "100%",
												transform: `translateY(${String(virtualRow.start)}px)`,
												display: "grid",
												gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`
											}}
										>
											{Array.from({ length: columns }, (_, column) => {
												const itemIndex = virtualRow.index * columns + column
												const item = sortedItems[itemIndex]

												if (!item) {
													return null
												}

												// exactOptionalPropertyTypes forbids passing searchParentPath={undefined} outright (a
												// distinct state from "omitted") — spread it in only when there's a real string to show.
												const parentPath = search.active ? search.parentPaths.get(item.data.uuid) : undefined

												return (
													<DriveTile
														key={driveRowKey(item)}
														item={item}
														index={itemIndex}
														total={sortedItems.length}
														selected={selectedRowKeys.has(driveRowKey(item))}
														active={itemIndex === safeActiveIndex}
														variant={variant}
														splat={splat}
														{...(parentPath !== undefined ? { searchParentPath: parentPath } : {})}
														selectedItems={reconciledSelectedItems}
														onPointerSelect={handlePointerSelect}
														onCursorMove={setCursor}
														onOpen={handleOpen}
														onItemAction={handleItemAction}
														destinationActions={destination.actionsFor}
														onBulkAction={handleBulkDialogAction}
														registerRef={registerRef}
													/>
												)
											})}
										</div>
									))}
						</div>
					</div>
				)}
				{/* One strip, one 32px row — the search progress notes and the hidden-row count share it, so
				    they can never stack into a second bar. Both search reads compare against the PRE-hide
				    count: post-hide, "Showing N of M" would render forever and its N would mean the wrong
				    thing (delivered matches, not displayed rows). */}
				{searchFooterVisible || hiddenCount > 0 ? (
					<div className="flex h-8 shrink-0 items-center justify-center gap-2 border-t border-border/50 px-3 text-xs text-muted-foreground">
						{search.active && search.status === "background" ? (
							<Spinner
								aria-hidden="true"
								className="size-3"
							/>
						) : null}
						{isSearchTruncated ? (
							<span>{t("driveSearchShowingOf", { shown: resolvedCount, total: search.total.toString() })}</span>
						) : null}
						{searchFooterVisible && hiddenCount > 0 ? <span aria-hidden="true">·</span> : null}
						{hiddenCount > 0 ? <span>{t("driveHiddenItemsNotShown", { count: hiddenCount })}</span> : null}
					</div>
				) : null}
			</>
		)
	}

	return (
		<>
			{/* Card top row: breadcrumbs left, the action-button cluster right. Everything down to the
			    listing runs full width at px-3, the listing rows' own inset, so the page's left and right
			    content edges line up with the table's first column and its trailing ⋯ column. */}
			<header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border/50 px-3">
				<Breadcrumb
					variant={variant}
					splat={splat}
				/>
				<div className="flex shrink-0 items-center gap-2">
					{/* The whole trash, not the rows the filter leaves: Empty trash acts on all of it. */}
					{isEmptyTrashTriggerVisible(variant, visibleItems.length) ? (
						<EmptyTrashButton
							onClick={handleEmptyTrash}
							disabled={!isOnline}
							offlineTitle={!isOnline ? t("common:offlineActionDisabled") : undefined}
						/>
					) : null}
					<NewDirectory
						parentUuid={uuid}
						disabled={writeDisabled}
						offline={!isOnline}
						hiddenNotice={hideHidden}
					/>
					<UploadMenu
						parentUuid={uuid}
						disabled={writeDisabled}
						openPreview={openPreview}
						offline={!isOnline}
						hiddenNotice={hideHidden}
						paste={paste}
					/>
				</div>
			</header>
			{/* Controls row: sort + display left, search right — bordered controls, room to grow. */}
			<div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-4">
				<div className="flex items-center gap-2">
					<SortMenu
						value={effectiveSort}
						onChange={next => {
							void applySortChange(next)
						}}
						disabled={!isSortableVariant(variant) || !listingReady}
					/>
					<ViewModeToggle
						value={effectiveViewMode}
						onChange={next => {
							void applyViewModeChange(next)
						}}
						{...(hiddenFilterApplies
							? {
									hiddenItems: {
										show: !hiddenPref,
										onChange: next => {
											void applyHideHiddenItemsChange(!next)
										}
									}
								}
							: {})}
					/>
				</div>
				{/* Every variant gets a filter box — "drive" drives the cache-backed recursive engine
					above, every other variant drives the instant local name filter (localFilter) instead.
					Same component either way (mod+f focuses it, Escape/the X button clears it) — only which
					state it's bound to differs. */}
				<SearchInput
					action="drive.search"
					label={t("driveSearch")}
					value={variant === "drive" ? search.input : localFilter}
					onChange={variant === "drive" ? search.setInput : setLocalFilter}
					onClear={
						variant === "drive"
							? search.clear
							: () => {
									setLocalFilter("")
								}
					}
				/>
			</div>
			<UploadDropzone
				parentUuid={uuid}
				disabled={writeDisabled}
			>
				<ListingDropSurface
					uuid={uuid}
					ancestry={pathUuids}
					// Not over search results: they come from all over the subtree, not from the directory on
					// screen.
					disabled={!canDragVariant(variant) || !listingReady || search.active}
				>
					{/* Full bleed to the content card's side and bottom edges; only the top rule separates it
					    from the controls above. */}
					<div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border/70 bg-background">
						{search.active ? (
							search.status === "warming" ? (
								<LoadingState size="lg" />
							) : search.status === "searching-empty" ? (
								<div className="flex flex-1 flex-col items-center justify-center gap-2 overflow-y-auto">
									<Spinner className="size-5 text-muted-foreground" />
									<p className="text-sm text-muted-foreground">{t("driveSearchStillSearching")}</p>
								</div>
							) : search.status === "terminal" ? (
								<div className="flex flex-1 overflow-y-auto">
									<EmptyMessage
										icon={CircleAlertIcon}
										title={t("driveSearchUnavailable")}
									/>
								</div>
							) : sortedItems.length === 0 ? (
								<div className="flex flex-1 overflow-y-auto">
									{allHidden ? renderAllHiddenEmpty() : <NoResultsMessage />}
								</div>
							) : (
								renderListboxContent()
							)
						) : listingQuery.status === "pending" ? (
							<LoadingState size="lg" />
						) : listingQuery.status === "error" &&
						  isBlockingListingError(listingQuery.isRefetchError, listingQuery.data !== undefined) ? (
							<div className="flex flex-1 overflow-y-auto">
								<EmptyState
									variant="error"
									error={asErrorDTO(listingQuery.error)}
									onRetry={() => {
										void listingQuery.refetch()
									}}
								/>
							</div>
						) : sortedItems.length === 0 ? (
							withBackgroundMenu(<div className="flex flex-1 overflow-y-auto">{renderEmptyListing()}</div>)
						) : (
							renderListboxContent()
						)}
					</div>
					{/* Bottom-anchored floating selection bar — overlays the listing container, replacing
					    nothing in the toolbar. */}
					{listingReady && selectedItems.length > 0 ? (
						<div className="pointer-events-none absolute inset-x-6 bottom-4 z-10 flex justify-center">
							<BulkActionBar
								variant={variant}
								selectedItems={reconciledSelectedItems}
								onDialogAction={handleBulkDialogAction}
							/>
						</div>
					) : null}
				</ListingDropSurface>
			</UploadDropzone>
			{destination.host}
			{renderActiveDialog()}
		</>
	)
}

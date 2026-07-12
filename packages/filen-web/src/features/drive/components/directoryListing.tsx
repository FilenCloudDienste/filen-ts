import { useEffect, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { useShallow } from "zustand/shallow"
import { SearchXIcon, CircleAlertIcon } from "lucide-react"
import {
	resolveEffectiveSort,
	resolveEffectiveViewMode,
	withSortSelection,
	withViewModeSelection,
	setSortPreferences,
	setViewModePreferences,
	isSortableVariant,
	DEFAULT_SORT_PREFERENCES,
	DEFAULT_VIEW_MODE_PREFERENCES,
	type DriveVariant,
	type DriveLocation,
	type DriveViewMode
} from "@/features/drive/lib/preferences"
import { sortDriveItems, type DriveSortBy } from "@/features/drive/lib/sort"
import { resolveDriveNavigationTarget, splatToUuids } from "@/features/drive/lib/navigate"
import { asDirectoryOrFile } from "@/features/drive/lib/item"
import { canPreview, previewableSiblings } from "@/features/drive/lib/preview.logic"
import { drivePreviewSources } from "@/features/preview/lib/previewSource"
import { startDownloads } from "@/features/drive/lib/download"
import { useDirectoryListingQuery, useSortPreferencesQuery, useViewModePreferencesQuery } from "@/features/drive/queries/drive"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { cn } from "@/lib/utils"
import { asErrorDTO } from "@/lib/sdk/errors"
import { registerAction } from "@/lib/keymap/registry"
import { useAction } from "@/lib/keymap/useAction"
import { useBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import { driveItemActions } from "@/features/drive/components/itemMenu.logic"
import { isBulkDownloadEnabled } from "@/features/drive/components/bulkActionBar.logic"
import {
	filterSharedInByBlocked,
	isEmptyTrashTriggerVisible,
	resolveSearchDisplayItems,
	staleBlockedSelectionUuids,
	staleSelectionUuids
} from "@/features/drive/components/directoryListing.logic"
import { Breadcrumb } from "@/features/drive/components/breadcrumb"
import { SortMenu } from "@/features/drive/components/sortMenu"
import { ViewModeToggle } from "@/features/drive/components/viewModeToggle"
import { NewDirectory } from "@/features/drive/components/newDirectory"
import { EmptyTrashButton } from "@/features/drive/components/emptyTrashButton"
import { UploadMenu } from "@/features/drive/components/uploadMenu"
import { UploadDropzone } from "@/features/drive/components/uploadDropzone"
import { BulkActionBar } from "@/features/drive/components/bulkActionBar"
import { EmptyState } from "@/features/drive/components/emptyState"
import { ListingSkeleton } from "@/features/drive/components/listingSkeleton"
import { DriveRow } from "@/features/drive/components/driveRow"
import { DriveTile } from "@/features/drive/components/driveTile"
import { SearchInput } from "@/features/drive/components/searchInput"
import { useDriveSearch } from "@/features/drive/hooks/useDriveSearch"
import { searchHitNavigationTarget } from "@/features/drive/hooks/useDriveSearch.logic"
import { useDriveVirtualizer } from "@/features/drive/hooks/useDriveVirtualizer"
import { useDriveDirectorySizes } from "@/features/drive/hooks/useDriveDirectorySizes"
import { useDriveListboxNav } from "@/features/drive/hooks/useDriveListboxNav"
import { useDriveMarquee } from "@/features/drive/hooks/useDriveMarquee"
import { useDriveDialogHost } from "@/features/drive/hooks/useDriveDialogHost"
import { useIsOnline } from "@/lib/useIsOnline"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

// Centered content column inside the card — the width cap rides one CSS var (see index.css) so the
// preset flips project-wide in one place.
const CONTENT_COLUMN_CLASS = "mx-auto w-full max-w-(--content-column)"

// Stable identity so a disabled/empty directorySizes read never re-triggers row renders — module scope,
// not recreated per render (a fresh `new Map()` every render would defeat DriveRow's memoization).
const EMPTY_DIRECTORY_SIZES: ReadonlyMap<string, number> = new Map()

export interface DirectoryListingProps {
	variant: DriveVariant
	// The full "/drive/$" splat path ("" for root, else a "/"-joined ancestor-uuid chain) — recents/
	// favorites/trash pass "" (they're flat, never nested). The current directory is the last segment.
	splat: string
}

// Module scope, not inside the component: runs exactly once per module evaluation (see
// themeProvider.tsx's own "app.toggleTheme" registration for the full StrictMode/HMR rationale).
//
// Reconciling these with the listbox's own roving-tabindex `onKeyDown` (useDriveListboxNav): select-all
// and clear-selection used to be hand-rolled checks inside that handler, matching Cmd/Ctrl+A and
// Escape unconditionally whenever the listbox had focus. They are registered as commands here
// INSTEAD of that (not in addition to it — a stray double-registration would double-fire, since
// useAction's useHotkeys binds document-wide, not scoped to the listbox element) so a user remap
// actually changes what fires, and so `<Kbd action>` reflects the real live combo. This makes them
// fire regardless of focus location on the page (not just while the listbox itself is focused) —
// an accepted, documented widening: every registered action fires globally today (no
// `<HotkeysProvider>` scope activation yet, see registry.ts's ActionScope comment), and drive is
// currently the app's only real interactive surface, so "global" and "listbox-focused" coincide
// in practice. Arrow/Home/End/Space/Enter cursor movement stays listbox-local — those are
// continuous, per-row navigation semantics, not discrete user-remappable commands.
registerAction({
	id: "drive.selectAll",
	defaultCombo: "mod+a",
	scope: "drive",
	descriptionKey: "driveCommandSelectAll"
})
registerAction({
	id: "drive.clearSelection",
	defaultCombo: "escape",
	scope: "drive",
	descriptionKey: "driveCommandClearSelection"
})
// No prior intrinsic handling to reconcile — view mode had no keyboard toggle before this.
registerAction({
	id: "drive.toggleView",
	defaultCombo: "v",
	scope: "drive",
	descriptionKey: "driveCommandToggleView"
})
// Opens the rename dialog for the roving-cursor item — see the useAction call below for the guard
// (only a real, wired dialog blocks it; only an item driveItemActions itself would offer Rename for).
registerAction({
	id: "drive.rename",
	defaultCombo: "f2",
	scope: "drive",
	descriptionKey: "driveCommandRename"
})
// Opens the trash confirm for the current selection — see the useAction call below for its guards.
registerAction({
	id: "drive.trash",
	defaultCombo: "delete,backspace",
	scope: "drive",
	descriptionKey: "driveCommandTrash"
})
// Downloads the current selection — see the useAction call below for its guards (single unifying
// gate, mirroring item-menu/bulk-bar: mod+s reads as "save to disk", the FSA picker's own verb, and
// is free of every other registered combo (mod+a/escape/v/f2/delete/backspace/n, global "d"/"").
registerAction({
	id: "drive.download",
	defaultCombo: "mod+s",
	scope: "drive",
	descriptionKey: "driveCommandDownload"
})

// Every drive route (drive.$.tsx, recents/favorites/trash.tsx) renders this one container with its
// own {variant,splat} — the single place the placeholder body is swapped for the real virtualized
// list, so no route needs to change again when it does. The current directory's own uuid is always
// the splat's last segment (null at the root, where the splat is empty).
export function DirectoryListing({ variant, splat }: DirectoryListingProps) {
	const { t } = useTranslation(["drive", "common"])
	const navigate = useNavigate()
	const uuid = splatToUuids(splat).at(-1) ?? null
	const driveLocation: DriveLocation = { variant, uuid }

	const listingQuery = useDirectoryListingQuery(variant, uuid)
	const sortPrefsQuery = useSortPreferencesQuery()
	const viewModePrefsQuery = useViewModePreferencesQuery()
	const isOnline = useIsOnline()
	// New directory / upload only make sense in the navigable "drive" variant, once the listing has
	// loaded — recents/favorites/trash/shared have no directory to write into, and a still-loading
	// listing has no confirmed uuid to target yet. Shared by NewDirectory, UploadMenu and
	// UploadDropzone below (all three write into the same `uuid`). Offline folds in here too: all
	// three write to the SDK, which has nothing to reach while offline.
	const writeDisabled = variant !== "drive" || listingQuery.status !== "success" || !isOnline
	// Gates the underlying contacts/blocked fetch itself (see useBlockedUsers.ts) — only sharedIn
	// filters by it, so the other 5 variants skip the getContacts/getBlockedContacts worker round trip
	// on every mount and window refocus.
	const blocked = useBlockedUsers(variant === "sharedIn")

	const sortPrefs = sortPrefsQuery.data ?? DEFAULT_SORT_PREFERENCES
	const viewModePrefs = viewModePrefsQuery.data ?? DEFAULT_VIEW_MODE_PREFERENCES
	const effectiveSort = resolveEffectiveSort(sortPrefs, driveLocation)
	const effectiveViewMode = resolveEffectiveViewMode(viewModePrefs, driveLocation)

	// sharedIn ONLY: hide items shared by a blocked user (fail-open — see directoryListing.logic.ts).
	// Every other variant's listing data passes straight through, untouched.
	const visibleItems = variant === "sharedIn" ? filterSharedInByBlocked(listingQuery.data ?? [], blocked) : (listingQuery.data ?? [])
	// Subtree search rooted at the CURRENT directory (uuid), gated to the "drive" variant — recents/
	// favorites/trash/shared have no navigable subtree of their own for it to search. While active,
	// search results stand in for the normal listing query everywhere below: selection, the listbox's
	// keyboard nav, context menus, the bulk bar, and preview siblings all read `sortedItems` alone, so
	// swapping its one source here is what makes every one of them inherited for free.
	const search = useDriveSearch(uuid, variant === "drive")

	// Threaded ONCE here (not per-row — see driveRow.tsx's own comment) and read down into every row's
	// size column AND the size sort below. Fed the PRE-sort item set (uuid-keyed, order-independent —
	// see useDriveDirectorySizes.logic.ts), not sortedItems: sortedItems below depends on this map, so
	// feeding it sortedItems would be circular. Gated to list view: DriveTile shows no size at all
	// (mirrors filen-mobile's grid item, which never mounts a size query either), so prefetching while
	// the grid is showing would pay for recursive server-side size walks nothing on screen reads.
	const directorySizes =
		useDriveDirectorySizes({ items: search.active ? search.results : visibleItems, enabled: effectiveViewMode === "list" }) ??
		EMPTY_DIRECTORY_SIZES
	const sortedItems = search.active
		? resolveSearchDisplayItems(search.results, search.total, effectiveSort, directorySizes)
		: sortDriveItems(visibleItems, effectiveSort, directorySizes)

	const selectedItems = useDriveStore(useShallow(state => state.selectedItems))
	// Derived once per render so each row/tile's membership check is an O(1) `.has()` instead of an
	// O(selected) `.some()` — select-all in a large directory would otherwise make every render
	// O(visible * selected).
	const selectedUuids = new Set(selectedItems.map(item => item.data.uuid))

	const { isDialogOpen, handleItemAction, handleBulkDialogAction, handleEmptyTrash, openPreview, renderActiveDialog } =
		useDriveDialogHost({
			variant,
			selectedItems
		})

	const { setScrollElement, scrollElement, columns, listVirtualizer, gridVirtualizer, activeVirtualizer, registerRef, itemRefs } =
		useDriveVirtualizer(sortedItems, effectiveViewMode)

	function handleOpen(index: number) {
		const item = sortedItems[index]

		if (!item) {
			return
		}

		// A file opens the preview overlay when previewable, else no-ops (mirrors the prior behavior:
		// resolveDriveNavigationTarget already returns null for every file arm — see its own comment).
		// A directory falls through to the unchanged navigation path below.
		if (asDirectoryOrFile(item).type === "file") {
			if (!canPreview(item, variant)) {
				return
			}

			const siblings = previewableSiblings(sortedItems, variant)
			const siblingIndex = siblings.findIndex(sibling => sibling.data.uuid === item.data.uuid)

			openPreview(drivePreviewSources(siblings), siblingIndex === -1 ? 0 : siblingIndex)

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
	const marquee = useDriveMarquee({
		items: sortedItems,
		viewMode: effectiveViewMode,
		columns,
		scrollElement,
		setCursor
	})

	// Stale-selection purge (sharedIn only): drops any selected item that just became blocked (the
	// user blocked its sharer while viewing this listing) so the bulk bar can never target a
	// now-hidden item. Fail-open, same predicate as the display filter above — an item whose sharer
	// identity doesn't resolve is never purged.
	useEffect(() => {
		if (variant !== "sharedIn") {
			return
		}

		const toRemove = staleBlockedSelectionUuids(useDriveStore.getState().selectedItems, blocked)

		if (toRemove.length > 0) {
			useDriveStore.getState().removeFromSelection(toRemove)
		}
	}, [variant, blocked])

	// Ghost-selection purge (search only): search results are PUSH-FED — a live resync can drop a
	// selected hit with no navigation involved — so nothing else intersects `selectedItems` with the
	// live result set ([variant, splat] in useDriveListboxNav only resets on navigation; SearchInput's
	// own onKeyDown consumes Escape locally to clear the query, so drive.clearSelection never reaches
	// the store either). Mirrors the sharedIn purge above.
	//
	// Keyed on a uuid-content signature, not `sortedItems` itself: resolveSearchDisplayItems/
	// buildSearchResults rebuild a brand-new array of brand-new items every render regardless of
	// whether a push changed anything, so a reference-keyed effect would re-fire on every unrelated
	// re-render — this string stays `===`-stable across those, so an unchanged heartbeat can't fight
	// an in-progress in-search selection, and only changes when a push actually adds or drops a hit.
	// The normal listing's own rarer refetch-drop case stays out of scope — its items aren't
	// reference-stable either, so covering it here isn't free.
	const searchResultUuids = search.active
		? sortedItems
				.map(item => item.data.uuid)
				.sort()
				.join(",")
		: ""

	useEffect(() => {
		if (!search.active) {
			return
		}

		const toRemove = staleSelectionUuids(useDriveStore.getState().selectedItems, sortedItems)

		if (toRemove.length > 0) {
			useDriveStore.getState().removeFromSelection(toRemove)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the signature above, not sortedItems — see comment above
	}, [search.active, searchResultUuids])

	async function applySortChange(next: DriveSortBy): Promise<void> {
		await setSortPreferences(withSortSelection(sortPrefs, driveLocation, next))
		await sortPrefsQuery.refetch()
	}

	async function applyViewModeChange(next: DriveViewMode): Promise<void> {
		await setViewModePreferences(withViewModeSelection(viewModePrefs, driveLocation, next))
		await viewModePrefsQuery.refetch()
	}

	// Registered above at module scope. Browser default for mod+a is "select all page text" — must
	// preventDefault or the native selection would visibly compete with the drive-item selection.
	// Guarded on isDialogOpen (see its own comment) so a background Cmd+A can't select items behind
	// an open dialog — returns before preventDefault, so the browser default runs instead in that case.
	useAction(
		"drive.selectAll",
		keyboardEvent => {
			if (isDialogOpen) {
				return
			}

			keyboardEvent.preventDefault()
			useDriveStore.getState().setSelectedItems(sortedItems)
		},
		undefined,
		[isDialogOpen, sortedItems]
	)

	// Registered above at module scope. No preventDefault — bare Escape has no disruptive browser
	// default, matching the hand-rolled handler this replaced. Guarded on isDialogOpen so Escape closes
	// the dialog (its own onOpenChange handling) without also clearing the background selection.
	useAction(
		"drive.clearSelection",
		() => {
			if (isDialogOpen) {
				return
			}

			useDriveStore.getState().clearSelectedItems()
		},
		undefined,
		[isDialogOpen]
	)

	// Registered above at module scope. Net-new shortcut — no listbox handling to reconcile. Guarded
	// on isDialogOpen so it can't flip the background view mode while a dialog is open.
	useAction(
		"drive.toggleView",
		() => {
			if (isDialogOpen) {
				return
			}

			void applyViewModeChange(effectiveViewMode === "list" ? "grid" : "list")
		},
		undefined,
		[isDialogOpen, effectiveViewMode, applyViewModeChange]
	)

	// Registered above at module scope. No preventDefault — F2 has no disruptive browser default.
	// Reuses driveItemActions' own gating (rather than re-deriving "not in trash, not undecryptable"
	// here) so this can never open a rename the item menu itself wouldn't offer for the same item.
	useAction(
		"drive.rename",
		() => {
			if (isDialogOpen) {
				return
			}

			const item = sortedItems[safeActiveIndex]

			if (!isOnline || !item || !driveItemActions(item, variant).some(descriptor => descriptor.id === "rename")) {
				return
			}

			handleItemAction("rename", item)
		},
		undefined,
		[isDialogOpen, sortedItems, safeActiveIndex, variant, isOnline]
	)

	// Registered above at module scope. preventDefault unconditionally — Backspace's browser default
	// (navigate back) must never fire while this listing has focus, guarded case or not. Guards: empty
	// selection, a wired dialog already open (isDialogOpen — see its own comment), and trash itself
	// (permanent delete stays menu-only + explicitly confirmed, never a bare keypress).
	useAction(
		"drive.trash",
		keyboardEvent => {
			keyboardEvent.preventDefault()

			if (selectedItems.length === 0 || isDialogOpen || variant === "trash" || !isOnline) {
				return
			}

			handleBulkDialogAction("trash")
		},
		undefined,
		[selectedItems, isDialogOpen, variant, isOnline]
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
				isDialogOpen ||
				variant === "trash" ||
				!isOnline ||
				!isBulkDownloadEnabled(selectedItems) ||
				selectedItems.some(item => item.data.undecryptable)
			) {
				return
			}

			void startDownloads(selectedItems)
		},
		undefined,
		[selectedItems, isDialogOpen, variant, isOnline]
	)

	// The column header + virtualized listbox — identical shape whether sortedItems is the normal
	// listing or (search.active) the search results; only the per-row/tile searchParentPath and the
	// trailing footer differ. Kept as one render function rather than duplicated JSX in both branches
	// below.
	function renderListboxContent(): ReactNode {
		return (
			<>
				{effectiveViewMode === "list" ? (
					<div
						aria-hidden="true"
						className="flex h-8 shrink-0 items-center gap-3 border-b border-border/50 px-3 text-xs font-medium text-muted-foreground"
					>
						<span className="size-4 shrink-0" />
						<span className="min-w-0 flex-1">{t("driveColumnName")}</span>
						<span className="w-20 shrink-0 text-right">{t("driveColumnSize")}</span>
						<span className="w-28 shrink-0 text-right">{t("driveColumnModified")}</span>
					</div>
				) : null}
				<div
					ref={setScrollElement}
					role="listbox"
					aria-multiselectable="true"
					aria-label={t("driveListLabel")}
					tabIndex={-1}
					onKeyDown={handleKeyDown}
					onPointerDown={marquee.onPointerDown}
					className="min-h-0 flex-1 overflow-y-auto"
				>
					<div style={{ position: "relative", width: "100%", height: activeVirtualizer.getTotalSize() }}>
						{/* Marquee rectangle — content-space, so it stretches correctly as the listing auto-scrolls.
						    Non-interactive (pointer-events-none) so it never intercepts the ongoing drag. */}
						{marquee.rect ? (
							<div
								aria-hidden="true"
								className="pointer-events-none absolute z-20 rounded-xs border border-primary/60 bg-primary/15"
								style={{
									left: marquee.rect.left,
									top: marquee.rect.top,
									width: marquee.rect.right - marquee.rect.left,
									height: marquee.rect.bottom - marquee.rect.top
								}}
							/>
						) : null}
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
											selected={selectedUuids.has(item.data.uuid)}
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
											onPointerSelect={handlePointerSelect}
											onOpen={handleOpen}
											onItemAction={handleItemAction}
											registerRef={registerRef}
										/>
									)
								})
							: gridVirtualizer.getVirtualItems().map(virtualRow => (
									<div
										key={virtualRow.key}
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

											// exactOptionalPropertyTypes forbids passing searchParentPath={undefined} outright (a distinct
											// state from "omitted") — spread it in only when there's a real string to show.
											const parentPath = search.active ? search.parentPaths.get(item.data.uuid) : undefined

											return (
												<DriveTile
													key={item.data.uuid}
													item={item}
													index={itemIndex}
													selected={selectedUuids.has(item.data.uuid)}
													active={itemIndex === safeActiveIndex}
													variant={variant}
													splat={splat}
													{...(parentPath !== undefined ? { searchParentPath: parentPath } : {})}
													onPointerSelect={handlePointerSelect}
													onOpen={handleOpen}
													onItemAction={handleItemAction}
													registerRef={registerRef}
												/>
											)
										})}
									</div>
								))}
					</div>
				</div>
				{search.active && (search.status === "background" || search.total > BigInt(sortedItems.length)) ? (
					<div className="flex h-8 shrink-0 items-center justify-center gap-2 border-t border-border/50 px-3 text-xs text-muted-foreground">
						{search.status === "background" ? (
							<Spinner
								aria-hidden="true"
								className="size-3"
							/>
						) : null}
						{search.total > BigInt(sortedItems.length) ? (
							<span>{t("driveSearchShowingOf", { shown: sortedItems.length, total: search.total.toString() })}</span>
						) : null}
					</div>
				) : null}
			</>
		)
	}

	return (
		<>
			{/* Card top row: breadcrumbs left, the action-button cluster right, content column-capped —
			    the bottom hairline is the card's one sanctioned full-width rule. */}
			<header className="shrink-0 border-b border-border/50 px-6">
				<div className={cn(CONTENT_COLUMN_CLASS, "flex h-14 items-center justify-between gap-4")}>
					<Breadcrumb
						variant={variant}
						splat={splat}
					/>
					<div className="flex shrink-0 items-center gap-2">
						{isEmptyTrashTriggerVisible(variant, sortedItems.length) ? (
							<EmptyTrashButton
								onClick={handleEmptyTrash}
								disabled={!isOnline}
							/>
						) : null}
						<NewDirectory
							parentUuid={uuid}
							disabled={writeDisabled}
							dialogOpen={isDialogOpen}
						/>
						<UploadMenu
							parentUuid={uuid}
							disabled={writeDisabled}
							openPreview={openPreview}
						/>
					</div>
				</div>
			</header>
			{/* Controls row: sort + display left, search right — bordered controls, room to grow. */}
			<div className="shrink-0 px-6 pt-4">
				<div className={cn(CONTENT_COLUMN_CLASS, "flex items-center justify-between gap-2")}>
					<div className="flex items-center gap-2">
						<SortMenu
							value={effectiveSort}
							onChange={next => {
								void applySortChange(next)
							}}
							disabled={!isSortableVariant(variant) || listingQuery.status !== "success"}
						/>
						<ViewModeToggle
							value={effectiveViewMode}
							onChange={next => {
								void applyViewModeChange(next)
							}}
						/>
					</div>
					{variant === "drive" ? (
						<SearchInput
							value={search.input}
							onChange={search.setInput}
							onClear={search.clear}
							dialogOpen={isDialogOpen}
						/>
					) : null}
				</div>
			</div>
			<UploadDropzone
				parentUuid={uuid}
				disabled={writeDisabled}
			>
				<div className="relative flex min-h-0 flex-1 flex-col px-6 pt-4 pb-6">
					<div
						className={cn(
							CONTENT_COLUMN_CLASS,
							"flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-background"
						)}
					>
						{search.active ? (
							search.status === "warming" ? (
								<div className="flex-1 overflow-y-auto">
									<ListingSkeleton viewMode={effectiveViewMode} />
								</div>
							) : search.status === "searching-empty" ? (
								<div className="flex flex-1 flex-col items-center justify-center gap-2 overflow-y-auto">
									<Spinner className="size-5 text-muted-foreground" />
									<p className="text-sm text-muted-foreground">{t("driveSearchStillSearching")}</p>
								</div>
							) : search.status === "terminal" ? (
								<div className="flex flex-1 overflow-y-auto">
									<Empty>
										<EmptyHeader>
											<EmptyMedia variant="icon">
												<CircleAlertIcon />
											</EmptyMedia>
											<EmptyTitle>{t("driveSearchUnavailable")}</EmptyTitle>
										</EmptyHeader>
									</Empty>
								</div>
							) : sortedItems.length === 0 ? (
								<div className="flex flex-1 overflow-y-auto">
									<Empty>
										<EmptyHeader>
											<EmptyMedia variant="icon">
												<SearchXIcon />
											</EmptyMedia>
											<EmptyTitle>{t("driveSearchNoResults")}</EmptyTitle>
										</EmptyHeader>
									</Empty>
								</div>
							) : (
								renderListboxContent()
							)
						) : listingQuery.status === "pending" ? (
							<div className="flex-1 overflow-y-auto">
								<ListingSkeleton viewMode={effectiveViewMode} />
							</div>
						) : listingQuery.status === "error" ? (
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
							<div className="flex flex-1 overflow-y-auto">
								<EmptyState variant="empty" />
							</div>
						) : (
							renderListboxContent()
						)}
					</div>
					{/* Bottom-anchored floating selection bar — overlays the listing container, replacing
					    nothing in the toolbar. */}
					{listingQuery.status === "success" && selectedItems.length > 0 ? (
						<div className="pointer-events-none absolute inset-x-6 bottom-10 z-10 flex justify-center">
							<BulkActionBar
								variant={variant}
								selectedItems={selectedItems}
								onDialogAction={handleBulkDialogAction}
							/>
						</div>
					) : null}
				</div>
			</UploadDropzone>
			{renderActiveDialog()}
		</>
	)
}

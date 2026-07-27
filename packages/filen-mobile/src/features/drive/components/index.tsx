import { Fragment, useCallback, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import SafeAreaView from "@/components/ui/safeAreaView"
import useDrivePath from "@/hooks/useDrivePath"
import useDriveItemsQuery from "@/features/drive/queries/useDriveItems.query"
import type { DriveItem } from "@/types"
import { itemSorter } from "@/lib/sort"
import { useDriveSortPreference } from "@/features/drive/driveSortPreference"
import { filterHiddenDriveItems, useHideHiddenItems } from "@/features/drive/driveHiddenItems"
import VirtualList, { type ListRef, type ListRenderItemInfo } from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
import Button from "@/components/ui/button"
import Item from "@/features/drive/components/item"
import Header from "@/features/drive/components/header"
import DriveListFooter from "@/features/drive/components/listFooter"
import { run, cn } from "@filen/utils"
import alerts from "@/lib/alerts"
import { type View as RNView, Platform, ActivityIndicator } from "react-native"
import useViewLayout from "@/hooks/useViewLayout"
import { useDriveViewMode } from "@/features/drive/driveViewModePreference"
import { gridColumnsForWidth, GRID_EDGE_PADDING } from "@/features/drive/driveGrid"
import { driveScreenUsesBaseBackground, hiddenFilterAppliesTo } from "@/features/drive/driveSelectors"
import GridItem from "@/features/drive/components/item/gridItem"
import { useFocusEffect } from "expo-router"
import useDriveStore from "@/features/drive/store/useDrive.store"
import { onlineManager } from "@tanstack/react-query"
import { useDriveSearch } from "@/features/drive/hooks/useDriveSearch"
import { isSearchWindowTruncated } from "@/features/drive/hooks/driveSearchStatus"
import { useDriveDirectorySizes } from "@/features/drive/hooks/useDriveDirectorySizes"
import { useDriveHighlight } from "@/features/drive/hooks/useDriveHighlight"
import useBlockedUsers from "@/features/contacts/hooks/useBlockedUsers"
import { isBlocked } from "@/features/contacts/blockedSelectors"
import { getSharerIdentity } from "@/features/drive/driveSharer"
import {
	getDriveEmptyStateIcon,
	getDriveEmptyStateTitleKey,
	getDriveEmptyStateDescriptionKey,
	filterDriveItemsBySearchQuery
} from "@/features/drive/utils"
import offlineSync from "@/features/offline/offlineSync"
import SyncErrorsHeaderRow from "@/features/offline/components/syncErrorsHeaderRow"
import { LazyWrapper } from "@/components/lazyWrapper"
import { getDriveParent, canShowDriveCreateMenu, buildDriveCreateMenuButtons } from "@/features/drive/components/driveCreateMenu"
import { useDriveUpload } from "@/features/drive/hooks/useDriveUpload"
import View from "@/components/ui/view"
import Menu from "@/components/ui/menu"
import { PressableScale } from "@/components/ui/pressables"
import Text from "@/components/ui/text"
import Ionicons from "@expo/vector-icons/Ionicons"
import logger from "@/lib/logger"
import { useResolveClassNames } from "uniwind"

// Height reserved below each grid card for the single-line filename label.
const GRID_LABEL_HEIGHT = 28

const Drive = () => {
	const drivePath = useDrivePath()
	const { viewMode } = useDriveViewMode(drivePath)
	const containerRef = useRef<RNView>(null)
	const listRef = useRef<ListRef<DriveItem>>(null)
	const { layout, onLayout } = useViewLayout(containerRef)
	const isGrid = viewMode === "grid"
	const columns = gridColumnsForWidth(layout.width)
	const gridItemWidth = isGrid && layout.width > 0 ? (layout.width - GRID_EDGE_PADDING * 2) / columns : 0
	const gridItemHeight = gridItemWidth + GRID_LABEL_HEIGHT
	// Guard: VirtualList throws if grid=true but itemWidth/itemHeight are absent.
	// Before the first layout event layout.width is 0, so we fall back to list for that frame.
	const isGridActive = isGrid && gridItemWidth > 0
	const { t } = useTranslation()
	const { searchQuery, setSearchQuery, searchResults, searchResultPaths, status, totalCount } = useDriveSearch({ drivePath })
	const { sort } = useDriveSortPreference(drivePath)
	const [hideHiddenItems] = useHideHiddenItems()
	const blocked = useBlockedUsers()
	const parent = getDriveParent(drivePath)
	const upload = useDriveUpload({ parent, drivePath, t })
	const textForegroundColor = useResolveClassNames("text-foreground").color as string
	const primaryColor = useResolveClassNames("bg-primary").backgroundColor as string
	const driveCreateButtons = canShowDriveCreateMenu({ drivePath, parent, selectionMode: false })
		? buildDriveCreateMenuButtons({ t, parent, upload })
		: []

	const driveItemsQuery = useDriveItemsQuery(
		{
			path: drivePath
		},
		{
			enabled: drivePath.type !== null
		}
	)

	const isPlainDrive = drivePath.type === "drive" && !drivePath.selectOptions
	const searchActive = searchQuery.trim().length > 0
	// The cache-backed search is the SINGLE source for the list ONLY on the plain /drive
	// browser with an active query — it already matched the whole subtree, so there's no
	// merge with the directory listing and no local re-filter (that would double-filter an
	// already-matched set). Every other context (favorites/trash/recents/select/…) keeps
	// its local listing, locally filtered by the query — and the plain browser with no
	// query falls through here too (empty query → filter is a no-op).
	const isCacheSearch = isPlainDrive && searchActive

	// Size sort needs the REAL directory sizes (items carry size: 0n for dirs — #49); the hook
	// prefetches + reads them from the same query cache the rows display from, and returns
	// undefined for every other sort mode (zero cost there).
	const directorySizes = useDriveDirectorySizes({
		items: isCacheSearch ? searchResults : driveItemsQuery.data,
		drivePathType: drivePath.type,
		enabled: sort === "sizeAsc" || sort === "sizeDesc"
	})

	// #26 — use retained data unconditionally (stale-while-error); status "error"
	// with prior data keeps the listing visible instead of flipping to "empty".
	const sortedItems = isCacheSearch
		? // Truncated window (more matches than the loaded CEILING): the SDK loaded the
			// alphabetically-FIRST slice, so re-sorting it by a non-name preference (newest/largest)
			// would show "the newest of the alphabetically-first 1000" and silently hide the true
			// top-N. Keep the SDK's name-ascending order (the footer states it); below the cap the
			// whole match set is loaded, so the user's sort is honoured.
			isSearchWindowTruncated(totalCount, searchResults.length)
			? searchResults
			: itemSorter.sortItems(searchResults, sort, { directorySizes })
		: filterDriveItemsBySearchQuery(itemSorter.sortItems(driveItemsQuery.data ?? [], sort, { directorySizes }), searchQuery)

	// Hide shared-in items shared by a blocked user (virtual-root filter — the query stays
	// unopinionated). Only the sharedIn context carries a sharer identity to check.
	const visibleItems =
		drivePath.type === "sharedIn"
			? sortedItems.filter(item => {
					const sharer = getSharerIdentity(item)

					return !sharer || !isBlocked(sharer, blocked)
				})
			: sortedItems

	// Dot-prefixed items, when the user has opted into hiding them. Applied last and to the single
	// `items` this screen renders from, so one application covers every context this screen backs.
	//
	// Which contexts it applies to is `hiddenFilterAppliesTo`: the two browsing views only. See
	// there for why every other list this screen backs shows everything.
	const hidingActive = hideHiddenItems && hiddenFilterAppliesTo(drivePath)
	const items = filterHiddenDriveItems({
		items: visibleItems,
		hide: hidingActive,
		// Search is recursive: without the hit's ancestry, hiding `.thumb` from the browser would
		// still flood the results with its contents — and the row prints the full relative path,
		// naming the hidden directory right back at the user.
		searchParentPaths: isCacheSearch ? searchResultPaths : undefined
	})
	const hiddenCount = visibleItems.length - items.length

	// The filter emptied a listing that wasn't empty. Without its own empty state this reads as
	// "this directory is empty" or, worse, "no results" for a search whose term WAS matched —
	// leaving no way to work out why. Covers both, since both render from `items`.
	const emptiedByHiddenFilter = hiddenCount > 0 && items.length === 0
	// A truncated search filtered to nothing is a distinct story: matches exist beyond the loaded
	// window, and since the SDK loads the alphabetically-FIRST slice — and `.` sorts ahead of
	// letters and digits — that slice skews heavily towards the very items being hidden. Refining
	// the term shrinks the match set below the cap and brings the rest into view, so say so.
	const searchTruncated = isCacheSearch && isSearchWindowTruncated(totalCount, searchResults.length)

	// The setting's own label and its location, interpolated rather than written into the sentences
	// that reference them — otherwise the translator localizes four copies of "Hide hidden items"
	// and "More"/"Appearance" independently of the real keys, and they drift apart per locale.
	const hiddenSetting = t("hide_hidden_items")
	const hiddenSettingPath = `${t("more")} › ${t("appearance")}`

	// Reveal target of an "open containing directory" navigation: scrolls this listing to the item
	// the search hit pointed at and tints its row once. No-op on every other entry to the screen.
	// `settled` deliberately keys off isFetching, not just status: this screen mounts with
	// `refetchOnMount: "always"`, so a directory that WAS visited before renders its persisted
	// listing at status "success" while the real one is still in flight. Giving up on that
	// snapshot would miss anything added since. The status term additionally covers a query that
	// is pending without fetching, where there is no listing to search at all.
	const highlightedUuid = useDriveHighlight({
		items,
		listRef,
		// Grid mode is resolved from a measured width, so until layout lands the VirtualList below
		// is the list-mode one and its `key` is about to change — revealing against an instance
		// that is then remounted loses the scroll with nothing to retry it.
		ready: layout.width > 0,
		// `settled` keys off fetchStatus, not status: this screen mounts with
		// `refetchOnMount: "always"`, so a directory visited before renders its persisted listing at
		// status "success" while the real one is still in flight, and giving up on that snapshot
		// would miss anything added since. "idle" (rather than !isFetching) additionally excludes a
		// query the offlineFirst retryer has PAUSED, which would otherwise read as settled and
		// permanently abandon a reveal that connectivity is about to make possible.
		settled: driveItemsQuery.fetchStatus === "idle" && driveItemsQuery.status !== "pending"
	})

	// Returning from a cache search to the directory listing: the search REPLACED the
	// listing as the rendered source, so on clear the list shows whatever
	// `driveItemsQuery.data` currently holds. Refetch on that transition so a listing that
	// went stale / errored / never settled while the search was the view repopulates,
	// instead of dropping to a false empty state.
	const refetchListing = driveItemsQuery.refetch
	const wasCacheSearchRef = useRef<boolean>(isCacheSearch)

	useEffect(() => {
		const wasCacheSearch = wasCacheSearchRef.current

		wasCacheSearchRef.current = isCacheSearch

		if (wasCacheSearch && !isCacheSearch) {
			void refetchListing()
		}
	}, [isCacheSearch, refetchListing])

	// Stale-selection purge (hidden filter): a selected row that becomes hidden — renamed to a
	// dot-name locally or remotely, or the preference flipped — would otherwise stay selected while
	// off screen, so the header would count a row nobody can see and a bulk action would target it.
	//
	// Purges exactly what THIS filter removed, never "everything not currently rendered". Two
	// reasons, both reachable: `items` is legitimately EMPTY while the search suppresses its
	// results (warming / terminal), so reconciling against it would wipe the whole selection on
	// every keystroke that re-warms a query; and `selectedItems` is a global store while several
	// Drive instances are mounted at once (the tab stack plus trash / offline / favorites as
	// separate routes), whose effects run unfocused — so one listing's notion of "not rendered"
	// must never speak for another's. A dot-name is hidden in every listing alike, so removing only
	// those is correct from whichever instance runs it.
	useEffect(() => {
		if (hiddenCount === 0) {
			return
		}

		const rendered = new Set(items.map(item => item.data.uuid))
		const removed = visibleItems.filter(item => !rendered.has(item.data.uuid)).map(item => item.data.uuid)

		useDriveStore.getState().removeFromSelection(removed)
	}, [items, visibleItems, hiddenCount])

	// Stale-selection purge (sharedIn): if a sharer becomes blocked while their items are
	// selected, drop those items from the selection so bulk actions / select-all stay honest.
	useEffect(() => {
		if (drivePath.type !== "sharedIn") {
			return
		}

		const selected = useDriveStore.getState().selectedItems
		const kept = selected.filter(item => {
			const sharer = getSharerIdentity(item)

			return !sharer || !isBlocked(sharer, blocked)
		})

		if (kept.length !== selected.length) {
			useDriveStore.getState().setSelectedItems(kept)
		}
	}, [blocked, drivePath.type])

	useFocusEffect(
		useCallback(() => {
			useDriveStore.getState().clearSelectedItems()

			return () => {
				useDriveStore.getState().clearSelectedItems()
			}
		}, [])
	)

	return (
		<Fragment>
			<Header
				setSearchQuery={setSearchQuery}
				listItems={items}
				searchStatus={status}
			/>
			<SafeAreaView
				className={cn(
					"flex-1",
					drivePath.type === "drive" && !drivePath.selectOptions ? "bg-background" : "bg-background-secondary"
				)}
				edges={["left", "right"]}
			>
				{/*  disabled={!(drivePath.type === "drive" && !drivePath.uuid && !drivePath.selectOptions && !drivePath.linked)} */}
				{/*
				 * Measuring wrapper: ref + onLayout let useViewLayout track the available
				 * width so we can compute gridItemWidth before VirtualList renders. Mirrors
				 * the same pattern used in features/photos/screens/photos.tsx.
				 */}
				<View
					ref={containerRef}
					onLayout={onLayout}
					className="flex-1 bg-transparent"
				>
					<LazyWrapper>
						<VirtualList
							ref={listRef}
							key={isGridActive ? `grid-${columns}` : "list"}
							className={cn("flex-1", driveScreenUsesBaseBackground(drivePath) ? "bg-background" : "bg-background-secondary")}
							contentInsetAdjustmentBehavior="automatic"
							contentContainerClassName={cn("pb-80", Platform.OS === "android" && "pb-96", isGridActive && "px-2")}
							keyExtractor={(item: DriveItem) => {
								return item.data.uuid
							}}
							data={items}
							// Offline VIRTUAL ROOT only (nested offline dirs have a uuid): surfaces
							// the last sync pass's error count as a pressable row above the listing.
							// The row hides itself while there are no errors.
							headerComponent={drivePath.type === "offline" && !drivePath.uuid ? () => <SyncErrorsHeaderRow /> : undefined}
							grid={isGridActive}
							itemWidth={isGridActive ? gridItemWidth : undefined}
							itemHeight={isGridActive ? gridItemHeight : undefined}
							itemsPerRow={isGridActive ? columns : undefined}
							renderItem={(info: ListRenderItemInfo<DriveItem>) => {
								if (isGridActive) {
									return (
										<GridItem
											info={info}
											drivePath={drivePath}
											getListItems={() => items}
											itemWidth={gridItemWidth}
											highlighted={info.item.data.uuid === highlightedUuid}
										/>
									)
								}

								return (
									<Item
										info={info}
										drivePath={drivePath}
										getListItems={() => items}
										searchParentPath={isCacheSearch ? searchResultPaths.get(info.item.data.uuid) : undefined}
										highlighted={info.item.data.uuid === highlightedUuid}
									/>
								)
							}}
							// Cache search is live (no manual refetch): suppress pull-to-refresh while it's
							// the source. Every non-cache-search context keeps the existing refresh.
							onRefresh={
								isCacheSearch
									? undefined
									: async () => {
											// The offline cache listing reads purely from local storage
											// (the query is networkMode: "always"), so pull-to-refresh must
											// work while offline. Every other variant hits the network.
											if (!onlineManager.isOnline() && drivePath.type !== "offline") {
												return
											}

											// Manual offline-cache sync on pull-to-refresh — fire-and-forget
											// so the gesture resolves with the local listing refetch;
											// offlineSync gates connectivity/Wi-Fi-only internally.
											if (drivePath.type === "offline") {
												offlineSync
													.sync({ manual: true })
													.catch(e => logger.warn("drive", "offline sync failed", { error: e }))
											}

											const result = await run(async () => {
												return await driveItemsQuery.refetch()
											})

											if (!result.success) {
												logger.error("drive", "drive list refresh failed", { error: result.error })
												alerts.error(result.error)
											}
										}
							}
							loading={driveItemsQuery.status === "pending" || (isCacheSearch && status === "warming")}
							footerComponent={
								isCacheSearch || hiddenCount > 0
									? () => (
											<DriveListFooter
												status={status}
												totalCount={totalCount}
												loadedCount={searchResults.length}
												renderedCount={items.length}
												hiddenCount={hiddenCount}
												setting={hiddenSetting}
												settingPath={hiddenSettingPath}
											/>
										)
									: undefined
							}
							emptyComponent={() => {
								// The rows exist and were withheld by a local preference, which none of the
								// states below describe — including the query-error branch, which would
								// otherwise claim the directory failed to load when it loaded fine and the
								// preference emptied it. That branch's Try-again is carried here instead, so
								// a listing that BOTH failed to refresh and filtered to nothing still offers
								// the retry. Unreachable from a terminal search — that hides its results, so
								// nothing was filtered.
								if (emptiedByHiddenFilter) {
									return (
										<ListEmpty
											icon="eye-off-outline"
											title={searchActive ? t("all_matches_hidden") : t("all_items_hidden")}
											description={
												searchTruncated
													? t("all_matches_hidden_truncated_description", {
															setting: hiddenSetting,
															path: hiddenSettingPath
														})
													: searchActive
														? t("all_matches_hidden_description", {
																setting: hiddenSetting,
																path: hiddenSettingPath
															})
														: t("all_items_hidden_description", {
																setting: hiddenSetting,
																path: hiddenSettingPath
															})
											}
											action={
												!isCacheSearch && driveItemsQuery.status === "error" ? (
													<Button onPress={() => void driveItemsQuery.refetch()}>{t("try_again")}</Button>
												) : undefined
											}
										/>
									)
								}

								// Plain-drive cache search: its own terminal / no-results states. The
								// directory listing query is NOT the source here, so its error/empty
								// states don't apply (`warming` never reaches this — `loading` suppresses
								// emptyComponent). `searching-empty` (empty so far, resync still converging)
								// surfaces a "still searching" hint; a bare empty result is genuinely
								// settled/terminal.
								if (isCacheSearch) {
									if (status === "terminal") {
										return (
											<ListEmpty
												icon="alert-circle-outline"
												title={t("search_unavailable")}
												description={t("search_unavailable_description")}
											/>
										)
									}

									// Empty so far while the convergence resync is still streaming the
									// subtree in: an explicit "no results yet, still searching" with a
									// spinner instead of a premature "no results" or a bare full-screen loader.
									if (status === "searching-empty") {
										return (
											<ListEmpty
												icon="search-outline"
												title={t("no_results_yet")}
												description={t("still_searching_description")}
												action={
													<ActivityIndicator
														size="small"
														color={textForegroundColor}
													/>
												}
											/>
										)
									}

									return (
										<ListEmpty
											icon="search-outline"
											title={t("no_results")}
											description={t("no_results_description")}
										/>
									)
								}

								// #26 — distinguish a query error with no retained data (show
								// error + retry) from a genuinely empty directory (existing empty
								// state). When data was retained through the error, items.length
								// will be > 0 and this component is not rendered at all.
								if (driveItemsQuery.status === "error") {
									return (
										<ListEmpty
											icon="alert-circle-outline"
											title={t("could_not_load_directory")}
											description={t("please_check_connection")}
											action={<Button onPress={() => void driveItemsQuery.refetch()}>{t("try_again")}</Button>}
										/>
									)
								}

								// Local-filter search (favorites/trash/recents/select/…) with no matches.
								if (searchActive) {
									return (
										<ListEmpty
											icon="search-outline"
											title={t("no_results")}
											description={t("no_results_description")}
										/>
									)
								}

								return (
									<ListEmpty
										icon={getDriveEmptyStateIcon(drivePath.type)}
										title={t(getDriveEmptyStateTitleKey(drivePath.type))}
										description={t(getDriveEmptyStateDescriptionKey(drivePath.type))}
										action={
											driveCreateButtons.length > 0 ? (
												<Menu
													type="dropdown"
													buttons={driveCreateButtons}
												>
													<PressableScale className="flex-row items-center gap-1.5 px-4 py-2">
														<Ionicons
															name="add"
															size={20}
															color={primaryColor}
														/>
														<Text
															style={{ color: primaryColor }}
															className="text-base font-medium"
														>
															{t("add")}
														</Text>
													</PressableScale>
												</Menu>
											) : undefined
										}
									/>
								)
							}}
						/>
					</LazyWrapper>
				</View>
			</SafeAreaView>
		</Fragment>
	)
}

export default Drive

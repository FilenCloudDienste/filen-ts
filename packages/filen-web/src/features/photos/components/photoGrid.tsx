import { useCallback, useDeferredValue, useEffect, useMemo, useState, type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { SearchXIcon } from "lucide-react"
import { useShallow } from "zustand/shallow"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useAction } from "@/lib/keymap/useAction"
import { useIsOnline } from "@/lib/useIsOnline"
import { selectableForSelectAll } from "@/features/drive/lib/selectionFlags"
import { reconcileSelectedItems } from "@/features/drive/components/directoryListing.logic"
import { canCopyToClipboard, shouldHandleClipboardShortcut } from "@/features/drive/lib/clipboard.logic"
import { clipboardShortcutContext, copyToClipboard } from "@/features/drive/lib/clipboard"
import { KEEP_SELECTION_PROPS } from "@/features/drive/lib/clickAway.logic"
import { SearchInput } from "@/features/drive/components/searchInput"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { type PhotosListing } from "@/features/photos/queries/photos"
import {
	EMPTY_PHOTOS_FILTER,
	filterPhotos,
	isPhotosFilterActive,
	monthNameTable,
	photoKindsPresent,
	type PhotosFilter,
	type PhotosKindFilter
} from "@/features/photos/lib/search"
import {
	buildPhotosTimeline,
	formatTimelineMonth,
	timelineIndexAtPoint,
	timelineMarqueeIndices,
	timelineRowSize
} from "@/features/photos/lib/timeline"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"
import { usePhotosSelection } from "@/features/photos/hooks/usePhotosSelection"
import { usePhotosGridNav } from "@/features/photos/hooks/usePhotosGridNav"
import { useMarqueeSelection } from "@/features/drive/hooks/useMarqueeSelection"
import { useClickAwayDeselect } from "@/features/drive/hooks/useClickAwayDeselect"
import { usePhotosDialogHost } from "@/features/photos/hooks/usePhotosDialogHost"
import { resolveTileClickIntent, previewOpenTarget } from "@/features/photos/components/photoGrid.logic"
import { usePhotosGridDensityQuery } from "@/features/photos/queries/preferences"
import { DEFAULT_DENSITY_INDEX, tileSizeForDensity, columnsForWidth } from "@/features/photos/lib/gridDensity"
import { PhotoTile } from "@/features/photos/components/photoTile"
import { setThumbnailVisibleSlots } from "@/features/drive/lib/thumbnails"
import { PhotosBulkActionBar } from "@/features/photos/components/bulkActionBar"
import { TimelineScrubber } from "@/features/photos/components/timelineScrubber"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

// Spacer between tiles only, never along the grid's outer edges: CSS grid gap separates columns and
// the virtualizer's gap separates rows. 2px reads as a seam, not as padding.
const GRID_GAP = 2
const GRID_OVERSCAN = 3
// Bulk bar only earns its own floating UI at 2+ selected — a single selection is already fully
// covered by that one tile's own context menu (photosItemActions), unlike drive's listing which
// shows its bar from 1 (a deliberate photos-only threshold, not a drive gating drift).
const BULK_BAR_MIN_SELECTION = 2

const KIND_CHIPS: readonly {
	kind: PhotosKindFilter
	labelKey: "photosFilterAll" | "photosFilterImages" | "photosFilterVideos" | "photosFilterRaw"
}[] = [
	{ kind: "all", labelKey: "photosFilterAll" },
	{ kind: "image", labelKey: "photosFilterImages" },
	{ kind: "video", labelKey: "photosFilterVideos" },
	{ kind: "rawImage", labelKey: "photosFilterRaw" }
]

export interface PhotoGridProps {
	rootUuid: string
	listing: PhotosListing
}

export function PhotoGrid({ rootUuid, listing }: PhotoGridProps) {
	const { t, i18n } = useTranslation(["drive", "photos"])
	const isOnline = useIsOnline()
	const densityQuery = usePhotosGridDensityQuery()
	const densityIndex = densityQuery.data ?? DEFAULT_DENSITY_INDEX
	const tileSize = tileSizeForDensity(densityIndex)

	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const [containerWidth, setContainerWidth] = useState(0)
	const [containerHeight, setContainerHeight] = useState(0)
	const [anchorUuid, setAnchorUuid] = useState<string | null>(null)
	const [filter, setFilter] = useState<PhotosFilter>(EMPTY_PHOTOS_FILTER)

	// Typing stays responsive over a large library: the grid re-filters at lower priority than the input.
	const query = useDeferredValue(filter.query)
	const favoritesOnly = filter.favoritesOnly
	const language = i18n.language
	// Memoized by hand below: useVirtualizer opts this component out of the React Compiler, and the
	// virtualizer re-renders it on every scroll frame.
	const kinds = useMemo(() => photoKindsPresent(listing.photos, listing.folders), [listing])
	// Kind chips only show while the listing holds two kinds or more; a kind that has since vanished (its
	// last video trashed) must not leave the grid filtered by a chip no longer on screen.
	const kind = kinds.size > 1 && filter.kind !== "all" && kinds.has(filter.kind) ? filter.kind : "all"
	const filtered = useMemo(
		() => filterPhotos(listing.photos, listing.folders, { query, kind, favoritesOnly }, monthNameTable(language)),
		[listing, query, kind, favoritesOnly, language]
	)
	const items = filtered.items

	const selection = usePhotosStore(useShallow(state => state.selectedItems))
	// Each selected photo as the grid now holds it, not as it was when selected: a rename or favorite
	// replaces it in the grid, never in the selection (see reconcileSelectedItems). Both inputs hold across
	// scroll renders, so those do no work proportional to the selection.
	const selectedItems = useMemo(() => reconcileSelectedItems(selection, items), [selection, items])
	const selectedUuids = useMemo(() => new Set(selectedItems.map(selected => selected.data.uuid)), [selectedItems])
	const { handlePointerSelect } = usePhotosSelection(items, anchorUuid, setAnchorUuid)
	const { isDialogOpen, handleItemAction, handleBulkDialogAction, openPreview, renderActiveDialog } = usePhotosDialogHost({
		rootUuid,
		selectedItems
	})

	// Plain click opens the viewer (browsing is the grid's whole point); once a selection is active a
	// plain click instead falls through to handlePointerSelect's own plain-click branch (select just this
	// item, or deselect it when it is the whole selection), exactly matching drive's plain-click
	// convention. A modifier click always builds/extends the selection regardless of selection state —
	// see photoGrid.logic.ts's own doc comment on resolveTileClickIntent for the full decision table.
	function handleTileClick(index: number, event: MouseEvent<HTMLDivElement>): void {
		const intent = resolveTileClickIntent(event, selectedItems.length > 0)

		if (intent.kind === "open") {
			handleOpenAt(index)

			return
		}

		handlePointerSelect(index, event)
		// The cursor follows the click, exactly as drive's own handlePointerSelect moves activeUuid.
		setActive(index)
	}

	// One open path shared by a plain click and Enter.
	function handleOpenAt(index: number): void {
		const target = previewOpenTarget(items, index)

		if (target) {
			openPreview(target.sources, target.index)
		}
	}

	// A fresh root must never inherit a previous root's selection — the store outlives this grid, which
	// the screen remounts per root (so anchor, cursor and search start fresh on their own).
	useEffect(() => {
		usePhotosStore.getState().clearSelectedItems()
	}, [rootUuid])

	useEffect(() => {
		if (!scrollElement) {
			return
		}

		const observer = new ResizeObserver(entries => {
			const entry = entries[0]

			if (entry) {
				setContainerWidth(entry.contentRect.width)
				setContainerHeight(entry.contentRect.height)
			}
		})

		observer.observe(scrollElement)

		return () => {
			observer.disconnect()
		}
	}, [scrollElement])

	// The density's tile size only decides how many columns fit; each tile then fills its share of the
	// width after the gaps, and rows are that tall, so no slack is left anywhere.
	const columns = columnsForWidth(containerWidth, tileSize, GRID_GAP)
	const cellSize = containerWidth > 0 ? (containerWidth - GRID_GAP * (columns - 1)) / columns : tileSize
	const timeline = useMemo(() => buildPhotosTimeline(filtered.entries, columns, cellSize, GRID_GAP), [filtered, columns, cellSize])

	// This grid lays out its own tiles, so it sizes the shared thumbnail objectURL cache itself: the
	// visible rows plus one partial row, the cache's headroom covering the overscan rows either side.
	useEffect(() => {
		setThumbnailVisibleSlots(columns * (Math.ceil(containerHeight / cellSize) + 1))
	}, [columns, cellSize, containerHeight])
	// Changing with the timeline is what makes the virtualizer re-read row sizes (it re-lays rows only
	// when its key function changes); stable otherwise, so a scroll frame re-lays nothing.
	const getRowKey = useCallback((index: number) => timeline.rows[index]?.key ?? index, [timeline])

	// Sizes come from the timeline, never from measuring.
	const virtualizer = useVirtualizer({
		count: timeline.rows.length,
		getScrollElement: () => scrollElement,
		estimateSize: index => {
			const row = timeline.rows[index]

			return row === undefined ? cellSize : timelineRowSize(timeline, row)
		},
		gap: GRID_GAP,
		overscan: GRID_OVERSCAN,
		getItemKey: getRowKey
	})

	const { safeActiveIndex, handleKeyDown, registerRef, setActive, setCursor, resetCursor } = usePhotosGridNav({
		items,
		timeline,
		virtualizer,
		anchorUuid,
		setAnchorUuid,
		onOpen: handleOpenAt
	})

	// Rubber-band selection over blank grid space — the same hook the drive listing uses, with the
	// timeline's own hit-test (month headers make rows uneven) and photos' selection store injected.
	const marquee = useMarqueeSelection({
		items,
		hitTest: {
			indices: (rect, contentWidth) => timelineMarqueeIndices(rect, timeline, contentWidth),
			indexAtPoint: (x, y, contentWidth) => timelineIndexAtPoint(x, y, timeline, contentWidth)
		},
		selection: {
			read: () => usePhotosStore.getState().selectedItems,
			write: next => {
				usePhotosStore.getState().setSelectedItems(next)
			}
		},
		scrollElement,
		setCursor
	})

	// Drive parity (directoryListing.tsx): a plain click on empty space drops the selection.
	useClickAwayDeselect(selectedItems.length > 0, () => {
		usePhotosStore.getState().clearSelectedItems()
	})

	useAction(
		"photos.selectAll",
		keyboardEvent => {
			if (isDialogOpen) {
				return
			}

			keyboardEvent.preventDefault()
			// selectableForSelectAll's undecryptable filter is a no-op here (isPhotoItem's own
			// precondition already excludes undecryptable rows) — reused for the same defense-in-depth
			// reason the drive listing keeps it rather than assuming the invariant holds forever.
			usePhotosStore.getState().setSelectedItems(selectableForSelectAll(items) as PhotoItem[])
		},
		undefined,
		[isDialogOpen, items]
	)

	useAction(
		"photos.clearSelection",
		() => {
			if (isDialogOpen) {
				return
			}

			usePhotosStore.getState().clearSelectedItems()
		},
		undefined,
		[isDialogOpen]
	)

	// Gated on the same threshold that mounts the bulk bar and on the same offline rule its Trash button
	// uses (bulkActionBar.tsx) — a trash has nothing to reach without a connection. preventDefault:
	// Backspace still has a "go back" default in some engines.
	useAction(
		"photos.trash",
		keyboardEvent => {
			keyboardEvent.preventDefault()

			if (isDialogOpen || !isOnline || selectedItems.length < BULK_BAR_MIN_SELECTION) {
				return
			}

			handleBulkDialogAction("trash")
		},
		undefined,
		[isDialogOpen, isOnline, selectedItems]
	)

	// Copies the selection onto the drive clipboard, for a paste into a Cloud Drive directory. Photos has
	// no directory to paste into, and no Move, so no paste or cut here. Stands down like drive's own
	// (useDriveClipboard.ts), leaving text copy to the browser.
	useAction(
		"photos.copy",
		keyboardEvent => {
			if (
				isDialogOpen ||
				!shouldHandleClipboardShortcut(clipboardShortcutContext(keyboardEvent, true)) ||
				!canCopyToClipboard(selectedItems, "drive")
			) {
				return
			}

			keyboardEvent.preventDefault()
			copyToClipboard(selectedItems)
		},
		undefined,
		[isDialogOpen, selectedItems]
	)

	// A changed search or filter shows a different set: the selection, anchor, cursor and scroll position
	// of the old one go. A selection hidden by a filter would otherwise ride along into a bulk trash.
	function updateFilter(update: (prev: PhotosFilter) => PhotosFilter): void {
		setFilter(update)
		usePhotosStore.getState().clearSelectedItems()
		setAnchorUuid(null)
		resetCursor()
		scrollElement?.scrollTo({ top: 0 })
	}

	return (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
			<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-3">
				<SearchInput
					action="photos.search"
					label={t("photos:photosSearch")}
					value={filter.query}
					onChange={next => {
						updateFilter(prev => ({ ...prev, query: next }))
					}}
					onClear={() => {
						updateFilter(prev => ({ ...prev, query: "" }))
					}}
					dialogOpen={isDialogOpen}
				/>
				<div
					role="group"
					aria-label={t("photos:photosFilterLabel")}
					className="flex flex-wrap items-center gap-1"
					{...KEEP_SELECTION_PROPS}
				>
					{kinds.size > 1
						? KIND_CHIPS.filter(chip => chip.kind === "all" || kinds.has(chip.kind)).map(chip => (
								<Button
									key={chip.kind}
									variant={kind === chip.kind ? "secondary" : "outline"}
									size="xs"
									className="rounded-full"
									aria-pressed={kind === chip.kind}
									onClick={() => {
										updateFilter(prev => ({ ...prev, kind: chip.kind }))
									}}
								>
									{t(`photos:${chip.labelKey}`)}
								</Button>
							))
						: null}
					<Button
						variant={filter.favoritesOnly ? "secondary" : "outline"}
						size="xs"
						className="rounded-full"
						aria-pressed={filter.favoritesOnly}
						onClick={() => {
							updateFilter(prev => ({ ...prev, favoritesOnly: !prev.favoritesOnly }))
						}}
					>
						{t("photos:photosFilterFavorites")}
					</Button>
				</div>
				{isPhotosFilterActive({ query, kind, favoritesOnly }) ? (
					<span
						role="status"
						className="ml-auto text-xs text-muted-foreground tabular-nums"
					>
						{t("photos:photosResultCount", { count: items.length })}
					</span>
				) : null}
			</div>
			{items.length === 0 ? (
				<div className="flex flex-1 overflow-y-auto">
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<SearchXIcon />
							</EmptyMedia>
							<EmptyTitle>{t("photos:photosNoMatchesTitle")}</EmptyTitle>
							<EmptyDescription>{t("photos:photosNoMatchesBody")}</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button
								variant="outline"
								onClick={() => {
									updateFilter(() => EMPTY_PHOTOS_FILTER)
								}}
							>
								{t("photos:photosClearFilters")}
							</Button>
						</EmptyContent>
					</Empty>
				</div>
			) : (
				<div className="flex min-h-0 flex-1">
					<div
						ref={setScrollElement}
						role="listbox"
						aria-multiselectable="true"
						aria-label={t("photos:photosGridLabel")}
						// Drive parity (directoryListing.tsx): the tab stop is the ACTIVE tile's own tabIndex={0},
						// never the container.
						tabIndex={-1}
						// The scrubber beside it is the scrollbar.
						className="min-h-0 min-w-0 flex-1 [scrollbar-width:none] overflow-y-auto [&::-webkit-scrollbar]:hidden"
						onKeyDown={handleKeyDown}
						onPointerDown={marquee.onPointerDown}
					>
						<div style={{ position: "relative", width: "100%", height: virtualizer.getTotalSize() }}>
							{/* Marquee rectangle — content-space, so it stretches correctly as the grid auto-scrolls, and
							    the FIRST child of the sized wrapper so it shares the tiles' own content-space origin.
							    Non-interactive (pointer-events-none) so it never intercepts the ongoing drag. */}
							{marquee.rect ? (
								<div
									aria-hidden="true"
									data-testid="marquee-rect"
									className="pointer-events-none absolute z-20 rounded-xs border border-primary/60 bg-primary/15"
									style={{
										left: marquee.rect.left,
										top: marquee.rect.top,
										width: marquee.rect.right - marquee.rect.left,
										height: marquee.rect.bottom - marquee.rect.top
									}}
								/>
							) : null}
							{virtualizer.getVirtualItems().map(virtualRow => {
								const row = timeline.rows[virtualRow.index]

								if (row === undefined) {
									return null
								}

								const rowStyle = {
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									height: virtualRow.size,
									transform: `translateY(${String(virtualRow.start)}px)`
								} as const

								if (row.kind === "header") {
									// Hidden from the listbox's own semantics, which only admit options; each tile still
									// names itself.
									return (
										<div
											key={virtualRow.key}
											aria-hidden="true"
											className="flex items-end px-4 pb-2 text-sm font-medium"
											style={rowStyle}
										>
											{formatTimelineMonth(language, row.year, row.month)}
										</div>
									)
								}

								return (
									<div
										key={virtualRow.key}
										style={{
											...rowStyle,
											display: "grid",
											gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`,
											gap: GRID_GAP
										}}
									>
										{items.slice(row.start, row.end).map((item, column) => {
											const itemIndex = row.start + column

											return (
												<PhotoTile
													key={item.data.uuid}
													rootUuid={rootUuid}
													item={item}
													index={itemIndex}
													total={items.length}
													selected={selectedUuids.has(item.data.uuid)}
													active={itemIndex === safeActiveIndex}
													registerRef={registerRef}
													onTileClick={handleTileClick}
													onItemAction={handleItemAction}
												/>
											)
										})}
									</div>
								)
							})}
						</div>
					</div>
					{scrollElement ? (
						<TimelineScrubber
							timeline={timeline}
							scrollElement={scrollElement}
						/>
					) : null}
				</div>
			)}
			{selectedItems.length >= BULK_BAR_MIN_SELECTION ? (
				<div className="pointer-events-none absolute inset-x-6 bottom-6 z-10 flex justify-center">
					<PhotosBulkActionBar
						rootUuid={rootUuid}
						selectedItems={selectedItems}
						onDialogAction={handleBulkDialogAction}
					/>
				</div>
			) : null}
			{renderActiveDialog()}
		</div>
	)
}

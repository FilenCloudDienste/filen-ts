import {
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type MouseEvent,
	type Ref
} from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveSortBy } from "@/features/drive/lib/sort"
import { type DriveViewMode } from "@/features/drive/lib/preferences"
import { GRID_INSET, ROW_HEIGHT, TILE_ROW_HEIGHT, TILE_WIDTH, columnsForWidth } from "@/features/drive/lib/gridLayout"
import { setThumbnailViewport } from "@/features/drive/lib/thumbnails"
import { rowRank } from "@/features/drive/lib/thumbnails.logic"
import { ThumbnailRankContext } from "@/features/drive/lib/thumbnailRank"
import { ThumbnailSourceContext } from "@/features/drive/lib/thumbnailSource"
import { listboxKeyTargetIsInteractive, openOptionContextMenu } from "@/features/drive/lib/listbox"
import { ListColumnHeader } from "@/features/drive/components/listColumnHeader"
import { MarqueeRect } from "@/features/drive/components/marqueeRect"
import { useMarqueeSelection } from "@/features/drive/hooks/useMarqueeSelection"
import { useRovingItemRefs } from "@/features/drive/hooks/useRovingItemRefs"
import { usePublicListboxNav } from "@/features/publicLinks/hooks/usePublicListboxNav"
import { BrowseRow, SelectionBox } from "@/features/publicLinks/components/browseRow"
import { BrowseTile } from "@/features/publicLinks/components/browseTile"
import { linkThumbnailSource } from "@/features/publicLinks/lib/thumbnails"
import {
	DEFAULT_PUBLIC_SORT,
	selectionCheck,
	toggleAllSelection,
	toggleSelection,
	type BrowseActionDescriptor,
	type BrowseEntry,
	type BrowseSelection
} from "@/features/publicLinks/lib/browse.logic"
import { type BrowseMenu } from "@/features/publicLinks/components/browseRow"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import { useElementSize } from "@/lib/useElementSize"
import { useLatestRef } from "@/lib/useLatestRef"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"

const LIST_OVERSCAN = 8
const GRID_OVERSCAN = 3
// The grid's inset between the tiles and the pane's edges, as the drive's grid has it.
const GRID_LISTBOX_STYLE: CSSProperties = { padding: GRID_INSET }

export interface BrowseListHandle {
	// The filter's ArrowDown: the list takes focus on its cursor row.
	focusCursor: () => void
	// How far the rows are scrolled, kept as a file opens from them.
	scrollOffset: () => number
}

// Where the list stood as a file opened from it: the list it returns to starts there, focused on that row.
export interface BrowseResume {
	key: string
	scrollOffset: number
}

export interface BrowseListProps {
	ref: Ref<BrowseListHandle>
	// Read as the list mounts; onResumed says it is spent.
	resume: BrowseResume | null
	onResumed: () => void
	entries: BrowseEntry[]
	selection: BrowseSelection
	onSelectionChange: (next: BrowseSelection) => void
	sort: DriveSortBy
	onSortChange: (next: DriveSortBy) => void
	// Rows under drive's column header, or drive's tiles with their thumbnails.
	viewMode: DriveViewMode
	// The link's preview cache scope (linkFingerprint): thumbnails reuse the bytes its previews hold.
	linkScope: string
	onOpen: (entry: BrowseEntry) => void
	// What a menu opened on an entry offers, and on which entries (the selection it is part of, or itself).
	menuFor: (entry: BrowseEntry) => BrowseMenu
	onAction: (descriptor: BrowseActionDescriptor, entries: readonly BrowseEntry[]) => void
}

// The level's entries as drive's list view (its column header with a select-all box ahead) or its grid view (a
// select-all bar over rows of tiles, image thumbnails read through the public-link client), one virtualized listbox
// with drive's keyboard and pointer selection and its marquee over blank space either way. The browser remounts it per
// level and per view, so the cursor and scroll start fresh, and as an opened file closes, which resumes them.
//
// useVirtualizer opts this component out of the React Compiler, so what the rows get is memoized by hand: the
// row handlers never change identity.
export function BrowseList({
	ref,
	resume,
	onResumed,
	entries,
	selection,
	onSelectionChange,
	sort,
	onSortChange,
	viewMode,
	linkScope,
	onOpen,
	menuFor,
	onAction
}: BrowseListProps) {
	const { t } = useTranslation(["drive", "publicLinks"])
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	// The mount's resume until it is spent: its offset as the listbox attaches, its row's focus once it has.
	const pendingResume = useRef(resume)
	const { registerRef, focusItem } = useRovingItemRefs()
	const items = useMemo<DriveItem[]>(() => entries.map(entry => entry.item), [entries])
	const grid = viewMode === "grid"
	const { width: contentWidth, height: contentHeight } = useElementSize(scrollElement)
	const columns = grid ? columnsForWidth(contentWidth, TILE_WIDTH) : 1
	const rowHeight = grid ? TILE_ROW_HEIGHT : ROW_HEIGHT
	// A list row is keyed by its entry; a grid row by its index (its tiles carry their own keys).
	const getItemKey = useCallback((index: number) => (grid ? index : (items[index]?.data.uuid ?? index)), [grid, items])

	const virtualizer = useVirtualizer({
		count: Math.ceil(items.length / columns),
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => rowHeight,
		overscan: grid ? GRID_OVERSCAN : LIST_OVERSCAN,
		// The grid's padding shifts every row down by GRID_INSET, which the offsets do not know about.
		scrollPaddingEnd: grid ? GRID_INSET * 2 : 0,
		getItemKey
	})

	// The thumbnail service's objectURL cache holds what this listing can show.
	useEffect(() => {
		setThumbnailViewport(contentWidth, contentHeight, viewMode)
	}, [contentWidth, contentHeight, viewMode])

	// Stable while scrolling: the range is read as a generation slot frees.
	const rankThumbnail = useCallback((index: number) => rowRank(Math.floor(index / columns), virtualizer.range), [columns, virtualizer])

	const nav = usePublicListboxNav({
		items,
		selection,
		onSelectionChange,
		virtualizer,
		focusItem,
		onOpen: index => {
			const entry = entries[index]

			if (entry !== undefined) {
				onOpen(entry)
			}
		},
		initialKey: resume?.key ?? null,
		columns,
		rowHeight
	})

	const marquee = useMarqueeSelection({
		items,
		viewMode,
		columns,
		geometry: { rowHeight, tileWidth: TILE_WIDTH },
		selection: {
			read: () => items.filter(item => selection.has(item.data.uuid)),
			write: next => {
				onSelectionChange(new Set(next.map(item => item.data.uuid)))
			}
		},
		scrollElement,
		setCursor: nav.setCursor
	})

	useImperativeHandle(ref, () => ({ focusCursor: nav.focusCursor, scrollOffset: () => scrollElement?.scrollTop ?? 0 }), [
		nav.focusCursor,
		scrollElement
	])

	// The rows' handlers read the latest render through one ref, so a row only re-renders for its own values.
	const latest = useLatestRef({ nav, entries, selection, onSelectionChange, onOpen, menuFor, onAction, onResumed })

	// A grid knows its columns once its width is measured; before that a tile's row would be read as a one-column one.
	const laidOut = !grid || contentWidth > 0

	// Back from an opened file: the keys go on from its row (already in view at the restored offset).
	useEffect(() => {
		if (scrollElement === null || !laidOut || pendingResume.current === null) {
			return
		}

		pendingResume.current = null
		latest.current.nav.focusCursor()
		latest.current.onResumed()
	}, [scrollElement, laidOut, latest])
	const handlePointerSelect = useCallback(
		(index: number, event: MouseEvent<HTMLDivElement>, pointerType: string) => {
			latest.current.nav.handlePointerSelect(index, event, pointerType)
		},
		[latest]
	)
	const handleOpen = useCallback(
		(index: number) => {
			const entry = latest.current.entries[index]

			if (entry !== undefined) {
				latest.current.nav.setCursor(index)
				latest.current.onOpen(entry)
			}
		},
		[latest]
	)
	const handleToggle = useCallback(
		(index: number) => {
			const { entries: current, selection: selected, onSelectionChange: change, nav: cursor } = latest.current
			const entry = current[index]

			if (entry !== undefined) {
				cursor.setCursor(index)
				change(toggleSelection(selected, entry.item.data.uuid))
			}
		},
		[latest]
	)
	// A right-click outside the selection retargets it to the entry, as in drive, so the menu acts on what is shown
	// selected.
	const handleRetarget = useCallback(
		(index: number) => {
			const { entries: current, onSelectionChange: change, nav: cursor } = latest.current
			const entry = current[index]

			if (entry !== undefined) {
				cursor.setCursor(index)
				change(new Set([entry.item.data.uuid]))
			}
		},
		[latest]
	)
	const handleMenuFor = useCallback((entry: BrowseEntry) => latest.current.menuFor(entry), [latest])
	const handleAction = useCallback(
		(descriptor: BrowseActionDescriptor, entries: readonly BrowseEntry[]) => {
			latest.current.onAction(descriptor, entries)
		},
		[latest]
	)

	// Scoped to the listbox: Enter opens the cursor row, and is every other control's own key. A row's ⋯
	// trigger owns its keys.
	const openRef = useAction(
		"drive.open",
		event => {
			if (listboxKeyTargetIsInteractive(event.target)) {
				return
			}

			const entry = entries[nav.safeActiveIndex]

			if (entry !== undefined) {
				event.preventDefault()
				onOpen(entry)
			}
		},
		OUTSIDE_OVERLAYS,
		[entries, nav.safeActiveIndex, onOpen]
	)

	// The cursor row's own menu, as a right-click on it.
	const itemMenuRef = useAction(
		"drive.openItemMenu",
		event => {
			if (openOptionContextMenu(event.target)) {
				event.preventDefault()
			}
		},
		OUTSIDE_OVERLAYS
	)

	const listboxRef = useCallback(
		(element: HTMLDivElement | null) => {
			// Before the virtualizer attaches, which reads the offset as it does: the rows render where they stood.
			if (element !== null && pendingResume.current !== null) {
				element.scrollTop = pendingResume.current.scrollOffset
			}

			setScrollElement(element)
			openRef(element)
			itemMenuRef(element)
		},
		[openRef, itemMenuRef]
	)

	const headerCheck = selectionCheck(entries, selection)
	const selectAll = (
		<button
			type="button"
			role="checkbox"
			aria-checked={headerCheck === "mixed" ? "mixed" : headerCheck === "on"}
			aria-label={t("publicLinks:selectAll")}
			disabled={entries.length === 0}
			className="flex shrink-0 rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
			onClick={() => {
				onSelectionChange(toggleAllSelection(entries, selection))
			}}
		>
			<SelectionBox check={headerCheck} />
		</button>
	)

	function renderEntry(index: number, start: number) {
		const entry = entries[index]

		if (entry === undefined) {
			return null
		}

		const cell = {
			entry,
			index,
			total: entries.length,
			selected: selection.has(entry.item.data.uuid),
			active: index === nav.safeActiveIndex,
			onPointerSelect: handlePointerSelect,
			onOpen: handleOpen,
			onToggle: handleToggle,
			onRetarget: handleRetarget,
			menuFor: handleMenuFor,
			onAction: handleAction,
			registerRef
		}

		return grid ? (
			<BrowseTile
				key={entry.item.data.uuid}
				{...cell}
			/>
		) : (
			<BrowseRow
				key={entry.item.data.uuid}
				{...cell}
				start={start}
			/>
		)
	}

	return (
		<>
			{grid ? (
				// The grid has no columns to sort by (the sort menu beside the filter does it): only the select-all box.
				<div className="flex h-10 shrink-0 items-center border-b border-border px-4">{selectAll}</div>
			) : (
				<ListColumnHeader
					sort={sort}
					onSortChange={next => {
						onSortChange(next ?? DEFAULT_PUBLIC_SORT)
					}}
					disabled={false}
					leading={selectAll}
				/>
			)}
			<div
				ref={listboxRef}
				role="listbox"
				aria-multiselectable="true"
				aria-label={t("drive:driveListLabel")}
				tabIndex={-1}
				onKeyDown={nav.handleKeyDown}
				onPointerDown={marquee.onPointerDown}
				className="min-h-0 flex-1 scrollbar-gutter-stable overflow-y-auto"
				style={grid ? GRID_LISTBOX_STYLE : undefined}
			>
				<ThumbnailSourceContext value={linkThumbnailSource(linkScope)}>
					<ThumbnailRankContext value={rankThumbnail}>
						<div
							role="presentation"
							style={{ position: "relative", width: "100%", height: virtualizer.getTotalSize() }}
						>
							<MarqueeRect store={marquee.rectStore} />
							{virtualizer.getVirtualItems().map(virtualRow =>
								grid ? (
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
										{Array.from({ length: columns }, (_, column) =>
											renderEntry(virtualRow.index * columns + column, 0)
										)}
									</div>
								) : (
									renderEntry(virtualRow.index, virtualRow.start)
								)
							)}
						</div>
					</ThumbnailRankContext>
				</ThumbnailSourceContext>
			</div>
		</>
	)
}

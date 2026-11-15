import { useCallback, useImperativeHandle, useMemo, useState, type MouseEvent, type Ref } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveSortBy } from "@/features/drive/lib/sort"
import { ROW_HEIGHT, TILE_WIDTH } from "@/features/drive/lib/gridLayout"
import { listboxKeyTargetIsInteractive, openOptionContextMenu } from "@/features/drive/lib/listbox"
import { ListColumnHeader } from "@/features/drive/components/listColumnHeader"
import { MarqueeRect } from "@/features/drive/components/marqueeRect"
import { useMarqueeSelection } from "@/features/drive/hooks/useMarqueeSelection"
import { useRovingItemRefs } from "@/features/drive/hooks/useRovingItemRefs"
import { usePublicListboxNav } from "@/features/publicLinks/hooks/usePublicListboxNav"
import { BrowseRow, SelectionBox } from "@/features/publicLinks/components/browseRow"
import {
	DEFAULT_PUBLIC_SORT,
	selectionCheck,
	toggleAllSelection,
	toggleSelection,
	type BrowseEntry,
	type BrowseEntryAction,
	type BrowseSelection
} from "@/features/publicLinks/lib/browse.logic"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import { useLatestRef } from "@/lib/useLatestRef"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"

const LIST_OVERSCAN = 8

export interface BrowseListHandle {
	// The filter's ArrowDown: the list takes focus on its cursor row.
	focusCursor: () => void
}

export interface BrowseListProps {
	ref: Ref<BrowseListHandle>
	entries: BrowseEntry[]
	selection: BrowseSelection
	onSelectionChange: (next: BrowseSelection) => void
	sort: DriveSortBy
	onSortChange: (next: DriveSortBy) => void
	downloadable: boolean
	downloadBusy: boolean
	saveable: boolean
	onOpen: (entry: BrowseEntry) => void
	onAction: (entry: BrowseEntry, action: BrowseEntryAction) => void
}

// The level's entries as drive's list view: its column header with a select-all box ahead, a virtualized
// listbox with drive's keyboard and pointer selection, and its marquee over blank space. The browser remounts
// it per level, so the cursor and scroll start fresh.
//
// useVirtualizer opts this component out of the React Compiler, so what the rows get is memoized by hand: the
// row handlers never change identity.
export function BrowseList({
	ref,
	entries,
	selection,
	onSelectionChange,
	sort,
	onSortChange,
	downloadable,
	downloadBusy,
	saveable,
	onOpen,
	onAction
}: BrowseListProps) {
	const { t } = useTranslation(["drive", "publicLinks"])
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const { registerRef, focusItem } = useRovingItemRefs()
	const items = useMemo<DriveItem[]>(() => entries.map(entry => entry.item), [entries])
	const getItemKey = useCallback((index: number) => items[index]?.data.uuid ?? index, [items])

	const virtualizer = useVirtualizer({
		count: items.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => ROW_HEIGHT,
		overscan: LIST_OVERSCAN,
		getItemKey
	})

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
		}
	})

	const marquee = useMarqueeSelection({
		items,
		viewMode: "list",
		columns: 1,
		geometry: { rowHeight: ROW_HEIGHT, tileWidth: TILE_WIDTH },
		selection: {
			read: () => items.filter(item => selection.has(item.data.uuid)),
			write: next => {
				onSelectionChange(new Set(next.map(item => item.data.uuid)))
			}
		},
		scrollElement,
		setCursor: nav.setCursor
	})

	useImperativeHandle(ref, () => ({ focusCursor: nav.focusCursor }), [nav.focusCursor])

	// The rows' handlers read the latest render through one ref, so a row only re-renders for its own values.
	const latest = useLatestRef({ nav, entries, selection, onSelectionChange, onOpen, onAction })
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
	const handleAction = useCallback(
		(entry: BrowseEntry, action: BrowseEntryAction) => {
			latest.current.onAction(entry, action)
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
			setScrollElement(element)
			openRef(element)
			itemMenuRef(element)
		},
		[openRef, itemMenuRef]
	)

	const headerCheck = selectionCheck(entries, selection)

	return (
		<>
			<ListColumnHeader
				sort={sort}
				onSortChange={next => {
					onSortChange(next ?? DEFAULT_PUBLIC_SORT)
				}}
				disabled={false}
				leading={
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
				}
			/>
			<div
				ref={listboxRef}
				role="listbox"
				aria-multiselectable="true"
				aria-label={t("drive:driveListLabel")}
				tabIndex={-1}
				onKeyDown={nav.handleKeyDown}
				onPointerDown={marquee.onPointerDown}
				className="min-h-0 flex-1 overflow-y-auto"
			>
				<div
					role="presentation"
					style={{ position: "relative", width: "100%", height: virtualizer.getTotalSize() }}
				>
					<MarqueeRect store={marquee.rectStore} />
					{virtualizer.getVirtualItems().map(virtualRow => {
						const entry = entries[virtualRow.index]

						if (entry === undefined) {
							return null
						}

						return (
							<BrowseRow
								key={virtualRow.key}
								entry={entry}
								index={virtualRow.index}
								total={entries.length}
								start={virtualRow.start}
								selected={selection.has(entry.item.data.uuid)}
								active={virtualRow.index === nav.safeActiveIndex}
								downloadable={downloadable}
								downloadBusy={downloadBusy}
								saveable={saveable}
								onPointerSelect={handlePointerSelect}
								onOpen={handleOpen}
								onToggle={handleToggle}
								onAction={handleAction}
								registerRef={registerRef}
							/>
						)
					})}
				</div>
			</div>
		</>
	)
}

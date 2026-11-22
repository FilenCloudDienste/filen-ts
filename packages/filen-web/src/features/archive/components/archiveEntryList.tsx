import {
	useCallback,
	useContext,
	useEffect,
	useEffectEvent,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode
} from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { type ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, MinusIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { ENTRY_FLAG, skipReasonOf } from "@/lib/sdk/archiveListing"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import { useLatestRef } from "@/lib/useLatestRef"
import { isRecordingCombo, useBindings } from "@/lib/keymap/registry"
import { isImeKeydown } from "@filen/shared/keymap"
import { LIST_MODIFIED_COLUMN_CLASS, LIST_SIZE_COLUMN_CLASS, LIST_TRAILING_SLOT_CLASS } from "@/features/drive/lib/listingCells"
import {
	ARCHIVE_LIST_OVERSCAN,
	ARCHIVE_ROW_HEIGHT,
	browserKeyAction,
	entryRowKind,
	hasFlag,
	positionIndex,
	rowElementId,
	rowFlags,
	rowName,
	rowSkip,
	SKIP_LABEL_KEYS,
	type BrowserListKeyAction,
	type ReadingRow,
	type RowPosition
} from "@/features/archive/lib/archiveBrowser.logic"
import type { ListingSnapshot } from "@/features/archive/lib/listingSession"
import { EMPTY_SELECTION, isSelectable, rowCheck, type RowCheck, type Selection } from "@/features/archive/lib/selection"
import { useMarqueeSelection } from "@/features/drive/hooks/useMarqueeSelection"
import { MarqueeRect } from "@/features/drive/components/marqueeRect"
import { isEmptySpaceTarget, isPlainPointerClick } from "@/features/drive/lib/clickAway.logic"
import { isKeyboardContextMenu, openOptionContextMenu } from "@/features/drive/lib/listbox"
import { dirOfRef, isDirRef, type ChildSort, type ChildSortKey, type RowRef, type RowView } from "@/features/archive/lib/sortedChildren"
import { EntryMenuContext, type RowMenu } from "@/features/archive/lib/entryMenu"
import { ArchiveEntryRow, ArchiveReadingRow } from "@/features/archive/components/archiveEntryRow"
import { ArchiveRowContextMenuContent } from "@/features/archive/components/archiveEntryMenu"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"

export interface ArchiveEntryListProps {
	listId: string
	// Escape goes out of this archive into the one holding it.
	escapeLeaves: boolean
	// A change moves focus to the list again (an archive left for the one holding it).
	focusKey: number
	label: string
	// Changes with the view (another directory, search on or off), which starts at its cursor row.
	viewKey: string
	// Re-renders the list on every listing notification; its store is read in place.
	snapshot: ListingSnapshot
	rows: RowView
	selection: Selection
	cursor: RowPosition | null
	searchMode: boolean
	sort: ChildSort
	headerCheck: RowCheck
	// Nothing in the directory can be selected.
	headerDisabled: boolean
	// Shown in place of the rows when there are none, and no member is being read.
	empty: ReactNode
	// The member the listing is reading, shown after the rows.
	reading: ReadingRow | null
	onSort: (key: ChildSortKey) => void
	onHeaderCheck: () => void
	// The cursor's new index, which the list scrolls to; null when it didn't move.
	onKeyAction: (action: BrowserListKeyAction, pageSize: number) => number | null
	onPointer: (index: number, ref: RowRef, event: MouseEvent<HTMLDivElement>) => void
	onOpen: (ref: RowRef) => void
	onCheck: (index: number, ref: RowRef) => void
	onSelect: (next: Selection) => void
	// The selection a marquee over rows `indices` makes (MarqueeIndexSelection's cover).
	onMarquee: (indices: readonly number[], preset: Selection | null) => Selection
	// Puts the cursor (and the range anchor) on the row at `index`.
	onCursor: (index: number) => void
}

const SORT_COLUMNS: readonly { key: ChildSortKey; className: string }[] = [
	{ key: "name", className: "min-w-0 flex-1 justify-start" },
	{ key: "size", className: cn(LIST_SIZE_COLUMN_CLASS, "justify-end") },
	{ key: "modified", className: cn(LIST_MODIFIED_COLUMN_CLASS, "justify-end") }
]

const SORT_LABEL_KEYS = {
	name: "previewArchiveColumnName",
	size: "previewArchiveColumnSize",
	modified: "previewArchiveColumnModified"
} as const

// The archive browser's entries: one focusable listbox holding the selection state, its cursor named by
// aria-activedescendant, so no row carries an input of its own (a focused input would read as text
// editing and stop the overlay's Left/Right paging). Keys are taken here, before the overlay's own
// handler: each handled one is stopped there, Left/Right never are.
//
// useVirtualizer opts this component out of the React Compiler, so what the rows get is memoized by
// hand: the row handlers never change identity, and every row's props are primitives.
export function ArchiveEntryList({
	listId,
	escapeLeaves,
	focusKey,
	label,
	viewKey,
	snapshot,
	rows,
	selection,
	cursor,
	searchMode,
	sort,
	headerCheck,
	headerDisabled,
	empty,
	reading,
	onSort,
	onHeaderCheck,
	onKeyAction,
	onPointer,
	onOpen,
	onCheck,
	onSelect,
	onMarquee,
	onCursor
}: ArchiveEntryListProps) {
	const { t } = useTranslation(["preview", "drive"])
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const focusedOnce = useRef(false)
	// A keyboard menu asked for while the cursor row was out of the mounted rows.
	const menuPending = useRef(false)
	const handlers = useLatestRef({ onPointer, onOpen, onCheck })
	const store = snapshot.store
	const getItemKey = useCallback((index: number) => rows.at(index), [rows])
	const cursorIndex = useMemo(() => positionIndex(rows, cursor), [rows, cursor])
	const bindings = useBindings()
	const menuHost = useContext(EntryMenuContext)
	// What the open context menu offers; set as it opens.
	const [rowMenu, setRowMenu] = useState<RowMenu | null>(null)
	const handlePointer = useCallback(
		(index: number, ref: RowRef, event: MouseEvent<HTMLDivElement>) => {
			handlers.current.onPointer(index, ref, event)
		},
		[handlers]
	)
	const handleOpen = useCallback(
		(ref: RowRef) => {
			handlers.current.onOpen(ref)
		},
		[handlers]
	)
	const handleCheck = useCallback(
		(index: number, ref: RowRef) => {
			handlers.current.onCheck(index, ref)
		},
		[handlers]
	)

	const virtualizer = useVirtualizer({
		count: rows.count,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => ARCHIVE_ROW_HEIGHT,
		overscan: ARCHIVE_LIST_OVERSCAN,
		getItemKey
	})
	const virtualRows = virtualizer.getVirtualItems()
	const cursorShown = virtualRows.some(row => row.index === cursorIndex)
	// Rubber-band selection, as in the drive listing, by row index over the browser's own selection: the
	// rows are store refs, none of which is handed over as an item. Rows are no drag sources, so a press on
	// a row's plain area starts one too.
	const marquee = useMarqueeSelection<Selection>({
		itemCount: rows.count,
		viewMode: "list",
		columns: 1,
		// One column: no tile to hit-test.
		geometry: { rowHeight: ARCHIVE_ROW_HEIGHT, tileWidth: 0 },
		selection: { read: () => selection, write: onSelect, cover: onMarquee },
		scrollElement,
		setCursor: onCursor,
		startsOnItems: true
	})

	const revealCursor = useEffectEvent(() => {
		virtualizer.scrollToIndex(Math.max(cursorIndex, 0), {
			align: "auto"
		})
	})

	useEffect(() => {
		revealCursor()
	}, [viewKey])

	// Focus starts on the list once it has rows, unless the user is typing somewhere already.
	useEffect(() => {
		if (focusedOnce.current || rows.count === 0 || scrollElement === null) {
			return
		}

		focusedOnce.current = true

		const active = document.activeElement

		if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
			return
		}

		scrollElement.focus({
			preventScroll: true
		})
	}, [rows.count, scrollElement])

	// Shown again after an inner archive: focus back on the list, the cursor row brought into view.
	useEffect(() => {
		if (focusKey === 0 || scrollElement === null) {
			return
		}

		scrollElement.focus({ preventScroll: true })
		revealCursor()
	}, [focusKey, scrollElement])

	// The cursor row's context menu, as a right-click on it opens it and where drive's keyboard menu places it. A cursor
	// scrolled out of the mounted rows is brought in first, its menu opening once it is.
	function openCursorMenu(): void {
		if (cursorIndex < 0) {
			return
		}

		if (!openOptionContextMenu(document.getElementById(rowElementId(listId, rows.at(cursorIndex))))) {
			menuPending.current = true
			virtualizer.scrollToIndex(cursorIndex, {
				align: "auto"
			})
		}
	}

	const openPendingMenu = useEffectEvent(() => {
		if (menuPending.current) {
			menuPending.current = false
			openCursorMenu()
		}
	})

	useEffect(() => {
		if (cursorShown) {
			openPendingMenu()
		}
	}, [cursorShown])

	// The keyboard's context menu lands on the listbox, which keeps focus while aria-activedescendant names the cursor:
	// it is the cursor row's. A pointer's on the list's empty space stays the trigger's, which opens nothing there.
	function handleContextMenuCapture(event: MouseEvent<HTMLDivElement>): void {
		if (event.target !== event.currentTarget || !isKeyboardContextMenu(event.nativeEvent)) {
			return
		}

		event.preventDefault()
		event.stopPropagation()
		openCursorMenu()
	}

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		if (event.target !== event.currentTarget || isImeKeydown(event.nativeEvent) || isRecordingCombo()) {
			return
		}

		const action = browserKeyAction(event, selection.rules.size > 0, bindings, undefined, escapeLeaves)

		if (action === null) {
			return
		}

		event.preventDefault()
		event.stopPropagation()
		menuPending.current = false

		// Held, only the cursor moves on.
		if (event.repeat && action.type !== "move") {
			return
		}

		if (action.type === "openMenu") {
			openCursorMenu()

			return
		}

		const pageSize = Math.floor(event.currentTarget.clientHeight / ARCHIVE_ROW_HEIGHT)
		const next = onKeyAction(action, pageSize)

		if (next !== null) {
			virtualizer.scrollToIndex(next, {
				align: "auto"
			})
		}
	}

	// A right-click (or a touch held) on a row: the browser selects it if need be and says what its menu
	// offers. Anywhere else in the list, or on a row with nothing to offer, no menu opens.
	function handleMenuOpenChange(open: boolean, details: ContextMenuPrimitive.Root.ChangeEventDetails): void {
		if (!open) {
			return
		}

		const target = details.event.target
		const option = target instanceof Element ? target.closest<HTMLElement>('[role="option"]') : null
		const index = option === null ? -1 : Number(option.dataset["index"])
		const menu = menuHost !== null && index >= 0 && index < rows.count ? menuHost.openRowMenu(index, rows.at(index)) : null

		if (menu === null) {
			details.cancel()

			return
		}

		setRowMenu(menu)
	}

	// A plain click on the list's empty space drops the selection, as in the drive listing (whose
	// window-wide click-away stands down inside the preview overlay this list lives in).
	function handleBackgroundClick(event: MouseEvent<HTMLDivElement>): void {
		const bounds = event.currentTarget.getBoundingClientRect()

		if (
			isPlainPointerClick(event) &&
			isEmptySpaceTarget(event.target, event.currentTarget, event.clientX - bounds.left, event.clientY - bounds.top)
		) {
			onSelect(EMPTY_SELECTION)
		}
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* The same stable scrollbar gutter as the listbox below, so the columns stay over the rows'. */}
			<div className="flex h-8 shrink-0 scrollbar-gutter-stable items-center gap-3 overflow-hidden border-b border-border px-3 text-xs text-muted-foreground">
				<button
					type="button"
					role="checkbox"
					aria-checked={headerCheck === "mixed" ? "mixed" : headerCheck === "on"}
					aria-label={t("previewArchiveSelectAll")}
					disabled={headerDisabled}
					className={cn(
						"flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
						headerCheck !== "off" && "border-primary bg-primary text-primary-foreground"
					)}
					onClick={onHeaderCheck}
				>
					{headerCheck === "on" ? (
						<CheckIcon className="size-3" />
					) : headerCheck === "mixed" ? (
						<MinusIcon className="size-3" />
					) : null}
				</button>
				{/* The row's icon column. */}
				<span className="w-5 shrink-0" />
				{SORT_COLUMNS.map(column => {
					const active = sort.key === column.key

					return (
						<button
							key={column.key}
							type="button"
							disabled={searchMode}
							className={cn(
								"flex items-center gap-1 rounded-md outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none",
								active && "text-foreground",
								column.className
							)}
							onClick={() => {
								onSort(column.key)
							}}
						>
							{t(SORT_LABEL_KEYS[column.key])}
							{active && !searchMode ? (
								sort.descending ? (
									<>
										<ArrowDownIcon
											aria-hidden="true"
											className="size-3"
										/>{" "}
										<span className="sr-only">{t("drive:driveColumnSortedDescending")}</span>
									</>
								) : (
									<>
										<ArrowUpIcon
											aria-hidden="true"
											className="size-3"
										/>{" "}
										<span className="sr-only">{t("drive:driveColumnSortedAscending")}</span>
									</>
								)
							) : null}
						</button>
					)
				})}
				<span className={LIST_TRAILING_SLOT_CLASS} />
			</div>
			{/* One context menu for every row, its trigger the listbox itself: no row mounts a menu root of its
			    own, and which row it is for is read off the event when it opens. */}
			<ContextMenu onOpenChange={handleMenuOpenChange}>
				<ContextMenuTrigger
					render={
						<div
							ref={setScrollElement}
							role="listbox"
							aria-label={label}
							aria-multiselectable="true"
							aria-activedescendant={cursorShown && cursorIndex >= 0 ? rowElementId(listId, rows.at(cursorIndex)) : undefined}
							tabIndex={0}
							className="group min-h-0 flex-1 scrollbar-gutter-stable overflow-y-auto outline-none"
							onKeyDown={handleKeyDown}
							onContextMenuCapture={handleContextMenuCapture}
							onPointerDown={marquee.onPointerDown}
							onClick={handleBackgroundClick}
						/>
					}
				>
					{rows.count === 0 && reading === null ? (
						empty
					) : (
						<div
							className="relative w-full"
							style={{ height: virtualizer.getTotalSize() + (reading === null ? 0 : ARCHIVE_ROW_HEIGHT) }}
						>
							<MarqueeRect store={marquee.rectStore} />
							{virtualRows.map(virtualRow => {
								const ref = rows.at(virtualRow.index)
								const isDir = isDirRef(ref)
								const dir = isDir ? dirOfRef(ref) : -1
								const skip = skipReasonOf(rowSkip(store, ref))
								const flags = rowFlags(store, ref)
								const parent = isDir ? store.dirParent(dir) : store.parent(ref)
								const parentPath = searchMode ? store.dirPath(parent) : ""
								const kind = entryRowKind(store, ref)
								const selectable = isSelectable(store, ref)

								return (
									<ArchiveEntryRow
										key={virtualRow.key}
										id={rowElementId(listId, ref)}
										rowRef={ref}
										index={virtualRow.index}
										total={rows.count}
										start={virtualRow.start}
										name={rowName(store, ref)}
										kind={kind}
										size={isDir ? -1 : store.size(ref)}
										modified={isDir ? store.dirModified(dir) : store.modified(ref)}
										childCount={isDir ? store.childDirs(dir).length + store.childEntries(dir).length : 0}
										check={rowCheck(store, selection, ref)}
										selectable={selectable}
										cursor={virtualRow.index === cursorIndex}
										skipLabel={skip === null ? null : t(SKIP_LABEL_KEYS[skip])}
										encrypted={hasFlag(flags, ENTRY_FLAG.encrypted)}
										misleading={hasFlag(flags, ENTRY_FLAG.misleading)}
										storedPath={isDir || !hasFlag(flags, ENTRY_FLAG.rewritten) ? null : (store.storedPath(ref) ?? null)}
										linkTarget={isDir ? null : (store.link(ref)?.target ?? null)}
										parentPath={parentPath === "" ? null : parentPath}
										menu={kind === "file" && selectable}
										onPointer={handlePointer}
										onOpen={handleOpen}
										onCheck={handleCheck}
									/>
								)
							})}
							{reading === null ? null : (
								<ArchiveReadingRow
									{...reading}
									start={virtualizer.getTotalSize()}
								/>
							)}
						</div>
					)}
				</ContextMenuTrigger>
				{rowMenu === null ? null : <ArchiveRowContextMenuContent menu={rowMenu} />}
			</ContextMenu>
		</div>
	)
}

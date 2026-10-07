import {
	useCallback,
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
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, MinusIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { ENTRY_FLAG, skipReasonOf } from "@/lib/sdk/archiveListing"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import { useLatestRef } from "@/lib/useLatestRef"
import { LIST_MODIFIED_COLUMN_CLASS, LIST_SIZE_COLUMN_CLASS } from "@/features/drive/lib/listingCells"
import {
	ARCHIVE_LIST_OVERSCAN,
	ARCHIVE_MENU_COLUMN_CLASS,
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
	type BrowserKeyAction,
	type RowPosition
} from "@/features/archive/lib/archiveBrowser.logic"
import type { ListingSnapshot } from "@/features/archive/lib/listingSession"
import { isSelectable, rowCheck, type RowCheck, type Selection } from "@/features/archive/lib/selection"
import { dirOfRef, isDirRef, type ChildSort, type ChildSortKey, type RowRef, type RowView } from "@/features/archive/lib/sortedChildren"
import { ArchiveEntryRow } from "@/features/archive/components/archiveEntryRow"

export interface ArchiveEntryListProps {
	listId: string
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
	// Shown in place of the rows when there are none.
	empty: ReactNode
	onSort: (key: ChildSortKey) => void
	onHeaderCheck: () => void
	// The cursor's new index, which the list scrolls to; null when it didn't move.
	onKeyAction: (action: BrowserKeyAction, pageSize: number) => number | null
	onPointer: (index: number, ref: RowRef, event: MouseEvent<HTMLDivElement>) => void
	onOpen: (ref: RowRef) => void
	onCheck: (index: number, ref: RowRef) => void
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
	onSort,
	onHeaderCheck,
	onKeyAction,
	onPointer,
	onOpen,
	onCheck
}: ArchiveEntryListProps) {
	const { t } = useTranslation("preview")
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const focusedOnce = useRef(false)
	const handlers = useLatestRef({ onPointer, onOpen, onCheck })
	const store = snapshot.store
	const getItemKey = useCallback((index: number) => rows.at(index), [rows])
	const cursorIndex = useMemo(() => positionIndex(rows, cursor), [rows, cursor])
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

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		if (event.target !== event.currentTarget) {
			return
		}

		const action = browserKeyAction(event, selection.rules.size > 0)

		if (action === null) {
			return
		}

		event.preventDefault()
		event.stopPropagation()

		const pageSize = Math.floor(event.currentTarget.clientHeight / ARCHIVE_ROW_HEIGHT)
		const next = onKeyAction(action, pageSize)

		if (next !== null) {
			virtualizer.scrollToIndex(next, {
				align: "auto"
			})
		}
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-3 text-xs text-muted-foreground">
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
							aria-pressed={active}
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
									<ArrowDownIcon
										aria-hidden="true"
										className="size-3"
									/>
								) : (
									<ArrowUpIcon
										aria-hidden="true"
										className="size-3"
									/>
								)
							) : null}
						</button>
					)
				})}
				<span className={ARCHIVE_MENU_COLUMN_CLASS} />
			</div>
			<div
				ref={setScrollElement}
				role="listbox"
				aria-label={label}
				aria-multiselectable="true"
				aria-activedescendant={cursorShown && cursorIndex >= 0 ? rowElementId(listId, rows.at(cursorIndex)) : undefined}
				tabIndex={0}
				className="group min-h-0 flex-1 overflow-y-auto outline-none"
				onKeyDown={handleKeyDown}
			>
				{rows.count === 0 ? (
					empty
				) : (
					<div
						className="relative w-full"
						style={{ height: virtualizer.getTotalSize() }}
					>
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
					</div>
				)}
			</div>
		</div>
	)
}

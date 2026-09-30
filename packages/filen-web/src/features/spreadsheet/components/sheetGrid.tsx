import {
	useEffect,
	useId,
	useRef,
	useState,
	type CSSProperties,
	type KeyboardEvent,
	type MouseEvent,
	type PointerEvent,
	type ReactNode,
	type RefObject
} from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import { listenWindowDrag } from "@/lib/windowDrag"
import type { Axis } from "@/features/spreadsheet/lib/axis.logic"
import {
	cellName,
	columnName,
	expandToMerges,
	rangeContains,
	selectionRange,
	type CellPosition,
	type Selection
} from "@/features/spreadsheet/lib/cellRef.logic"
import type { GridSheet } from "@/features/spreadsheet/lib/cellStore.logic"
import { gridMove, lastUsed, mergeAt, sheetBounds, sheetCols, sheetRows } from "@/features/spreadsheet/lib/navigation.logic"
import { cellKey, DEFAULT_ROW_HEIGHT, type CellRange, type CellStyleView, type CellView } from "@/features/spreadsheet/lib/model"
import { measureContents } from "@/features/spreadsheet/lib/autofit"
import {
	CELL_PADDING,
	clampSize,
	fitSize,
	PX_PER_POINT,
	resizeTargets,
	sheetWithSizes,
	type SizeAxis,
	type SizeEntry
} from "@/features/spreadsheet/lib/sizes.logic"

const ROW_HEADER_WIDTH = 52
const COL_HEADER_HEIGHT = 24
const OVERSCAN = 4

export interface SheetGridProps {
	sheet: GridSheet
	styles: readonly CellStyleView[]
	selection: Selection
	onSelectionChange: (selection: Selection) => void
	label: string
	// Sees every key first; returning true takes it (editing, clipboard, undo), before navigation does.
	onKey?: (event: KeyboardEvent<HTMLDivElement>) => boolean
	// A double-click on a cell.
	onCellActivate?: (position: CellPosition) => void
	// The in-cell editor, drawn over its cell.
	editor?: { row: number; col: number; node: ReactNode } | null
	// Lets the parent hand focus back to the grid after an edit.
	gridRef?: RefObject<HTMLDivElement | null>
	// Columns or rows resized by dragging a rail edge (or autofit): the grid shows its draft until this
	// settles. Without it the rails cannot be resized.
	onResize?: (axis: SizeAxis, sizes: readonly SizeEntry[]) => Promise<void>
}

// A rail edge being dragged, as the pointer left it.
interface ResizeDraft {
	axis: SizeAxis
	entries: SizeEntry[]
	size: number
	x: number
	y: number
}

interface ResizeGesture {
	axis: SizeAxis
	targets: number[]
	start: number
	origin: number
	pointerId: number
}

interface Viewport {
	top: number
	left: number
	width: number
	height: number
}

interface Layout {
	rows: Axis
	cols: Axis
	frozenRows: number
	frozenCols: number
	frozenHeight: number
	frozenWidth: number
}

interface Span {
	first: number
	last: number
}

// The visible indices of one axis's scrolling part, plus a few past each edge.
function visibleRange(axis: Axis, frozen: number, frozenSize: number, scroll: number, extent: number): Span {
	if (axis.count <= frozen) {
		return { first: frozen, last: frozen - 1 }
	}

	const first = Math.max(frozen, axis.indexAt(frozenSize + scroll) - OVERSCAN)
	const last = Math.min(axis.count - 1, axis.indexAt(frozenSize + scroll + extent) + OVERSCAN)

	return { first, last }
}

// The rows and columns drawn for a scroll position. State follows this, not every scrolled pixel, so a
// scroll frame that draws the same cells renders nothing.
function gridWindow(layout: Layout, viewport: Viewport): { rows: Span; cols: Span } {
	return {
		rows: visibleRange(
			layout.rows,
			layout.frozenRows,
			layout.frozenHeight,
			viewport.top,
			Math.max(0, viewport.height - COL_HEADER_HEIGHT - layout.frozenHeight)
		),
		cols: visibleRange(
			layout.cols,
			layout.frozenCols,
			layout.frozenWidth,
			viewport.left,
			Math.max(0, viewport.width - ROW_HEADER_WIDTH - layout.frozenWidth)
		)
	}
}

function sameWindow(layout: Layout, a: Viewport, b: Viewport): boolean {
	if (a.width !== b.width || a.height !== b.height) {
		return false
	}

	const x = gridWindow(layout, a)
	const y = gridWindow(layout, b)

	return x.rows.first === y.rows.first && x.rows.last === y.rows.last && x.cols.first === y.cols.first && x.cols.last === y.cols.last
}

function span(first: number, last: number): number[] {
	const indices: number[] = []

	for (let index = first; index <= last; index++) {
		indices.push(index)
	}

	return indices
}

function overlaps(start: number, end: number, spans: readonly Span[]): boolean {
	return spans.some(part => start <= part.last && end >= part.first)
}

const SPILL_COLUMNS = 32

function cellStyle(view: CellView, style: CellStyleView | undefined): CSSProperties {
	const css: CSSProperties = {}

	if (style?.fill !== undefined) {
		css.backgroundColor = style.fill
		// The file drew its text for this fill on paper: dark text unless it says otherwise.
		css.color = style.color ?? "#000000"
	} else if (style?.color !== undefined) {
		css.color = style.color
	}

	if (style?.bold === true) css.fontWeight = 600
	if (style?.italic === true) css.fontStyle = "italic"

	const lines = [style?.underline === true ? "underline" : "", style?.strike === true ? "line-through" : ""].filter(Boolean)

	if (lines.length > 0) css.textDecoration = lines.join(" ")
	if (style?.size !== undefined) css.fontSize = `${String(Math.max(8, Math.min(style.size * PX_PER_POINT, 40)))}px`

	css.justifyContent =
		style?.align === "center"
			? "center"
			: style?.align === "right" || (style?.align === undefined && view.numeric === true)
				? "flex-end"
				: "flex-start"
	css.alignItems = style?.valign === "top" ? "flex-start" : style?.valign === "bottom" ? "flex-end" : "center"

	return css
}

interface GridCellProps {
	col: number
	top: number
	left: number
	width: number
	height: number
	view: CellView | undefined
	style: CellStyleView | undefined
	merged: boolean
	selected: boolean
	active: boolean
	activeId: string
	nameId: string
	spill: number
	editing: boolean
	editorNode: ReactNode
}

// Every prop is a primitive or a stable reference, so the compiler hands back the same element for a cell
// that did not change and React skips it on a scroll step, a selection move or an editor keystroke.
function GridCell(props: GridCellProps): ReactNode {
	const { col, top, left, width, height, view, style, merged, selected, active, activeId, nameId, spill, editing, editorNode } = props

	return (
		<div
			id={active ? activeId : undefined}
			role="gridcell"
			aria-colindex={col + 2}
			data-merged={merged ? "" : undefined}
			aria-selected={selected}
			aria-describedby={active ? nameId : undefined}
			className={cn(
				"absolute flex px-1.5 text-[13px] leading-tight",
				spill > 0 || editing ? "overflow-visible" : "overflow-hidden",
				editing && "z-10",
				merged && "bg-background",
				view?.error === true && "text-destructive"
			)}
			style={{
				top,
				left,
				width: width - 1,
				height: height - 1,
				...(view === undefined ? {} : cellStyle(view, style))
			}}
		>
			<span
				className={cn(
					spill > 0 ? "shrink-0" : "min-w-0",
					style?.wrap === true ? "break-words whitespace-pre-wrap" : "truncate whitespace-pre"
				)}
				style={spill > 0 ? { maxWidth: width + spill - CELL_PADDING } : undefined}
			>
				{view?.text ?? ""}
			</span>
			{editing ? (
				<div
					data-cell-editor
					className="absolute top-0 left-0 font-normal text-foreground not-italic"
					style={{ minWidth: width, height }}
				>
					{editorNode}
				</div>
			) : null}
		</div>
	)
}

// A spreadsheet grid: column letters and row numbers, frozen panes, merged cells, and a selection moved by
// mouse or keyboard. Rows and columns are windowed on both axes (only what is on screen, and a few past it,
// is in the DOM), and the headers and frozen panes are sticky regions of one scrolling box, so they stay put
// with the browser's own scrolling rather than following it a frame late.
export function SheetGrid({
	sheet: sheetProp,
	styles,
	selection,
	onSelectionChange,
	label,
	onKey,
	onCellActivate,
	editor,
	gridRef,
	onResize
}: SheetGridProps) {
	const { t } = useTranslation("preview")
	const ownRef = useRef<HTMLDivElement>(null)
	const scrollRef = gridRef ?? ownRef
	const idPrefix = useId()
	const [viewport, setViewport] = useState<Viewport>({ top: 0, left: 0, width: 0, height: 0 })
	const draggingRef = useRef(false)
	const [draft, setDraft] = useState<ResizeDraft | null>(null)
	const gestureRef = useRef<ResizeGesture | null>(null)
	const pendingDraft = useRef<ResizeDraft | null>(null)
	const frameRef = useRef(0)
	// Removes the live gesture's window listeners.
	const detachRef = useRef<(() => void) | null>(null)
	// While a rail edge is dragged, everything lays out at the draft's sizes.
	const sheet = draft === null ? sheetProp : sheetWithSizes(sheetProp, draft.axis, draft.entries)

	const { axis: rows, truncated } = sheetRows(sheet)
	const cols = sheetCols(sheet)
	const frozenRows = Math.min(sheet.frozenRows, rows.count)
	const frozenCols = Math.min(sheet.frozenCols, cols.count)
	const frozenHeight = rows.offset(frozenRows)
	const frozenWidth = cols.offset(frozenCols)
	const layout: Layout = { rows, cols, frozenRows, frozenCols, frozenHeight, frozenWidth }
	const layoutRef = useRef(layout)
	const committedRef = useRef(viewport)
	const remeasureRef = useRef<(() => void) | null>(null)
	const bodyHeight = rows.total - frozenHeight
	const bodyWidth = cols.total - frozenWidth
	const visibleHeight = Math.max(0, viewport.height - COL_HEADER_HEIGHT - frozenHeight)
	const visibleWidth = Math.max(0, viewport.width - ROW_HEADER_WIDTH - frozenWidth)
	const { rows: rowWindow, cols: colWindow } = gridWindow(layout, viewport)
	const frozenRowIndices = span(0, frozenRows - 1)
	const frozenColIndices = span(0, frozenCols - 1)
	const bodyRowIndices = span(rowWindow.first, rowWindow.last)
	const bodyColIndices = span(colWindow.first, colWindow.last)
	const range = selectionRange(selection)
	const { focus } = selection
	// Text spilling into view can start this far left of the drawn columns.
	const spillFirst = Math.max(frozenCols, colWindow.first - SPILL_COLUMNS)
	const rowSpans: Span[] = [{ first: 0, last: frozenRows - 1 }, rowWindow]
	const colSpans: Span[] = [
		{ first: 0, last: frozenCols - 1 },
		{ first: spillFirst, last: colWindow.last }
	]
	const visibleMerges = sheet.merges.filter(
		merge => overlaps(merge.startRow, merge.endRow, rowSpans) && overlaps(merge.startCol, merge.endCol, colSpans)
	)
	// Every drawn cell a merge covers, for O(1) lookups while drawing: bounded by the drawn area.
	const mergeIndex = new Map<number, CellRange>()

	for (const merge of visibleMerges) {
		for (const rowPart of rowSpans) {
			for (let row = Math.max(merge.startRow, rowPart.first); row <= Math.min(merge.endRow, rowPart.last); row++) {
				for (const colPart of colSpans) {
					for (let col = Math.max(merge.startCol, colPart.first); col <= Math.min(merge.endCol, colPart.last); col++) {
						mergeIndex.set(cellKey(row, col), merge)
					}
				}
			}
		}
	}

	const activeMerge = mergeAt(sheet.merges, focus.row, focus.col)
	const activeWidth = activeMerge === undefined ? cols.size(focus.col) : cols.offset(activeMerge.endCol + 1) - cols.offset(focus.col)
	const activeHeight = activeMerge === undefined ? rows.size(focus.row) : rows.offset(activeMerge.endRow + 1) - rows.offset(focus.row)
	// The active cell is always drawn (see layer), unless it has no size.
	const activeShown = focus.row < rows.count && focus.col < cols.count && activeWidth > 0 && activeHeight > 0
	const activeId = `${idPrefix}-active`
	const nameId = `${idPrefix}-name`

	useEffect(() => {
		layoutRef.current = layout
		remeasureRef.current?.()
	})

	useEffect(
		() => () => {
			detachRef.current?.()
			cancelAnimationFrame(frameRef.current)
		},
		[]
	)

	useEffect(() => {
		const element = scrollRef.current

		if (element === null) {
			return undefined
		}

		let frame = 0

		function measure(): void {
			frame = 0

			if (element === null) {
				return
			}

			const next = { top: element.scrollTop, left: element.scrollLeft, width: element.clientWidth, height: element.clientHeight }

			if (!sameWindow(layoutRef.current, committedRef.current, next)) {
				committedRef.current = next
				setViewport(next)
			}
		}

		function schedule(): void {
			if (frame === 0) {
				frame = requestAnimationFrame(measure)
			}
		}

		const observer = new ResizeObserver(schedule)

		remeasureRef.current = schedule
		observer.observe(element)
		element.addEventListener("scroll", schedule, { passive: true })
		measure()

		return () => {
			remeasureRef.current = null
			observer.disconnect()
			element.removeEventListener("scroll", schedule)
			cancelAnimationFrame(frame)
		}
	}, [scrollRef])

	// Keeps the active cell in view after a keyboard move. Frozen rows and columns are always in view.
	function reveal(position: CellPosition): void {
		const element = scrollRef.current

		if (element === null) {
			return
		}

		if (position.row >= frozenRows) {
			const top = rows.offset(position.row) - frozenHeight
			const bottom = top + rows.size(position.row)

			if (top < element.scrollTop) {
				element.scrollTop = top
			} else if (bottom > element.scrollTop + visibleHeight) {
				element.scrollTop = bottom - visibleHeight
			}
		}

		if (position.col >= frozenCols) {
			const left = cols.offset(position.col) - frozenWidth
			const right = left + cols.size(position.col)

			if (left < element.scrollLeft) {
				element.scrollLeft = left
			} else if (right > element.scrollLeft + visibleWidth) {
				element.scrollLeft = right - visibleWidth
			}
		}
	}

	// The cell under a pointer, or the header it is on: row or col is null over the other axis's header.
	function hit(clientX: number, clientY: number): { row: number | null; col: number | null } | null {
		const element = scrollRef.current

		if (element === null) {
			return null
		}

		const rect = element.getBoundingClientRect()
		const x = clientX - rect.left
		const y = clientY - rect.top

		if (x > element.clientWidth || y > element.clientHeight) {
			return null
		}

		const col =
			x < ROW_HEADER_WIDTH
				? null
				: x < ROW_HEADER_WIDTH + frozenWidth
					? cols.indexAt(x - ROW_HEADER_WIDTH)
					: cols.indexAt(x - ROW_HEADER_WIDTH + element.scrollLeft)
		const row =
			y < COL_HEADER_HEIGHT
				? null
				: y < COL_HEADER_HEIGHT + frozenHeight
					? rows.indexAt(y - COL_HEADER_HEIGHT)
					: rows.indexAt(y - COL_HEADER_HEIGHT + element.scrollTop)

		return { row, col }
	}

	const { row: lastUsedRow, col: lastUsedCol } = lastUsed(sheet)

	function select(anchor: CellPosition, next: CellPosition): void {
		onSelectionChange({ anchor, focus: next })
	}

	// Clicks inside the cell editor are the editor's (placing the caret), not a new selection.
	function inEditor(target: EventTarget): boolean {
		return target instanceof Element && target.closest("[data-cell-editor]") !== null
	}

	function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
		const target = (event.button === 0 || event.button === 2) && !inEditor(event.target) ? hit(event.clientX, event.clientY) : null

		if (target === null) {
			return
		}

		// A right-click acts on the selection it lands in, or on the cell it lands on.
		if (event.button === 2) {
			if (
				target.row !== null &&
				target.col !== null &&
				!rangeContains(expandToMerges(range, visibleMerges), target.row, target.col)
			) {
				select({ row: target.row, col: target.col }, { row: target.row, col: target.col })
			}

			return
		}

		event.currentTarget.focus({ preventScroll: true })

		if (target.row === null && target.col === null) {
			select({ row: 0, col: 0 }, { row: lastUsedRow, col: lastUsedCol })

			return
		}

		if (target.row === null && target.col !== null) {
			select({ row: 0, col: target.col }, { row: lastUsedRow, col: target.col })

			return
		}

		if (target.col === null && target.row !== null) {
			select({ row: target.row, col: 0 }, { row: target.row, col: lastUsedCol })

			return
		}

		if (target.row !== null && target.col !== null) {
			const position = { row: target.row, col: target.col }

			select(event.shiftKey ? selection.anchor : position, position)
			draggingRef.current = true
			event.currentTarget.setPointerCapture(event.pointerId)
		}
	}

	function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
		if (!draggingRef.current) {
			return
		}

		const target = hit(event.clientX, event.clientY)

		if (target?.row == null || target.col == null) {
			return
		}

		const merge = mergeIndex.get(cellKey(target.row, target.col))
		const row = merge?.startRow ?? target.row
		const col = merge?.startCol ?? target.col

		if (row !== focus.row || col !== focus.col) {
			select(selection.anchor, { row, col })
		}
	}

	function handlePointerUp(event: PointerEvent<HTMLDivElement>): void {
		if (draggingRef.current) {
			draggingRef.current = false
			event.currentTarget.releasePointerCapture(event.pointerId)
		}
	}

	function handleDoubleClick(event: MouseEvent<HTMLDivElement>): void {
		const target = inEditor(event.target) ? null : hit(event.clientX, event.clientY)

		if (target?.row != null && target.col != null) {
			onCellActivate?.({ row: target.row, col: target.col })
		}
	}

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		if (event.target !== event.currentTarget || onKey?.(event) === true) {
			return
		}

		const move = gridMove(event, selection, {
			...sheetBounds(sheet, rows, cols),
			pageRows: Math.max(1, Math.floor(visibleHeight / DEFAULT_ROW_HEIGHT) - 1)
		})

		if (move === null) {
			return
		}

		event.preventDefault()
		onSelectionChange(move)
		reveal(move.focus)
	}

	// The selection's rectangle clipped to what one region draws, in that region's own coordinates.
	function selectionRect(
		rowsDrawn: [number, number],
		colsDrawn: [number, number],
		rowOrigin: number,
		colOrigin: number
	): CSSProperties | null {
		const grown = expandToMerges(range, visibleMerges)
		const startRow = Math.max(grown.startRow, rowsDrawn[0])
		const endRow = Math.min(grown.endRow, rowsDrawn[1])
		const startCol = Math.max(grown.startCol, colsDrawn[0])
		const endCol = Math.min(grown.endCol, colsDrawn[1])

		if (startRow > endRow || startCol > endCol) {
			return null
		}

		return {
			top: rows.offset(startRow) - rowOrigin,
			left: cols.offset(startCol) - colOrigin,
			height: rows.offset(endRow + 1) - rows.offset(startRow),
			width: cols.offset(endCol + 1) - cols.offset(startCol)
		}
	}

	// One region's cells: its rows by its columns, merges anchored in it, gridlines and the selection. Cells
	// are grouped into rows (display: contents), as the grid role needs.
	function layer(
		rowIndices: number[],
		colIndices: number[],
		rowDomain: [number, number],
		colDomain: [number, number],
		rowOrigin: number,
		colOrigin: number
	): ReactNode {
		const nodes: ReactNode[] = []
		const rowCells = new Map<number, ReactNode[]>()
		// Cells already drawn: a spill source, a merge's anchor and the active cell can be the same one.
		const done = new Set<number>()
		const width = colIndices.length === 0 ? 0 : cols.offset((colIndices.at(-1) ?? 0) + 1) - colOrigin

		for (const row of rowIndices) {
			const height = rows.size(row)

			if (height === 0) {
				continue
			}

			nodes.push(
				<div
					key={`h${String(row)}`}
					aria-hidden="true"
					className="pointer-events-none absolute border-b border-border/60"
					style={{ top: rows.offset(row) - rowOrigin, left: 0, width, height }}
				/>
			)
		}

		for (const col of colIndices) {
			const width = cols.size(col)

			if (width === 0) {
				continue
			}

			nodes.push(
				<div
					key={`v${String(col)}`}
					aria-hidden="true"
					className="pointer-events-none absolute top-0 bottom-0 border-r border-border/60"
					style={{ left: cols.offset(col) - colOrigin, width }}
				/>
			)
		}

		// Left-aligned text runs on over the empty cells to its right, as spreadsheets draw it: as far as the
		// next cell holding anything, a merge, or the region's edge, and no more than SPILL_COLUMNS.
		function spillWidth(row: number, col: number, end: number): number {
			let spilled = 0

			for (let next = col + 1; next <= Math.min(end, col + SPILL_COLUMNS); next++) {
				const key = cellKey(row, next)

				if (sheet.cells.has(key) || mergeIndex.has(key)) {
					break
				}

				spilled += cols.size(next)
			}

			return spilled
		}

		function cell(row: number, col: number, merge: CellRange | undefined): void {
			const key = cellKey(row, col)
			const view = sheet.cells.get(key)
			const isActive = row === focus.row && col === focus.col

			if ((view === undefined && merge === undefined && !isActive) || done.has(key)) {
				return
			}

			done.add(key)

			const width = merge === undefined ? cols.size(col) : cols.offset(merge.endCol + 1) - cols.offset(col)
			const height = merge === undefined ? rows.size(row) : rows.offset(merge.endRow + 1) - rows.offset(row)

			if (width === 0 || height === 0) {
				return
			}

			const style = view?.style === undefined ? undefined : styles[view.style]
			const editing = isActive && editor?.row === row && editor.col === col
			const spill =
				merge === undefined &&
				view !== undefined &&
				view.text !== "" &&
				view.numeric !== true &&
				view.error !== true &&
				style?.wrap !== true &&
				(style?.align === undefined || style.align === "left")
					? spillWidth(row, col, colDomain[1])
					: 0
			let list = rowCells.get(row)

			if (list === undefined) {
				list = []
				rowCells.set(row, list)
			}

			list.push(
				<GridCell
					key={`c${String(col)}`}
					col={col}
					top={rows.offset(row) - rowOrigin}
					left={cols.offset(col) - colOrigin}
					width={width}
					height={height}
					view={view}
					style={style}
					merged={merge !== undefined}
					selected={rangeContains(range, row, col)}
					active={isActive}
					activeId={activeId}
					nameId={nameId}
					spill={spill}
					editing={editing}
					editorNode={editing ? editor.node : null}
				/>
			)
		}

		const firstRow = rowIndices[0] ?? 0
		const lastRow = rowIndices.at(-1) ?? -1
		const firstCol = colIndices[0] ?? 0
		const lastCol = colIndices.at(-1) ?? -1
		const inDomain = (row: number, col: number): boolean =>
			row >= rowDomain[0] && row <= rowDomain[1] && col >= colDomain[0] && col <= colDomain[1]

		for (const row of rowIndices) {
			// Text that starts left of the drawn columns may still spill into them: its cell is drawn too.
			for (let col = firstCol - 1; col >= Math.max(colDomain[0], firstCol - SPILL_COLUMNS); col--) {
				const key = cellKey(row, col)

				if (mergeIndex.has(key)) {
					break
				}

				if (sheet.cells.has(key)) {
					cell(row, col, undefined)

					break
				}
			}

			for (const col of colIndices) {
				const merge = mergeIndex.get(cellKey(row, col))

				if (merge === undefined || (merge.startRow === row && merge.startCol === col)) {
					cell(row, col, merge)
				}
			}
		}

		// A merge whose anchor has scrolled out of the window still shows the part of it that has not.
		for (const merge of visibleMerges) {
			if (inDomain(merge.startRow, merge.startCol)) {
				cell(merge.startRow, merge.startCol, merge)
			}
		}

		// The active cell is drawn wherever it is: aria-activedescendant and the cell editor live on it.
		if (inDomain(focus.row, focus.col)) {
			cell(focus.row, focus.col, activeMerge)
		}

		for (const row of [...rowCells.keys()].sort((a, b) => a - b)) {
			nodes.push(
				<div
					key={`r${String(row)}`}
					role="row"
					aria-rowindex={row + 2}
					className="contents"
				>
					{rowCells.get(row)}
				</div>
			)
		}

		const rect = selectionRect([firstRow, lastRow], [firstCol, lastCol], rowOrigin, colOrigin)

		if (rect !== null) {
			nodes.push(
				<div
					key="selection"
					aria-hidden="true"
					className="pointer-events-none absolute border-2 border-primary bg-primary/8"
					style={rect}
				/>
			)
		}

		return nodes
	}

	function sizeAt(axis: SizeAxis, index: number): number {
		return axis === "cols" ? cols.size(index) : rows.size(index)
	}

	// A drag on a column or row inside a selection of whole columns or rows resizes all of them. A header
	// click selects to the last used row or column, never the grid's blank tail, so "whole" means that.
	function targetsFor(axis: SizeAxis, index: number): number[] {
		const whole =
			axis === "cols" ? range.startRow === 0 && range.endRow >= lastUsedRow : range.startCol === 0 && range.endCol >= lastUsedCol

		return resizeTargets(axis, index, range, whole, at => sizeAt(axis, at) === 0)
	}

	function clearDraft(): void {
		detachRef.current?.()
		detachRef.current = null
		cancelAnimationFrame(frameRef.current)
		frameRef.current = 0
		pendingDraft.current = null
		gestureRef.current = null
		setDraft(null)
	}

	function draftAt(gesture: ResizeGesture, x: number, y: number): ResizeDraft {
		const size = clampSize(gesture.axis, gesture.start + (gesture.axis === "cols" ? x : y) - gesture.origin)

		return { axis: gesture.axis, entries: gesture.targets.map((at): SizeEntry => [at, size]), size, x, y }
	}

	function startResize(event: PointerEvent<HTMLDivElement>, axis: SizeAxis, index: number): void {
		// Never the grid's own pointerdown, which would start a selection.
		event.stopPropagation()

		if (event.button !== 0) {
			return
		}

		detachRef.current?.()
		event.currentTarget.setPointerCapture(event.pointerId)

		const pointerId = event.pointerId

		gestureRef.current = {
			axis,
			targets: targetsFor(axis, index),
			start: sizeAt(axis, index),
			origin: axis === "cols" ? event.clientX : event.clientY,
			pointerId
		}

		// Followed on the window, not the handle: dragging several columns moves the handle's own header,
		// which can leave the drawn window and unmount, taking its pointer capture along.
		function cancel(cancelled: globalThis.PointerEvent): void {
			if (cancelled.pointerId === pointerId) {
				clearDraft()
			}
		}

		// Escape cancels the drag and nothing else (the preview would close on it).
		function cancelOnEscape(pressed: globalThis.KeyboardEvent): void {
			if (pressed.key === "Escape") {
				pressed.preventDefault()
				pressed.stopPropagation()
				clearDraft()
			}
		}

		detachRef.current = listenWindowDrag({ move: moveResize, up: endResize, cancel, key: cancelOnEscape })
	}

	// At most one layout per frame, however fast the pointer moves.
	function moveResize(event: globalThis.PointerEvent): void {
		const gesture = gestureRef.current

		if (gesture?.pointerId !== event.pointerId) {
			return
		}

		pendingDraft.current = draftAt(gesture, event.clientX, event.clientY)

		if (frameRef.current === 0) {
			frameRef.current = requestAnimationFrame(() => {
				frameRef.current = 0
				setDraft(pendingDraft.current)
			})
		}
	}

	function endResize(event: globalThis.PointerEvent): void {
		const gesture = gestureRef.current

		if (gesture?.pointerId !== event.pointerId || onResize === undefined) {
			return
		}

		const final = draftAt(gesture, event.clientX, event.clientY)

		// A press that never moved (a click, or the first half of a double-click) resizes nothing.
		if (final.size === gesture.start) {
			clearDraft()

			return
		}

		clearDraft()
		// Held until the new sizes are the sheet's, so an answer from the worker never flickers back; a drag
		// started meanwhile has its own draft, which this never clears.
		setDraft(final)
		void onResize(final.axis, final.entries).finally(() => {
			setDraft(current => (current === final ? null : current))
		})
	}

	function autofit(event: MouseEvent<HTMLDivElement>, axis: SizeAxis, index: number): void {
		// Never the grid's own double-click, which opens the cell editor.
		event.stopPropagation()

		const root = scrollRef.current

		if (root === null || onResize === undefined) {
			return
		}

		// Only what is drawn can be measured: the rest keep their size.
		const drawn = new Set(axis === "cols" ? [...frozenColIndices, ...bodyColIndices] : [...frozenRowIndices, ...bodyRowIndices])
		const entries = targetsFor(axis, index)
			.filter(at => drawn.has(at))
			.map((at): SizeEntry => [at, fitSize(axis, measureContents(root, axis, at))])

		if (entries.length > 0) {
			void onResize(axis, entries)
		}
	}

	function resizeHandle(axis: SizeAxis, index: number): ReactNode {
		return onResize === undefined ? null : (
			<div
				data-resize-handle
				aria-hidden="true"
				title={t(axis === "cols" ? "previewSpreadsheetResizeColumn" : "previewSpreadsheetResizeRow")}
				className={cn(
					"absolute z-10 touch-none",
					axis === "cols"
						? "top-0 right-0 h-full w-1.5 translate-x-1/2 cursor-col-resize"
						: "bottom-0 left-0 h-1.5 w-full translate-y-1/2 cursor-row-resize"
				)}
				onPointerDown={event => {
					startResize(event, axis, index)
				}}
				onDoubleClick={event => {
					autofit(event, axis, index)
				}}
			/>
		)
	}

	function columnHeaders(colIndices: number[], origin: number): ReactNode {
		return (
			<div
				role="row"
				aria-rowindex={1}
				className="contents"
			>
				{colIndices.map(col => {
					const width = cols.size(col)

					return width === 0 ? null : (
						<div
							key={col}
							role="columnheader"
							aria-colindex={col + 2}
							className={cn(
								"absolute top-0 flex items-center justify-center border-r border-b border-border text-xs text-muted-foreground",
								col >= range.startCol && col <= range.endCol ? "bg-accent font-medium text-foreground" : "bg-muted"
							)}
							style={{ left: cols.offset(col) - origin, width, height: COL_HEADER_HEIGHT }}
						>
							{columnName(col)}
							{resizeHandle("cols", col)}
						</div>
					)
				})}
			</div>
		)
	}

	function rowHeaders(rowIndices: number[], origin: number): ReactNode {
		return rowIndices.map(row => {
			const height = rows.size(row)

			return height === 0 ? null : (
				<div
					key={row}
					role="row"
					aria-rowindex={row + 2}
					className="contents"
				>
					<div
						role="rowheader"
						aria-colindex={1}
						className={cn(
							"absolute left-0 flex items-center justify-center border-r border-b border-border text-xs text-muted-foreground tabular-nums",
							row >= range.startRow && row <= range.endRow ? "bg-accent font-medium text-foreground" : "bg-muted"
						)}
						style={{ top: rows.offset(row) - origin, height, width: ROW_HEADER_WIDTH }}
					>
						{row + 1}
						{resizeHandle("rows", row)}
					</div>
				</div>
			)
		})
	}

	const allRows: [number, number] = [frozenRows, rows.count - 1]
	const allCols: [number, number] = [frozenCols, cols.count - 1]
	const frozenRowDomain: [number, number] = [0, frozenRows - 1]
	const frozenColDomain: [number, number] = [0, frozenCols - 1]

	return (
		<>
			<div
				ref={scrollRef}
				role="grid"
				aria-label={label}
				aria-rowcount={rows.count + 1}
				aria-colcount={cols.count + 1}
				aria-multiselectable="true"
				aria-activedescendant={activeShown ? activeId : undefined}
				tabIndex={0}
				className="relative min-h-0 flex-1 overflow-auto bg-background focus-ring-row outline-none select-none focus-visible:ring-inset"
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerUp}
				onDoubleClick={handleDoubleClick}
				onKeyDown={handleKeyDown}
			>
				<div
					className="grid"
					style={{
						gridTemplateColumns: `${String(ROW_HEADER_WIDTH)}px ${String(frozenWidth)}px ${String(bodyWidth)}px`,
						gridTemplateRows: `${String(COL_HEADER_HEIGHT)}px ${String(frozenHeight)}px ${String(bodyHeight)}px`,
						width: ROW_HEADER_WIDTH + cols.total,
						height: COL_HEADER_HEIGHT + rows.total
					}}
				>
					{/* The select-all corner */}
					<div
						aria-hidden="true"
						className="sticky top-0 left-0 z-40 border-r border-b border-border bg-background"
					>
						<div className="size-full bg-muted" />
					</div>
					{/* Rail layers are opaque: their cells' tint is translucent. */}
					<div
						className="sticky top-0 z-30 overflow-hidden bg-background"
						style={{ left: ROW_HEADER_WIDTH }}
					>
						{columnHeaders(frozenColIndices, 0)}
					</div>
					<div className="sticky top-0 z-20 overflow-hidden bg-background">{columnHeaders(bodyColIndices, frozenWidth)}</div>
					<div
						className="sticky left-0 z-30 overflow-hidden bg-background"
						style={{ top: COL_HEADER_HEIGHT }}
					>
						{rowHeaders(frozenRowIndices, 0)}
					</div>
					<div
						className={cn(
							"sticky z-30 overflow-hidden bg-background",
							frozenRows > 0 && "border-b-2 border-border",
							frozenCols > 0 && "border-r-2 border-border"
						)}
						style={{ top: COL_HEADER_HEIGHT, left: ROW_HEADER_WIDTH }}
					>
						{layer(frozenRowIndices, frozenColIndices, frozenRowDomain, frozenColDomain, 0, 0)}
					</div>
					<div
						className={cn("sticky z-20 overflow-hidden bg-background", frozenRows > 0 && "border-b-2 border-border")}
						style={{ top: COL_HEADER_HEIGHT }}
					>
						{layer(frozenRowIndices, bodyColIndices, frozenRowDomain, allCols, 0, frozenWidth)}
					</div>
					<div className="sticky left-0 z-20 overflow-hidden bg-background">{rowHeaders(bodyRowIndices, frozenHeight)}</div>
					<div
						className={cn("sticky z-10 overflow-hidden bg-background", frozenCols > 0 && "border-r-2 border-border")}
						style={{ left: ROW_HEADER_WIDTH }}
					>
						{layer(bodyRowIndices, frozenColIndices, allRows, frozenColDomain, frozenHeight, 0)}
					</div>
					<div className="relative overflow-hidden">
						{layer(bodyRowIndices, bodyColIndices, allRows, allCols, frozenHeight, frozenWidth)}
					</div>
				</div>
				<span
					id={nameId}
					hidden
				>
					{cellName(focus.row, focus.col)}
				</span>
			</div>
			{truncated ? (
				<p className="shrink-0 border-t border-border px-2 py-1 text-xs text-muted-foreground">
					{t("previewSpreadsheetRowsTruncated", { rows: rows.count.toLocaleString() })}
				</p>
			) : null}
			{draft === null
				? null
				: createPortal(
						<div
							role="status"
							className="pointer-events-none fixed z-50 rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
							style={{ left: draft.x + 12, top: draft.y + 12 }}
						>
							{t(draft.axis === "cols" ? "previewSpreadsheetWidthPx" : "previewSpreadsheetHeightPx", { size: draft.size })}
						</div>,
						document.body
					)}
		</>
	)
}

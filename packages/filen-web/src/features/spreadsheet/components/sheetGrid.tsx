import {
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type KeyboardEvent,
	type MouseEvent,
	type PointerEvent,
	type ReactNode,
	type RefObject
} from "react"
import { cn } from "@filen/shared"
import { createAxis, type Axis } from "@/features/spreadsheet/lib/axis.logic"
import {
	cellName,
	columnName,
	expandToMerges,
	rangeContains,
	rangesIntersect,
	selectionRange,
	type CellPosition,
	type Selection
} from "@/features/spreadsheet/lib/cellRef.logic"
import { gridMove } from "@/features/spreadsheet/lib/navigation.logic"
import {
	cellKey,
	DEFAULT_COL_WIDTH,
	DEFAULT_ROW_HEIGHT,
	type CellRange,
	type CellStyleView,
	type CellView,
	type SheetView
} from "@/features/spreadsheet/lib/model"

const ROW_HEADER_WIDTH = 52
const COL_HEADER_HEIGHT = 24
// Blank rows and columns past the used area, as a spreadsheet shows.
const EXTRA_ROWS = 100
const EXTRA_COLS = 20
const MIN_COLS = 26
// Browsers cap an element's height (Firefox near 17.9 million pixels); rows past it cannot be scrolled to.
const MAX_GRID_PIXELS = 15_000_000
const OVERSCAN = 4

export interface SheetGridProps {
	sheet: SheetView
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
}

interface Viewport {
	top: number
	left: number
	width: number
	height: number
}

// The visible indices of one axis's scrolling part, plus a few past each edge.
function visibleRange(axis: Axis, frozen: number, frozenSize: number, scroll: number, extent: number): { first: number; last: number } {
	if (axis.count <= frozen) {
		return { first: frozen, last: frozen - 1 }
	}

	const first = Math.max(frozen, axis.indexAt(frozenSize + scroll) - OVERSCAN)
	const last = Math.min(axis.count - 1, axis.indexAt(frozenSize + scroll + extent) + OVERSCAN)

	return { first, last }
}

function span(first: number, last: number): number[] {
	const indices: number[] = []

	for (let index = first; index <= last; index++) {
		indices.push(index)
	}

	return indices
}

const SPILL_COLUMNS = 32
// A cell's horizontal padding (px-1.5 each side) and its gridline.
const CELL_PADDING = 13

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
	if (style?.size !== undefined) css.fontSize = `${String(Math.max(8, Math.min(style.size * (4 / 3), 40)))}px`

	css.justifyContent =
		style?.align === "center"
			? "center"
			: style?.align === "right" || (style?.align === undefined && view.numeric === true)
				? "flex-end"
				: "flex-start"
	css.alignItems = style?.valign === "top" ? "flex-start" : style?.valign === "bottom" ? "flex-end" : "center"

	return css
}

// A spreadsheet grid: column letters and row numbers, frozen panes, merged cells, and a selection moved by
// mouse or keyboard. Rows and columns are windowed on both axes (only what is on screen, and a few past it,
// is in the DOM), and the headers and frozen panes are sticky regions of one scrolling box, so they stay put
// with the browser's own scrolling rather than following it a frame late.
export function SheetGrid({ sheet, styles, selection, onSelectionChange, label, onKey, onCellActivate, editor, gridRef }: SheetGridProps) {
	const ownRef = useRef<HTMLDivElement>(null)
	const scrollRef = gridRef ?? ownRef
	const [viewport, setViewport] = useState<Viewport>({ top: 0, left: 0, width: 0, height: 0 })
	const draggingRef = useRef(false)

	const rowCap = createAxis(sheet.rowCount + EXTRA_ROWS, DEFAULT_ROW_HEIGHT, sheet.rowHeights, sheet.hiddenRows)
	const rowCount = rowCap.total > MAX_GRID_PIXELS ? rowCap.indexAt(MAX_GRID_PIXELS) : rowCap.count
	const rows = rowCount === rowCap.count ? rowCap : createAxis(rowCount, DEFAULT_ROW_HEIGHT, sheet.rowHeights, sheet.hiddenRows)
	const cols = createAxis(Math.max(sheet.colCount + EXTRA_COLS, MIN_COLS), DEFAULT_COL_WIDTH, sheet.colWidths, sheet.hiddenCols)
	const frozenRows = Math.min(sheet.frozenRows, rows.count)
	const frozenCols = Math.min(sheet.frozenCols, cols.count)
	const frozenHeight = rows.offset(frozenRows)
	const frozenWidth = cols.offset(frozenCols)
	const bodyHeight = rows.total - frozenHeight
	const bodyWidth = cols.total - frozenWidth
	const visibleHeight = Math.max(0, viewport.height - COL_HEADER_HEIGHT - frozenHeight)
	const visibleWidth = Math.max(0, viewport.width - ROW_HEADER_WIDTH - frozenWidth)
	const rowWindow = visibleRange(rows, frozenRows, frozenHeight, viewport.top, visibleHeight)
	const colWindow = visibleRange(cols, frozenCols, frozenWidth, viewport.left, visibleWidth)
	const frozenRowIndices = span(0, frozenRows - 1)
	const frozenColIndices = span(0, frozenCols - 1)
	const bodyRowIndices = span(rowWindow.first, rowWindow.last)
	const bodyColIndices = span(colWindow.first, colWindow.last)
	const range = selectionRange(selection)
	const windowRange: CellRange = {
		startRow: Math.min(0, rowWindow.first),
		startCol: Math.min(0, colWindow.first),
		endRow: Math.max(frozenRows - 1, rowWindow.last),
		endCol: Math.max(frozenCols - 1, colWindow.last)
	}
	const visibleMerges = sheet.merges.filter(merge => rangesIntersect(merge, windowRange))
	const activeId = `sheet-cell-${String(selection.focus.row)}-${String(selection.focus.col)}`

	useEffect(() => {
		const element = scrollRef.current

		if (element === null) {
			return undefined
		}

		let frame = 0

		function measure(): void {
			frame = 0

			if (element !== null) {
				setViewport({ top: element.scrollTop, left: element.scrollLeft, width: element.clientWidth, height: element.clientHeight })
			}
		}

		function schedule(): void {
			frame ||= requestAnimationFrame(measure)
		}

		const observer = new ResizeObserver(schedule)

		observer.observe(element)
		element.addEventListener("scroll", schedule, { passive: true })
		measure()

		return () => {
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

	const lastUsedRow = Math.max(0, sheet.rowCount - 1)
	const lastUsedCol = Math.max(0, sheet.colCount - 1)

	function select(anchor: CellPosition, focus: CellPosition): void {
		onSelectionChange({ anchor, focus })
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
			if (target.row !== null && target.col !== null && !rangeContains(range, target.row, target.col)) {
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

		if (target?.row != null && target.col != null && (target.row !== selection.focus.row || target.col !== selection.focus.col)) {
			select(selection.anchor, { row: target.row, col: target.col })
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
			rowCount: rows.count,
			colCount: cols.count,
			lastUsedRow,
			lastUsedCol,
			pageRows: Math.max(1, Math.floor(visibleHeight / DEFAULT_ROW_HEIGHT) - 1)
		})

		if (move === null) {
			return
		}

		event.preventDefault()
		onSelectionChange(move)
		reveal(move.focus)
	}

	// The selection's rectangle clipped to one region, in that region's own coordinates.
	function selectionRect(
		rowDomain: [number, number],
		colDomain: [number, number],
		rowOrigin: number,
		colOrigin: number
	): CSSProperties | null {
		const grown = expandToMerges(range, visibleMerges)
		const startRow = Math.max(grown.startRow, rowDomain[0])
		const endRow = Math.min(grown.endRow, rowDomain[1])
		const startCol = Math.max(grown.startCol, colDomain[0])
		const endCol = Math.min(grown.endCol, colDomain[1])

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

	// One region's cells: its rows by its columns, merges anchored in it, gridlines and the selection.
	function layer(
		rowIndices: number[],
		colIndices: number[],
		rowDomain: [number, number],
		colDomain: [number, number],
		rowOrigin: number,
		colOrigin: number
	): ReactNode {
		const nodes: ReactNode[] = []
		const width = colIndices.length === 0 ? 0 : cols.offset((colIndices.at(-1) ?? 0) + 1) - colOrigin

		for (const row of rowIndices) {
			const top = rows.offset(row) - rowOrigin
			const height = rows.size(row)

			if (height === 0) {
				continue
			}

			nodes.push(
				<div
					key={`h${String(row)}`}
					aria-hidden="true"
					className="pointer-events-none absolute border-b border-border/60"
					style={{ top, left: 0, width, height }}
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
				if (sheet.cells.has(cellKey(row, next)) || visibleMerges.some(candidate => rangeContains(candidate, row, next))) {
					break
				}

				spilled += cols.size(next)
			}

			return spilled
		}

		function cell(row: number, col: number, merge: CellRange | undefined): void {
			const view = sheet.cells.get(cellKey(row, col))
			const isActive = row === selection.focus.row && col === selection.focus.col

			if (view === undefined && merge === undefined && !isActive) {
				return
			}

			const width = merge === undefined ? cols.size(col) : cols.offset(merge.endCol + 1) - cols.offset(col)
			const height = merge === undefined ? rows.size(row) : rows.offset(merge.endRow + 1) - rows.offset(row)

			if (width === 0 || height === 0) {
				return
			}

			const style = view?.style === undefined ? undefined : styles[view.style]
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

			nodes.push(
				<div
					key={`c${String(row)}:${String(col)}`}
					id={isActive ? activeId : undefined}
					role="gridcell"
					aria-rowindex={row + 1}
					aria-colindex={col + 1}
					aria-selected={rangeContains(range, row, col)}
					className={cn(
						"absolute flex px-1.5 text-[13px] leading-tight",
						spill > 0 ? "overflow-visible" : "overflow-hidden",
						merge !== undefined && "bg-background",
						view?.error === true && "text-destructive"
					)}
					style={{
						top: rows.offset(row) - rowOrigin,
						left: cols.offset(col) - colOrigin,
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
				</div>
			)
		}

		const firstRow = rowIndices[0] ?? 0
		const lastRow = rowIndices.at(-1) ?? -1
		const firstCol = colIndices[0] ?? 0
		const lastCol = colIndices.at(-1) ?? -1

		for (const row of rowIndices) {
			for (const col of colIndices) {
				const merge = visibleMerges.find(candidate => rangeContains(candidate, row, col))

				if (merge === undefined || (merge.startRow === row && merge.startCol === col)) {
					cell(row, col, merge)
				}
			}
		}

		// A merge whose anchor has scrolled out of the window still shows the part of it that has not.
		for (const merge of visibleMerges) {
			const anchorInDomain =
				merge.startRow >= rowDomain[0] &&
				merge.startRow <= rowDomain[1] &&
				merge.startCol >= colDomain[0] &&
				merge.startCol <= colDomain[1]
			const anchorRendered =
				merge.startRow >= firstRow && merge.startRow <= lastRow && merge.startCol >= firstCol && merge.startCol <= lastCol

			if (anchorInDomain && !anchorRendered) {
				cell(merge.startRow, merge.startCol, merge)
			}
		}

		if (
			editor != null &&
			editor.row >= rowDomain[0] &&
			editor.row <= rowDomain[1] &&
			editor.col >= colDomain[0] &&
			editor.col <= colDomain[1]
		) {
			const merge = visibleMerges.find(candidate => candidate.startRow === editor.row && candidate.startCol === editor.col)

			nodes.push(
				<div
					key="editor"
					data-cell-editor
					className="absolute z-10"
					style={{
						top: rows.offset(editor.row) - rowOrigin,
						left: cols.offset(editor.col) - colOrigin,
						minWidth: merge === undefined ? cols.size(editor.col) : cols.offset(merge.endCol + 1) - cols.offset(editor.col),
						height: merge === undefined ? rows.size(editor.row) : rows.offset(merge.endRow + 1) - rows.offset(editor.row)
					}}
				>
					{editor.node}
				</div>
			)
		}

		const rect = selectionRect(rowDomain, colDomain, rowOrigin, colOrigin)

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

	function columnHeaders(colIndices: number[], origin: number): ReactNode {
		return colIndices.map(col => {
			const width = cols.size(col)

			return width === 0 ? null : (
				<div
					key={col}
					role="columnheader"
					className={cn(
						"absolute top-0 flex items-center justify-center border-r border-b border-border text-xs text-muted-foreground",
						col >= range.startCol && col <= range.endCol ? "bg-accent font-medium text-foreground" : "bg-muted"
					)}
					style={{ left: cols.offset(col) - origin, width, height: COL_HEADER_HEIGHT }}
				>
					{columnName(col)}
				</div>
			)
		})
	}

	function rowHeaders(rowIndices: number[], origin: number): ReactNode {
		return rowIndices.map(row => {
			const height = rows.size(row)

			return height === 0 ? null : (
				<div
					key={row}
					role="rowheader"
					className={cn(
						"absolute left-0 flex items-center justify-center border-r border-b border-border text-xs text-muted-foreground tabular-nums",
						row >= range.startRow && row <= range.endRow ? "bg-accent font-medium text-foreground" : "bg-muted"
					)}
					style={{ top: rows.offset(row) - origin, height, width: ROW_HEADER_WIDTH }}
				>
					{row + 1}
				</div>
			)
		})
	}

	const allRows: [number, number] = [frozenRows, rows.count - 1]
	const allCols: [number, number] = [frozenCols, cols.count - 1]
	const frozenRowDomain: [number, number] = [0, frozenRows - 1]
	const frozenColDomain: [number, number] = [0, frozenCols - 1]

	return (
		<div
			ref={scrollRef}
			role="grid"
			aria-label={label}
			aria-rowcount={rows.count}
			aria-colcount={cols.count}
			aria-multiselectable="true"
			aria-activedescendant={activeId}
			tabIndex={0}
			className="relative min-h-0 flex-1 overflow-auto bg-background outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
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
				<div className="sticky top-0 left-0 z-40 border-r border-b border-border bg-muted" />
				<div
					className="sticky top-0 z-30 overflow-hidden"
					style={{ left: ROW_HEADER_WIDTH }}
				>
					{columnHeaders(frozenColIndices, 0)}
				</div>
				<div className="sticky top-0 z-20 overflow-hidden">{columnHeaders(bodyColIndices, frozenWidth)}</div>
				<div
					className="sticky left-0 z-30 overflow-hidden"
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
				<div className="sticky left-0 z-20 overflow-hidden">{rowHeaders(bodyRowIndices, frozenHeight)}</div>
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
			<span className="sr-only">{cellName(selection.focus.row, selection.focus.col)}</span>
		</div>
	)
}

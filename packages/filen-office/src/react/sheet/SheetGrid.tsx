import {
	useEffect,
	useId,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type FocusEvent,
	type KeyboardEvent,
	type MouseEvent,
	type PointerEvent,
	type ReactNode,
	type Ref
} from "react"
import { flushSync } from "react-dom"
import { isTypedCharacter } from "../../core/sheet/grid/navigation"
import { cellName } from "../../core/sheet/refs/cellRef"
import { cycleReference } from "../../core/sheet/refs/formulaRefs"
import { clampSize, resizeTargets } from "../../core/sheet/sizes/sizes"
import {
	SHEET_MAX_COLS,
	SHEET_MAX_ROWS,
	type SheetAxis,
	type SheetCommand,
	type SheetFormatPatch,
	type SheetRange
} from "../../core/sheet/protocol"
import type { FillDirection } from "../../core/sheet/fill/fill"
import { autofitSizes } from "./autofit"
import {
	BORDER_SLOP,
	cellSpot,
	draggable,
	dragKeys,
	dropAt,
	dropRange,
	moveCommand,
	onBorder,
	sameDrop,
	type CellSpot,
	type DragDrop
} from "./cellDrag"
import type { SheetMoveCommand } from "../../core/sheet/move/plan"
import { isImeKeydown } from "@filen/shared/keymap"
import {
	APP_SHORTCUTS,
	EDITOR_SHORTCUTS,
	SHORTCUT_FORMATS,
	dateEntry,
	isMacPlatform,
	layoutKey,
	shortcutOf,
	timeEntry,
	type SheetShortcut
} from "./keys"
import {
	editorBackdrop,
	extensionParts,
	type GridRect,
	type SheetCellDrag,
	type SheetCellPointer,
	type SheetCellPointerResult,
	type SheetGridExtension
} from "./layers"
import { fillDownTo, fillHandleShown, fillLeft, fillTarget, sameRange } from "./fill"
import { canEditSnapshot, celllessSheet, type GridResizeDraft, type SheetGridModel, type SheetGridSizes } from "./model"
import { keyMove, stepFrom } from "./navigation"
import { GridRenderer, type GridHit } from "./renderer"
import {
	addSelection,
	axisMove,
	axisSelection,
	cellSelection,
	extendSelection,
	wholeAxis,
	type GridPoint,
	type GridSelection
} from "./selection"
import { entryInput, entryText } from "./tiles"
import {
	DOUBLE_TAP_MS,
	LONG_PRESS_MS,
	dragStartHandle,
	isDoubleTap,
	isSoleCell,
	isTap,
	stillPressed,
	type TouchPress,
	type TouchTap
} from "./touch/gestures"

// The grid: canvases drawn by GridRenderer under a scroller that holds only an empty extent, so no cell is a
// React component or a DOM node. React renders what changes with the selection or the entry: the in-cell editor
// (a textarea, so an input method composes in place), the accessible active cell the grid's
// aria-activedescendant names, a live region saying the active cell, and a resize's size tip. Unstyled: the look
// is css/sheet.css and its --fo-sheet-* variables.

export interface SheetGridHandle {
	focus(): void
	// Scrolls a cell into view.
	reveal(point: GridPoint): void
	// Selects a cell and scrolls to it (the name box, Ctrl+G).
	goTo(point: GridPoint): void
	hit(clientX: number, clientY: number): GridHit | null
	// A cell's (or its merge's) box in CSS pixels from the grid's top left, as shown (mirrored in a right-to-left
	// sheet); null when it is not on screen. For overlays placed in the grid (SheetGrid's children).
	cellRect(point: GridPoint): GridRect | null
	// The same box in client coordinates (a popover's anchor).
	clientRect(point: GridPoint): DOMRect | null
	// Called after every frame drawn (a scroll, a zoom, a sheet switch): overlays re-place themselves from cellRect
	// without a React render.
	onFrame(listener: () => void): () => void
	// Opens the active cell's entry from a control's press (a touch menu's Edit): the soft keyboard comes up, as the
	// grid's hidden input takes focus within the press before the entry does. False when it cannot be edited.
	editActive(): boolean
	// What of a range is on screen, as cellRect gives a cell's (a menu's anchor); null when none of it is.
	rangeRect(range: SheetRange): GridRect | null
	// A key in another field that edits the open entry (a formula bar, marked data-sheet-editor), handled as the
	// in-cell editor handles it: Enter and Tab step as in the grid, Ctrl+Enter fills the selection, Alt+Enter breaks
	// the line, F4 cycles a reference, the date and time shortcuts type at the caret.
	editorKey(event: KeyboardEvent<HTMLTextAreaElement>): void
	// The renderer's frame costs while `measure` is on (perf harness).
	readonly renderer: GridRenderer
}

export interface SheetGridProps {
	readonly grid: SheetGridModel
	readonly label: string
	readonly editorLabel: string
	readonly className?: string
	// What the live region says for the active cell; "<name> <text>" without it.
	readonly describeCell?: (name: string, text: string) => string
	// What it adds for a selection of more than one cell (its last range, as "A1:C3"); the range alone without it.
	readonly describeSelection?: (range: string) => string
	// The touch menu (Cut, Copy, Paste, Select all, Edit) is asked for (true: a long press, a tap on the cell that
	// is the selection, a touch handle let go) or should go (false: a press or key elsewhere, an entry opening). It
	// is about the selection at the time it is asked for; the app places it with rangeRect.
	readonly onTouchMenu?: (shown: boolean) => void
	// A resize's size tip; none without it.
	readonly resizeLabel?: (axis: SheetAxis, px: number) => string
	// Sees every grid key first: true takes it (clipboard, shortcuts the app owns).
	readonly onKey?: (event: KeyboardEvent<HTMLDivElement>) => boolean
	// Sees every editor key first: true takes it (formula autocomplete).
	readonly onEditorKey?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
	// Sees every keyboard shortcut (keys.ts) first: true takes it. The ones only an app can do (Find, Save, dialogs)
	// do nothing unless it takes them.
	readonly onShortcut?: (shortcut: SheetShortcut) => boolean
	// Command is the primary modifier, as on a Mac (detected from the platform when absent).
	readonly mac?: boolean
	// A drag of the selection's border dropped over cells holding data (cellDrag.ts): the app asks Excel's "There's
	// already data here. Do you want to replace it?" and calls `replace` on OK. Without it the refusal goes to the
	// model's refusal handler.
	readonly onConfirmReplace?: (replace: () => void) => void
	// A double-click (or double-tap) on a cell: true takes it, else the cell's entry opens.
	readonly onCellActivate?: (point: GridPoint) => boolean
	// Change it when the app's theme changes: the canvas reads the --fo-sheet-* variables again.
	readonly themeKey?: string | number
	// The app's size layer, for sessions that cannot hold sizes (text files, view-only workbooks): hand in a new
	// object whenever its sizes change.
	readonly sizes?: SheetGridSizes
	// Features' paint layers, cell decorators and pointer hooks (layers.ts), in order. A new list (or a new layer in
	// it) repaints.
	readonly extensions?: readonly SheetGridExtension[]
	// Overlays over the cells (under the editor), in a layer that passes the pointer through except where a child
	// takes it: placed with the handle's cellRect, re-placed on its onFrame.
	readonly children?: ReactNode
	readonly ref?: Ref<SheetGridHandle>
}

interface Drag {
	readonly pointerId: number
	readonly kind: "cells" | "rows" | "cols"
	readonly add: boolean
}

interface Resize {
	readonly pointerId: number
	readonly axis: SheetAxis
	readonly index: number
	readonly targets: readonly number[]
	// Pixels at 100 %.
	readonly start: number
	readonly origin: number
	readonly scale: number
	draft: GridResizeDraft | null
}

// A fill-handle drag: the selection it started from, what it would fill now, and the cell the pointer was last on.
interface FillDrag {
	readonly pointerId: number
	readonly source: SheetRange
	target: SheetRange
	at: GridPoint
}

// A finger on the cells: its long press is timed while it stays put.
interface Press extends TouchPress {
	timer: ReturnType<typeof setTimeout> | null
	// The long press fired: the release is no tap.
	held: boolean
	// After the long press, a move drags the selection (cellDrag.ts) from this cell.
	grab: GridPoint | null
}

// A drag of the selection by its border (cellDrag.ts): the block, the cell it was grabbed by, the cell and spot the
// pointer was last on, the keys last read, and where the block would land.
interface CellDrag {
	readonly pointerId: number
	readonly source: SheetRange
	readonly grab: GridPoint
	at: GridPoint
	cell: SheetRange
	spot: CellSpot | null
	copy: boolean
	insert: boolean
	drop: DragDrop
}

// A touch handle being dragged: the range it started from.
interface HandleDrag {
	readonly pointerId: number
	readonly range: SheetRange
	at: GridPoint
}

// An insert's spot before the pointer has crossed a cell: the gridline above it.
const NO_SPOT: CellSpot = { edge: "top", below: false, after: false }

// How near a header edge a pointer resizes, in pixels.
const EDGE_SLOP = 4
// Selection drag past the edge scrolls this share of the overshoot per frame.
const AUTOSCROLL_RATE = 0.4

const TEXT_KINDS: ReadonlySet<string> = new Set(["csv", "tsv", "tab"])

const FORMAT_SHORTCUTS: ReadonlySet<SheetShortcut> = new Set<SheetShortcut>([
	"bold",
	"italic",
	"underline",
	"strikethrough",
	"formatGeneral",
	"formatCurrency",
	"formatPercent",
	"formatScientific",
	"formatDate",
	"formatTime",
	"formatNumber"
])

// The shortcuts a chartsheet (no cells) keeps: the workbook's, not a cell's.
const CELLLESS_SHORTCUTS: ReadonlySet<SheetShortcut> = new Set<SheetShortcut>([
	"save",
	"print",
	"newSheet",
	"nextSheet",
	"previousSheet",
	"goTo"
])

// Cells a move on a protected sheet passes over looking for one it may select.
const MAX_PROTECTED_STEPS = 1024

// A command whose answer the grid needs nothing from: a refusal reaches onRefusal, a session that died its
// "failed" event.
function settled(promise: Promise<unknown>): void {
	promise.then(undefined, () => undefined)
}

function defaultDescription(name: string, text: string): string {
	return text === "" ? name : `${name} ${text}`
}

// What the live region says of a selection beyond its active cell: its last range, once it holds more than one cell.
function selectionPhrase(selection: GridSelection, describeSelection: ((range: string) => string) | undefined): string | null {
	const lastRange = selection.ranges[selection.ranges.length - 1]
	const many =
		lastRange !== undefined &&
		(selection.ranges.length > 1 || lastRange.endRow > lastRange.startRow || lastRange.endCol > lastRange.startCol)

	if (lastRange === undefined || !many) return null

	return describeSelection === undefined ? rangeName(lastRange) : describeSelection(rangeName(lastRange))
}

interface CellEditorProps {
	readonly id: string
	readonly label: string
	readonly text: string
	readonly invalid: boolean
	// Drawn under the text, which is then clear (layers.ts editorText); null for plain text.
	readonly backdrop: ReactNode | null
	readonly element: (element: HTMLDivElement | null) => void
	readonly onText: (text: string) => void
	readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
	readonly onBlur: (event: FocusEvent<HTMLTextAreaElement>) => void
}

function inRange(range: SheetRange, row: number, col: number): boolean {
	return row >= range.startRow && row <= range.endRow && col >= range.startCol && col <= range.endCol
}

// Whether a range holds the whole column (row) `index`.
function holdsWhole(range: SheetRange, axis: SheetAxis, index: number): boolean {
	return axis === "cols"
		? range.startRow === 0 && range.endRow >= SHEET_MAX_ROWS - 1 && index >= range.startCol && index <= range.endCol
		: range.startCol === 0 && range.endCol >= SHEET_MAX_COLS - 1 && index >= range.startRow && index <= range.endRow
}

function rangeName(range: SheetRange): string {
	return `${cellName(range.startRow, range.startCol)}:${cellName(range.endRow, range.endCol)}`
}

// The in-cell editor. It exists only while an entry is typed, and takes focus as it appears (in the same task, so
// a composition started by the key that opened it lands here), with the caret after what it starts from. The
// renderer places its box, which the textarea sizes; a backdrop fills the same box with the same font and padding
// and moves with the textarea's scroll, so its glyphs sit under the textarea's clear ones. While an input method
// composes the textarea's own text shows (its underline and candidates are the input method's).
function CellEditor({ id, label, text, invalid, backdrop, element, onText, onKeyDown, onBlur }: CellEditorProps) {
	const boxRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const layerRef = useRef<HTMLDivElement>(null)
	const [composing, setComposing] = useState(false)
	const colored = backdrop !== null && !composing

	useLayoutEffect(() => {
		const input = inputRef.current

		input?.focus({ preventScroll: true })
		input?.setSelectionRange(input.value.length, input.value.length)
	}, [])

	useLayoutEffect(() => {
		element(boxRef.current)

		return () => element(null)
	}, [element])

	function follow(): void {
		const input = inputRef.current
		const layer = layerRef.current

		if (input !== null && layer !== null)
			layer.style.transform = `translate(${String(-input.scrollLeft)}px, ${String(-input.scrollTop)}px)`
	}

	// A backdrop appearing over an editor already scrolled starts where it is.
	useLayoutEffect(() => {
		if (colored) follow()
	}, [colored])

	return (
		<div
			ref={boxRef}
			className="fo-sheet-editor-box"
			data-colored={colored ? "" : undefined}
		>
			{colored ? (
				<div
					className="fo-sheet-editor-backdrop"
					aria-hidden="true"
				>
					<div ref={layerRef}>{backdrop}</div>
				</div>
			) : null}
			<textarea
				ref={inputRef}
				id={id}
				data-sheet-editor=""
				className="fo-sheet-editor"
				aria-label={label}
				aria-invalid={invalid}
				spellCheck={false}
				autoComplete="off"
				rows={1}
				value={text}
				onChange={event => onText(event.target.value)}
				onKeyDown={onKeyDown}
				onBlur={onBlur}
				onScroll={colored ? follow : undefined}
				onCompositionStart={() => setComposing(true)}
				onCompositionEnd={() => setComposing(false)}
			/>
		</div>
	)
}

export function SheetGrid({
	grid,
	label,
	editorLabel,
	className,
	describeCell,
	describeSelection,
	onTouchMenu,
	resizeLabel,
	onKey,
	onEditorKey,
	onShortcut,
	mac,
	onConfirmReplace,
	onCellActivate,
	themeKey,
	sizes,
	extensions,
	children,
	ref
}: SheetGridProps) {
	const snapshot = useSyncExternalStore(grid.subscribe, grid.getSnapshot, grid.getSnapshot)
	const [owned, setOwned] = useState(() => ({ grid, renderer: new GridRenderer(grid) }))
	// The live region's selection phrase while a pointer drags the selection (undefined: no drag).
	const [heldPhrase, setHeldPhrase] = useState<string | null | undefined>(undefined)
	let current = owned

	// A new model replaces the renderer during render; the old one detaches with its effect.
	if (owned.grid !== grid) {
		current = { grid, renderer: new GridRenderer(grid) }
		setOwned(current)
	}

	const renderer = current.renderer
	const rootRef = useRef<HTMLDivElement>(null)
	const scrollerRef = useRef<HTMLDivElement>(null)
	const extentRef = useRef<HTMLDivElement>(null)
	const cellsRef = useRef<HTMLCanvasElement>(null)
	const chromeRef = useRef<HTMLCanvasElement>(null)
	const activeRef = useRef<HTMLDivElement>(null)
	const tipRef = useRef<HTMLDivElement>(null)
	const handleRef = useRef<HTMLDivElement>(null)
	const fillRef = useRef<FillDrag | null>(null)
	const cellDragRef = useRef<CellDrag | null>(null)
	// While a held finger may drag the selection: the browser must not pan it (a touchmove listener only then).
	const panGuardRef = useRef<(() => void) | null>(null)
	const dragRef = useRef<Drag | null>(null)
	const resizeRef = useRef<Resize | null>(null)
	const pressRef = useRef<Press | null>(null)
	const lastTapRef = useRef<TouchTap | null>(null)
	// A tap on the cell that is the selection asks for the menu once no second tap made it a double tap.
	const menuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	// The selection was last made by touch: it shows the start handle.
	const touchModeRef = useRef(false)
	const lastPointerRef = useRef<string>("")
	const startHandleRef = useRef<HTMLDivElement>(null)
	const handleDragRef = useRef<HandleDrag | null>(null)
	const sinkRef = useRef<HTMLInputElement>(null)
	const autoscrollRef = useRef<{ frame: number; x: number; y: number } | null>(null)
	// A press an extension took, and the cell its pointer was last on.
	const takenRef = useRef<{ pointerId: number; drag: SheetCellDrag; row: number; col: number } | null>(null)
	// The cell a mouse or pen hovers (for the extensions' "hover"), or null off the cells.
	const hoverRef = useRef<GridPoint | null>(null)
	const parts = extensionParts(extensions)
	const ids = useId()
	const activeId = `${ids}-active`
	const editorId = `${ids}-editor`
	const { selection, editing, active, layout } = snapshot
	// Its own value, so the editor renders again only when it changes: a render while a key's input is on its way
	// (before onChange reads it) would put back the text it held.
	const backdrop = editing === null ? null : editorBackdrop(extensions, editing.text)
	const describe = describeCell ?? defaultDescription
	const cellText = describe(cellName(selection.active.row, selection.active.col), active.text)
	// While a pointer drags the selection wider, the range said is the one it started from: the range it settles on
	// is said once, when the pointer lets go (a drag would say every range it passes through).
	const phrase = heldPhrase === undefined ? selectionPhrase(selection, describeSelection) : heldPhrase
	// A chartsheet has no active cell to say.
	const cellless = celllessSheet(snapshot)
	const liveText = cellless ? "" : phrase === null ? cellText : `${cellText}, ${phrase}`
	const readOnly = !canEditSnapshot(snapshot)
	const onMac = mac ?? isMacPlatform()

	// Shown at the corner of a single selection while it can be edited and no entry is open; kept while dragged.
	function placeHandle(): void {
		const element = handleRef.current

		if (element === null) return

		const snapshot = grid.getSnapshot()
		const fill = fillRef.current
		const range = fill?.source ?? fillHandleShown(snapshot.selection.ranges)
		const corner =
			range === null || (fill === null && (snapshot.editing !== null || !canEditSnapshot(snapshot) || grid.cellless()))
				? null
				: renderer.cornerOf(range)

		if (corner === null) {
			if (!element.hidden) element.hidden = true

			return
		}

		element.hidden = false
		element.style.transform = `translate(${String(corner.x)}px, ${String(corner.y)}px)`
	}

	// Shown at the start corner of a single selection a finger made while no entry is open; kept while dragged.
	function placeStartHandle(): void {
		const element = startHandleRef.current

		if (element === null) return

		const snapshot = grid.getSnapshot()
		const drag = handleDragRef.current
		const range = fillHandleShown(snapshot.selection.ranges)
		const corner =
			range === null || (drag === null && (!touchModeRef.current || snapshot.editing !== null || grid.cellless()))
				? null
				: renderer.startCornerOf(range)

		if (corner === null) {
			if (!element.hidden) element.hidden = true

			return
		}

		element.hidden = false
		element.style.transform = `translate(${String(corner.x)}px, ${String(corner.y)}px)`
	}

	function placeHandles(): void {
		placeHandle()
		placeStartHandle()
	}

	useLayoutEffect(() => {
		const root = rootRef.current
		const scroller = scrollerRef.current
		const extent = extentRef.current
		const cells = cellsRef.current
		const chrome = chromeRef.current
		const activeCell = activeRef.current

		if (root === null || scroller === null || extent === null || cells === null || chrome === null || activeCell === null)
			return undefined

		renderer.attach({ root, scroller, extent, cells, chrome, active: activeCell })

		// Rows fit the wrapped text an edit changes, measured as the renderer draws it (rowFit.ts).
		const unmeasure = grid.measureWith({ measurer: () => renderer.measurerFor(), font: () => renderer.themeFont() })
		// The handles follow the selection's corners on every frame.
		const unframe = renderer.onFrame(placeHandles)

		return () => {
			unframe()
			unmeasure()
			renderer.dispose()
		}
	}, [grid, renderer])

	useEffect(() => {
		if (themeKey !== undefined) renderer.refreshTheme()
	}, [renderer, themeKey])

	// An entry opening, or the grid turning read-only, hides the handles without a frame.
	useLayoutEffect(() => {
		placeHandles()
	})

	// An entry opening puts the touch menu away.
	const entryOpen = editing !== null

	useEffect(() => {
		if (entryOpen) onTouchMenu?.(false)
	}, [entryOpen, onTouchMenu])

	useLayoutEffect(() => {
		renderer.setExtensions(parts)
		grid.setEntryHooks(parts.entries)
	}, [renderer, grid, parts])

	// Before the frame, so a resize's draft never shows the old size for a frame.
	useLayoutEffect(() => {
		grid.setSizes(sizes ?? null)
	}, [grid, sizes])

	useEffect(
		() => () => {
			const autoscroll = autoscrollRef.current

			if (autoscroll !== null) cancelAnimationFrame(autoscroll.frame)

			const press = pressRef.current

			if (press?.timer !== null && press?.timer !== undefined) clearTimeout(press.timer)
			if (menuTimerRef.current !== null) clearTimeout(menuTimerRef.current)

			panGuardRef.current?.()
		},
		[]
	)

	function merges(): readonly SheetRange[] {
		const current = grid.getSnapshot().layout

		return current === null ? [] : grid.merges(current)
	}

	function focusGrid(): void {
		scrollerRef.current?.focus({ preventScroll: true })
	}

	// A selection the user made: none on a cell sheet protection keeps from being selected.
	// `tabFrom`: the move is a Tab from that cell (Enter after a run of them goes back to the column it began in).
	function select(next: GridSelection, reveal: GridPoint | null, tabFrom?: GridPoint): void {
		if (grid.choose(next, tabFrom) && reveal !== null) renderer.reveal(reveal)
	}

	// The active cell for a click on a column (row) header: the first row (column) on screen.
	function headerActive(kind: "rows" | "cols", index: number): GridPoint {
		const view = renderer.currentView()

		return kind === "cols"
			? { row: view === null ? 0 : view.rows.frozen > 0 ? view.rows.frozenFirst : view.rows.first, col: index }
			: { row: index, col: view === null ? 0 : view.cols.frozen > 0 ? view.cols.frozenFirst : view.cols.first }
	}

	function selectHit(hit: GridHit, shift: boolean, add: boolean): Drag["kind"] | null {
		const current = grid.getSnapshot().selection
		// Shift extends the last range and keeps the others.
		const earlier = current.ranges.length > 1 ? { ...current, ranges: current.ranges.slice(0, -1) } : null

		switch (hit.kind) {
			case "corner":
				select(
					{
						active: { row: 0, col: 0 },
						anchor: { row: 0, col: 0 },
						focus: { row: SHEET_MAX_ROWS - 1, col: SHEET_MAX_COLS - 1 },
						ranges: [{ startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: SHEET_MAX_COLS - 1 }]
					},
					null
				)

				return null
			case "colHeader":
				if (shift) select(axisSelection("cols", current.anchor.col, hit.col, current.active, earlier), null)
				else select(axisSelection("cols", hit.col, hit.col, headerActive("cols", hit.col), add ? current : null), null)

				return "cols"
			case "rowHeader":
				if (shift) select(axisSelection("rows", current.anchor.row, hit.row, current.active, earlier), null)
				else select(axisSelection("rows", hit.row, hit.row, headerActive("rows", hit.row), add ? current : null), null)

				return "rows"
			case "cell": {
				const point = { row: hit.row, col: hit.col }

				if (shift) select(extendSelection(current, point, merges()), null)
				else if (add) select(addSelection(current, point, merges()), null)
				else select(cellSelection(point, merges()), null)

				return "cells"
			}
		}
	}

	// --- Resizing ---

	function canResize(): boolean {
		return grid.canResize()
	}

	function targetsFor(axis: SheetAxis, index: number): number[] {
		const { selection: current, sheet } = grid.getSnapshot()
		const range = current.ranges[current.ranges.length - 1] as SheetRange
		const axes = grid.axes(sheet)
		const whole =
			axis === "cols"
				? range.startRow === 0 && range.endRow >= SHEET_MAX_ROWS - 1
				: range.startCol === 0 && range.endCol >= SHEET_MAX_COLS - 1

		return resizeTargets(axis, index, range, whole, at =>
			axes === null ? false : (axis === "cols" ? axes.cols : axes.rows).hidden(at)
		)
	}

	function startResize(event: PointerEvent<HTMLDivElement>, axis: SheetAxis, index: number): void {
		const { sheet } = grid.getSnapshot()
		const axes = grid.axes(sheet)

		if (axes === null) return

		event.preventDefault()
		event.currentTarget.setPointerCapture(event.pointerId)
		resizeRef.current = {
			pointerId: event.pointerId,
			axis,
			index,
			targets: targetsFor(axis, index),
			start: (axis === "cols" ? axes.cols : axes.rows).size(index) / axes.scale,
			origin: axis === "cols" ? event.clientX : event.clientY,
			scale: axes.scale,
			draft: null
		}
		renderer.setGuide({ axis, index })
	}

	// A column's edge in a right-to-left sheet is its left one: dragging it left widens the column.
	function resizeSize(resize: Resize, clientX: number, clientY: number): number {
		const moved = (resize.axis === "cols" ? clientX : clientY) - resize.origin
		const mirrored = resize.axis === "cols" && grid.layout(grid.getSnapshot().sheet)?.rightToLeft === true

		return clampSize(resize.axis, resize.start + (mirrored ? -moved : moved) / resize.scale)
	}

	function moveResize(resize: Resize, event: PointerEvent<HTMLDivElement>): void {
		const size = resizeSize(resize, event.clientX, event.clientY)
		const draft: GridResizeDraft = {
			sheet: grid.getSnapshot().sheet,
			axis: resize.axis,
			sizes: new Map(resize.targets.map(target => [target, size]))
		}

		resize.draft = draft
		grid.setDraft(draft)

		const tip = tipRef.current
		const local = renderer.local(event.clientX, event.clientY)

		if (tip !== null && local !== null && resizeLabel !== undefined) {
			tip.textContent = resizeLabel(resize.axis, size)
			tip.hidden = false
			tip.style.transform = `translate(${String(local.x + 12)}px, ${String(local.y + 12)}px)`
		}
	}

	function endResize(commit: PointerEvent<HTMLDivElement> | null): void {
		const resize = resizeRef.current

		resizeRef.current = null
		renderer.setGuide(null)

		if (tipRef.current !== null) tipRef.current.hidden = true
		if (resize === null) return

		const size = commit === null ? resize.start : resizeSize(resize, commit.clientX, commit.clientY)

		// A press that never moved (a click, or the first half of a double-click) resizes nothing.
		if (commit === null || Math.abs(size - Math.round(resize.start)) < 1) {
			grid.setDraft(null)

			return
		}

		const draft = resize.draft
		const sheet = grid.getSnapshot().sheet

		// The draft stays until the new sizes are the sheet's (the session's or the app's), so nothing flickers back.
		const done = (): void => {
			if (grid.getDraft() === draft) grid.setDraft(null)
		}

		grid.resize(sheet, resize.axis, Uint32Array.from(resize.targets), new Float32Array(resize.targets.length).fill(size)).then(
			done,
			done
		)
	}

	function autofit(axis: SheetAxis, index: number): void {
		const measurer = renderer.measurerFor()

		if (measurer === null || !canResize()) return

		const sheet = grid.getSnapshot().sheet

		void autofitSizes(grid, sheet, axis, targetsFor(axis, index), measurer, renderer.themeFont()).then(
			({ indices, sizes }) => {
				if (indices.length > 0) settled(grid.resize(sheet, axis, indices, sizes))
			},
			() => undefined
		)
	}

	// --- Pointer ---

	function stopAutoscroll(): void {
		const autoscroll = autoscrollRef.current

		if (autoscroll !== null) cancelAnimationFrame(autoscroll.frame)

		autoscrollRef.current = null
	}

	function extendDrag(drag: Drag, row: number | null, col: number | null): void {
		const current = grid.getSnapshot().selection
		const focus = { row: row ?? current.focus.row, col: col ?? current.focus.col }

		if (drag.kind === "cells") {
			if (focus.row !== current.focus.row || focus.col !== current.focus.col) grid.select(extendSelection(current, focus, merges()))
		} else {
			const kind = drag.kind
			const index = kind === "cols" ? focus.col : focus.row
			const start = kind === "cols" ? current.anchor.col : current.anchor.row
			const previous = drag.add ? { ...current, ranges: current.ranges.slice(0, -1) } : null

			grid.select(axisSelection(kind, start, index, current.active, previous))
		}
	}

	// A fill-handle drag reaching `point`: what it would fill, previewed.
	function moveFill(fill: FillDrag, point: GridPoint): void {
		if (point.row === fill.at.row && point.col === fill.at.col) return

		fill.at = point
		fill.target = fillTarget(fill.source, point)
		renderer.setFillPreview(sameRange(fill.target, fill.source) ? null : fill.target)
	}

	// A touch start handle dragged to `point` (touch/gestures.ts): the selection runs from its end corner to it.
	function moveStartHandle(drag: HandleDrag, point: GridPoint): void {
		if (point.row === drag.at.row && point.col === drag.at.col) return

		drag.at = point
		grid.choose(dragStartHandle(grid.getSnapshot().selection, drag.range, point, merges()))
	}

	// --- Dragging the selection by its border (cellDrag.ts) ---

	function setCursor(cursor: string): void {
		const root = rootRef.current

		if (root !== null && root.dataset["cursor"] !== cursor) root.dataset["cursor"] = cursor
	}

	// The range a drag of the border would take: one range of a sheet whose cells can change while no entry is open; none
	// on a protected sheet, where Excel turns drag-and-drop off.
	function dragSource(): SheetRange | null {
		const snapshot = grid.getSnapshot()

		if (snapshot.editing !== null || grid.cellless() || !grid.canChange() || (snapshot.layout?.protection ?? null) !== null) return null

		return draggable(snapshot.selection.ranges)
	}

	// The range whose border the pointer is on, or null.
	function borderUnder(clientX: number, clientY: number): SheetRange | null {
		const source = dragSource()
		const local = source === null ? null : renderer.local(clientX, clientY)

		if (source === null || local === null) return null

		return onBorder(renderer.laidRects(source), renderer.layoutX(local.x), local.y, BORDER_SLOP) ? source : null
	}

	function cellOf(point: GridPoint): SheetRange {
		return (
			cellSelection(point, merges()).ranges[0] ?? { startRow: point.row, startCol: point.col, endRow: point.row, endCol: point.col }
		)
	}

	// Where the block would land now, shown (nothing where it would change nothing).
	function previewCellDrag(drag: CellDrag): void {
		drag.drop = dropAt(drag.source, drag.grab, drag.at, drag.insert ? (drag.spot ?? NO_SPOT) : null, drag.cell)
		renderer.setMovePreview(
			sameDrop(drag.source, drag.drop, drag.copy) ? null : { range: dropRange(drag.source, drag.drop.to), insert: drag.drop.insert }
		)
		setCursor(drag.copy ? "copy" : "move")
	}

	function startCellDrag(pointerId: number, source: SheetRange, at: GridPoint, keys: { copy: boolean; insert: boolean }): void {
		// The cell grabbed is the block's own: a pointer just outside its outline grabs the cell inside it.
		const grab = {
			row: Math.max(source.startRow, Math.min(source.endRow, at.row)),
			col: Math.max(source.startCol, Math.min(source.endCol, at.col))
		}
		const drag: CellDrag = {
			pointerId,
			source,
			grab,
			at: grab,
			cell: cellOf(grab),
			spot: null,
			copy: keys.copy,
			insert: keys.insert,
			drop: { to: { row: source.startRow, col: source.startCol }, insert: null }
		}

		cellDragRef.current = drag
		previewCellDrag(drag)
	}

	function moveCellDrag(drag: CellDrag, clientX: number, clientY: number, keys: { copy: boolean; insert: boolean }): void {
		const hit = renderer.hit(clientX, clientY, 0)

		drag.copy = keys.copy
		drag.insert = keys.insert

		if (hit?.kind === "cell") {
			const point = { row: hit.row, col: hit.col }
			const box = renderer.laidCellBox(point)
			const local = renderer.local(clientX, clientY)

			drag.at = point
			drag.cell = cellOf(point)

			if (box !== null && local !== null) drag.spot = cellSpot(box, renderer.layoutX(local.x), local.y)
		} else if (hit?.kind === "colHeader") {
			drag.at = { row: drag.at.row, col: hit.col }
			drag.cell = cellOf(drag.at)
		} else if (hit?.kind === "rowHeader") {
			drag.at = { row: hit.row, col: drag.at.col }
			drag.cell = cellOf(drag.at)
		}

		previewCellDrag(drag)
	}

	function releasePanGuard(): void {
		panGuardRef.current?.()
		panGuardRef.current = null
	}

	// Sends an edit, once the session was told the user set out to edit.
	function edit(run: () => Promise<unknown> | null): void {
		if (!grid.canChange()) return

		void grid.intent()

		const sent = run()

		if (sent !== null) settled(sent)
	}

	// A move over data asks first (the app's question), and goes again with `replace` once agreed.
	function sendMove(command: SheetMoveCommand): void {
		edit(() =>
			grid.command(command, false).then(result => {
				if (result.ok) return

				if (result.refusal.reason === "occupied" && onConfirmReplace !== undefined) {
					onConfirmReplace(() => edit(() => grid.command({ ...command, replace: true })))

					return
				}

				grid.refuse(result.refusal, command)
			})
		)
	}

	// `commit`: the keys as the pointer let go (null: cancelled).
	function endCellDrag(commit: { copy: boolean; insert: boolean } | null): void {
		const drag = cellDragRef.current

		cellDragRef.current = null
		stopAutoscroll()
		releasePanGuard()
		renderer.setMovePreview(null)
		setCursor("")

		if (drag === null || commit === null) return

		const drop = dropAt(drag.source, drag.grab, drag.at, commit.insert ? (drag.spot ?? NO_SPOT) : null, drag.cell)

		if (sameDrop(drag.source, drop, commit.copy)) return

		const { sheet, selection: current } = grid.getSnapshot()

		sendMove(moveCommand(sheet, drag.source, drop, commit.copy, current.active))
	}

	// The keys pressed or let go while dragging change what the drop does, as Excel's pointer shows.
	function cellDragKeys(event: KeyboardEvent<HTMLDivElement>): boolean {
		const drag = cellDragRef.current

		if (drag === null) return false

		event.preventDefault()
		event.stopPropagation()

		if (event.type === "keydown" && event.key === "Escape") {
			endCellDrag(null)

			return true
		}

		const keys = dragKeys(event, onMac)

		if (keys.copy !== drag.copy || keys.insert !== drag.insert) {
			drag.copy = keys.copy
			drag.insert = keys.insert
			previewCellDrag(drag)
		}

		return true
	}

	// While a selection drag is past the grid's edge, scroll towards it and extend to the cell at the edge.
	function autoscroll(x: number, y: number): void {
		const view = renderer.currentView()

		if (view === null) return

		const left = view.cols.header + view.cols.frozenSize
		const top = view.rows.header + view.rows.frozenSize
		const dx = x < left ? x - left : x > view.width ? x - view.width : 0
		const dy = y < top ? y - top : y > view.height ? y - view.height : 0

		if (dx === 0 && dy === 0) {
			stopAutoscroll()

			return
		}

		if (autoscrollRef.current !== null) {
			autoscrollRef.current.x = x
			autoscrollRef.current.y = y

			return
		}

		const tick = (): void => {
			const state = autoscrollRef.current
			const drag = dragRef.current
			const fill = fillRef.current
			const now = renderer.currentView()

			const handleDrag = handleDragRef.current
			const cellDrag = cellDragRef.current

			if (state === null || (drag === null && fill === null && handleDrag === null && cellDrag === null) || now === null) return

			const ddx = state.x < left ? state.x - left : state.x > now.width ? state.x - now.width : 0
			const ddy = state.y < top ? state.y - top : state.y > now.height ? state.y - now.height : 0

			renderer.scrollBy(drag?.kind === "rows" ? 0 : ddx * AUTOSCROLL_RATE, drag?.kind === "cols" ? 0 : ddy * AUTOSCROLL_RATE)

			const edge = renderer.currentView()

			if (edge !== null) {
				const row = ddy < 0 ? edge.rows.first : ddy > 0 ? edge.rows.last : null
				const col = ddx < 0 ? edge.cols.first : ddx > 0 ? edge.cols.last : null

				if (drag !== null) extendDrag(drag, row, col)
				else if (fill !== null) moveFill(fill, { row: row ?? fill.at.row, col: col ?? fill.at.col })
				else if (handleDrag !== null) moveStartHandle(handleDrag, { row: row ?? handleDrag.at.row, col: col ?? handleDrag.at.col })
				else if (cellDrag !== null && (row !== null || col !== null)) {
					cellDrag.at = { row: row ?? cellDrag.at.row, col: col ?? cellDrag.at.col }
					cellDrag.cell = cellOf(cellDrag.at)
					previewCellDrag(cellDrag)
				}
			}

			state.frame = requestAnimationFrame(tick)
		}

		autoscrollRef.current = { frame: requestAnimationFrame(tick), x, y }
	}

	// --- The fill handle (fill.ts) ---

	// The extensions hear a pointer event in order; the first to take a "down" has it.
	function askPointer(pointer: SheetCellPointer): SheetCellPointerResult {
		for (const listener of parts.pointers) {
			const answer = listener(pointer)

			if (pointer.kind === "down" && answer !== undefined && answer !== false) return answer
		}

		return undefined
	}

	function cellDown(event: PointerEvent<HTMLDivElement>, row: number, col: number): SheetCellPointerResult {
		if (parts.pointers.length === 0) return undefined

		return askPointer({
			kind: "down",
			row,
			col,
			clientX: event.clientX,
			clientY: event.clientY,
			pointerType: event.pointerType,
			ctrlKey: event.ctrlKey,
			metaKey: event.metaKey,
			shiftKey: event.shiftKey,
			altKey: event.altKey,
			editing: grid.getSnapshot().editing !== null
		})
	}

	function hover(event: PointerEvent<HTMLDivElement>, hit: GridHit | null): void {
		if (parts.pointers.length === 0) return

		const last = hoverRef.current

		if (hit?.kind !== "cell") {
			if (last !== null) {
				hoverRef.current = null
				askPointer({ kind: "leave" })
			}

			return
		}

		if (last !== null && last.row === hit.row && last.col === hit.col) return

		hoverRef.current = { row: hit.row, col: hit.col }
		askPointer({ kind: "hover", row: hit.row, col: hit.col, clientX: event.clientX, clientY: event.clientY })
	}

	function handlePointerLeave(): void {
		if (hoverRef.current === null) return

		hoverRef.current = null
		askPointer({ kind: "leave" })
	}

	// --- Touch (touch/gestures.ts) ---

	function cancelMenuTimer(): void {
		if (menuTimerRef.current !== null) clearTimeout(menuTimerRef.current)

		menuTimerRef.current = null
	}

	function endPress(): void {
		const press = pressRef.current

		if (press?.timer !== null && press?.timer !== undefined) clearTimeout(press.timer)

		pressRef.current = null

		if (cellDragRef.current === null) releasePanGuard()
	}

	// A press that is no finger's: the touch mode and its menu end.
	function leaveTouch(): void {
		cancelMenuTimer()
		lastTapRef.current = null

		if (touchModeRef.current) {
			touchModeRef.current = false
			placeStartHandle()
		}

		onTouchMenu?.(false)
	}

	// The selection a finger made or touched.
	function touched(): void {
		touchModeRef.current = true
		placeStartHandle()
	}

	// Opens the active cell's entry for a finger. The hidden input takes focus first, inside the press, so the soft
	// keyboard comes up however the entry's own field appears; the entry's field then takes focus from it, which
	// keeps the keyboard up.
	function editByTouch(): boolean {
		// Refused (and a locked cell's refusal said) without moving focus.
		if (!grid.canEdit()) return grid.startEditing(null, "edit")

		sinkRef.current?.focus({ preventScroll: true })

		let started = false

		flushSync(() => {
			started = grid.startEditing(null, "edit")
		})

		if (!started) focusGrid()

		return started
	}

	// A held finger: the cell (or header) under it is selected unless the selection holds it, and the menu comes.
	function longPress(press: Press): void {
		press.timer = null

		if (pressRef.current !== press) return

		const hit = renderer.hit(press.x, press.y, 0)

		if (hit === null) return

		press.held = true
		lastTapRef.current = null

		if (hit.kind !== "cell" || !grid.getSnapshot().selection.ranges.some(range => inRange(range, hit.row, hit.col)))
			selectHit(hit, false, false)

		focusGrid()
		touched()
		onTouchMenu?.(true)

		// Held on the selection, the finger now drags it (cellDrag.ts): the browser is kept from panning until it lifts.
		const source = hit.kind === "cell" ? dragSource() : null
		const scroller = scrollerRef.current

		if (hit.kind === "cell" && source !== null && scroller !== null && inRange(source, hit.row, hit.col)) {
			press.grab = { row: hit.row, col: hit.col }

			const block = (event: TouchEvent): void => {
				if (event.cancelable) event.preventDefault()
			}

			releasePanGuard()
			scroller.addEventListener("touchmove", block, { passive: false })
			panGuardRef.current = () => scroller.removeEventListener("touchmove", block)
		}
	}

	function touchDown(event: PointerEvent<HTMLDivElement>): void {
		endPress()
		cancelMenuTimer()

		// A chartsheet has no cells: a finger only pans (an extension still hears its tap).
		if (grid.cellless()) {
			pressRef.current = {
				pointerId: event.pointerId,
				x: event.clientX,
				y: event.clientY,
				time: event.timeStamp,
				timer: null,
				held: false,
				grab: null
			}

			return
		}

		// Touch pans natively: what the press was is known when it ends (or, held, when it has been held long enough).
		const press: Press = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			time: event.timeStamp,
			timer: null,
			held: false,
			grab: null
		}

		press.timer = setTimeout(() => longPress(press), LONG_PRESS_MS)
		pressRef.current = press
	}

	// A tap (or a touch extension's press): a second tap on the cell edits it, a tap on the cell that is the selection
	// asks for the menu, any other selects.
	function touchTap(event: PointerEvent<HTMLDivElement>): void {
		const hit = renderer.hit(event.clientX, event.clientY, 0)
		// A tap is a touch's press: an extension may take it (a drag ends where it began).
		const tapTaken = hit?.kind === "cell" ? cellDown(event, hit.row, hit.col) : undefined

		if (tapTaken !== undefined && tapTaken !== false) {
			if (tapTaken !== true) tapTaken.end(true)

			return
		}

		if (hit === null || grid.cellless()) return

		if (hit.kind !== "cell") {
			lastTapRef.current = null
			focusGrid()
			selectHit(hit, false, false)
			touched()
			onTouchMenu?.(false)

			return
		}

		const cell = { row: hit.row, col: hit.col }
		const tap: TouchTap = { x: event.clientX, y: event.clientY, time: event.timeStamp, cell }

		if (isDoubleTap(lastTapRef.current, tap)) {
			lastTapRef.current = null
			touched()

			if (onCellActivate?.(cell) !== true) editByTouch()

			return
		}

		lastTapRef.current = tap

		if (isSoleCell(grid.getSnapshot().selection, cell, merges())) {
			focusGrid()
			touched()
			// Once a second tap is no longer coming.
			menuTimerRef.current = setTimeout(() => {
				menuTimerRef.current = null
				onTouchMenu?.(true)
			}, DOUBLE_TAP_MS)

			return
		}

		focusGrid()
		selectHit(hit, false, false)
		touched()
		onTouchMenu?.(false)
	}

	// --- The touch start handle: dragged, the selection runs from its end corner to the finger ---

	function handleStartDown(event: PointerEvent<HTMLDivElement>): void {
		const range = fillHandleShown(grid.getSnapshot().selection.ranges)

		if (event.button !== 0 || range === null) return

		event.preventDefault()
		event.stopPropagation()

		if (event.nativeEvent.isTrusted) event.currentTarget.setPointerCapture(event.pointerId)

		cancelMenuTimer()
		onTouchMenu?.(false)
		focusGrid()
		handleDragRef.current = { pointerId: event.pointerId, range, at: { row: range.startRow, col: range.startCol } }
		setHeldPhrase(selectionPhrase(grid.getSnapshot().selection, describeSelection))
	}

	function handleStartMove(event: PointerEvent<HTMLDivElement>): void {
		const drag = handleDragRef.current

		if (drag === null || drag.pointerId !== event.pointerId) return

		const local = renderer.local(event.clientX, event.clientY)

		if (local !== null) autoscroll(renderer.layoutX(local.x), local.y)

		const hit = renderer.hit(event.clientX, event.clientY, 0)

		if (hit?.kind === "cell") moveStartHandle(drag, { row: hit.row, col: hit.col })
	}

	function handleStartEnd(event: PointerEvent<HTMLDivElement>, commit: boolean): void {
		if (handleDragRef.current?.pointerId !== event.pointerId) return

		handleDragRef.current = null
		setHeldPhrase(undefined)
		stopAutoscroll()
		placeStartHandle()

		if (commit) onTouchMenu?.(true)
	}

	function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
		if (event.button !== 0 && event.button !== 2) return

		lastPointerRef.current = event.pointerType

		const hit = renderer.hit(event.clientX, event.clientY, EDGE_SLOP)

		if (hit === null) return

		if (event.pointerType === "touch") {
			touchDown(event)

			return
		}

		leaveTouch()

		// A right-click acts on the selection it lands in, or on the cell it lands on. On a header it acts on that whole
		// column (row) unless one selected already, as Excel selects it: a cell of it selected is not enough.
		if (event.button === 2) {
			if (hit.kind === "corner" || grid.cellless()) return

			const ranges = grid.getSnapshot().selection.ranges
			const inside =
				hit.kind === "cell"
					? ranges.some(range => inRange(range, hit.row, hit.col))
					: ranges.some(range =>
							holdsWhole(range, hit.kind === "colHeader" ? "cols" : "rows", hit.kind === "colHeader" ? hit.col : hit.row)
						)

			if (!inside) selectHit(hit, false, false)

			return
		}

		if ((hit.kind === "colHeader" || hit.kind === "rowHeader") && hit.edge !== null && canResize()) {
			focusGrid()
			startResize(event, hit.kind === "colHeader" ? "cols" : "rows", hit.edge)

			return
		}

		// An extension's press: nothing is selected, and an open entry keeps focus.
		const taken = hit.kind === "cell" ? cellDown(event, hit.row, hit.col) : undefined

		if (hit.kind === "cell" && taken !== undefined && taken !== false) {
			event.preventDefault()

			if (taken !== true) {
				takenRef.current = { pointerId: event.pointerId, drag: taken, row: hit.row, col: hit.col }
				event.currentTarget.setPointerCapture(event.pointerId)
			}

			return
		}

		// A press on the selection's border drags it (cellDrag.ts), whatever the keys: they say what the drop does.
		const border = hit.kind === "cell" ? borderUnder(event.clientX, event.clientY) : null

		if (hit.kind === "cell" && border !== null) {
			event.preventDefault()
			focusGrid()
			startCellDrag(event.pointerId, border, { row: hit.row, col: hit.col }, dragKeys(event, onMac))
			event.currentTarget.setPointerCapture(event.pointerId)

			return
		}

		const { sheet: shownSheet, editing: open } = grid.getSnapshot()

		focusGrid()

		// An entry pointing at another sheet that this press does not point with ends, and its own sheet is shown
		// again: nothing is selected there from a press on this one.
		if (open !== null && open.sheet !== shownSheet) return

		// A chartsheet has no cells to select.
		if (grid.cellless()) return

		const add = event.ctrlKey || event.metaKey
		const kind = selectHit(hit, event.shiftKey, add)

		if (kind !== null) {
			dragRef.current = { pointerId: event.pointerId, kind, add }
			setHeldPhrase(selectionPhrase(grid.getSnapshot().selection, describeSelection))
			event.currentTarget.setPointerCapture(event.pointerId)
		}
	}

	function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
		const press = pressRef.current

		// A finger that moves pans: no long press. One that moves after its long press on the selection drags it.
		if (press !== null && press.pointerId === event.pointerId && !stillPressed(press, event.clientX, event.clientY)) {
			if (press.timer !== null) clearTimeout(press.timer)

			press.timer = null

			const source = press.grab === null || cellDragRef.current !== null ? null : dragSource()

			if (source !== null && press.grab !== null) {
				onTouchMenu?.(false)
				startCellDrag(event.pointerId, source, press.grab, { copy: false, insert: false })
				event.currentTarget.setPointerCapture(event.pointerId)
			}

			press.grab = null
		}

		const cellDrag = cellDragRef.current

		if (cellDrag !== null && cellDrag.pointerId === event.pointerId) {
			const local = renderer.local(event.clientX, event.clientY)

			if (local !== null) autoscroll(renderer.layoutX(local.x), local.y)

			// A finger has no keys: it moves.
			moveCellDrag(
				cellDrag,
				event.clientX,
				event.clientY,
				event.pointerType === "touch" ? { copy: false, insert: false } : dragKeys(event, onMac)
			)

			return
		}

		const resize = resizeRef.current

		if (resize !== null && resize.pointerId === event.pointerId) {
			moveResize(resize, event)

			return
		}

		const taken = takenRef.current

		if (taken !== null && taken.pointerId === event.pointerId) {
			const hit = renderer.hit(event.clientX, event.clientY, 0)

			if (hit?.kind === "cell" && (hit.row !== taken.row || hit.col !== taken.col)) {
				taken.row = hit.row
				taken.col = hit.col
				taken.drag.move({ row: hit.row, col: hit.col })
			}

			return
		}

		const drag = dragRef.current

		if (drag === null || drag.pointerId !== event.pointerId) {
			if (event.pointerType !== "touch" && event.buttons === 0) {
				const hit = renderer.hit(event.clientX, event.clientY, EDGE_SLOP)

				hoverCursor(hit, event.clientX, event.clientY)
				hover(event, hit)
			}

			return
		}

		const local = renderer.local(event.clientX, event.clientY)

		if (local !== null) autoscroll(renderer.layoutX(local.x), local.y)

		const hit = renderer.hit(event.clientX, event.clientY, 0)

		if (hit === null) return

		if (hit.kind === "cell") extendDrag(drag, drag.kind === "cols" ? null : hit.row, drag.kind === "rows" ? null : hit.col)
		else if (hit.kind === "colHeader" && drag.kind !== "rows") extendDrag(drag, null, hit.col)
		else if (hit.kind === "rowHeader" && drag.kind !== "cols") extendDrag(drag, hit.row, null)
	}

	function hoverCursor(hit: GridHit | null, clientX: number, clientY: number): void {
		setCursor(
			hit?.kind === "colHeader" && hit.edge !== null && canResize()
				? "col-resize"
				: hit?.kind === "rowHeader" && hit.edge !== null && canResize()
					? "row-resize"
					: hit?.kind === "cell" && borderUnder(clientX, clientY) !== null
						? "move"
						: ""
		)
	}

	function handlePointerUp(event: PointerEvent<HTMLDivElement>): void {
		const resize = resizeRef.current

		if (resize !== null && resize.pointerId === event.pointerId) {
			endResize(event)

			return
		}

		const taken = takenRef.current

		if (taken !== null && taken.pointerId === event.pointerId) {
			takenRef.current = null
			taken.drag.end(true)

			return
		}

		// The keys as the pointer lets go decide, as in Excel (let go of Ctrl first, and the block moves).
		if (cellDragRef.current?.pointerId === event.pointerId) {
			if (pressRef.current?.pointerId === event.pointerId) endPress()

			endCellDrag(event.pointerType === "touch" ? { copy: false, insert: false } : dragKeys(event, onMac))

			return
		}

		const press = pressRef.current

		if (press !== null && press.pointerId === event.pointerId) {
			endPress()

			if (!press.held && isTap(press, event.clientX, event.clientY, event.timeStamp)) touchTap(event)

			return
		}

		if (dragRef.current?.pointerId === event.pointerId) {
			dragRef.current = null
			setHeldPhrase(undefined)
			stopAutoscroll()
		}
	}

	function handlePointerCancel(event: PointerEvent<HTMLDivElement>): void {
		const taken = takenRef.current

		if (taken !== null && taken.pointerId === event.pointerId) {
			takenRef.current = null
			taken.drag.end(false)
		}

		if (resizeRef.current?.pointerId === event.pointerId) endResize(null)
		if (cellDragRef.current?.pointerId === event.pointerId) endCellDrag(null)
		if (pressRef.current?.pointerId === event.pointerId) endPress()
		if (dragRef.current?.pointerId === event.pointerId) {
			dragRef.current = null
			setHeldPhrase(undefined)
			stopAutoscroll()
		}
	}

	function handleDoubleClick(event: MouseEvent<HTMLDivElement>): void {
		// A finger's double tap is the touch code's (a browser may send a dblclick for it too).
		if (lastPointerRef.current === "touch") return

		const hit = renderer.hit(event.clientX, event.clientY, EDGE_SLOP)

		if (hit === null) return

		if ((hit.kind === "colHeader" || hit.kind === "rowHeader") && hit.edge !== null) {
			autofit(hit.kind === "colHeader" ? "cols" : "rows", hit.edge)

			return
		}

		if (hit.kind !== "cell" || grid.cellless()) return

		const point = { row: hit.row, col: hit.col }

		if (onCellActivate?.(point) === true) return

		grid.startEditing(null, "edit")
	}

	// --- Keys ---

	function navigate(direction: "up" | "down" | "left" | "right", extend: boolean): void {
		const { sheet, selection: current } = grid.getSnapshot()
		const from = extend ? current.focus : current.active

		grid.session.query("navigate", { sheet, row: from.row, col: from.col, direction, to: "dataEdge" }).then(
			to => {
				const now = grid.getSnapshot()

				if (now.sheet !== sheet || now.selection !== current) return

				const point = { row: to.row, col: to.col }

				select(extend ? extendSelection(current, point, merges()) : cellSelection(point, merges()), point)
			},
			() => undefined
		)
	}

	function clearContents(): void {
		const { sheet, selection: current } = grid.getSnapshot()
		const command: SheetCommand = { type: "cells.clear", sheet, ranges: current.ranges, what: "contents" }

		if (!grid.canEdit()) {
			grid.refuseLocked(() => command)

			return
		}

		void grid.intent()
		settled(grid.command(command))
	}

	// --- Filling from the handle (fill.ts) ---

	function endFill(commit: { readonly alternate: boolean } | null): void {
		const fill = fillRef.current

		fillRef.current = null
		stopAutoscroll()
		renderer.setFillPreview(null)

		if (fill === null || commit === null || sameRange(fill.target, fill.source)) {
			placeHandle()

			return
		}

		const { sheet } = grid.getSnapshot()
		const target = fill.target
		const left = fillLeft(fill.source, target)

		select(
			{
				active: { row: fill.source.startRow, col: fill.source.startCol },
				anchor: { row: target.startRow, col: target.startCol },
				focus: { row: target.endRow, col: target.endCol },
				ranges: [target]
			},
			null
		)
		edit(() =>
			left === null
				? grid.command({ type: "fill.auto", sheet, source: fill.source, target, mode: commit.alternate ? "alternate" : "auto" })
				: grid.command({ type: "cells.clear", sheet, ranges: [left], what: "contents" })
		)
	}

	function handleFillDown(event: PointerEvent<HTMLDivElement>): void {
		const source = fillHandleShown(grid.getSnapshot().selection.ranges)

		if (event.button !== 0 || source === null || !grid.canEdit()) return

		event.preventDefault()
		event.stopPropagation()

		// The handle follows its pointer off itself; a script's pointer (no device behind it) has nothing to capture.
		if (event.nativeEvent.isTrusted) event.currentTarget.setPointerCapture(event.pointerId)

		focusGrid()
		fillRef.current = { pointerId: event.pointerId, source, target: source, at: { row: source.endRow, col: source.endCol } }
	}

	function handleFillMove(event: PointerEvent<HTMLDivElement>): void {
		const fill = fillRef.current

		if (fill === null || fill.pointerId !== event.pointerId) return

		const local = renderer.local(event.clientX, event.clientY)

		if (local !== null) autoscroll(renderer.layoutX(local.x), local.y)

		const hit = renderer.hit(event.clientX, event.clientY, 0)

		if (hit?.kind === "cell") moveFill(fill, { row: hit.row, col: hit.col })
		else if (hit?.kind === "colHeader") moveFill(fill, { row: fill.at.row, col: hit.col })
		else if (hit?.kind === "rowHeader") moveFill(fill, { row: hit.row, col: fill.at.col })
	}

	function handleFillUp(event: PointerEvent<HTMLDivElement>): void {
		if (fillRef.current?.pointerId !== event.pointerId) return

		// Ctrl (Option on a Mac) swaps a copy and a series, as Excel's fill handle does.
		endFill({ alternate: event.ctrlKey || (onMac && event.altKey) })
	}

	function handleFillCancel(event: PointerEvent<HTMLDivElement>): void {
		if (fillRef.current?.pointerId === event.pointerId) endFill(null)
	}

	// Fills down as far as the data beside the selection runs.
	function handleFillDoubleClick(event: MouseEvent<HTMLDivElement>): void {
		event.stopPropagation()

		const { sheet, selection: current } = grid.getSnapshot()
		const source = fillHandleShown(current.ranges)
		const axes = grid.axes(sheet)

		if (source === null || axes === null || !grid.canEdit()) return

		fillDownTo(grid.session, sheet, source, axes.rows).then(
			last => {
				if (last === null || grid.getSnapshot().selection !== current) return

				const target = { ...source, endRow: last }

				select(
					{
						...current,
						anchor: { row: source.startRow, col: source.startCol },
						focus: { row: last, col: source.endCol },
						ranges: [target]
					},
					null
				)
				edit(() => grid.command({ type: "fill.auto", sheet, source, target, mode: "auto" }))
			},
			() => undefined
		)
	}

	// On or off as the active cell is, as a toolbar button toggles it.
	function toggleFormat(format: "bold" | "italic" | "underline" | "strike"): void {
		const { sheet, selection: current } = grid.getSnapshot()
		const { row, col } = current.active
		const apply = (style: number): void => {
			const look = grid.style(style)
			const on = format === "underline" ? look.underline !== undefined : look[format] === true
			const patch: SheetFormatPatch = format === "underline" ? { underline: on ? null : "single" } : { [format]: !on }

			edit(() => grid.command({ type: "format.apply", sheet, ranges: current.ranges, patch }))
		}
		const held = grid.entry(sheet, row, col)

		if (held !== null || grid.tileHeld(sheet, row, col)) apply(held === null ? 0 : (held.tile.styles[held.entry] ?? 0))
		else
			grid.session.query("cell", { sheet, row, col }).then(
				detail => apply(detail.style),
				() => undefined
			)
	}

	// Ctrl+A: the data region round the active cell, then (pressed again, or with no data round it) the whole sheet.
	function selectRegion(whole: boolean): void {
		const { sheet, selection: current } = grid.getSnapshot()
		const all: GridSelection = {
			active: current.active,
			anchor: { row: 0, col: 0 },
			focus: { row: SHEET_MAX_ROWS - 1, col: SHEET_MAX_COLS - 1 },
			ranges: [{ startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: SHEET_MAX_COLS - 1 }]
		}

		grid.session.query("dataRegion", { sheet, row: current.active.row, col: current.active.col }).then(
			region => {
				const now = grid.getSnapshot()

				if (now.sheet !== sheet || now.selection !== current) return

				const last = current.ranges[current.ranges.length - 1]
				const alone =
					region.startRow === region.endRow &&
					region.startCol === region.endCol &&
					grid.entry(sheet, region.startRow, region.startCol) === null
				const same =
					last !== undefined &&
					current.ranges.length === 1 &&
					last.startRow === region.startRow &&
					last.startCol === region.startCol &&
					last.endRow === region.endRow &&
					last.endCol === region.endCol

				if (whole && (alone || same)) {
					select(all, null)

					return
				}

				select(
					{
						active: current.active,
						anchor: { row: region.startRow, col: region.startCol },
						focus: { row: region.endRow, col: region.endCol },
						ranges: [region]
					},
					null
				)
			},
			() => undefined
		)
	}

	// Ctrl+' and Ctrl+Shift+": an entry starts from the cell above's formula (as typed there) or its value.
	function fromAbove(value: boolean): void {
		const { sheet, selection: current } = grid.getSnapshot()
		const { row, col } = current.active

		if (row === 0 || !grid.canEdit()) return

		const held = grid.entry(sheet, row - 1, col)

		if (held !== null || grid.tileHeld(sheet, row - 1, col)) {
			const text = held === null ? "" : value ? entryText(held.tile, held.entry) : entryInput(held.tile, held.entry)

			grid.startEditing(text, "edit")

			return
		}

		grid.session.query("cell", { sheet, row: row - 1, col }).then(
			detail => {
				if (grid.getSnapshot().selection === current) grid.startEditing(detail.input, "edit")
			},
			() => undefined
		)
	}

	function switchSheet(step: 1 | -1): void {
		const { sheets, sheet } = grid.getSnapshot()
		const shown = sheets.filter(entry => entry.state === "visible")
		const target = shown[shown.findIndex(entry => entry.id === sheet) + step]

		if (target !== undefined) void grid.showSheet(target.id)
	}

	// Rows or columns inserted or deleted when whole ones are selected; cells alone are the app's (a dialog asks how,
	// as the app was handed the shortcut first). The key is taken either way: the page never zooms on it.
	// Several ranges: each one's (Ctrl+click), in one step; whole rows with whole columns are refused, as Excel does.
	function insertOrDelete(type: "axis.insert" | "axis.delete"): void {
		const { sheet, selection: current } = grid.getSnapshot()
		const axis = wholeAxis(current)

		if (axis === null) return

		if (axis === "mixed") {
			if (grid.canChange())
				grid.refuse({ reason: "multipleSelection", detail: "mixed" }, axisMove(type, sheet, "rows", current.ranges))

			return
		}

		edit(() => grid.command(axisMove(type, sheet, axis, current.ranges)))
	}

	// A shortcut the grid performs itself: false for the app's.
	function runShortcut(shortcut: SheetShortcut): boolean {
		const { sheet, selection: current, state } = grid.getSnapshot()
		const merges_ = merges()
		const range = current.ranges[current.ranges.length - 1] as SheetRange
		const earlier = current.ranges.length > 1 ? { ...current, ranges: current.ranges.slice(0, -1) } : null
		const numFmt = SHORTCUT_FORMATS[shortcut]
		// A text file holds no formats.
		const formats = !TEXT_KINDS.has(grid.kind)

		if (FORMAT_SHORTCUTS.has(shortcut) && !formats) return true

		if (numFmt !== undefined) {
			edit(() => grid.command({ type: "format.apply", sheet, ranges: current.ranges, patch: { numFmt } }))

			return true
		}

		switch (shortcut) {
			case "fillDown":
			case "fillRight": {
				const direction: FillDirection = shortcut === "fillDown" ? "down" : "right"

				edit(() => grid.command({ type: "fill.copy", sheet, ranges: current.ranges, direction }))

				return true
			}
			case "repeat":
				edit(() => grid.repeat(current))

				return true
			case "redoOrRepeat":
				edit(() => (state.canRedo ? grid.redo() : grid.repeat(current)))

				return true
			case "insertDate":
			case "insertTime":
				grid.startEditing(shortcut === "insertDate" ? dateEntry(new Date()) : timeEntry(new Date()), "enter")

				return true
			case "selectColumns":
				select(axisSelection("cols", range.startCol, range.endCol, current.active, earlier), null)

				return true
			case "selectRows":
				select(axisSelection("rows", range.startRow, range.endRow, current.active, earlier), null)

				return true
			case "selectAll":
			case "selectRegion":
				selectRegion(shortcut === "selectAll")

				return true
			case "collapseSelection":
				select(cellSelection(current.active, merges_), current.active)

				return true
			case "nextCorner": {
				const corners: GridPoint[] = [
					{ row: range.startRow, col: range.startCol },
					{ row: range.startRow, col: range.endCol },
					{ row: range.endRow, col: range.endCol },
					{ row: range.endRow, col: range.startCol }
				]
				const at = corners.findIndex(corner => corner.row === current.active.row && corner.col === current.active.col)
				const next = corners[(at + 1) % corners.length] as GridPoint

				select({ ...current, active: next }, next)

				return true
			}
			case "revealActive":
				renderer.reveal(current.active)

				return true
			case "screenLeft":
			case "screenRight": {
				const step = renderer.pageCols() * (shortcut === "screenLeft" ? -1 : 1)
				const point = { row: current.active.row, col: Math.max(0, Math.min(SHEET_MAX_COLS - 1, current.active.col + step)) }

				if (grid.choose(cellSelection(point, merges_))) renderer.page(current.active, point)

				return true
			}
			case "nextSheet":
			case "previousSheet":
				switchSheet(shortcut === "nextSheet" ? 1 : -1)

				return true
			case "formulaFromAbove":
			case "valueFromAbove":
				fromAbove(shortcut === "valueFromAbove")

				return true
			case "showFormulas":
				grid.setShowFormulas(!grid.getSnapshot().showFormulas)

				return true
			case "insertCells":
			case "deleteCells":
				insertOrDelete(shortcut === "insertCells" ? "axis.insert" : "axis.delete")

				return true
			case "bold":
			case "italic":
			case "underline":
				toggleFormat(shortcut)

				return true
			case "strikethrough":
				toggleFormat("strike")

				return true
			default:
				return false
		}
	}

	// Ctrl+Home on a sheet with frozen panes goes to the first cell under and right of them, as Excel does.
	function frozenHome(event: KeyboardEvent<HTMLDivElement>): boolean {
		const pane = grid.getSnapshot().layout?.pane ?? null

		if (event.key !== "Home" || !(event.ctrlKey || event.metaKey) || event.altKey || pane === null || pane.rows + pane.cols === 0)
			return false

		const current = grid.getSnapshot().selection
		const point = { row: pane.rows > 0 ? pane.firstRow + pane.rows : 0, col: pane.cols > 0 ? pane.firstCol + pane.cols : 0 }

		select(event.shiftKey ? extendSelection(current, point, merges()) : cellSelection(point, merges()), point)

		return true
	}

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		if (event.target !== event.currentTarget) return

		// A key is no finger's: a selection it makes shows no touch handle, and the menu goes.
		if (touchModeRef.current || menuTimerRef.current !== null) leaveTouch()
		if (cellDragKeys(event)) return
		if (onKey?.(event) === true) return

		if (resizeRef.current !== null || fillRef.current !== null) {
			if (event.key === "Escape") {
				event.preventDefault()
				event.stopPropagation()

				if (resizeRef.current !== null) endResize(null)
				else endFill(null)
			}

			return
		}

		// Esc takes the copy's moving border away (and cancels a cut), as in Excel; with none showing it is the app's.
		if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && grid.cancelClip()) {
			event.preventDefault()
			event.stopPropagation()

			return
		}

		// An input method's key, or a dead key, is no shortcut: an empty entry opens and takes focus before the key's
		// default runs, so what it composes lands in the entry. A chartsheet has no cell to enter.
		if (isImeKeydown(event.nativeEvent) || event.key === "Dead") {
			if (!cellless)
				flushSync(() => {
					grid.startEditing("", "enter")
				})

			return
		}

		const shortcut = shortcutOf(event, onMac)

		// A chartsheet's keys move to nothing, enter nothing and select nothing; Ctrl+Y redoes, never repeats on cells.
		if (cellless && shortcut === "redoOrRepeat") {
			event.preventDefault()

			if (grid.getSnapshot().state.canRedo) edit(() => grid.redo())

			return
		}

		if (cellless && shortcut !== null && !CELLLESS_SHORTCUTS.has(shortcut)) return

		if (shortcut !== null) {
			if (onShortcut?.(shortcut) === true || (!APP_SHORTCUTS.has(shortcut) && runShortcut(shortcut))) {
				event.preventDefault()

				return
			}

			// An app shortcut nobody took: the key keeps its default.
			if (APP_SHORTCUTS.has(shortcut)) return
		}

		if (!cellless && frozenHome(event)) {
			event.preventDefault()

			return
		}

		const mod = event.ctrlKey || event.metaKey
		const key = layoutKey(event).toLowerCase()

		if (mod && !event.altKey && (key === "z" || key === "y")) {
			if (grid.canChange()) {
				event.preventDefault()

				settled(key === "z" && !event.shiftKey ? grid.undo() : grid.redo())
			}

			return
		}

		if (cellless) return

		const { sheet, layout: current, selection: currentSelection } = grid.getSnapshot()
		const axes = grid.axes(sheet)

		if (current !== null && axes !== null) {
			const tabOrigin = grid.tabOrigin()
			const move = keyMove(event, currentSelection, axes, current, grid.merges(current), renderer.pageRows(), tabOrigin)

			// A move is the grid's alone: Mod+Shift+Arrow selects to the edge, and must not also reach the page's own keys
			// (the audio player's skip).
			if (move !== null) {
				event.preventDefault()
				event.stopPropagation()

				if (move.kind === "navigate") {
					navigate(move.direction, move.extend)

					return
				}

				// On a protected sheet a move passes over the cells it may not select, as Tab goes from one unlocked cell
				// to the next in Excel; with none that way, the selection stays.
				let landed = move

				for (let step = 0; step < MAX_PROTECTED_STEPS && !grid.selectable(sheet, landed.selection.active); step++) {
					const next = keyMove(event, landed.selection, axes, current, grid.merges(current), renderer.pageRows())

					if (
						next?.kind !== "select" ||
						(next.selection.active.row === landed.selection.active.row &&
							next.selection.active.col === landed.selection.active.col)
					)
						break

					landed = next
				}

				// Page Up and Page Down scroll a screen with the cell they move.
				if (event.key === "PageDown" || event.key === "PageUp") {
					if (grid.choose(landed.selection))
						renderer.page(event.shiftKey ? currentSelection.focus : currentSelection.active, landed.reveal)
				} else select(landed.selection, landed.reveal, event.key === "Tab" ? currentSelection.active : undefined)

				return
			}
		}

		if (event.key === "F2") {
			event.preventDefault()
			grid.startEditing(null, "edit")

			return
		}

		// A Mac keyboard's delete key sends Backspace: Excel for Mac clears the selection on it.
		if (event.key === "Delete" || (event.key === "Backspace" && onMac && !mod && !event.altKey && !event.shiftKey)) {
			event.preventDefault()
			clearContents()

			return
		}

		// Backspace empties the active cell into a new entry, as Excel does.
		if (event.key === "Backspace") {
			event.preventDefault()
			grid.startEditing("", "enter")

			return
		}

		// A character starts an entry that replaces the cell; on a locked cell the model reports the refusal.
		if (isTypedCharacter(event) && grid.startEditing(event.key, "enter")) event.preventDefault()
	}

	// --- Editor ---

	function commitTo(next: GridSelection | null, tabFrom?: GridPoint): void {
		void grid.commitEditing(next, tabFrom)
		focusGrid()

		if (next !== null) renderer.reveal(next.active)
	}

	function handleEditorKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
		if (onEditorKey?.(event) === true || isImeKeydown(event.nativeEvent)) return

		const { sheet: shownSheet, editing: open } = grid.getSnapshot()
		const shortcut = shortcutOf(event, onMac)

		// Go To (F5, Ctrl+G) is the grid's, not the browser's: F5 would reload the page under the entry.
		if (shortcut === "goTo") {
			event.preventDefault()

			return
		}

		// A formula's entry moves through the sheets to point at their cells, as Excel's Ctrl+Page Down does.
		if ((shortcut === "nextSheet" || shortcut === "previousSheet") && grid.formulaOpen()) {
			event.preventDefault()
			switchSheet(shortcut === "nextSheet" ? 1 : -1)

			return
		}

		// A key that ends an entry pointing at another sheet acts on the entry's own sheet, shown again first.
		if (
			open !== null &&
			open.sheet !== shownSheet &&
			(event.key === "Enter" ||
				event.key === "Tab" ||
				(event.key.startsWith("Arrow") &&
					open.mode === "enter" &&
					!event.shiftKey &&
					!event.ctrlKey &&
					!event.metaKey &&
					!event.altKey))
		)
			grid.setSheet(open.sheet, true)

		const { sheet, layout: current, selection: currentSelection, editing: entry } = grid.getSnapshot()
		const axes = grid.axes(sheet)

		if (entry === null || current === null || axes === null) return

		const mergeList = grid.merges(current)

		if (shortcut !== null && EDITOR_SHORTCUTS.has(shortcut)) {
			// Today's date or the time, typed at the caret.
			event.preventDefault()

			const input = event.currentTarget

			input.setRangeText(
				shortcut === "insertDate" ? dateEntry(new Date()) : timeEntry(new Date()),
				input.selectionStart,
				input.selectionEnd,
				"end"
			)
			grid.setEditText(input.value)

			return
		}

		// F4 in a formula: the reference at the caret cycles through absolute and relative.
		if (shortcut === "repeat" && entry.text.startsWith("=")) {
			const input = event.currentTarget
			const cycled = cycleReference(entry.text.slice(1), (input.selectionEnd ?? input.value.length) - 1)

			if (cycled !== null) {
				event.preventDefault()
				input.value = `=${cycled.formula}`
				input.setSelectionRange(cycled.end + 1, cycled.end + 1)
				grid.setEditText(input.value)
			}

			return
		}

		if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
			event.preventDefault()
			fillSelection(entry.text, currentSelection)

			return
		}

		// Ctrl+Shift+Enter (Cmd+Shift+Return): Excel's array entry, which keeps the active cell where it is.
		if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey && event.shiftKey) {
			event.preventDefault()
			commitTo(null)

			return
		}

		if (event.key === "Enter" && event.altKey) {
			// A line break in the entry.
			event.preventDefault()

			const input = event.currentTarget

			input.setRangeText("\n", input.selectionStart, input.selectionEnd, "end")
			grid.setEditText(input.value)

			return
		}

		if (event.key === "Enter" || event.key === "Tab") {
			event.preventDefault()

			const move = keyMove(
				{ key: event.key, shiftKey: event.shiftKey, ctrlKey: false, metaKey: false, altKey: false },
				currentSelection,
				axes,
				current,
				mergeList,
				1,
				grid.tabOrigin()
			)

			commitTo(move?.kind === "select" ? move.selection : null, event.key === "Tab" ? { row: entry.row, col: entry.col } : undefined)

			return
		}

		if (event.key === "Escape") {
			event.preventDefault()
			event.stopPropagation()
			grid.cancelEditing()
			focusGrid()

			return
		}

		if (event.key === "F2") {
			event.preventDefault()
			grid.setEditMode(entry.mode === "enter" ? "edit" : "enter")

			return
		}

		const direction = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" }[event.key] as
			"up" | "down" | "left" | "right" | undefined

		// Enter mode: an arrow commits and moves, as Excel does.
		if (direction !== undefined && entry.mode === "enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
			event.preventDefault()
			commitTo(stepFrom({ row: entry.row, col: entry.col }, direction, axes, current, mergeList))
		}
	}

	// Ctrl+Enter: the entry goes into every selected cell (a merge's first one), a formula's relative references
	// moving from the active cell to each, as Excel fills a selection. The session lists the cells (fill.entry).
	// The extensions check the entry first, as they check one committed (an entry they stop is reopened or dropped).
	function fillSelection(text: string, current: GridSelection): void {
		const { sheet, editing: entry } = grid.getSnapshot()

		grid.cancelEditing()
		focusGrid()

		if (entry === null) return

		void grid.checkEntry({ ...entry, text }).then(checked => {
			if (checked.verdict === "commit")
				edit(() => grid.command({ type: "fill.entry", sheet, ranges: current.ranges, entry: checked.text, from: current.active }))
		})
	}

	function handleEditorBlur(event: FocusEvent<HTMLTextAreaElement>): void {
		const related = event.relatedTarget

		// Focus went to a control that edits the same entry (a formula bar marks itself so).
		if (related instanceof Element && related.closest("[data-sheet-editor]") !== null) return
		// The window or tab losing focus leaves the entry open: focus comes back to it.
		if (!document.hasFocus()) return
		if (grid.getSnapshot().editing !== null) void grid.commitEditing(null)
	}

	function editorElement(element: HTMLDivElement | null): void {
		renderer.setEditor(element)
	}

	useImperativeHandle(
		ref,
		() => ({
			focus: () => scrollerRef.current?.focus({ preventScroll: true }),
			reveal: point => renderer.reveal(point),
			goTo: point => {
				const current = grid.getSnapshot().layout

				if (grid.choose(cellSelection(point, current === null ? [] : grid.merges(current)))) renderer.reveal(point)
			},
			hit: (clientX, clientY) => renderer.hit(clientX, clientY, EDGE_SLOP),
			cellRect: point => renderer.cellRect(point),
			clientRect: point => {
				const box = renderer.cellRect(point)
				const root = rootRef.current

				if (box === null || root === null) return null

				const origin = root.getBoundingClientRect()

				return new DOMRect(origin.left + box.x, origin.top + box.y, box.width, box.height)
			},
			onFrame: listener => renderer.onFrame(listener),
			editActive: () => editByTouch(),
			rangeRect: range => renderer.rangeRect(range),
			editorKey: event => handleEditorKey(event),
			renderer
		}),
		[grid, renderer, onEditorKey, onMac]
	)

	return (
		<div
			ref={rootRef}
			className={className === undefined ? "fo-sheet" : `fo-sheet ${className}`}
			data-editing={editing === null ? undefined : ""}
		>
			<canvas
				ref={cellsRef}
				className="fo-sheet-canvas"
				aria-hidden="true"
			/>
			<canvas
				ref={chromeRef}
				className="fo-sheet-canvas"
				aria-hidden="true"
			/>
			<div
				ref={scrollerRef}
				className="fo-sheet-scroller"
				role="grid"
				aria-label={label}
				aria-rowcount={SHEET_MAX_ROWS}
				aria-colcount={SHEET_MAX_COLS}
				aria-multiselectable="true"
				aria-readonly={readOnly}
				aria-activedescendant={layout === null || cellless ? undefined : activeId}
				tabIndex={0}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerCancel}
				onPointerLeave={handlePointerLeave}
				onDoubleClick={handleDoubleClick}
				onKeyDown={handleKeyDown}
				onKeyUp={event => {
					if (event.target === event.currentTarget) cellDragKeys(event)
				}}
			>
				<div
					ref={extentRef}
					className="fo-sheet-extent"
				>
					<div
						ref={activeRef}
						role="row"
						aria-rowindex={selection.active.row + 1}
						className="fo-sheet-a11y"
					>
						<div
							id={activeId}
							role="gridcell"
							aria-colindex={selection.active.col + 1}
							aria-selected="true"
							aria-readonly={readOnly}
						>
							{active.text}
						</div>
						{/* Focused for a moment as a finger opens an entry (editByTouch): the soft keyboard comes up for it. */}
						<input
							ref={sinkRef}
							className="fo-sheet-touch-sink"
							aria-hidden="true"
							tabIndex={-1}
							autoComplete="off"
							autoCapitalize="off"
							spellCheck={false}
							onBlur={event => {
								event.currentTarget.value = ""
							}}
						/>
					</div>
				</div>
			</div>
			{children === undefined ? null : <div className="fo-sheet-overlays">{children}</div>}
			{editing === null ? null : (
				<CellEditor
					id={editorId}
					label={editorLabel}
					text={editing.text}
					invalid={editing.invalid}
					backdrop={backdrop}
					element={editorElement}
					onText={text => grid.setEditText(text)}
					onKeyDown={handleEditorKey}
					onBlur={handleEditorBlur}
				/>
			)}
			<div
				className="fo-sheet-live"
				role="status"
				aria-live="polite"
				aria-atomic="true"
			>
				{liveText}
			</div>
			<div
				ref={tipRef}
				className="fo-sheet-tip"
				role="status"
				hidden
			/>
			{/* The fill handle (fill.ts): placed on every frame; Ctrl+D, Ctrl+R and the Series dialog do the same by keys. */}
			<div
				ref={handleRef}
				className="fo-sheet-fill-handle"
				aria-hidden="true"
				hidden
				onPointerDown={handleFillDown}
				onPointerMove={handleFillMove}
				onPointerUp={handleFillUp}
				onPointerCancel={handleFillCancel}
				onDoubleClick={handleFillDoubleClick}
			/>
			{/* A touch selection's start handle: dragged, the selection follows the finger (touch/gestures.ts). */}
			<div
				ref={startHandleRef}
				className="fo-sheet-touch-handle"
				aria-hidden="true"
				hidden
				onPointerDown={handleStartDown}
				onPointerMove={handleStartMove}
				onPointerUp={event => handleStartEnd(event, true)}
				onPointerCancel={event => handleStartEnd(event, false)}
			/>
		</div>
	)
}

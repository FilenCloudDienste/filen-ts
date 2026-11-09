import {
	CellFlag,
	SHEET_MAX_COLS,
	SHEET_MAX_ROWS,
	tileKey,
	tileKeyCol,
	tileKeyRow,
	tileKeySheet,
	type SheetAxis,
	type SheetChange,
	type SheetCommand,
	type SheetCommandResult,
	type SheetDocState,
	type SheetEvent,
	type SheetFileKind,
	type SheetId,
	type SheetLayout,
	type SheetRange,
	type SheetRefusal,
	type SheetRenderStyle,
	type SheetSessionApi,
	type SheetStyleAppend,
	type SheetSummary,
	type SheetTile,
	type SheetWorkbookInfo,
	type SheetWritability
} from "../../core/sheet/protocol"
import { createGridAxis, type GridAxis } from "./axis"
import { checkEntry, type SheetEntryHook } from "./layers"
import { RowFitter, type TextMeasure } from "./rowFit"
import { cellSelection, fromSelectionState, mergeRanges, singleCell, type GridPoint, type GridSelection } from "./selection"
import { TileCache, entryInput, entryOf, entryText, regionHoldsTile, type GridEntry } from "./tiles"

// What a grid knows of an open session, outside React: the sheet list, layouts, render styles and the tiles in
// view (an LRU cache the frame's needs bound), kept current by command answers and session events in the order
// they arrive. React reads a small snapshot (sheet, selection, editing, document state); the canvas reads the
// rest on every frame it draws, so a tile arriving or a scroll step renders no component.

// Blank rows and columns shown past the used area (and past the active cell), as a spreadsheet shows.
export const EXTRA_ROWS = 100
export const EXTRA_COLS = 20
const MIN_COLS = 26
// Tiles kept beyond what a frame needs: room for scrolling back without fetching again.
const MIN_CAPACITY = 24

export interface GridEditing {
	readonly sheet: SheetId
	readonly row: number
	readonly col: number
	readonly text: string
	// The cell's input when editing started (null: not known yet, the cell query brings it): committing it unchanged
	// sends nothing.
	readonly initial: string | null
	// Started from the cell's input (F2, the formula bar), not from what was typed.
	readonly fromInput: boolean
	// "enter": started by typing, arrows commit and move (Excel's Enter mode); "edit": F2, arrows move the caret.
	readonly mode: "enter" | "edit"
	// A commit was refused (a formula that does not read as one): kept open, marked.
	readonly invalid: boolean
}

// Whether committing the entry changes the cell. One started from the cell's input before it was known, still
// empty, is unchanged; any other entry whose start was not known is a change (typing replaces, Backspace clears).
export function editingChanged(editing: GridEditing): boolean {
	return editing.initial === null ? !(editing.fromInput && editing.text === "") : editing.text !== editing.initial
}

export interface GridActiveCell {
	readonly text: string
	readonly input: string
	readonly flags: number
	// Its tile is held: text and flags are the cell's, not a placeholder.
	readonly known: boolean
}

export type GridEngineState = "none" | "building" | "ready" | "failed"

export interface SheetGridSnapshot {
	readonly sheet: SheetId
	readonly sheets: readonly SheetSummary[]
	readonly layout: SheetLayout | null
	readonly state: SheetDocState
	readonly writability: SheetWritability
	readonly engine: GridEngineState
	readonly selection: GridSelection
	readonly editing: GridEditing | null
	readonly active: GridActiveCell
	// The session failed (its worker died): nothing answers any more.
	readonly failed: string | null
	// The app's own view-only (a shared link, a preview): no editing starts.
	readonly readOnly: boolean
	// Formulas are shown in their cells instead of their results (Ctrl+`).
	readonly showFormulas: boolean
}

// The session's latest copy or cut (the "copy" query's clip id) and the range it was taken from.
export interface SheetGridClip {
	readonly id: number
	readonly sheet: SheetId
	readonly range: SheetRange
	readonly cut: boolean
}

export interface GridAxes {
	readonly rows: GridAxis
	readonly cols: GridAxis
	readonly scale: number
}

// A resize being dragged: sizes at 100 % (NaN: back to the default) shown until the session's answer lands.
export interface GridResizeDraft {
	readonly sheet: SheetId
	readonly axis: "rows" | "cols"
	readonly sizes: ReadonlyMap<number, number>
}

// A sheet's kept sizes: pixels at 100 % by index, over the file's.
export interface SheetGridKeptSizes {
	readonly cols: ReadonlyMap<number, number>
	readonly rows: ReadonlyMap<number, number>
}

// A shift of rows or columns, as a size layer follows it: `revert` undoes an earlier shift (an undone delete gets
// back the sizes it took out).
export interface SheetGridShift {
	readonly type: "insert" | "delete"
	readonly axis: SheetAxis
	readonly at: number
	readonly count: number
	readonly revert: boolean
}

// Sizes the app keeps beside the file (its key-value layer) for a session that cannot hold them: a text file, or a
// workbook that is view-only (by its writability or the app's). The grid draws them over the file's, and resizes,
// autofits and row or column shifts go to them instead of the session.
export interface SheetGridSizes {
	// The sheet's kept sizes, the same object until they change; undefined for none.
	sizes(sheet: SheetId): SheetGridKeptSizes | undefined
	// Indices resized (null: back to the file's size).
	update(sheet: SheetId, axis: SheetAxis, entries: readonly (readonly [index: number, px: number | null])[]): void
	follow(sheet: SheetId, shift: SheetGridShift): void
}

interface SheetShiftStep {
	readonly sheet: SheetId
	readonly shift: SheetGridShift
}

const TEXT_KINDS: ReadonlySet<SheetFileKind> = new Set(["csv", "tsv", "tab"])

// A refused command and what it was, for the app's message (or, for a refusal that asks the user, its question).
export type SheetGridRefusalHandler = (refusal: SheetRefusal, command: SheetCommand | "undo" | "redo") => void

export interface SheetGridModelOptions {
	readonly session: SheetSessionApi
	readonly info: SheetWorkbookInfo
}

interface InFlight {
	// A change touched the tile after it was built: it is fetched again.
	stale: boolean
	// A whole-tile patch that arrived before the tile did.
	replacement: SheetTile | null
}

// A command F4 can do again elsewhere: one that acts on the selection's ranges, or inserts or deletes rows or
// columns at it.
function repeatable(command: SheetCommand): boolean {
	if (command.type === "axis.insert" || command.type === "axis.delete") return true

	const fields = command as { readonly sheet?: unknown; readonly ranges?: unknown }

	return typeof fields.sheet === "number" && Array.isArray(fields.ranges)
}

// Fields holding the user's answer to a question about the cells a command was first sent for: a repeat elsewhere
// goes without them, so it is refused again and the app asks about those cells.
const CONSENTS: readonly string[] = ["discard"]

function withoutConsent(command: SheetCommand): SheetCommand {
	if (!CONSENTS.some(field => field in command)) return command

	const repeated: Record<string, unknown> = { ...command }

	for (const field of CONSENTS) delete repeated[field]

	return repeated as unknown as SheetCommand
}

// A sheet with no cells: a chartsheet (its chart is all it shows) or a dialog sheet (ECMA-376 §18.3.1.34: no
// sheetData). Nothing on it is selected, entered or moved to by keys.
export function celllessSheet(snapshot: SheetGridSnapshot, sheet: SheetId = snapshot.sheet): boolean {
	const kind = snapshot.sheets.find(entry => entry.id === sheet)?.kind

	return kind === "chartsheet" || kind === "dialogsheet"
}

// Whether the sheet's cells, rows and columns can be changed: a worksheet's only (the session refuses the others; a
// macro sheet's cells are shown, not edited). A sheet not listed yet counts as a worksheet.
export function cellsEditable(snapshot: SheetGridSnapshot, sheet: SheetId = snapshot.sheet): boolean {
	const kind = snapshot.sheets.find(entry => entry.id === sheet)?.kind

	return kind === undefined || kind === "worksheet"
}

// Whether an entry can start in the active cell: not view-only, the session alive, a worksheet, the cell not locked.
export function canEditSnapshot(snapshot: SheetGridSnapshot): boolean {
	const { writability, failed, active, readOnly } = snapshot

	return (
		!readOnly &&
		failed === null &&
		writability.state !== "viewOnly" &&
		cellsEditable(snapshot) &&
		(active.flags & CellFlag.LOCKED) === 0
	)
}

const NO_ACTIVE: GridActiveCell = { text: "", input: "", flags: 0, known: false }

function pendingKey(sheet: SheetId, row: number, col: number): string {
	return `${String(sheet)}:${String(row)}:${String(col)}`
}

function sameActive(a: GridActiveCell, b: GridActiveCell): boolean {
	return a.text === b.text && a.input === b.input && a.flags === b.flags && a.known === b.known
}

export class SheetGridModel {
	readonly session: SheetSessionApi
	readonly tiles = new TileCache()
	readonly date1904: boolean
	readonly kind: SheetFileKind
	private snapshot: SheetGridSnapshot
	private readonly listeners = new Set<() => void>()
	private readonly painters = new Set<() => void>()
	private cellsGeneration = 0
	private readonly inFlight = new Map<number, InFlight>()
	// What the last frame needed: never evicted.
	private needed: ReadonlySet<number> = new Set()
	private readonly styles: SheetRenderStyle[] = []
	private readonly layouts = new Map<SheetId, SheetLayout>()
	private readonly layoutRequests = new Set<SheetId>()
	private readonly selections = new Map<SheetId, GridSelection>()
	// Counts the user's selection moves (select, setSheet): a command's answer takes the selection it carries only
	// when no move came after the command was sent, so a paste landing late never undoes where the user went.
	private moves = 0
	// A run of Tab moves on one row: the cell it began in and the cell the last Tab left. Enter at the end of the run
	// goes to the next row in the column it began in, as Excel does; any other selection move ends the run.
	private tabRun: { readonly sheet: SheetId; readonly origin: GridPoint; readonly at: GridPoint } | null = null
	private readonly reach = new Map<SheetId, GridPoint>()
	private readonly pending = new Map<string, string>()
	// The commit each pending text is from: a later commit of the same cell owns it, and an earlier one's answer
	// leaves it alone.
	private readonly pendingOwners = new Map<string, number>()
	private commits = 0
	private readonly mergeMemo = new WeakMap<Uint32Array, SheetRange[]>()
	private axesMemo: {
		layout: SheetLayout
		rows: number
		cols: number
		scale: number
		draft: GridResizeDraft | null
		kept: SheetGridKeptSizes | undefined
		axes: GridAxes
	} | null = null
	private draft: GridResizeDraft | null = null
	private sizeLayer: SheetGridSizes | null = null
	// Row and column shifts of the steps the session can undo and redo, for the size layer to follow back.
	private readonly shifts: { undo: (SheetShiftStep | null)[]; redo: (SheetShiftStep | null)[] } = { undo: [], redo: [] }
	private zoom: number | null = null
	private intention: Promise<SheetWritability> | null = null
	private disposed = false
	// The cell query of the open entry whose start was not known (identity: a later entry asks again).
	private entryQuery: object | null = null
	// A clipped active cell's whole input, from the cell query, for the tile it was asked for (a new tile asks again).
	private clipped: { sheet: SheetId; row: number; col: number; tile: GridEntry["tile"]; input: string | null } | null = null
	// Refused commands, for the app's message.
	private onRefusal: SheetGridRefusalHandler | null = null
	private entryHooks: readonly SheetEntryHook[] = []
	// The last command that changed the file and can be done again on another selection (F4).
	private lastRepeatable: SheetCommand | null = null
	// The latest copy or cut, and whether its moving border shows (until Esc, an edit, or a cut's paste).
	private clip: SheetGridClip | null = null
	private clipShown = false
	// Rows without a height of their own fitted to the wrapped text an edit changes (rowFit.ts).
	private readonly fitter = new RowFitter(this)

	constructor(options: SheetGridModelOptions) {
		const { session, info } = options

		this.session = session
		this.date1904 = info.date1904
		this.kind = info.kind
		this.appendStyles(info.styles)
		this.layouts.set(info.activeSheet, info.activeLayout)

		const merges = this.merges(info.activeLayout)
		const selection = fromSelectionState(info.activeLayout.selection, merges)

		this.selections.set(info.activeSheet, selection)
		this.snapshot = {
			sheet: info.activeSheet,
			sheets: info.sheets,
			layout: info.activeLayout,
			state: info.state,
			writability: info.writability,
			engine: "none",
			selection,
			editing: null,
			active: NO_ACTIVE,
			failed: null,
			readOnly: false,
			showFormulas: false
		}
	}

	// --- Subscriptions ---

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	getSnapshot = (): SheetGridSnapshot => this.snapshot

	// Where refused commands go (null: nowhere), for the app's message.
	setRefusalHandler(handler: SheetGridRefusalHandler | null): void {
		this.onRefusal = handler
	}

	// The grid's text measure, for fitting rows to wrapped text while it draws; returns the detach.
	measureWith(measure: TextMeasure): () => void {
		return this.fitter.attach(measure)
	}

	// Anything a frame draws changed (tiles, layout, styles, selection, a pending entry).
	onPaint(listener: () => void): () => void {
		this.painters.add(listener)

		return () => {
			this.painters.delete(listener)
		}
	}

	// What the cells layer draws from (tiles, styles, layouts, pending entries, show formulas) may have changed since
	// this last moved: a frame draws the cells again only then (or when its own inputs moved). Every repaint() moves
	// it; only a change the caller knows touches none of it (a selection move, the entry's text) leaves it.
	cellsVersion(): number {
		return this.cellsGeneration
	}

	// A new snapshot when anything in it changed (the active cell read again from the tiles held), and a frame.
	// `chromeOnly`: nothing the cells layer reads changed (the selection, the open entry).
	private update(patch: Partial<SheetGridSnapshot>, chromeOnly = false): void {
		const previous = this.snapshot
		const next = { ...previous, ...patch }

		if (patch.active === undefined) {
			const active = this.activeCell(next.sheet, next.selection.active)

			next.active = sameActive(active, previous.active) ? previous.active : active
		}

		if ((Object.keys(next) as (keyof SheetGridSnapshot)[]).some(key => next[key] !== previous[key])) {
			this.snapshot = next

			for (const listener of this.listeners) listener()
		}

		if (!chromeOnly) this.cellsGeneration++

		for (const painter of this.painters) painter()
	}

	repaint(): void {
		this.cellsGeneration++

		for (const painter of this.painters) painter()
	}

	dispose(): void {
		this.disposed = true
		this.listeners.clear()
		this.painters.clear()
	}

	// --- Reads for painting ---

	style(index: number): SheetRenderStyle {
		return this.styles[index] ?? this.styles[0] ?? {}
	}

	layout(sheet: SheetId): SheetLayout | null {
		return this.layouts.get(sheet) ?? null
	}

	merges(layout: SheetLayout): readonly SheetRange[] {
		let ranges = this.mergeMemo.get(layout.merges)

		if (ranges === undefined) {
			ranges = mergeRanges(layout.merges)
			this.mergeMemo.set(layout.merges, ranges)
		}

		return ranges
	}

	// The app's zoom in percent over the sheet's own (null: the sheet's).
	setZoom(percent: number | null): void {
		this.zoom = percent === null ? null : Math.min(400, Math.max(10, percent))
		this.axesMemo = null
		this.repaint()
	}

	setShowFormulas(showFormulas: boolean): void {
		if (showFormulas !== this.snapshot.showFormulas) this.update({ showFormulas })
	}

	scale(layout: SheetLayout): number {
		return (this.zoom ?? (layout.zoom > 0 ? layout.zoom : 100)) / 100
	}

	// Rows and columns shown: the used area, the active cell and how far the user went, plus blank ones past them.
	extent(sheet: SheetId, layout: SheetLayout): { rows: number; cols: number } {
		const reach = this.reach.get(sheet)
		const selection = this.selections.get(sheet)
		const lastRow = Math.max(layout.rowCount, (reach?.row ?? 0) + 1, (selection?.active.row ?? 0) + 1)
		const lastCol = Math.max(layout.colCount, (reach?.col ?? 0) + 1, (selection?.active.col ?? 0) + 1)

		return {
			rows: Math.min(SHEET_MAX_ROWS, lastRow + EXTRA_ROWS),
			cols: Math.min(SHEET_MAX_COLS, Math.max(MIN_COLS, lastCol + EXTRA_COLS))
		}
	}

	// The extent grows to hold this cell (a jump, or scrolling to the end).
	grow(sheet: SheetId, row: number, col: number): void {
		const reach = this.reach.get(sheet)
		const toRow = Math.min(SHEET_MAX_ROWS - 1, Math.max(row, reach?.row ?? 0))
		const toCol = Math.min(SHEET_MAX_COLS - 1, Math.max(col, reach?.col ?? 0))

		if (reach !== undefined && reach.row === toRow && reach.col === toCol) return

		this.reach.set(sheet, { row: toRow, col: toCol })
		this.axesMemo = null
		this.repaint()
	}

	// The extent gives back how far the user went, down to `row` and `col` (the renderer's choice: what its view
	// still needs). The used area and the active cell stay in extent() anyway; the selection's far corner is kept.
	shrink(sheet: SheetId, row: number, col: number): void {
		const reach = this.reach.get(sheet)

		if (reach === undefined) return

		const focus = this.selections.get(sheet)?.focus
		const toRow = Math.max(0, Math.min(reach.row, Math.max(row, focus?.row ?? 0)))
		const toCol = Math.max(0, Math.min(reach.col, Math.max(col, focus?.col ?? 0)))

		if (toRow === reach.row && toCol === reach.col) return

		this.reach.set(sheet, { row: toRow, col: toCol })
		this.axesMemo = null
		this.repaint()
	}

	axes(sheet: SheetId): GridAxes | null {
		const layout = this.layouts.get(sheet)

		if (layout === undefined) return null

		const { rows, cols } = this.extent(sheet, layout)
		const scale = this.scale(layout)
		const draft = this.draft?.sheet === sheet ? this.draft : null
		const kept = this.keepsSizes() ? this.sizeLayer?.sizes(sheet) : undefined
		const memo = this.axesMemo

		if (
			memo?.layout === layout &&
			memo.rows === rows &&
			memo.cols === cols &&
			memo.scale === scale &&
			memo.draft === draft &&
			memo.kept === kept
		)
			return memo.axes

		const overrides = (axis: SheetAxis): ReadonlyMap<number, number> | undefined => {
			const own = axis === "rows" ? kept?.rows : kept?.cols
			const dragged = draft?.axis === axis ? draft.sizes : undefined

			if (own === undefined || own.size === 0) return dragged
			if (dragged === undefined) return own

			return new Map([...own, ...dragged])
		}

		const axes: GridAxes = {
			rows: createGridAxis(layout.rows, rows, scale, overrides("rows")),
			cols: createGridAxis(layout.cols, cols, scale, overrides("cols")),
			scale
		}

		this.axesMemo = { layout, rows, cols, scale, draft, kept, axes }

		return axes
	}

	// The app's size layer (null: none). Handed in again whenever its sizes change.
	setSizes(sizes: SheetGridSizes | null): void {
		if (this.sizeLayer === sizes) return

		this.sizeLayer = sizes
		this.repaint()
	}

	// Sizes go to the app's layer: the session cannot hold them, or the file is not to be written.
	keepsSizes(): boolean {
		const { writability, readOnly } = this.snapshot

		return this.sizeLayer !== null && (TEXT_KINDS.has(this.kind) || writability.state === "viewOnly" || readOnly)
	}

	// Columns or rows can be resized: into the file, or into the app's layer (a text file holds no sizes).
	canResize(): boolean {
		return this.snapshot.failed === null && (this.keepsSizes() || (this.canChange() && !TEXT_KINDS.has(this.kind)))
	}

	// Pixel sizes at 100 % (NaN: back to the file's size), to the app's layer or the session. Resolves once the
	// new sizes are the ones drawn (a draft can go then).
	async resize(sheet: SheetId, axis: SheetAxis, indices: Uint32Array, sizes: Float32Array): Promise<void> {
		const layer = this.sizeLayer

		if (layer !== null && this.keepsSizes()) {
			layer.update(
				sheet,
				axis,
				Array.from(indices, (index, k) => {
					const px = sizes[k] ?? Number.NaN

					return [index, Number.isNaN(px) ? null : px] as const
				})
			)

			// The app hands its new sizes in when it renders, which a discrete event's update does before a macrotask.
			await new Promise(resolve => setTimeout(resolve, 0))

			return
		}

		await this.command({ type: "axis.resize", sheet, axis, indices, sizes })
	}

	setDraft(draft: GridResizeDraft | null): void {
		if (this.draft === draft) return

		this.draft = draft
		this.repaint()
	}

	getDraft(): GridResizeDraft | null {
		return this.draft
	}

	// A held cell's tile entry (no fetch).
	entry(sheet: SheetId, row: number, col: number): GridEntry | null {
		const tile = this.tiles.peek(tileKey(sheet, row >>> 6, col >>> 5))

		if (tile === undefined) return null

		const entry = entryOf(tile, row, col)

		return entry < 0 ? null : { tile, entry }
	}

	// A held cell's tile, entry or not.
	tileHeld(sheet: SheetId, row: number, col: number): boolean {
		return this.tiles.has(tileKey(sheet, row >>> 6, col >>> 5))
	}

	// What an entry being committed shows until the session's answer lands.
	pendingText(sheet: SheetId, row: number, col: number): string | undefined {
		return this.pending.size === 0 ? undefined : this.pending.get(pendingKey(sheet, row, col))
	}

	// --- Tiles ---

	// The tiles a frame draws (tile row and column pairs of one sheet): missing ones are fetched in one call, the
	// rest kept as recently used, and the cache trimmed to a multiple of the need.
	need(sheet: SheetId, coordinates: readonly number[]): void {
		if (this.disposed || this.snapshot.failed !== null) return

		const needed = new Set<number>()
		const missing: number[] = []

		for (let i = 0; i + 1 < coordinates.length; i += 2) {
			const tileRow = coordinates[i] ?? 0
			const tileCol = coordinates[i + 1] ?? 0
			const key = tileKey(sheet, tileRow, tileCol)

			if (needed.has(key)) continue

			needed.add(key)

			if (this.tiles.touch(key) !== undefined || this.inFlight.has(key)) continue

			missing.push(tileRow, tileCol)
		}

		// The active cell's tile is kept and fetched whatever is in view: the formula bar and the editor read it.
		if (sheet === this.snapshot.sheet) {
			const { row, col } = this.snapshot.selection.active
			const key = tileKey(sheet, row >>> 6, col >>> 5)

			if (!needed.has(key)) {
				needed.add(key)

				if (this.tiles.touch(key) === undefined && !this.inFlight.has(key)) missing.push(row >>> 6, col >>> 5)
			}
		}

		this.needed = needed
		this.tiles.evict(this.capacity(), needed)
		this.tiles.keep(needed)
		this.flushReleases()

		if (missing.length > 0) this.fetch(sheet, missing)
	}

	private capacity(): number {
		return Math.max(MIN_CAPACITY, this.needed.size * 3)
	}

	private flushReleases(): void {
		const released = this.tiles.takeReleased()

		if (released !== null) this.session.release(released)
	}

	private fetch(sheet: SheetId, coordinates: number[]): void {
		const keys: number[] = []

		for (let i = 0; i + 1 < coordinates.length; i += 2) {
			const key = tileKey(sheet, coordinates[i] ?? 0, coordinates[i + 1] ?? 0)

			keys.push(key)
			this.inFlight.set(key, { stale: false, replacement: null })
		}

		this.session.tiles(sheet, Uint32Array.from(coordinates)).then(
			answer => {
				if (answer.styles !== undefined) this.appendStyles(answer.styles)

				const dropped: number[] = []

				for (const tile of answer.tiles) {
					const key = tileKey(tile.sheet, tile.tileRow, tile.tileCol)
					const flight = this.inFlight.get(key)

					this.inFlight.delete(key)

					if (flight !== undefined && flight.replacement !== null && flight.replacement.version >= tile.version)
						this.tiles.put(flight.replacement)
					else if (flight?.stale === true) dropped.push(key)
					else this.tiles.put(tile)
				}

				for (const key of keys) this.inFlight.delete(key)

				this.fitter.arrived(keys)

				// A dropped tile is fetched again by the next frame that needs it; until then the session need not
				// patch it.
				if (dropped.length > 0) this.session.release(Float64Array.from(dropped))

				this.tiles.evict(this.capacity(), this.needed)
				this.flushReleases()

				// The active cell may have arrived.
				this.update({})
			},
			() => {
				for (const key of keys) this.inFlight.delete(key)
			}
		)
	}

	private appendStyles(append: SheetStyleAppend): void {
		append.styles.forEach((style, k) => {
			this.styles[append.from + k] = style
		})
	}

	// --- Sheets ---

	// `keepEntry`: an open entry stays open on its own sheet while another is shown (pointing at that sheet's cells).
	setSheet(sheet: SheetId, keepEntry = false): void {
		if (sheet === this.snapshot.sheet || !this.snapshot.sheets.some(entry => entry.id === sheet)) return

		this.moves++
		this.tabRun = null

		if (!keepEntry) this.commitOrDrop()

		const layout = this.layouts.get(sheet) ?? null

		if (layout === null) this.loadLayout(sheet)

		this.update({
			sheet,
			layout,
			selection: this.selections.get(sheet) ?? fromSelectionState(layout?.selection, layout === null ? [] : this.merges(layout)),
			...(!keepEntry && { editing: null })
		})
	}

	// Shows another sheet as the user asks (a tab, Ctrl+Page Down): an open formula entry stays open so its cells can
	// be pointed at (Excel's point mode); any other entry is committed first, and the sheet shown once it is kept.
	async showSheet(sheet: SheetId): Promise<void> {
		if (this.formulaOpen()) {
			this.setSheet(sheet, true)

			return
		}

		if (await this.commitEditing(null)) this.setSheet(sheet)
	}

	// Whether the open entry is a formula, which stays open across sheets to point at their cells.
	formulaOpen(): boolean {
		return this.snapshot.editing?.text.startsWith("=") === true
	}

	// An entry ended while another sheet is shown: its own sheet is shown again.
	private returnTo(editing: GridEditing): void {
		if (editing.sheet !== this.snapshot.sheet) this.setSheet(editing.sheet)
	}

	// Switching sheets mid-entry drops the entry (the caller commits it first when it should be kept).
	private commitOrDrop(): void {
		if (this.snapshot.editing !== null) this.snapshot = { ...this.snapshot, editing: null }
	}

	private loadLayout(sheet: SheetId): void {
		if (this.layoutRequests.has(sheet)) return

		this.layoutRequests.add(sheet)
		this.session.layout(sheet).then(
			layout => {
				this.layoutRequests.delete(sheet)
				this.storeLayout(sheet, layout)
			},
			() => {
				this.layoutRequests.delete(sheet)
			}
		)
	}

	private storeLayout(sheet: SheetId, layout: SheetLayout): void {
		const held = this.layouts.get(sheet)

		if (held !== undefined && held.version > layout.version) return

		this.layouts.set(sheet, layout)

		if (!this.selections.has(sheet)) this.selections.set(sheet, fromSelectionState(layout.selection, this.merges(layout)))

		if (sheet === this.snapshot.sheet) {
			this.update({ layout, selection: this.selections.get(sheet) ?? this.snapshot.selection })
		} else {
			this.repaint()
		}
	}

	// --- Selection ---

	// Whether sheet protection lets a cell be selected (ECMA-376 Part 1 §18.3.1.85 sheetProtection): no cell when
	// unlocked cells may not be selected, and no locked one when locked cells may not. A cell is locked unless its
	// tile entry says otherwise (the default format locks), so one whose tile is not held counts as locked.
	selectable(sheet: SheetId, point: GridPoint): boolean {
		const allows = this.layouts.get(sheet)?.protection?.allows

		if (allows === undefined) return true
		if (!allows.has("selectUnlockedCells")) return false
		if (allows.has("selectLockedCells")) return true

		const found = this.entry(sheet, point.row, point.col)

		return found !== null && ((found.tile.flags[found.entry] ?? 0) & CellFlag.LOCKED) === 0
	}

	// A selection the user made (a key, a click, the name box): its active cell must be selectable, else nothing
	// changes. Answers whether it was taken.
	// `tabFrom`: the move is a Tab (or Shift+Tab) from that cell.
	choose(selection: GridSelection, tabFrom?: GridPoint): boolean {
		if (!this.selectable(this.snapshot.sheet, selection.active)) return false

		this.select(selection, tabFrom)

		return true
	}

	// `tabFrom`: the move is a Tab (or Shift+Tab) from that cell, which begins a run of them or goes on with one on
	// the same row; any other move ends the run.
	select(selection: GridSelection, tabFrom?: GridPoint): void {
		const sheet = this.snapshot.sheet
		const prior = this.selections.get(sheet)

		if (tabFrom !== undefined && singleCell(selection) && (prior === undefined || singleCell(prior))) {
			const run = this.tabRun
			const goesOn =
				run !== null &&
				run.sheet === sheet &&
				run.origin.row === tabFrom.row &&
				run.at.row === tabFrom.row &&
				run.at.col === tabFrom.col

			this.tabRun = { sheet, origin: goesOn ? run.origin : tabFrom, at: selection.active }
		} else this.tabRun = null

		this.moves++
		this.selections.set(sheet, selection)

		const reach = this.reach.get(sheet)
		const focus =
			selection.focus.row < SHEET_MAX_ROWS - 1 && selection.focus.col < SHEET_MAX_COLS - 1 ? selection.focus : selection.active

		// The extent may grow with the reach: axes() keys its memo on the extent, so the axes (and the cells drawn) change
		// only when the extent does.
		if (reach === undefined || reach.row < focus.row || reach.col < focus.col)
			this.reach.set(sheet, { row: Math.max(focus.row, reach?.row ?? 0), col: Math.max(focus.col, reach?.col ?? 0) })

		this.update({ selection }, true)
	}

	// Where the run of Tab moves that left the active cell began (the column Enter goes back to), or null when the
	// active cell was not reached by one.
	tabOrigin(): GridPoint | null {
		const run = this.tabRun
		const { sheet, selection } = this.snapshot

		if (run === null || run.sheet !== sheet || !singleCell(selection)) return null

		return run.at.row === selection.active.row && run.at.col === selection.active.col ? run.origin : null
	}

	private activeCell(sheet: SheetId, point: GridPoint): GridActiveCell {
		if (!this.tileHeld(sheet, point.row, point.col)) {
			// Asked for now, whether or not a frame draws it (the cell answers once it arrives).
			const key = tileKey(sheet, point.row >>> 6, point.col >>> 5)

			if (!this.disposed && this.snapshot.failed === null && !this.inFlight.has(key) && this.layouts.has(sheet))
				this.fetch(sheet, [point.row >>> 6, point.col >>> 5])

			return NO_ACTIVE
		}

		const found = this.entry(sheet, point.row, point.col)

		if (found === null) return { text: "", input: "", flags: 0, known: true }

		const flags = found.tile.flags[found.entry] ?? 0
		const text = entryText(found.tile, found.entry)

		if ((flags & CellFlag.CLIPPED) === 0) return { text, input: entryInput(found.tile, found.entry), flags, known: true }

		// The tile holds only the start of the cell's text: its whole input comes from the cell query, and until it
		// does the entry is not known (an edit starts from the query too).
		const held = this.clipped

		if (held?.sheet === sheet && held.row === point.row && held.col === point.col && held.tile === found.tile) {
			return held.input === null
				? { text, input: entryInput(found.tile, found.entry), flags, known: false }
				: { text, input: held.input, flags, known: true }
		}

		const asked = { sheet, row: point.row, col: point.col, tile: found.tile, input: null as string | null }

		this.clipped = asked
		this.session.query("cell", { sheet, row: point.row, col: point.col }).then(
			detail => {
				if (this.clipped !== asked || this.disposed) return

				asked.input = detail.input
				this.update({})
			},
			() => undefined
		)

		return { text, input: entryInput(found.tile, found.entry), flags, known: false }
	}

	// --- Editing ---

	// An entry open as the grid turns read-only is committed, not dropped (the app's discard prompt then sees it); a
	// refusal, a malformed formula's too, goes to the refusal handler, as the entry can no longer be mended.
	setReadOnly(readOnly: boolean): void {
		if (readOnly === this.snapshot.readOnly) return

		this.update({ readOnly })

		if (readOnly) void this.commitEditing(null)
	}

	canEdit(): boolean {
		return canEditSnapshot(this.snapshot)
	}

	// An edit of the active cell kept back only by its lock on a protected sheet goes to onRefusal as the session's
	// refusal would (Excel says the cell is on a protected sheet); a view-only grid or a failed session says nothing.
	refuseLocked(command: () => SheetCommand): void {
		const snapshot = this.snapshot

		if ((snapshot.active.flags & CellFlag.LOCKED) !== 0 && canEditSnapshot({ ...snapshot, active: NO_ACTIVE }))
			this.onRefusal?.({ reason: "protectedSheet" }, command())
	}

	// Commands that change the file but not a cell's content (resizing) are allowed.
	canChange(): boolean {
		const { writability, failed, readOnly } = this.snapshot

		return !readOnly && failed === null && writability.state !== "viewOnly" && cellsEditable(this.snapshot)
	}

	// The user set out to edit: the session proves the file (once) and builds its formula engine.
	// Never rejects: a session that cannot answer leaves the writability as it was.
	intent(): Promise<SheetWritability> {
		this.intention ??= this.session.intent().then(
			writability => {
				if (writability !== this.snapshot.writability) this.update({ writability })

				return writability
			},
			() => this.snapshot.writability
		)

		return this.intention
	}

	cellless(sheet: SheetId = this.snapshot.sheet): boolean {
		return celllessSheet(this.snapshot, sheet)
	}

	// Starts an entry in the active cell from `text`, or from what the cell holds (its input) when null. False when
	// the cell cannot be edited.
	startEditing(text: string | null, mode: GridEditing["mode"]): boolean {
		if (!this.canEdit()) {
			const { sheet, selection } = this.snapshot
			const { row, col } = selection.active

			this.refuseLocked(() => ({
				type: "cells.set",
				sheet,
				cells: { rows: Uint32Array.of(row), cols: Uint16Array.of(col), inputs: [text ?? ""] }
			}))

			return false
		}

		const { sheet, selection, active } = this.snapshot
		const { row, col } = selection.active
		const initial = active.known ? active.input : null

		void this.intent()
		this.update(
			{
				editing: { sheet, row, col, text: text ?? initial ?? "", initial, fromInput: text === null, mode, invalid: false }
			},
			true
		)

		if (active.known) {
			this.entryQuery = null

			return true
		}

		// What the cell holds is not known (its tile is not held, or holds only the start of its text): it comes from
		// the session, once per entry. An entry started from it and still empty takes it.
		const query = {}

		this.entryQuery = query
		this.session.query("cell", { sheet, row, col }).then(
			detail => {
				const editing = this.snapshot.editing

				if (this.entryQuery !== query || editing?.sheet !== sheet || editing.row !== row || editing.col !== col) return

				this.entryQuery = null
				this.update(
					{
						editing: {
							...editing,
							text: editing.fromInput && editing.text === "" ? detail.input : editing.text,
							initial: detail.input
						}
					},
					true
				)
			},
			() => undefined
		)

		return true
	}

	setEditText(text: string): void {
		const editing = this.snapshot.editing

		if (editing !== null && editing.text !== text) this.update({ editing: { ...editing, text, invalid: false } }, true)
	}

	setEditMode(mode: GridEditing["mode"]): void {
		const editing = this.snapshot.editing

		if (editing !== null && editing.mode !== mode) this.update({ editing: { ...editing, mode } }, true)
	}

	cancelEditing(): void {
		const editing = this.snapshot.editing

		if (editing === null) return

		this.update({ editing: null }, true)
		this.returnTo(editing)
	}

	// The extensions' entry hooks (layers.ts), asked before an entry is written.
	setEntryHooks(hooks: readonly SheetEntryHook[]): void {
		this.entryHooks = hooks
	}

	// An entry the extensions let through (with the text they leave), or what they said instead; the entry is reopened
	// on its cell for "edit". Resolves at once without hooks.
	async checkEntry(
		editing: GridEditing
	): Promise<{ readonly verdict: "commit"; readonly text: string } | { readonly verdict: "edit" | "discard" }> {
		if (this.entryHooks.length === 0) return { verdict: "commit", text: editing.text }

		const answer = await checkEntry(this.entryHooks, { sheet: editing.sheet, row: editing.row, col: editing.col, text: editing.text })

		if (
			answer.verdict === "edit" &&
			editing.sheet === this.snapshot.sheet &&
			this.snapshot.editing === null &&
			!this.snapshot.readOnly
		) {
			const layout = this.snapshot.layout

			this.select(cellSelection({ row: editing.row, col: editing.col }, layout === null ? [] : this.merges(layout)))
			this.update({ editing: { ...editing, mode: "edit" } })
		}

		return answer
	}

	// Commits the entry and moves the selection to `next` (null: stays; `tabFrom`: by Tab from that cell). The cell
	// shows what was typed until the session answers. Resolves false when the session refused it, or an extension stopped it (layers.ts entry
	// hooks); a malformed formula reopens the entry, marked.
	async commitEditing(next: GridSelection | null, tabFrom?: GridPoint): Promise<boolean> {
		const editing = this.snapshot.editing

		if (editing === null) return true

		const changed = editingChanged(editing)

		this.entryQuery = null
		const key = pendingKey(editing.sheet, editing.row, editing.col)
		const commit = ++this.commits
		const owns = (): boolean => this.pendingOwners.get(key) === commit
		const release = (): void => {
			if (!owns()) return

			this.pending.delete(key)
			this.pendingOwners.delete(key)
		}

		if (changed) {
			this.pending.set(key, editing.text)
			this.pendingOwners.set(key, commit)
		}

		this.update({ editing: null })
		this.returnTo(editing)

		if (next !== null && editing.sheet === this.snapshot.sheet) this.select(next, tabFrom)
		if (!changed) return true

		const checked = await this.checkEntry(editing)

		if (checked.verdict !== "commit") {
			release()
			this.repaint()

			return false
		}

		if (checked.text !== editing.text && owns()) this.pending.set(key, checked.text)

		let result: SheetCommandResult
		const command: SheetCommand = {
			type: "cells.set",
			sheet: editing.sheet,
			cells: { rows: Uint32Array.of(editing.row), cols: Uint16Array.of(editing.col), inputs: [checked.text] }
		}

		try {
			result = await this.command(command, false)
		} catch {
			// The session failed (a "failed" event says so): the entry was not kept.
			release()
			this.repaint()

			return false
		}

		release()

		if (!result.ok) {
			if (
				result.refusal.reason === "formula" &&
				editing.sheet === this.snapshot.sheet &&
				this.snapshot.editing === null &&
				!this.snapshot.readOnly
			) {
				const layout = this.snapshot.layout

				this.select(cellSelection({ row: editing.row, col: editing.col }, layout === null ? [] : this.merges(layout)))
				this.update({ editing: { ...editing, mode: "edit", invalid: true } })
			} else {
				this.onRefusal?.(result.refusal, command)
			}

			this.repaint()

			return false
		}

		this.repaint()

		return true
	}

	// --- Clipboard ---

	// A copy or cut the session answered: a paste names its id, and its range shows a moving border.
	setClip(clip: SheetGridClip): void {
		this.clip = clip
		this.clipShown = true
		this.repaint()
	}

	// The id a paste of the latest copy names; none once a cut was cancelled.
	clipId(): number | undefined {
		return this.clip?.id
	}

	// The copy or cut the moving border goes round, null when none shows.
	clipMark(): SheetGridClip | null {
		return this.clipShown ? this.clip : null
	}

	// Esc or an edit, as in Excel: the moving border goes, and a cut no longer moves its cells (a copy still pastes
	// with its formulas and formats). False when no border showed.
	cancelClip(): boolean {
		if (!this.clipShown) return false

		this.clipShown = false

		if (this.clip?.cut === true) this.clip = null

		this.repaint()

		return true
	}

	// After a command that changed the file: a paste of the copy keeps its border, a paste of the cut ends it (its
	// cells now live where they were pasted, which a paste again copies from), anything else cancels it.
	private clipAfter(command: SheetCommand): void {
		const clip = this.clip

		if (clip === null || !this.clipShown) return

		if ((command.type === "clipboard.paste" || command.type === "clipboard.pasteHtml") && command.clip === clip.id) {
			// Paste Values pastes a cut as a copy: the cut still waits.
			if (!clip.cut || (command.type === "clipboard.paste" && command.values === true)) return

			this.clip = { ...clip, cut: false }
			this.clipShown = false
			this.repaint()

			return
		}

		this.cancelClip()
	}

	// --- Commands ---

	// Runs a command and applies its change. `report`: a refusal goes to onRefusal.
	async command(command: SheetCommand, report = true): Promise<SheetCommandResult> {
		const moves = this.moves
		const result = await this.session.command(command)
		// Changes before this answer arrived before it: a newer version is this command's step.
		const before = this.snapshot.state.version

		this.settle(result, report ? command : null, moves)

		// A step the session can undo: the size layer's shift is kept beside it.
		if (result.ok && result.change.state.version > before) {
			const step: SheetShiftStep | null =
				command.type === "axis.insert" || command.type === "axis.delete"
					? {
							sheet: command.sheet,
							shift: {
								type: command.type === "axis.insert" ? "insert" : "delete",
								axis: command.axis,
								at: command.at,
								count: command.count,
								revert: false
							}
						}
					: null

			this.shifts.undo.push(step)
			this.shifts.redo = []
			this.follow(step, false)

			if (repeatable(command)) this.lastRepeatable = withoutConsent(command)

			this.clipAfter(command)
		}

		return result
	}

	// The last command again, on `selection` of the sheet shown (F4): null when there is none to repeat.
	repeat(selection: { readonly ranges: readonly SheetRange[] }): Promise<SheetCommandResult> | null {
		const last = this.lastRepeatable
		const range = selection.ranges[selection.ranges.length - 1]

		if (last === null || range === undefined) return null

		const sheet = this.snapshot.sheet
		let next: SheetCommand

		if (last.type === "axis.insert" || last.type === "axis.delete")
			next = { ...last, sheet, at: last.axis === "rows" ? range.startRow : range.startCol }
		else next = { ...last, sheet, ranges: selection.ranges } as SheetCommand

		return this.command(next)
	}

	async undo(): Promise<SheetCommandResult> {
		const moves = this.moves
		const result = await this.session.undo()

		this.settle(result, "undo", moves)

		if (result.ok) this.cancelClip()

		if (result.ok) {
			const step = this.shifts.undo.pop() ?? null

			this.shifts.redo.push(step)
			this.follow(step, true)
		}

		return result
	}

	async redo(): Promise<SheetCommandResult> {
		const moves = this.moves
		const result = await this.session.redo()

		this.settle(result, "redo", moves)

		if (result.ok) this.cancelClip()

		if (result.ok) {
			const step = this.shifts.redo.pop() ?? null

			this.shifts.undo.push(step)
			this.follow(step, false)
		}

		return result
	}

	private follow(step: SheetShiftStep | null, revert: boolean): void {
		const layer = this.sizeLayer

		if (step !== null && layer !== null && this.keepsSizes()) layer.follow(step.sheet, { ...step.shift, revert })
	}

	// `moves`: the selection moves counted when the command was sent.
	private settle(result: SheetCommandResult, reported: SheetCommand | "undo" | "redo" | null, moves: number): void {
		if (result.ok) {
			this.apply(result.change, moves)

			return
		}

		if (result.state.version >= this.snapshot.state.version && result.state !== this.snapshot.state)
			this.update({ state: result.state })
		if (reported !== null) this.onRefusal?.(result.refusal, reported)
	}

	// --- Changes and events ---

	handleEvent(event: SheetEvent): void {
		switch (event.type) {
			case "change":
				this.apply(event.change)
				break
			case "sheetReady":
				this.update({ sheets: this.snapshot.sheets.map(sheet => (sheet.id === event.sheet.id ? event.sheet : sheet)) })
				this.storeLayout(event.sheet.id, event.layout)
				break
			case "writability":
				this.update({ writability: event.writability })
				break
			case "engine":
				this.update({ engine: event.state })
				break
			case "failed":
				this.inFlight.clear()
				this.update({ failed: event.message, editing: null })
				break
			case "progress":
				break
		}
	}

	// A change, as a command answer or an event carries it: patches folded into held tiles (or kept for tiles still
	// on their way), invalidated tiles dropped, layouts, the sheet list, styles and the selection taken. `moves`: for
	// a command's answer, the selection moves counted when it was sent; its selection is dropped once the user moved.
	apply(change: SheetChange, moves = this.moves): void {
		if (this.disposed) return

		this.fitter.changed(change)

		const patched = new Set<number>()

		for (const patch of change.patches) {
			const key = tileKey(patch.sheet, patch.tileRow, patch.tileCol)
			const flight = this.inFlight.get(key)

			patched.add(key)

			if (flight !== undefined) {
				if (patch.mode === "replace" && (flight.replacement === null || flight.replacement.version <= patch.version))
					flight.replacement = patch
				else flight.stale = true

				continue
			}

			this.tiles.patch(patch)
		}

		for (const region of change.invalidated) {
			this.tiles.invalidate(region, patched)

			for (const [key, flight] of this.inFlight) {
				if (!patched.has(key) && regionHoldsTile(region, tileKeySheet(key), tileKeyRow(key), tileKeyCol(key))) {
					flight.stale = true
					flight.replacement = null
				}
			}
		}

		this.flushReleases()

		for (const patch of change.layouts) {
			const held = this.layouts.get(patch.sheet)

			if (held === undefined || held.version > change.state.version) continue

			this.layouts.set(patch.sheet, { ...held, ...patch.layout, version: change.state.version })
		}

		if (change.styles !== undefined) this.appendStyles(change.styles)

		const update: { -readonly [K in keyof SheetGridSnapshot]?: SheetGridSnapshot[K] } = {}

		if (change.sheets !== undefined) {
			const ids = new Set(change.sheets.map(sheet => sheet.id))

			for (const sheet of this.layouts.keys()) {
				if (ids.has(sheet)) continue

				this.layouts.delete(sheet)
				this.selections.delete(sheet)
				this.reach.delete(sheet)
				this.tiles.dropSheet(sheet)
			}

			this.flushReleases()
			update.sheets = change.sheets

			if (!ids.has(this.snapshot.sheet)) {
				const next = change.sheets.find(sheet => sheet.state === "visible") ?? change.sheets[0]

				if (next !== undefined) {
					update.sheet = next.id
					update.editing = null

					if (!this.layouts.has(next.id)) this.loadLayout(next.id)
				}
			}
		}

		if (change.state.version >= this.snapshot.state.version) update.state = change.state

		const selection = moves === this.moves ? change.selection : undefined

		if (selection !== undefined) {
			const layout = this.layouts.get(selection.sheet)
			const next = fromSelectionState(selection, layout === undefined ? [] : this.merges(layout))

			this.selections.set(selection.sheet, next)

			if (selection.sheet !== (update.sheet ?? this.snapshot.sheet)) {
				update.sheet = selection.sheet
				update.editing = null
			}
		}

		const sheet = update.sheet ?? this.snapshot.sheet
		const layout = this.layouts.get(sheet) ?? null

		update.layout = layout
		update.selection = this.selections.get(sheet) ?? fromSelectionState(layout?.selection, layout === null ? [] : this.merges(layout))
		this.axesMemo = null
		this.update(update)
	}
}

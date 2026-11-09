import { useEffect, useRef, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import {
	BetweenHorizontalEndIcon,
	BetweenHorizontalStartIcon,
	BetweenVerticalEndIcon,
	BetweenVerticalStartIcon,
	PaintBucketIcon,
	TableCellsMergeIcon,
	TableCellsSplitIcon,
	TableIcon,
	TableRowsSplitIcon,
	Trash2Icon,
	UnfoldHorizontalIcon,
	UnfoldVerticalIcon,
	type LucideIcon
} from "lucide-react"
import {
	TABLE_STYLE_GALLERY,
	canMerge,
	canSplit,
	cellAt,
	cellPropsOp,
	columnsBox,
	oneStep,
	selectionRange,
	tableCommandOps,
	tableShapeOfLayer,
	tableStyleOp,
	wholeTable,
	type CellRange,
	type ShapeRef,
	type TableCommand,
	type TableShape
} from "@filen/office/core/presentation"
import type { SlideLayer, SlideRender } from "@filen/office/dom/presentation"
import { createTextEditing, selectedShapes, useShapeSelection, useTextEditing, type ShapeSelection } from "@filen/office/react/presentation"
import { cn } from "@filen/shared"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { DocxColorGrid } from "@/features/office/components/officeColorGrid"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { STANDARD_SWATCHES } from "@/features/office/lib/officeControls"
import { DocxColorButton } from "@/features/preview/components/docxFormatControls"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import type { PreviewKey } from "@/lib/i18n"

// The Table tab (PowerPoint's Table Layout and Table Design in one): rows and columns beside the selected cells (a
// range Shift+pressed or Shift+dragged over the table, else the cell the caret is in, else the whole table), delete,
// merge and split, distribute, the style gallery, the style options and the cells' shading. The table's structure comes from its render layer (SlideLayer.table); every
// command is one op through the editor's session, several ops as one batch.

const BUTTON = 30
const MENU = 44

// The table frame selected alone on the slide in view, its base layer and its structure.
interface SelectedTable {
	readonly target: ShapeRef
	readonly layer: SlideLayer & { readonly table: NonNullable<SlideLayer["table"]> }
	readonly shape: TableShape
}

function tableLayer(render: SlideRender | undefined, id: number): SelectedTable["layer"] | undefined {
	const layer = render?.layers.find(each => each.box?.id === id && each.table !== undefined)

	return layer?.table === undefined ? undefined : (layer as SelectedTable["layer"])
}

function useSelectedTable(editor: PresentationRibbonEditor): SelectedTable | undefined {
	const state = useShapeSelection(editor.selection)
	const selected = selectedShapes(editor.render, state)
	const only = selected.length === 1 && selected[0]?.role === "table" ? selected[0] : undefined
	const render = editor.render
	const layer = only === undefined ? undefined : tableLayer(render, only.id)

	if (only === undefined || layer === undefined || render === undefined) return undefined

	return { target: { slide: render.ref, id: only.id }, layer, shape: tableShapeOfLayer(layer.table) }
}

// A store no body opens in (an editor without text editing).
const NO_TEXT = createTextEditing()

// ---- cell ranges -------------------------------------------------------------------------------------------------

// The cells selected in one table frame: from `anchor` (the cell first pressed, or the one the caret was in) to the
// cell the press reached, in whole merged cells.
interface CellRangeSelection {
	readonly table: ShapeRef
	readonly anchor: CellRange
	readonly range: CellRange
}

interface CellRangeStore {
	readonly get: () => CellRangeSelection | undefined
	readonly set: (next: CellRangeSelection | undefined) => void
	readonly subscribe: (listener: () => void) => () => void
}

// One range per editor (its shape selection), shared by the range layer on the slide and the Table tab.
const rangeStores = new WeakMap<ShapeSelection, CellRangeStore>()

function rangeStoreOf(selection: ShapeSelection): CellRangeStore {
	let store = rangeStores.get(selection)

	if (store === undefined) {
		let current: CellRangeSelection | undefined
		const listeners = new Set<() => void>()

		store = {
			get: () => current,
			set: next => {
				if (next === current) return

				current = next

				for (const listener of listeners) listener()
			},
			subscribe: listener => {
				listeners.add(listener)

				return () => {
					listeners.delete(listener)
				}
			}
		}
		rangeStores.set(selection, store)
	}

	return store
}

function sameShape(a: ShapeRef, b: ShapeRef): boolean {
	return a.slide === b.slide && a.id === b.id
}

// The cells between `anchor` and `to`, in whole merged cells.
export function rangeBetween(shape: TableShape, anchor: CellRange, to: CellRange): CellRange {
	const row = Math.min(anchor.row, to.row)
	const col = Math.min(anchor.col, to.col)

	return selectionRange(shape, {
		row,
		col,
		rows: Math.max(anchor.row + anchor.rows, to.row + to.rows) - row,
		cols: Math.max(anchor.col + anchor.cols, to.col + to.cols) - col
	})
}

function withinTable(shape: TableShape, range: CellRange): boolean {
	return range.row >= 0 && range.col >= 0 && range.row + range.rows <= shape.heights.length && range.col + range.cols <= shape.grid.length
}

// The cell area the caret is in, when a cell of this table is open.
function openArea(open: ShapeRef | undefined, table: SelectedTable): CellRange | undefined {
	if (open === undefined || !sameShape(open, table.target) || open.cell === undefined) return undefined

	const area = table.shape.areas.find(each => each.r === open.cell?.row && each.c === open.cell.col)

	return area === undefined ? undefined : { row: area.r, col: area.c, rows: area.rows, cols: area.cols }
}

// The cells the table commands act on: the selected range, else the cell open in the text editor, else the whole
// table.
function useCells(editor: PresentationRibbonEditor, table: SelectedTable | undefined): CellRange | undefined {
	const open = useTextEditing(editor.text ?? NO_TEXT)?.shape
	const store = rangeStoreOf(editor.selection)
	const ranged = useSyncExternalStore(store.subscribe, store.get)

	if (table === undefined) return undefined
	if (ranged !== undefined && sameShape(ranged.table, table.target) && withinTable(table.shape, ranged.range))
		return selectionRange(table.shape, ranged.range)

	return openArea(open, table) ?? wholeTable(table.shape)
}

// A point of the slide (slide px) in the table layer's px, through the inverse of its matrix.
function layerPoint(layer: SlideLayer, at: { readonly x: number; readonly y: number }): { x: number; y: number } | undefined {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = layer.matrix
	const determinant = a * d - b * c

	if (determinant === 0) return undefined

	return { x: (d * (at.x - e) - c * (at.y - f)) / determinant, y: (-b * (at.x - e) + a * (at.y - f)) / determinant }
}

// The cell range layer over the slide in view (SlideView's overlay slot, beside the selection layer): with a table
// selected alone, Shift+press on a cell selects the cells from the caret's cell (or the range's first cell) to it,
// and dragging on extends it; a plain press clears the range and does what it always does (select, move, enter a
// cell). It draws the range and announces its size.
export function PresentationTableRange({ editor, scale }: { editor: PresentationRibbonEditor; scale: number }) {
	const { t } = useTranslation("preview")
	const table = useSelectedTable(editor)
	const open = useTextEditing(editor.text ?? NO_TEXT)?.shape
	const store = rangeStoreOf(editor.selection)
	const ranged = useSyncExternalStore(store.subscribe, store.get)
	const rootRef = useRef<HTMLDivElement | null>(null)
	// What the listeners read: the latest table, caret cell and scale.
	const latest = useRef({ table, open, scale })

	useEffect(() => {
		latest.current = { table, open, scale }

		// A range belongs to the table it was made in: another selection drops it (a render in flight after a command,
		// with the table still the one selected, keeps it).
		const held = store.get()
		const selected = editor.selection.getSnapshot()
		const stillSelected =
			held !== undefined && selected.slide === held.table.slide && selected.ids.length === 1 && selected.ids[0] === held.table.id

		if (held !== undefined && (table === undefined ? !stillSelected : !sameShape(held.table, table.target))) store.set(undefined)
	})

	useEffect(() => {
		const host = rootRef.current?.parentElement

		if (host === null || host === undefined) return

		let dragging: number | undefined

		const cellUnder = (event: PointerEvent): CellRange | undefined => {
			const { table: selected, scale: k } = latest.current
			const rect = rootRef.current?.getBoundingClientRect()

			if (selected === undefined || rect === undefined || k <= 0) return undefined

			const point = layerPoint(selected.layer, { x: (event.clientX - rect.left) / k, y: (event.clientY - rect.top) / k })

			return point === undefined ? undefined : cellAt(selected.layer.table, selected.shape.areas, point.x, point.y)
		}

		const extend = (cell: CellRange, anchor: CellRange): void => {
			const selected = latest.current.table

			if (selected !== undefined) store.set({ table: selected.target, anchor, range: rangeBetween(selected.shape, anchor, cell) })
		}

		const down = (event: PointerEvent): void => {
			const selected = latest.current.table

			if (selected === undefined || event.button !== 0) return

			const cell = cellUnder(event)

			if (!event.shiftKey || cell === undefined) {
				store.set(undefined)

				return
			}

			const held = store.get()
			const caret = openArea(latest.current.open, selected)
			const anchor = held !== undefined && sameShape(held.table, selected.target) ? held.anchor : (caret ?? cell)

			// Shift+press inside the open cell selects its text.
			if (held === undefined && caret?.row === cell.row && caret.col === cell.col) return

			event.preventDefault()
			event.stopPropagation()
			extend(cell, anchor)
			dragging = event.pointerId

			try {
				host.setPointerCapture(event.pointerId)
			} catch {
				// A pointer that already ended has nothing to capture.
			}
		}

		const move = (event: PointerEvent): void => {
			if (dragging !== event.pointerId) return

			event.stopPropagation()

			const cell = cellUnder(event)
			const held = store.get()

			if (cell !== undefined && held !== undefined) extend(cell, held.anchor)
		}

		const up = (event: PointerEvent): void => {
			if (dragging !== event.pointerId) return

			event.stopPropagation()
			dragging = undefined
		}

		host.addEventListener("pointerdown", down, true)
		host.addEventListener("pointermove", move, true)
		host.addEventListener("pointerup", up, true)
		host.addEventListener("pointercancel", up, true)

		return () => {
			host.removeEventListener("pointerdown", down, true)
			host.removeEventListener("pointermove", move, true)
			host.removeEventListener("pointerup", up, true)
			host.removeEventListener("pointercancel", up, true)
		}
	}, [store])

	const shown =
		ranged !== undefined && table !== undefined && sameShape(ranged.table, table.target) && withinTable(table.shape, ranged.range)
			? selectionRange(table.shape, ranged.range)
			: undefined
	const edges = table?.layer.table
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = table?.layer.matrix ?? []
	const columns = shown === undefined || edges === undefined ? undefined : columnsBox(edges, shown.col, shown.cols)
	const x = columns?.x ?? 0
	const y = shown === undefined ? 0 : (edges?.rowEdges[shown.row] ?? 0)

	return (
		<div
			ref={rootRef}
			className="pointer-events-none absolute inset-0"
		>
			{shown === undefined ? null : (
				<div
					aria-hidden="true"
					className="absolute top-0 left-0 origin-top-left"
					style={{
						transform: `matrix(${String(a * scale)}, ${String(b * scale)}, ${String(c * scale)}, ${String(d * scale)}, ${String(e * scale)}, ${String(f * scale)})`
					}}
				>
					<div
						className="absolute bg-primary/20 outline-2 outline-primary"
						style={{
							left: x,
							top: y,
							width: columns?.width ?? 0,
							height: (edges?.rowEdges[shown.row + shown.rows] ?? y) - y
						}}
					/>
				</div>
			)}
			<span
				className="sr-only"
				aria-live="polite"
			>
				{shown === undefined ? "" : t("previewPptxTableRangeSelected", { rows: shown.rows, cols: shown.cols })}
			</span>
		</div>
	)
}

// The cell of a table frame under a point of the slide (slide px), for entering a cell's text: undefined for a shape
// that is not a table. The frame's matrix places the table's px on the slide.
export function tableCellAt(
	render: SlideRender | undefined,
	shape: ShapeRef,
	at: { readonly x: number; readonly y: number } | undefined
): ShapeRef {
	const layer = render === undefined ? undefined : tableLayer(render, shape.id)

	if (layer === undefined) return shape

	const areas = tableShapeOfLayer(layer.table).areas
	const first = areas[0]
	const point = at === undefined ? undefined : layerPoint(layer, at)

	if (point === undefined) return first === undefined ? shape : { ...shape, cell: { row: first.r, col: first.c } }

	const cell = cellAt(layer.table, areas, point.x, point.y)

	return cell === undefined ? shape : { ...shape, cell: { row: cell.row, col: cell.col } }
}

function run(editor: PresentationRibbonEditor, ops: Parameters<typeof oneStep>[0]): void {
	const [op] = oneStep(ops)

	if (op !== undefined) void editor.command(op)
}

const LINE_COMMANDS: readonly { readonly command: TableCommand; readonly label: PreviewKey; readonly icon: LucideIcon }[] = [
	{ command: "insertAbove", label: "previewPptxTableInsertAbove", icon: BetweenHorizontalStartIcon },
	{ command: "insertBelow", label: "previewPptxTableInsertBelow", icon: BetweenHorizontalEndIcon },
	{ command: "insertLeft", label: "previewPptxTableInsertLeft", icon: BetweenVerticalStartIcon },
	{ command: "insertRight", label: "previewPptxTableInsertRight", icon: BetweenVerticalEndIcon }
]

function RowsColumnsControls({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const table = useSelectedTable(editor)
	const cells = useCells(editor, table)
	const focus = useCommandMenuFocus()
	const command = (which: TableCommand): void => {
		if (table !== undefined && cells !== undefined) run(editor, tableCommandOps(table.target, table.shape, cells, which))
	}

	return (
		<>
			{LINE_COMMANDS.map(({ command: which, label, icon: Icon }) => (
				<RibbonButton
					key={which}
					label={t(label)}
					icon={<Icon />}
					disabled={table === undefined}
					onClick={() => {
						command(which)
					}}
				/>
			))}
			<DropdownMenu onOpenChange={focus.opened}>
				<RibbonMenuTrigger
					label={t("previewPptxTableDelete")}
					icon={<Trash2Icon />}
					disabled={table === undefined}
				/>
				<DropdownMenuContent
					finalFocus={focus.finalFocus}
					data-preview-surface
				>
					{(
						[
							["deleteRows", "previewPptxTableDeleteRows"],
							["deleteColumns", "previewPptxTableDeleteColumns"],
							["deleteTable", "previewPptxTableDeleteTable"]
						] as const
					).map(([which, label]) => (
						<DropdownMenuItem
							key={which}
							onClick={() => {
								focus.ran()
								command(which)
							}}
						>
							{t(label)}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	)
}

function MergeControls({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const table = useSelectedTable(editor)
	const cells = useCells(editor, table)
	const single = cells !== undefined && table !== undefined && canSplit(table.shape, cells)

	return (
		<>
			<RibbonButton
				label={t("previewPptxTableMergeCells")}
				icon={<TableCellsMergeIcon />}
				disabled={table === undefined || cells === undefined || !canMerge(table.shape, cells)}
				onClick={() => {
					if (table !== undefined && cells !== undefined) run(editor, tableCommandOps(table.target, table.shape, cells, "merge"))
				}}
			/>
			<RibbonButton
				label={t("previewPptxTableSplitCells")}
				icon={<TableCellsSplitIcon />}
				disabled={!single}
				onClick={() => {
					if (table !== undefined && cells !== undefined) run(editor, tableCommandOps(table.target, table.shape, cells, "split"))
				}}
			/>
		</>
	)
}

function SizeControls({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const table = useSelectedTable(editor)
	const cells = useCells(editor, table)

	return (
		<>
			<RibbonButton
				label={t("previewPptxTableDistributeRows")}
				icon={<UnfoldVerticalIcon />}
				disabled={table === undefined}
				onClick={() => {
					if (table !== undefined && cells !== undefined)
						run(editor, tableCommandOps(table.target, table.shape, cells, "distributeRows"))
				}}
			/>
			<RibbonButton
				label={t("previewPptxTableDistributeColumns")}
				icon={<UnfoldHorizontalIcon />}
				disabled={table === undefined}
				onClick={() => {
					if (table !== undefined && cells !== undefined)
						run(editor, tableCommandOps(table.target, table.shape, cells, "distributeColumns"))
				}}
			/>
		</>
	)
}

const ACCENTS: readonly string[] = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
	"var(--primary)"
]

function StylesMenu({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const table = useSelectedTable(editor)
	const focus = useCommandMenuFocus()
	// ODF has no table styles of these (an ODP table carries its look in its cells).
	const pptx = editor.info.format !== "odp"

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t("previewPptxTableStyles")}
				icon={<TableIcon />}
				disabled={table === undefined || !pptx}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
			>
				{TABLE_STYLE_GALLERY.map(style => (
					<DropdownMenuItem
						key={style.id}
						onClick={() => {
							focus.ran()

							if (table !== undefined) void editor.command(tableStyleOp(table.target, { styleId: style.id }))
						}}
					>
						<span
							aria-hidden="true"
							className={cn("size-4 rounded-sm ring-1 ring-border")}
							style={{ backgroundColor: style.accent === undefined ? "var(--foreground)" : ACCENTS[style.accent - 1] }}
						/>
						{style.accent === undefined
							? t("previewPptxTableStyleDark")
							: t("previewPptxTableStyleAccent", { accent: style.accent })}
					</DropdownMenuItem>
				))}
				<DropdownMenuItem
					onClick={() => {
						focus.ran()

						if (table !== undefined) void editor.command(tableStyleOp(table.target, { styleId: null }))
					}}
				>
					{t("previewPptxTableStyleNone")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

const OPTIONS: readonly {
	readonly flag: "firstRow" | "lastRow" | "bandRow" | "firstCol" | "lastCol" | "bandCol"
	readonly label: PreviewKey
}[] = [
	{ flag: "firstRow", label: "previewPptxTableHeaderRow" },
	{ flag: "lastRow", label: "previewPptxTableTotalRow" },
	{ flag: "bandRow", label: "previewPptxTableBandedRows" },
	{ flag: "firstCol", label: "previewPptxTableFirstColumn" },
	{ flag: "lastCol", label: "previewPptxTableLastColumn" },
	{ flag: "bandCol", label: "previewPptxTableBandedColumns" }
]

function OptionsMenu({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const table = useSelectedTable(editor)
	const focus = useCommandMenuFocus()
	const flags = table?.layer.table.flags

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t("previewPptxTableOptions")}
				icon={<TableRowsSplitIcon />}
				disabled={table === undefined || editor.info.format === "odp"}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
			>
				{OPTIONS.map(option => (
					<DropdownMenuCheckboxItem
						key={option.flag}
						checked={flags?.[option.flag] === true}
						onCheckedChange={checked => {
							focus.ran()

							if (table !== undefined) void editor.command(tableStyleOp(table.target, { flag: option.flag, on: checked }))
						}}
					>
						{t(option.label)}
					</DropdownMenuCheckboxItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function ShadingControl({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const table = useSelectedTable(editor)
	const cells = useCells(editor, table)

	return (
		<DocxColorButton
			label={t("previewPptxTableShading")}
			icon={<PaintBucketIcon />}
			rgb={undefined}
			disabled={table === undefined}
		>
			{close => (
				<DocxColorGrid
					theme={[]}
					standard={STANDARD_SWATCHES}
					chosen={undefined}
					none={{ label: t("previewPptxTableNoShading"), key: "none" }}
					onPick={swatch => {
						close()

						if (table !== undefined && cells !== undefined)
							void editor.command(
								cellPropsOp(table.target, table.shape, cells, {
									fill: swatch === null ? "none" : { kind: "solid", color: { kind: "srgb", rgb: swatch.rgb } }
								})
							)
					}}
				/>
			)}
		</DocxColorButton>
	)
}

export const tableGroups: PresentationGroups = context => {
	const editor = context.editor

	if (editor === undefined || !context.editable) return []

	const t = context.t

	return [
		{
			id: "rowsColumns",
			label: t("previewPptxTableRowsColumns", { ns: "preview" }),
			icon: BetweenHorizontalEndIcon,
			width: 4 * BUTTON + MENU,
			priority: 5,
			content: <RowsColumnsControls editor={editor} />
		},
		{
			id: "merge",
			label: t("previewPptxTableMerge", { ns: "preview" }),
			icon: TableCellsMergeIcon,
			width: 2 * BUTTON,
			priority: 4,
			content: <MergeControls editor={editor} />
		},
		{
			id: "cellSize",
			label: t("previewPptxTableCellSize", { ns: "preview" }),
			icon: UnfoldVerticalIcon,
			width: 2 * BUTTON,
			priority: 2,
			content: <SizeControls editor={editor} />
		},
		{
			id: "styles",
			label: t("previewPptxTableStyles", { ns: "preview" }),
			icon: TableIcon,
			width: 2 * MENU + BUTTON,
			priority: 3,
			content: (
				<>
					<StylesMenu editor={editor} />
					<OptionsMenu editor={editor} />
					<ShadingControl editor={editor} />
				</>
			)
		}
	]
}

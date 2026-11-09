import { CellFlag, TILE_COLS, TILE_ROWS, type SheetBorderLine, type SheetId, type SheetRange, type SheetRenderStyle } from "../protocol"
import { defineSheetFeature, type SheetReadContext, type SheetTileBuilder } from "../registry"
import { runSliced, sliceClock, type Slicing } from "../../slicing"
import { formatNumberInto, formatTextInto, numFmt, NumFmtOutput, type NumFmtOptions } from "../numfmt/format"
import type { NumFmt } from "../numfmt/parse"
import { isPlainGeneral } from "../numfmt/general"
import { SYSTEM_FOREGROUND } from "../style/palette"
import type { SheetStore } from "../../xlsx/model/store"
import type { XlsxColor, XlsxDxf, XlsxSheetModel } from "../../xlsx/model/types"
import type { XlsxDocument } from "../../xlsx/edit/document"
import { SheetConditionalFormats, type CfLook } from "./conditional"
import type { RangeStatistics } from "./statistics"
import { FormulaError, type Scalar } from "./formula/values"
import { DocumentFormulaHost, slotValue } from "./host"
import { readConditionalFormats } from "./rules"
import { SectionCache } from "./sections"
import "./layers"

// Conditional formats on an xlsx session's tiles: evaluated in the session (a worker on the web) per tile built,
// over the cells of the tile the rules cover. A rule's look goes into the cell's render style (fonts, fills, borders,
// a colour scale's fill) and text (a number format), data bars and icons into the tile's cfBars and cfIcons layers.
// What a rule computed over its range is kept until a cell it reads changes (dependents).

interface DocumentState {
	readonly host: DocumentFormulaHost
	readonly formats: SectionCache<SheetConditionalFormats | null>
	// Each sheet's formats as last built: their statistics stand in for the ones an edit rewrote until those are read.
	readonly last: Map<SheetId, SheetConditionalFormats>
}

const states = new WeakMap<XlsxDocument, DocumentState>()

function stateOf(document: XlsxDocument): DocumentState {
	let state = states.get(document)

	if (state === undefined) {
		const host = new DocumentFormulaHost(document)
		const last = new Map<SheetId, SheetConditionalFormats>()
		const created: DocumentState = {
			host,
			last,
			formats: new SectionCache(["conditionalFormatting", "extLst"], ([sections = [], ext = []], model) => {
				const blocks = readConditionalFormats(sections, ext.length === 0 ? null : ext.join(""), document.workbook.styles.dxfs)

				if (blocks.length === 0) {
					last.delete(model.id)

					return null
				}

				const formats = new SheetConditionalFormats(model.id, blocks, host, last.get(model.id) ?? null)

				last.set(model.id, formats)

				return formats
			})
		}

		state = created
		states.set(document, created)
	}

	return state
}

// The conditional formats of a parsed sheet, or null when it has none.
export function conditionalFormats(context: SheetReadContext<XlsxDocument>, sheet: SheetId): SheetConditionalFormats | null {
	const document = context.doc
	const model = document.model(sheet)

	if (model === null) return null

	return stateOf(document).formats.get(document.workbook, model, context.version)
}

function formatOptions(document: XlsxDocument): NumFmtOptions {
	const locale = document.numFmtLocale

	return {
		date1904: document.date1904,
		palette: document.styles.palette,
		...(locale !== undefined && { locale })
	}
}

type Building = { -readonly [K in keyof SheetRenderStyle]: SheetRenderStyle[K] }

// A dxf's fill as a cell draws it. In a differential format a solid fill's colour is its bgColor ([MS-OI29500]
// §2.1.680; LibreOffice reads it so), with no pattern given meaning solid.
function applyFill(style: Building, fill: NonNullable<XlsxDxf["fill"]>, colorOf: (color: XlsxColor | undefined) => number): void {
	delete style.pattern
	delete style.fill

	if (fill.kind === "gradient") {
		const first = fill.stops[0]
		const rgb = first === undefined ? -1 : colorOf(first.color)

		if (rgb >= 0) style.fill = rgb

		return
	}

	if (fill.pattern === "none" || fill.pattern === "solid") {
		const rgb = colorOf(fill.bg ?? fill.fg)

		if (rgb >= 0) style.fill = rgb

		return
	}

	const foreground = colorOf(fill.fg)
	const background = colorOf(fill.bg)

	style.pattern = { type: fill.pattern, color: foreground >= 0 ? foreground : 0, background: background >= 0 ? background : 0xffffff }
}

class TileLayers {
	readonly barEntries: number[] = []
	readonly starts: number[] = []
	readonly ends: number[] = []
	readonly axes: number[] = []
	readonly fills: number[] = []
	readonly borders: number[] = []
	readonly axisColors: number[] = []
	readonly barFlags: number[] = []
	readonly iconEntries: number[] = []
	readonly sets: number[] = []
	readonly icons: number[] = []
	// Entries whose text a format replaced: no longer shown through plain General.
	readonly retexted = new Set<number>()

	finish(tile: SheetTileBuilder): void {
		if (this.barEntries.length > 0)
			tile.layer("cfBars", {
				entries: Uint16Array.from(this.barEntries),
				starts: Float32Array.from(this.starts),
				ends: Float32Array.from(this.ends),
				axes: Float32Array.from(this.axes),
				fills: Uint32Array.from(this.fills),
				borders: Int32Array.from(this.borders),
				axisColors: Int32Array.from(this.axisColors),
				flags: Uint8Array.from(this.barFlags)
			})

		if (this.iconEntries.length > 0)
			tile.layer("cfIcons", {
				entries: Uint16Array.from(this.iconEntries),
				sets: Uint8Array.from(this.sets),
				icons: Uint8Array.from(this.icons)
			})

		const general = this.retexted.size === 0 ? undefined : tile.layerOf("general")

		if (general !== undefined) {
			const keep: number[] = []

			general.entries.forEach((entry, k) => {
				if (!this.retexted.has(entry)) keep.push(k)
			})

			if (keep.length < general.entries.length)
				tile.layer("general", {
					entries: Uint16Array.from(keep, k => general.entries[k] ?? 0),
					values: Float64Array.from(keep, k => general.values[k] ?? 0),
					decimal: general.decimal
				})
		}
	}
}

// A number per object, for keys made of looks the rules share (a dxf's font, a border).
const ids = new WeakMap<object, number>()
let nextId = 1

function idOf(value: object | null): number {
	if (value === null) return 0

	let id = ids.get(value)

	if (id === undefined) {
		id = nextId++
		ids.set(value, id)
	}

	return id
}

class TileLook {
	private readonly document: XlsxDocument
	private readonly model: XlsxSheetModel
	private readonly tile: SheetTileBuilder
	private readonly options: NumFmtOptions
	private readonly out = new NumFmtOutput()
	private readonly colorOf: (color: XlsxColor | undefined) => number
	readonly layers = new TileLayers()
	// Interned looks by what made them: equal cells intern once per tile.
	private readonly interned = new Map<string, number>()

	constructor(document: XlsxDocument, model: XlsxSheetModel, tile: SheetTileBuilder) {
		this.document = document
		this.model = model
		this.tile = tile
		this.options = formatOptions(document)
		this.colorOf = color => document.styles.color(color)
	}

	readonly rgb = (color: XlsxColor | null): number => {
		const rgb = this.document.styles.color(color ?? undefined)

		return rgb < 0 ? 0 : rgb
	}

	private line(edge: NonNullable<CfLook["top"]>): SheetBorderLine | undefined {
		if (edge.style === undefined) return undefined

		const rgb = this.document.styles.color(edge.color)

		return { style: edge.style, color: rgb >= 0 ? rgb : (this.document.styles.palette[SYSTEM_FOREGROUND] ?? 0) }
	}

	apply(row: number, col: number, value: Scalar, look: CfLook): void {
		const tile = this.tile
		const store = this.model.store as SheetStore
		const slot = store.locate(row, col)
		const xf = slot < 0 ? this.document.startingStyle(this.model, row, col) : store.style(slot)
		const found = tile.find(row, col)
		const code = look.numFmt ?? this.document.styles.numFmtCode(xf)
		// The value through its format: only a rule's format or font colour needs it (a [Red] stays over the latter).
		const shown =
			look.numFmt !== null || look.font?.color !== undefined
				? this.shown(look.numFmt === null ? this.document.styles.numFmt(xf) : numFmt(look.numFmt), value)
				: null
		const fill = look.fill === null ? "" : look.fill.kind === "solid" ? String(look.fill.rgb) : `d${String(idOf(look.fill.fill))}`
		const key = `${found >= 0 ? `s${String(tile.style(found))}` : `x${String(xf)}`}|${String(xf)}|${String(idOf(look.font))}|${fill}|${String(idOf(look.top))},${String(idOf(look.bottom))},${String(idOf(look.left))},${String(idOf(look.right))}|${String(shown?.color ?? -1)}|${look.numFmt === null ? 0 : 1}`
		const entry = found >= 0 ? found : tile.entry(row, col)
		const known = this.interned.get(key)

		if (known !== undefined) tile.setStyle(entry, known)
		else this.interned.set(key, this.restyle(entry, xf, found >= 0, look, shown))

		this.extras(entry, row, col, value, look, code, shown)
	}

	// The cell's render style with the rules' look over it, interned and set; its index.
	private restyle(entry: number, xf: number, own: boolean, look: CfLook, shown: { text: string; color: number } | null): number {
		const tile = this.tile
		// The look as the cell had it before the rules (earlier features' changes kept); a cell without an entry has
		// its row's or column's.
		const cell = this.document.styles.renderStyle(xf)
		const style: Building = { ...(own ? tile.styleOf(tile.style(entry)) : cell) }
		const font = look.font
		let fontColor = cell.color ?? -1

		if (font !== null) {
			if (font.bold !== undefined) style.bold = font.bold
			if (font.italic !== undefined) style.italic = font.italic
			if (font.strike !== undefined) style.strike = font.strike

			if (font.underline === "none") delete style.underline
			else if (font.underline !== undefined) style.underline = font.underline

			const color = font.color === undefined || font.color.auto === true ? -1 : this.colorOf(font.color)

			if (color >= 0) fontColor = color
		}

		if (look.fill !== null) {
			if (look.fill.kind === "solid") {
				delete style.pattern
				style.fill = look.fill.rgb
			} else {
				applyFill(style, look.fill.fill, this.colorOf)
			}
		}

		const top = look.top === null ? undefined : this.line(look.top)
		const bottom = look.bottom === null ? undefined : this.line(look.bottom)
		const left = look.left === null ? undefined : this.line(look.left)
		const right = look.right === null ? undefined : this.line(look.right)

		if (top !== undefined) style.top = top
		if (bottom !== undefined) style.bottom = bottom
		if (left !== undefined) style.left = left
		if (right !== undefined) style.right = right

		// The number format's colour stays over a rule's font colour (Excel and LibreOffice draw [Red] so); without
		// one, the rule's font colour, else the cell's.
		const color = shown !== null && shown.color >= 0 ? shown.color : fontColor

		if (font?.color !== undefined || look.numFmt !== null) {
			if (color >= 0) style.color = color
			else delete style.color
		}

		const index = tile.intern(style)

		tile.setStyle(entry, index)

		return index
	}

	// The text a rule's format or a hidden value gives the cell, and its bar and icon.
	private extras(
		entry: number,
		row: number,
		col: number,
		value: Scalar,
		look: CfLook,
		code: string,
		shown: { text: string; color: number } | null
	): void {
		const tile = this.tile

		if (look.hideValue || (look.numFmt !== null && shown !== null)) {
			const view = this.document.cellView(this.tile.sheet, row, col)
			const input = view.input ?? view.text

			tile.setText(entry, look.hideValue ? "" : (shown?.text ?? view.text), input === "" ? null : input)

			// A number a rule shows through plain General keeps its General layer value (the grid rounds it to fit).
			if (look.hideValue || typeof value !== "number" || !isPlainGeneral(numFmt(code))) this.layers.retexted.add(entry)
		}

		const bar = look.bar

		if (bar !== null) {
			const layers = this.layers

			layers.barEntries.push(entry)
			layers.starts.push(bar.start)
			layers.ends.push(bar.end)
			layers.axes.push(bar.axis)
			layers.fills.push(bar.fill)
			layers.borders.push(bar.border)
			layers.axisColors.push(bar.axisColor)
			layers.barFlags.push(bar.flags)
			tile.addFlags(entry, CellFlag.CF_BAR)
		}

		if (look.icon !== null) {
			this.layers.iconEntries.push(entry)
			this.layers.sets.push(look.icon.set)
			this.layers.icons.push(look.icon.icon)
			tile.addFlags(entry, CellFlag.CF_ICON)
		}
	}

	// A value through a format: its text and colour (null for a value no format changes: blank, logicals,
	// errors).
	private shown(format: NumFmt, value: Scalar): { text: string; color: number } | null {
		if (value === null || typeof value === "boolean" || value instanceof FormulaError) return null

		if (typeof value === "number") formatNumberInto(format, value, this.out, this.options)
		else formatTextInto(format, value, this.out, this.options)

		return { text: this.out.text, color: this.out.color }
	}
}

// The tile's cells under the sheet's conditional formats, each given its rules' look.
export function conditionalTile(context: SheetReadContext<XlsxDocument>, tile: SheetTileBuilder): void {
	const document = context.doc
	const model = document.model(tile.sheet)

	// A sheet still parsing shows its first rows' preview, without its formats (the parse sends its tiles again).
	if (model === null) return

	const formats = conditionalFormats(context, tile.sheet)

	if (formats === null) return

	const range: SheetRange = {
		startRow: tile.firstRow,
		startCol: tile.firstCol,
		endRow: tile.firstRow + TILE_ROWS - 1,
		endCol: tile.firstCol + TILE_COLS - 1
	}
	const rules = formats.rulesOn(range)

	if (rules.length === 0) return

	formats.later = readsLater(context, tile.sheet, formats)

	// Each rule's cells of the tile, once per set of ranges, from the parts that meet the tile.
	const covered = new Uint8Array(TILE_ROWS * TILE_COLS)
	const masks = new Map<object, Uint8Array>()
	const covers = rules.map(rule => {
		let mask = masks.get(rule.index)

		if (mask === undefined) {
			const built = new Uint8Array(TILE_ROWS * TILE_COLS)

			rule.index.each(range, part => {
				const startRow = Math.max(part.startRow, range.startRow)
				const endRow = Math.min(part.endRow, range.endRow)
				const startCol = Math.max(part.startCol, range.startCol)
				const endCol = Math.min(part.endCol, range.endCol)

				for (let row = startRow; row <= endRow; row++) {
					const offset = (row - range.startRow) * TILE_COLS - range.startCol

					built.fill(1, offset + startCol, offset + endCol + 1)
					covered.fill(1, offset + startCol, offset + endCol + 1)
				}
			})

			mask = built
			masks.set(rule.index, built)
		}

		return mask
	})

	const store = model.store as SheetStore
	const looks = new TileLook(document, model, tile)
	const rightToLeft = model.view.rightToLeft

	for (let index = 0; index < covered.length; index++) {
		if (covered[index] === 0) continue

		const row = range.startRow + Math.floor(index / TILE_COLS)
		const col = range.startCol + (index % TILE_COLS)
		const slot = store.locate(row, col)
		const value = slot < 0 ? null : slotValue(document, model, row, col, slot)
		const look = formats.look(rules, covers, index, value, row, col, looks.rgb, rightToLeft)

		if (look !== null) looks.apply(row, col, value, look)
	}

	looks.layers.finish(tile)
}

// Statistics with many bands to read again (a structure edit, a large paste) are read in turns of the session's slicing
// (or the worker's), the tiles built meanwhile showing them as last known; their tiles are patched once read.
function readsLater(
	context: SheetReadContext<XlsxDocument>,
	sheet: SheetId,
	formats: SheetConditionalFormats
): ((statistics: RangeStatistics, ranges: readonly SheetRange[]) => void) | null {
	const later = context.later

	if (later === undefined) return null

	return (statistics, ranges) => {
		later(sheet, async () => {
			const slicing = context.slicing ?? WORKER_SLICING

			try {
				// Not in the call that asked: its tile goes out with the statistics as last known.
				await slicing.pause()
				await runSliced(statistics.steps(), sliceClock(slicing))
			} finally {
				formats.readDone(statistics)
			}

			return { ranges }
		})
	}
}

// Turns of 8 ms between macrotasks, where the host gives no slicing (a worker: other calls are answered meanwhile).
const WORKER_SLICING: Slicing = {
	sliceMs: 8,
	now: () => Date.now(),
	pause: () =>
		new Promise<void>(resolve => {
			const timer: unknown = Reflect.get(globalThis, "setTimeout")

			if (typeof timer === "function") (timer as (callback: () => void, ms: number) => void)(resolve, 0)
			else resolve()
		})
}

export const conditionalFormattingFeature = defineSheetFeature<XlsxDocument>({
	id: "conditionalFormatting",
	tiles: conditionalTile,
	// Rules reading other sheets wait for them: their tiles are sent again once those are read.
	ready: async (context, sheet) => {
		const document = context.doc

		await document.ready(sheet, context.slicing, context.signal)

		const formats = conditionalFormats(context, sheet)

		if (formats === null) return { ranges: [] }

		// Statistics over the rules' ranges, sliced (a worker host gives none: its own turns then); tiles built meanwhile
		// leave those rules out and are sent again.
		formats.warming = true

		let warmed: SheetRange[]

		try {
			warmed = await runSliced(formats.warm(), sliceClock(context.slicing ?? WORKER_SLICING))
		} finally {
			formats.warming = false
		}

		const read = formats.sheetsRead()
		const waiting = document.workbook.sheets.filter(
			entry =>
				entry.id !== sheet &&
				entry.model === null &&
				entry.kind === "worksheet" &&
				(read.all || [...read.names].some(name => name.toUpperCase() === entry.name.toUpperCase()))
		)

		if (waiting.length === 0) return { ranges: warmed }

		for (const entry of waiting) await document.ready(entry.id, context.slicing, context.signal)

		return { ranges: formats.lookRanges() }
	},
	dependents: (context, sheet, range, add) => {
		const name = context.doc.entry(sheet)?.name ?? ""

		stateOf(context.doc).formats.forEach((formats, own) => {
			formats?.changed(sheet, name, range, changed => add(own, changed))
		})
	}
})

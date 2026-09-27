import { type } from "arktype"
import { kvDelete, kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { restoreSizes, shiftSizes, withSizes, type AxisShift, type SizeAxis, type SizeEntry } from "@/features/spreadsheet/lib/sizes.logic"

// Column widths and row heights kept beside a file rather than in it: every view but an editable
// workbook (a CSV cannot hold sizes, and a read-only file is never written). Keyed by the file's stable
// id, which outlives its content saves; a file without one keeps them for the session only.
export type LayerKey = { kind: "stable"; id: string } | { kind: "session"; id: string }

export interface SheetSizes {
	cols: ReadonlyMap<number, number>
	rows: ReadonlyMap<number, number>
}

// Grid sheet index → that sheet's sizes; sheets without any are absent.
export type SizeLayer = ReadonlyMap<number, SheetSizes>

export const EMPTY_LAYER: SizeLayer = new Map()

// Files remembered at once; saving past it forgets the one saved longest ago.
export const SIZE_LAYER_LIMIT = 200

const INDEX_KEY = "spreadsheet.sizes.index.v1"

function fileKey(id: string): string {
	return `spreadsheet.sizes.v1.${id}`
}

const pairs = type(["number", "number"]).array()
const storedSchema = type({ sheets: { "[string]": { cols: pairs, rows: pairs } } })
const indexSchema = type("string[]")

const sessionLayers = new Map<string, SizeLayer>()

export async function loadLayer(key: LayerKey): Promise<SizeLayer> {
	if (key.kind === "session") {
		return sessionLayers.get(key.id) ?? EMPTY_LAYER
	}

	const stored = await kvGetJson(fileKey(key.id), storedSchema)

	if (stored === null) {
		return EMPTY_LAYER
	}

	return new Map(
		Object.entries(stored.sheets).map(([sheet, sizes]): [number, SheetSizes] => [
			Number(sheet),
			{ cols: new Map(sizes.cols), rows: new Map(sizes.rows) }
		])
	)
}

export async function saveLayer(key: LayerKey, layer: SizeLayer): Promise<void> {
	if (key.kind === "session") {
		sessionLayers.set(key.id, layer)

		return
	}

	const index = ((await kvGetJson(INDEX_KEY, indexSchema)) ?? []).filter(id => id !== key.id)

	if (layer.size === 0) {
		await kvDelete(fileKey(key.id))
		await kvSetJson(INDEX_KEY, index)

		return
	}

	index.push(key.id)

	const evicted = index.splice(0, Math.max(0, index.length - SIZE_LAYER_LIMIT))

	await kvSetJson(fileKey(key.id), {
		sheets: Object.fromEntries([...layer].map(([sheet, sizes]) => [String(sheet), { cols: [...sizes.cols], rows: [...sizes.rows] }]))
	})
	await Promise.all(evicted.map(id => kvDelete(fileKey(id))))
	await kvSetJson(INDEX_KEY, index)
}

export function updateLayer(layer: SizeLayer, sheet: number, axis: SizeAxis, entries: readonly SizeEntry[]): SizeLayer {
	const current = layer.get(sheet) ?? { cols: new Map<number, number>(), rows: new Map<number, number>() }
	const next: SheetSizes =
		axis === "cols" ? { ...current, cols: withSizes(current.cols, entries) } : { ...current, rows: withSizes(current.rows, entries) }
	const layers = new Map(layer)

	if (next.cols.size === 0 && next.rows.size === 0) {
		layers.delete(sheet)
	} else {
		layers.set(sheet, next)
	}

	return layers
}

// Last result per layer entry: sheetRows/sheetCols memoize by map identity, so an unchanged sheet and
// layer must give the same sheet back, or every render would rebuild both axes.
const layered = new WeakMap<SheetSizes, { sheet: object; result: object }>()

// The sheet as shown: its own sizes with the layer's over them.
export function layeredSheet<T extends { colWidths: ReadonlyMap<number, number>; rowHeights: ReadonlyMap<number, number> }>(
	sheet: T,
	sizes: SheetSizes | undefined
): T {
	if (sizes === undefined) {
		return sheet
	}

	const cached = layered.get(sizes)

	if (cached?.sheet === sheet) {
		return cached.result as T
	}

	const result: T = {
		...sheet,
		colWidths: sizes.cols.size === 0 ? sheet.colWidths : withSizes(sheet.colWidths, [...sizes.cols]),
		rowHeights: sizes.rows.size === 0 ? sheet.rowHeights : withSizes(sheet.rowHeights, [...sizes.rows])
	}

	layered.set(sizes, { sheet, result })

	return result
}

// Sizes a delete took out, for its undo to put back; most recent last.
export interface StashedSizes {
	id: string
	removed: [number, number][]
}

// Undos kept: an older one just re-inserts at the default sizes.
const STASH_LIMIT = 50

// A CSV's rows or columns moved: the sheet's sizes move with them, and an undone delete gets back the
// sizes it took out.
export function followShift(
	layer: SizeLayer,
	sheet: number,
	shift: AxisShift & { revert: boolean },
	stash: readonly StashedSizes[]
): { layer: SizeLayer; stash: StashedSizes[] } {
	const sizes = layer.get(sheet)
	const axisSizes = shift.axis === "cols" ? sizes?.cols : sizes?.rows

	if (axisSizes === undefined || axisSizes.size === 0) {
		return { layer, stash: [...stash] }
	}

	const id = `${String(sheet)}:${shift.axis}:${String(shift.at)}:${String(shift.count)}`
	// Undoing an insert deletes the run again; undoing a delete inserts it back.
	const kind = shift.revert ? (shift.kind === "insert" ? "delete" : "insert") : shift.kind
	const moved = shiftSizes(axisSizes, kind, shift.at, shift.count)
	let next = moved.sizes
	let nextStash = [...stash]

	if (!shift.revert && kind === "delete" && moved.removed.length > 0) {
		nextStash = [...nextStash, { id, removed: moved.removed }].slice(-STASH_LIMIT)
	}

	if (shift.revert && kind === "insert") {
		const index = nextStash.findLastIndex(entry => entry.id === id)
		const entry = nextStash[index]

		if (entry !== undefined) {
			next = restoreSizes(next, shift.at, entry.removed)
			nextStash = nextStash.filter((_, at) => at !== index)
		}
	}

	const cleared = [...axisSizes.keys()].filter(at => !next.has(at)).map((at): SizeEntry => [at, null])

	return { layer: updateLayer(layer, sheet, shift.axis, [...cleared, ...next]), stash: nextStash }
}

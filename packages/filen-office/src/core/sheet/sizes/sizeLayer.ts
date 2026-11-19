import type { AxisEdit } from "../model/edits"
import { restoreSizes, shiftSizes, withSizes, type SizeAxis, type SizeEntry } from "./sizes"

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

// Where the stable layers are kept: the app's key-value store of JSON values (get answers null for a key it
// does not hold). What it hands back is checked here, so a stored value of another shape reads as none.
export interface SizeLayerStorage {
	get(key: string): Promise<unknown>
	set(key: string, value: unknown): Promise<void>
	delete(key: string): Promise<void>
}

// Files remembered at once; saving past it forgets the one saved longest ago.
export const SIZE_LAYER_LIMIT = 200

const INDEX_KEY = "spreadsheet.sizes.index.v1"

function fileKey(id: string): string {
	return `spreadsheet.sizes.v1.${id}`
}

type StoredPairs = [number, number][]

function isPairs(value: unknown): value is StoredPairs {
	return (
		Array.isArray(value) &&
		value.every(
			(pair: unknown) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "number" && typeof pair[1] === "number"
		)
	)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

// The stored layer's sheets, or null when the value is not one.
function storedSheets(value: unknown): [string, { cols: StoredPairs; rows: StoredPairs }][] | null {
	const sheets = isRecord(value) ? value["sheets"] : undefined

	if (!isRecord(sheets)) {
		return null
	}

	const out: [string, { cols: StoredPairs; rows: StoredPairs }][] = []

	for (const [sheet, sizes] of Object.entries(sheets)) {
		if (!isRecord(sizes)) {
			return null
		}

		const { cols, rows } = sizes

		if (!isPairs(cols) || !isPairs(rows)) {
			return null
		}

		out.push([sheet, { cols, rows }])
	}

	return out
}

function isStrings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((id: unknown) => typeof id === "string")
}

function storedIndex(value: unknown): string[] {
	return isStrings(value) ? value : []
}

const sessionLayers = new Map<string, SizeLayer>()

export async function loadLayer(storage: SizeLayerStorage, key: LayerKey): Promise<SizeLayer> {
	if (key.kind === "session") {
		return sessionLayers.get(key.id) ?? EMPTY_LAYER
	}

	const stored = storedSheets(await storage.get(fileKey(key.id)))

	if (stored === null) {
		return EMPTY_LAYER
	}

	return new Map(
		stored.map(([sheet, sizes]): [number, SheetSizes] => [Number(sheet), { cols: new Map(sizes.cols), rows: new Map(sizes.rows) }])
	)
}

export async function saveLayer(storage: SizeLayerStorage, key: LayerKey, layer: SizeLayer): Promise<void> {
	if (key.kind === "session") {
		sessionLayers.set(key.id, layer)

		return
	}

	const index = storedIndex(await storage.get(INDEX_KEY)).filter(id => id !== key.id)

	if (layer.size === 0) {
		await storage.delete(fileKey(key.id))
		await storage.set(INDEX_KEY, index)

		return
	}

	index.push(key.id)

	const evicted = index.splice(0, Math.max(0, index.length - SIZE_LAYER_LIMIT))

	await storage.set(fileKey(key.id), {
		sheets: Object.fromEntries([...layer].map(([sheet, sizes]) => [String(sheet), { cols: [...sizes.cols], rows: [...sizes.rows] }]))
	})
	await Promise.all(evicted.map(id => storage.delete(fileKey(id))))
	await storage.set(INDEX_KEY, index)
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

// Sizes a delete took out, for its undo to put back; most recent last.
export interface StashedSizes {
	id: string
	removed: [number, number][]
}

// Undos kept: an older one just re-inserts at the default sizes.
const STASH_LIMIT = 50

const NO_SIZES: ReadonlyMap<number, number> = new Map()

// A CSV's rows or columns moved: the sheet's sizes move with them, and an undone delete gets back the
// sizes it took out.
export function followShift(
	layer: SizeLayer,
	sheet: number,
	shift: AxisEdit & { revert: boolean },
	stash: readonly StashedSizes[]
): { layer: SizeLayer; stash: StashedSizes[] } {
	const sizes = layer.get(sheet)
	const axisSizes = (shift.axis === "cols" ? sizes?.cols : sizes?.rows) ?? NO_SIZES
	// Undoing an insert deletes the run again; undoing a delete inserts it back.
	const kind = shift.revert ? (shift.type === "insert" ? "delete" : "insert") : shift.type

	// An undone delete still looks in the stash: the delete may have taken the axis' last sizes.
	if (axisSizes.size === 0 && !(shift.revert && kind === "insert")) {
		return { layer, stash: [...stash] }
	}

	const id = `${String(sheet)}:${shift.axis}:${String(shift.at)}:${String(shift.count)}`
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
		} else if (axisSizes.size === 0) {
			return { layer, stash: nextStash }
		}
	}

	const cleared = [...axisSizes.keys()].filter(at => !next.has(at)).map((at): SizeEntry => [at, null])

	return { layer: updateLayer(layer, sheet, shift.axis, [...cleared, ...next]), stash: nextStash }
}

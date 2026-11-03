import type { DrawingData } from "../../../core/drawingml/data"
import {
	ITEM_FLOATS,
	ITEM_INTS,
	ItemFlag,
	ItemFloat,
	ItemInt,
	ItemKind,
	PATH_COMMAND_COORDS,
	type Paint
} from "../../../core/drawingml/displayList"

// A drawing whose consecutive items are plain shaded meshes (a metafile's gradient triangles: one item, one outline
// and one paint each) with that run drawn as one item: its outlines one path (consecutive in the drawing's commands),
// its triangles one mesh, in order, so later ones still lie over earlier ones. Thousands of items would otherwise be
// thousands of clipped images for the page to build, lay out and draw. The drawing itself when it has no such run.

// Items a run merges at least (fewer cost no more drawn apart).
const MIN_RUN = 8

type Shaded = Extract<Paint, { kind: "shaded" }>

const merged = new WeakMap<DrawingData, DrawingData>()

function plainMesh(data: DrawingData, item: number): Shaded | undefined {
	const i = item * ITEM_INTS
	const ints = data.itemInts

	if (ints[i + ItemInt.KIND] !== ItemKind.PATH || (ints[i + ItemInt.STROKE] ?? -1) >= 0 || (ints[i + ItemInt.SHADOW] ?? -1) >= 0)
		return undefined

	const paint = data.paints[ints[i + ItemInt.FILL] ?? -1]

	return paint?.kind === "shaded" && paint.ramp === null && paint.points instanceof Float32Array && paint.colors instanceof Uint32Array
		? paint
		: undefined
}

// The coordinates an item's commands use, and the sign of its outline's area (the shoelace sum over its points): a
// run's outlines join as one non-zero path only while they all turn one way (opposite ones would cut holes).
function outline(data: DrawingData, item: number): { readonly coords: number; readonly turn: number } {
	const ints = data.itemInts
	const i = item * ITEM_INTS
	const first = ints[i + ItemInt.FIRST_COMMAND] ?? 0
	const count = ints[i + ItemInt.COMMAND_COUNT] ?? 0
	let at = ints[i + ItemInt.FIRST_COORD] ?? 0
	const start = at
	let area = 0
	let px = Number.NaN
	let py = Number.NaN

	for (let k = first; k < first + count; k++) {
		const needed = PATH_COMMAND_COORDS[data.commands[k] ?? 0] ?? 0

		if (needed >= 2) {
			const x = data.coords[at + needed - 2] ?? 0
			const y = data.coords[at + needed - 1] ?? 0

			if (!Number.isNaN(px)) area += px * y - x * py

			px = x
			py = y
		}

		at += needed
	}

	return { coords: at - start, turn: Math.sign(area) }
}

// Whether `item` continues the run that `last` ends: same placement, flags and clip, its outline right after and
// turning the same way.
function continues(data: DrawingData, last: number, item: number): boolean {
	const floats = data.itemFloats
	const ints = data.itemInts
	const a = last * ITEM_FLOATS
	const b = item * ITEM_FLOATS
	const i = last * ITEM_INTS
	const j = item * ITEM_INTS

	for (let k = ItemFloat.A; k <= ItemFloat.F; k++) if (floats[a + k] !== floats[b + k]) return false

	const commandsEnd = (ints[i + ItemInt.FIRST_COMMAND] ?? 0) + (ints[i + ItemInt.COMMAND_COUNT] ?? 0)

	if (
		ints[i + ItemInt.FLAGS] !== ints[j + ItemInt.FLAGS] ||
		((ints[j + ItemInt.FLAGS] ?? 0) & ItemFlag.EVEN_ODD) !== 0 ||
		(data.itemClips?.[last] ?? -1) !== (data.itemClips?.[item] ?? -1) ||
		ints[j + ItemInt.FIRST_COMMAND] !== commandsEnd
	)
		return false

	const before = outline(data, last)
	const after = outline(data, item)

	return (
		ints[j + ItemInt.FIRST_COORD] === (ints[i + ItemInt.FIRST_COORD] ?? 0) + before.coords &&
		before.turn !== 0 &&
		before.turn === after.turn
	)
}

export function mergeShadedRuns(data: DrawingData): DrawingData {
	const known = merged.get(data)

	if (known !== undefined) return known

	const runs: [number, number][] = []

	for (let item = 0; item < data.itemCount;) {
		if (plainMesh(data, item) === undefined) {
			item++
			continue
		}

		let end = item + 1

		while (end < data.itemCount && plainMesh(data, end) !== undefined && continues(data, end - 1, end)) end++

		if (end - item >= MIN_RUN) runs.push([item, end])

		item = end
	}

	if (runs.length === 0) {
		merged.set(data, data)

		return data
	}

	const removed = runs.reduce((sum, [from, to]) => sum + (to - from - 1), 0)
	const count = data.itemCount - removed
	const itemFloats = new Float32Array(count * ITEM_FLOATS)
	const itemInts = new Int32Array(count * ITEM_INTS)
	const itemClips = data.itemClips === undefined ? undefined : new Int32Array(count)
	const paints = [...data.paints]
	let out = 0
	let run = 0

	for (let item = 0; item < data.itemCount; out++) {
		const [from, to] = runs[run] ?? [-1, -1]

		itemFloats.set(data.itemFloats.subarray(item * ITEM_FLOATS, (item + 1) * ITEM_FLOATS), out * ITEM_FLOATS)
		itemInts.set(data.itemInts.subarray(item * ITEM_INTS, (item + 1) * ITEM_INTS), out * ITEM_INTS)

		if (itemClips !== undefined) itemClips[out] = data.itemClips?.[item] ?? -1

		if (item !== from) {
			item++
			continue
		}

		// The run as its first item: every outline, the union of the boxes and one mesh of all the triangles.
		let points = 0
		let colors = 0
		let minX = Infinity
		let minY = Infinity
		let maxX = -Infinity
		let maxY = -Infinity

		for (let k = from; k < to; k++) {
			const paint = plainMesh(data, k) as Shaded
			const f = k * ITEM_FLOATS
			const x = data.itemFloats[f + ItemFloat.X] ?? 0
			const y = data.itemFloats[f + ItemFloat.Y] ?? 0

			points += paint.points.length - (paint.points.length % 6)
			colors += (paint.points.length - (paint.points.length % 6)) / 2
			minX = Math.min(minX, x)
			minY = Math.min(minY, y)
			maxX = Math.max(maxX, x + (data.itemFloats[f + ItemFloat.WIDTH] ?? 0))
			maxY = Math.max(maxY, y + (data.itemFloats[f + ItemFloat.HEIGHT] ?? 0))
		}

		const meshPoints = new Float32Array(points)
		const meshColors = new Uint32Array(colors)
		let p = 0
		let c = 0

		for (let k = from; k < to; k++) {
			const paint = plainMesh(data, k) as Shaded
			const triangles = Math.min(Math.floor(paint.points.length / 6), Math.floor(paint.colors.length / 3))

			meshPoints.set(paint.points.subarray(0, triangles * 6), p)
			meshColors.set(paint.colors.subarray(0, triangles * 3), c)
			p += triangles * 6
			c += triangles * 3
		}

		const o = out * ITEM_FLOATS
		const i = out * ITEM_INTS
		const last = (to - 1) * ITEM_INTS
		const firstCommand = data.itemInts[from * ITEM_INTS + ItemInt.FIRST_COMMAND] ?? 0

		itemFloats[o + ItemFloat.X] = minX
		itemFloats[o + ItemFloat.Y] = minY
		itemFloats[o + ItemFloat.WIDTH] = maxX - minX
		itemFloats[o + ItemFloat.HEIGHT] = maxY - minY
		itemInts[i + ItemInt.COMMAND_COUNT] =
			(data.itemInts[last + ItemInt.FIRST_COMMAND] ?? 0) + (data.itemInts[last + ItemInt.COMMAND_COUNT] ?? 0) - firstCommand
		itemInts[i + ItemInt.FILL] = paints.length
		paints.push({ kind: "shaded", points: meshPoints.subarray(0, p), colors: meshColors.subarray(0, c), ramp: null })
		item = to
		run++
	}

	const result: DrawingData = {
		...data,
		itemCount: count,
		itemFloats,
		itemInts,
		paints,
		...(itemClips === undefined ? {} : { itemClips })
	}

	merged.set(data, result)

	return result
}

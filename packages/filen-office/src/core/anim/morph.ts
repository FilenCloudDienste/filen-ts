import type { Rgba } from "../drawingml/displayList"
import type { Transition } from "./model"
import { paragraphElements } from "./runs"

// The morph transition (MS-PPTX §2.6.1.1 p159:morph, CT_MorphTransition §2.6.3.1): the objects of the slide before
// move, resize, turn and change their look into the matching objects of the slide being entered; objects without a
// match fade out or in. ST_TransitionMorphOption (§2.6.4.1) sets the level of detail: byObject matches objects,
// byWord also words, byChar also characters.
//
// MS-PPTX defines the element and its option only. How objects match is PowerPoint's documented behaviour
// ("Morph transition: Tips and tricks", support.microsoft.com):
//   1. a "!!" name forces a match: two objects of the same type with the same name starting with "!!" morph into each
//      other whatever their geometry or text; a "!!" object never matches one without "!!";
//   2. otherwise objects in common match: the same type and the same name (a duplicated slide or a copied object);
//   3. what is left matches by geometry: the same type and the same outline, nearest first;
//   charts never morph: they cross-fade (an exit and an entry).
// Words and characters (byWord, byChar) match by equal text, within each matched pair of objects first, then across
// the slide; a text object's shape (its drawing without the text) morphs as an object.

// A slide's top-level object as morph matches it (built in the worker by morphShapes.ts from the slide's model and
// render).
export interface MorphShape {
	readonly id: number
	readonly name: string
	// sp (shapes and text boxes), cxnSp, pic, grpSp, table, chart, smartart, media, ole, ink.
	readonly type: string
	// Slide px as rendered: the box before rotation, its rotation (degrees, clockwise) and flips.
	readonly x: number
	readonly y: number
	readonly w: number
	readonly h: number
	readonly rot: number
	readonly flipH: boolean
	readonly flipV: boolean
	// The outline of its own drawing, independent of size and rotation ("" when it draws no path).
	readonly outline: string
	// Its text in charRg offsets (each paragraph's text then one character for its end); absent without text.
	readonly text?: string
	// Its outline as geometry the page can draw at any point of the transition, when the object is a plain shape (one
	// solid fill, one solid line, no effect, image or arrowhead).
	readonly vector?: MorphVector
}

// A shape's geometry for morphing it: a preset's program (core/drawingml/geometry, encoded) with the shape's adjust
// values, or custom paths as drawn (coordinates in fractions of the shape's box).
export type MorphGeometry =
	| { readonly kind: "preset"; readonly program: string; readonly adjust: readonly (readonly [string, number])[] }
	| { readonly kind: "custom"; readonly paths: readonly MorphPath[] }

export interface MorphPath {
	readonly commands: Uint8Array
	readonly coords: Float32Array
	readonly fill: boolean
	readonly stroke: boolean
}

export interface MorphVector {
	readonly geometry: MorphGeometry
	readonly fill?: Rgba
	// Its line: colour and width (px).
	readonly line?: { readonly color: Rgba; readonly width: number }
}

export type MorphOption = "byObject" | "byWord" | "byChar"

// The MS-PPTX §2.3.1 particle transitions and §2.6.1.1 morph: the transitions the show draws with WebGL2.
export const WEBGL_TRANSITION_KINDS: ReadonlySet<string> = new Set(["vortex", "ripple", "honeycomb", "glitter", "shred", "morph"])

// What a slide may carry for morph: past these, a slide's objects are not described (its morph plays the file's
// fallback) and its text is not split (words and characters move with their objects).
export const MORPH_MAX_SHAPES = 2000
export const MORPH_MAX_TEXT = 20_000
// Words or characters split into their own layers per slide.
export const MORPH_MAX_TOKENS = 1500

export function morphOption(transition: Pick<Transition, "options">): MorphOption {
	const option = transition.options["option"]

	return option === "byWord" || option === "byChar" ? option : "byObject"
}

// --- Matching ---

// What matching reads of an object or a word.
export interface MorphCandidate {
	readonly name: string
	readonly type: string
	readonly outline: string
	readonly x: number
	readonly y: number
	readonly w: number
	readonly h: number
}

const FORCED = "!!"

// A box the matching can place: all four numbers finite (a hostile file's NaN or Infinity box matches nothing).
function placed(shape: MorphCandidate): boolean {
	return Number.isFinite(shape.x) && Number.isFinite(shape.y) && Number.isFinite(shape.w) && Number.isFinite(shape.h)
}

// Box centres as matching measures them: clamped to the slide extended by its size on every side (or, without one,
// to ±2^24 px), so a box billions of px away is as far as one just off the slide.
function centres(
	shapes: readonly MorphCandidate[],
	extent: { readonly w: number; readonly h: number } | undefined
): {
	x: Float64Array
	y: Float64Array
} {
	const x = new Float64Array(shapes.length)
	const y = new Float64Array(shapes.length)
	const w = extent !== undefined && extent.w > 0 ? extent.w : 0
	const h = extent !== undefined && extent.h > 0 ? extent.h : 0
	const clamp = (value: number, size: number): number =>
		size > 0 ? Math.min(2 * size, Math.max(-size, value)) : Math.min(2 ** 24, Math.max(-(2 ** 24), value))

	shapes.forEach((shape, k) => {
		if (!placed(shape)) return

		x[k] = clamp(shape.x + shape.w / 2, w)
		y[k] = clamp(shape.y + shape.h / 2, h)
	})

	return { x, y }
}

function centreDistance(plan: MorphPlan, f: number, t: number): number {
	return Math.hypot((plan.fromX[f] ?? 0) - (plan.toX[t] ?? 0), (plan.fromY[f] ?? 0) - (plan.toY[t] ?? 0))
}

function morphs(type: string): boolean {
	return type !== "chart"
}

// Rule 3 sorts at most this many candidate pairs (same type and outline, one from each slide); past it each object
// takes the nearest one left of its kind, found through a grid, so matching stays linear in the objects.
export const MORPH_MAX_PAIRS = 1 << 16
// Centre distances past this (slide px) sort as equal, so a sort key keeps its pair index exact.
const FAR = 2 ** 27

// What of matching depends on the objects only, made once per slide pair (prepared before the transition); matching
// at its start applies it to the objects then on stage.
export interface MorphPlan {
	readonly from: readonly MorphCandidate[]
	readonly to: readonly MorphCandidate[]
	// Each object's centre as matching measures it (centres()).
	readonly fromX: Float64Array
	readonly fromY: Float64Array
	readonly toX: Float64Array
	readonly toY: Float64Array
	// Per "type\0name", the from objects of that type and name in z-order; per to object, its list (-1: none).
	readonly named: readonly (readonly number[])[]
	readonly toNamed: Int32Array
	// Per object, its rule 3 group ("type\0outline", -1 when it takes no part: a chart, no outline or a "!!" name).
	readonly fromGroup: Int32Array
	readonly toGroup: Int32Array
	// With every object on stage: which take part in rule 3 and their pairs nearest first ([from, to] flat), or no
	// order past MORPH_MAX_PAIRS.
	readonly fromFree: Uint8Array
	readonly toFree: Uint8Array
	readonly order: Uint32Array | undefined
}

export interface MorphMatch {
	// [from index, to index] pairs.
	readonly pairs: readonly (readonly [number, number])[]
	// From indices with no match (fade out), to indices with no match (fade in).
	readonly exits: readonly number[]
	readonly entries: readonly number[]
}

function groups(from: readonly MorphCandidate[], to: readonly MorphCandidate[]): { fromGroup: Int32Array; toGroup: Int32Array } {
	const ids = new Map<string, number>()
	const fromGroup = new Int32Array(from.length).fill(-1)
	const toGroup = new Int32Array(to.length).fill(-1)

	from.forEach((shape, f) => {
		if (!morphs(shape.type) || shape.outline === "" || shape.name.startsWith(FORCED) || !placed(shape)) return

		const key = `${shape.type}\0${shape.outline}`
		let id = ids.get(key)

		if (id === undefined) {
			id = ids.size
			ids.set(key, id)
		}

		fromGroup[f] = id
	})

	to.forEach((shape, t) => {
		if (shape.name.startsWith(FORCED) || !placed(shape)) return

		toGroup[t] = ids.get(`${shape.type}\0${shape.outline}`) ?? -1
	})

	return { fromGroup, toGroup }
}

// Rules 1 and 2 over the objects on stage: the same type and name ("!!" names only ever equal "!!" names), in z-order.
function byName(plan: MorphPlan, fromIn: Uint8Array, toIn: Uint8Array, taken: Uint8Array, matched: Int32Array): void {
	// Per list, how far it is used up (taken only grows, so the first free entry only moves on).
	const cursor = new Int32Array(plan.named.length)

	for (const forced of [true, false]) {
		plan.to.forEach((shape, t) => {
			const id = plan.toNamed[t] ?? -1

			if (id < 0 || toIn[t] === 0 || matched[t] !== -1 || shape.name.startsWith(FORCED) !== forced) return

			const list = plan.named[id] ?? []
			let at = cursor[id] ?? 0

			while (at < list.length && (taken[list[at] ?? 0] !== 0 || fromIn[list[at] ?? 0] === 0)) at++

			cursor[id] = at

			const f = list[at]

			if (f === undefined) return

			taken[f] = 1
			matched[t] = f
		})
	}
}

// Rule 3's candidate pairs among the objects in `fromIn` and `toIn`, nearest first with ties in insertion order (to,
// then from in z-order); undefined past MORPH_MAX_PAIRS.
function pairOrder(plan: MorphPlan, fromIn: Uint8Array, toIn: Uint8Array): Uint32Array | undefined {
	const members: number[][] = []

	plan.from.forEach((_, f) => {
		const group = plan.fromGroup[f] ?? -1

		if (group < 0 || fromIn[f] === 0) return

		const list = members[group]

		if (list === undefined) members[group] = [f]
		else list.push(f)
	})

	let count = 0

	for (let t = 0; t < plan.to.length; t++) {
		const group = plan.toGroup[t] ?? -1

		if (group >= 0 && toIn[t] !== 0) count += members[group]?.length ?? 0
		if (count > MORPH_MAX_PAIRS) return undefined
	}

	const ends = new Uint32Array(count * 2)
	const span = 2 ** Math.ceil(Math.log2(count + 1))
	const keys = new Float64Array(count)
	let at = 0

	plan.to.forEach((_, t) => {
		const group = plan.toGroup[t] ?? -1

		if (group < 0 || toIn[t] === 0) return

		for (const f of members[group] ?? []) {
			const distance = centreDistance(plan, f, t)

			keys[at] = Math.round((distance >= 0 && distance < FAR ? distance : FAR) * 64) * span + at
			ends[at * 2] = f
			ends[at * 2 + 1] = t
			at++
		}
	})

	keys.sort()

	const order = new Uint32Array(count * 2)

	for (let k = 0; k < count; k++) {
		const pair = (keys[k] ?? 0) % span

		order[k * 2] = ends[pair * 2] ?? 0
		order[k * 2 + 1] = ends[pair * 2 + 1] ?? 0
	}

	return order
}

// Past MORPH_MAX_PAIRS: each to object in z-order takes the nearest free from object of its group, searched ring by
// ring through a grid over that group's centres. A search looks at no more than SCAN_LIMIT objects and SCAN_CELLS
// cells by ring (objects stacked in one cell, clusters far apart), then takes the nearest of those it saw, or else
// the objects of the nearest cell still holding any (of SCAN_CELLS looked at): matching stays linear whatever the
// boxes.
const SCAN_LIMIT = 64
const SCAN_CELLS = 64

function nearestFree(plan: MorphPlan, fromIn: Uint8Array, toIn: Uint8Array, taken: Uint8Array, matched: Int32Array): void {
	const members: number[][] = []

	plan.from.forEach((_, f) => {
		const group = plan.fromGroup[f] ?? -1

		if (group < 0 || fromIn[f] === 0 || taken[f] !== 0) return

		const list = members[group]

		if (list === undefined) members[group] = [f]
		else list.push(f)
	})

	const grids = members.map(list => {
		let x0 = Number.POSITIVE_INFINITY
		let y0 = Number.POSITIVE_INFINITY
		let x1 = Number.NEGATIVE_INFINITY
		let y1 = Number.NEGATIVE_INFINITY

		for (const f of list) {
			const x = plan.fromX[f] ?? 0
			const y = plan.fromY[f] ?? 0

			x0 = Math.min(x0, x)
			y0 = Math.min(y0, y)
			x1 = Math.max(x1, x)
			y1 = Math.max(y1, y)
		}

		// About one object per cell.
		const side = Math.max(1, Math.ceil(Math.sqrt(list.length)))
		const cell = Math.max((x1 - x0) / side, (y1 - y0) / side, 1e-6)
		const columns = Math.min(side, Math.floor((x1 - x0) / cell) + 1)
		const rows = Math.min(side, Math.floor((y1 - y0) / cell) + 1)
		const cells: number[][] = Array.from({ length: columns * rows }, () => [])
		const clampCell = (value: number, origin: number, size: number): number =>
			Math.min(size - 1, Math.max(0, Math.floor((value - origin) / cell)))
		const place = (x: number, y: number): [number, number] => [clampCell(x, x0, columns), clampCell(y, y0, rows)]

		for (const f of list) {
			const [cx, cy] = place(plan.fromX[f] ?? 0, plan.fromY[f] ?? 0)

			cells[cy * columns + cx]?.push(f)
		}

		// The group's remaining objects, and where each sits in its cell (both kept by swap-removal).
		// The cells holding objects (an emptied one is dropped when next met).
		const filled = cells.flatMap((held, k) => (held.length > 0 ? [k] : []))

		return { cells, columns, rows, cell, place, filled, cellOf: new Map<number, number[]>(), remaining: [...list] }
	})

	grids.forEach(grid => {
		for (const list of grid.cells) for (const f of list) grid.cellOf.set(f, list)
	})

	// Each from object's index in its group's remaining list.
	const position = new Int32Array(plan.from.length).fill(-1)

	for (const grid of grids) grid.remaining.forEach((f, k) => (position[f] = k))

	const remove = (list: number[], f: number): void => {
		const at = list.indexOf(f)
		const last = list.pop()

		if (last !== undefined && at >= 0 && at < list.length) list[at] = last
	}

	plan.to.forEach((_, t) => {
		const group = plan.toGroup[t] ?? -1
		const grid = group < 0 ? undefined : grids[group]

		if (grid === undefined || grid.remaining.length === 0 || toIn[t] === 0 || matched[t] !== -1) return

		const [cx, cy] = grid.place(plan.toX[t] ?? 0, plan.toY[t] ?? 0)
		let best = -1
		let bestDistance = Number.POSITIVE_INFINITY
		let seen = 0
		let visited = 0
		const consider = (f: number): void => {
			const d = centreDistance(plan, f, t)

			seen++

			// Ties keep the first in z-order.
			if (best < 0 || d < bestDistance || (d === bestDistance && f < best)) {
				best = f
				bestDistance = d
			}
		}
		const reach = Math.max(grid.columns, grid.rows)

		search: for (let ring = 0; ring <= reach; ring++) {
			if (best >= 0 && (ring - 1) * grid.cell > bestDistance) break

			for (let gy = cy - ring; gy <= cy + ring; gy++) {
				if (gy < 0 || gy >= grid.rows) continue

				const edge = gy === cy - ring || gy === cy + ring

				for (let gx = cx - ring; gx <= cx + ring; gx += edge ? 1 : 2 * ring) {
					if (gx >= 0 && gx < grid.columns) {
						visited++

						for (const f of grid.cells[gy * grid.columns + gx] ?? []) {
							consider(f)

							if (seen >= SCAN_LIMIT) break search
						}

						if (visited >= SCAN_CELLS && best >= 0) break search
					}

					if (ring === 0) break
				}
			}

			if (visited >= SCAN_CELLS && best < 0) {
				let nearest = -1
				let nearestDistance = Number.POSITIVE_INFINITY

				for (let k = 0; k < grid.filled.length && k < SCAN_CELLS;) {
					const index = grid.filled[k] ?? 0

					if ((grid.cells[index]?.length ?? 0) === 0) {
						grid.filled[k] = grid.filled[grid.filled.length - 1] ?? index
						grid.filled.pop()

						continue
					}

					const d = Math.hypot((index % grid.columns) - cx, Math.floor(index / grid.columns) - cy)

					if (d < nearestDistance) {
						nearest = index
						nearestDistance = d
					}

					k++
				}

				for (const f of grid.cells[nearest] ?? []) {
					consider(f)

					if (seen >= SCAN_LIMIT) break
				}

				break
			}
		}

		// Every cell left looked empty: one of the remaining objects.
		if (best < 0) for (let k = 0; k < grid.remaining.length && seen < SCAN_LIMIT; k++) consider(grid.remaining[k] ?? 0)

		if (best < 0) return

		const list = grid.cellOf.get(best)

		if (list !== undefined) remove(list, best)

		// The last remaining object takes its place.
		const at = position[best] ?? -1
		const last = grid.remaining.pop()

		if (last !== undefined && at >= 0 && at < grid.remaining.length) {
			grid.remaining[at] = last
			position[last] = at
		}

		taken[best] = 1
		matched[t] = best
	})
}

// Makes the plan of matching two slides' objects by the three rules above.
// `extent`: the slide (px), which centres are clamped about.
export function planMorph(
	from: readonly MorphCandidate[],
	to: readonly MorphCandidate[],
	extent?: { readonly w: number; readonly h: number }
): MorphPlan {
	const ids = new Map<string, number>()
	const named: number[][] = []

	from.forEach((shape, k) => {
		if (!morphs(shape.type) || !placed(shape)) return

		const key = `${shape.type}\0${shape.name}`
		const id = ids.get(key)

		if (id === undefined) {
			ids.set(key, named.length)
			named.push([k])
		} else named[id]?.push(k)
	})

	const toNamed = new Int32Array(to.length).fill(-1)

	to.forEach((shape, t) => {
		if (morphs(shape.type) && shape.name !== "" && placed(shape)) toNamed[t] = ids.get(`${shape.type}\0${shape.name}`) ?? -1
	})

	const { fromGroup, toGroup } = groups(from, to)
	const all = (count: number): Uint8Array => new Uint8Array(count).fill(1)
	const fromFree = all(from.length)
	const toFree = all(to.length)
	const taken = new Uint8Array(from.length)
	const matched = new Int32Array(to.length).fill(-1)
	const fromCentres = centres(from, extent)
	const toCentres = centres(to, extent)
	const base = {
		from,
		to,
		fromX: fromCentres.x,
		fromY: fromCentres.y,
		toX: toCentres.x,
		toY: toCentres.y,
		named,
		toNamed,
		fromGroup,
		toGroup
	}

	byName({ ...base, fromFree, toFree, order: undefined }, fromFree, toFree, taken, matched)

	for (let f = 0; f < from.length; f++) fromFree[f] = taken[f] === 0 && (fromGroup[f] ?? -1) >= 0 ? 1 : 0
	for (let t = 0; t < to.length; t++) toFree[t] = matched[t] === -1 && (toGroup[t] ?? -1) >= 0 ? 1 : 0

	const plan = { ...base, fromFree, toFree, order: undefined }

	return { ...plan, order: pairOrder(plan, fromFree, toFree) }
}

// Matches the objects of a plan that are on stage (`shownFrom`, `shownTo`; all when absent) by the three rules above,
// in that order; each object matches at most once. Indices are the plan's.
export function matchPlanned(plan: MorphPlan, shownFrom?: readonly boolean[], shownTo?: readonly boolean[]): MorphMatch {
	const fromIn = Uint8Array.from(plan.from, (_, f) => (shownFrom === undefined || shownFrom[f] === true ? 1 : 0))
	const toIn = Uint8Array.from(plan.to, (_, t) => (shownTo === undefined || shownTo[t] === true ? 1 : 0))
	const taken = new Uint8Array(plan.from.length)
	const matched = new Int32Array(plan.to.length).fill(-1)

	byName(plan, fromIn, toIn, taken, matched)

	// Rule 3's objects now: on stage, of a group and not matched by name.
	const fromLeft = Uint8Array.from(fromIn, (shown, f) => (shown !== 0 && taken[f] === 0 && (plan.fromGroup[f] ?? -1) >= 0 ? 1 : 0))
	const toLeft = Uint8Array.from(toIn, (shown, t) => (shown !== 0 && matched[t] === -1 && (plan.toGroup[t] ?? -1) >= 0 ? 1 : 0))
	// The plan's order holds when every one of them took part in it (hiding objects only removes pairs, in order).
	const within = (left: Uint8Array, free: Uint8Array): boolean => left.every((value, k) => value === 0 || free[k] === 1)
	const order =
		plan.order !== undefined && within(fromLeft, plan.fromFree) && within(toLeft, plan.toFree)
			? plan.order
			: pairOrder(plan, fromLeft, toLeft)

	if (order === undefined) nearestFree(plan, fromLeft, toLeft, taken, matched)
	else {
		for (let k = 0; k < order.length; k += 2) {
			const f = order[k] ?? 0
			const t = order[k + 1] ?? 0

			if (fromLeft[f] === 0 || toLeft[t] === 0 || taken[f] !== 0 || matched[t] !== -1) continue

			taken[f] = 1
			matched[t] = f
		}
	}

	const pairs: [number, number][] = []
	const entries: number[] = []

	matched.forEach((f, t) => {
		if (f >= 0) pairs.push([f, t])
		else if (toIn[t] !== 0) entries.push(t)
	})

	const exits: number[] = []

	for (let f = 0; f < plan.from.length; f++) if (taken[f] === 0 && fromIn[f] !== 0) exits.push(f)

	return { pairs, exits, entries }
}

// Matches the objects of two slides by the three rules above, in that order; each object matches at most once.
export function matchMorph(from: readonly MorphCandidate[], to: readonly MorphCandidate[]): MorphMatch {
	return matchPlanned(planMorph(from, to))
}

// --- Words and characters ---

// A word or character of an object's text: its charRg range [start, end] (end inclusive, one paragraph) and the text
// it matches by.
export interface MorphToken {
	// Index of its object in the slide's MorphShape list.
	readonly shape: number
	readonly start: number
	readonly end: number
	readonly text: string
}

function isBlank(text: string): boolean {
	return text.trim() === ""
}

// The words (byWord: a word without the spaces after it) or characters (byChar: non-space letters) of each object's
// text; undefined when the slide has more than MORPH_MAX_TOKENS of them.
export function morphTokens(shapes: readonly MorphShape[], option: Exclude<MorphOption, "byObject">): MorphToken[] | undefined {
	const out: MorphToken[] = []

	for (let k = 0; k < shapes.length; k++) {
		const text = shapes[k]?.text

		if (text === undefined || !morphs(shapes[k]?.type ?? "")) continue

		let at = 0

		for (const paragraph of text.split("\n")) {
			const elements = paragraphElements(paragraph)
			const letters = elements.letters

			for (let n = 0; n + 1 < letters.length; n++) {
				const start = letters[n] ?? 0
				let end = (letters[n + 1] ?? start + 1) - 1

				if (option === "byWord") {
					if (elements.wordStart[n] !== 1) continue

					let next = n + 1

					while (next + 1 < letters.length && elements.wordStart[next] !== 1) next++

					end = (letters[next] ?? paragraph.length) - 1
				}

				const piece = paragraph.slice(start, end + 1)
				const word = option === "byWord" ? piece.trim() : piece

				if (isBlank(word)) continue

				out.push({ shape: k, start: at + start, end: at + end, text: word })

				if (out.length > MORPH_MAX_TOKENS) return undefined
			}

			at += paragraph.length + 1
		}
	}

	return out
}

// Matches words or characters of equal text: within each matched pair of objects first (the first unmatched equal
// token in reading order, so a reordered phrase moves each word to its new place), then across the slide.
export function matchTokens(
	from: readonly MorphToken[],
	to: readonly MorphToken[],
	objects: MorphMatch
): { readonly pairs: readonly (readonly [number, number])[]; readonly exits: readonly number[]; readonly entries: readonly number[] } {
	const partner = new Map<number, number>()

	for (const [f, t] of objects.pairs) partner.set(t, f)

	const taken = new Uint8Array(from.length)
	const matched = new Int32Array(to.length).fill(-1)
	const byText = new Map<string, number[]>()

	from.forEach((token, k) => {
		const list = byText.get(token.text)

		if (list === undefined) byText.set(token.text, [k])
		else list.push(k)
	})

	for (const within of [true, false]) {
		to.forEach((token, t) => {
			if (matched[t] !== -1) return

			const owner = partner.get(token.shape)

			if (within && owner === undefined) return

			const f = byText.get(token.text)?.find(k => taken[k] === 0 && (!within || from[k]?.shape === owner))

			if (f === undefined) return

			taken[f] = 1
			matched[t] = f
		})
	}

	const pairs: [number, number][] = []
	const entries: number[] = []

	matched.forEach((f, t) => {
		if (f >= 0) pairs.push([f, t])
		else entries.push(t)
	})

	const exits: number[] = []

	for (let f = 0; f < from.length; f++) if (taken[f] === 0) exits.push(f)

	return { pairs, exits, entries }
}

// --- Interpolation ---

export interface MorphBox {
	readonly x: number
	readonly y: number
	readonly w: number
	readonly h: number
	// Degrees, clockwise.
	readonly rot: number
	readonly flipH: boolean
	readonly flipV: boolean
}

// Smooth start and end (cubic), the motion of every morphing object.
export function morphEase(p: number): number {
	const t = Math.min(1, Math.max(0, p))

	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

// The rotation from a to b the short way round (degrees).
export function turn(a: number, b: number): number {
	let delta = ((((b - a) % 360) + 540) % 360) - 180

	if (delta === -180 && b > a) delta = 180

	return delta
}

// An affine [a b c d e f] mapping points of `side`'s slide into the frame of the object at eased progress `t` between
// `from` and `to`: undone from its own box (centre, rotation, size, flips), done into the interpolated one. Flips
// that differ turn the object over through zero width or height.
export function morphPlacement(
	from: MorphBox,
	to: MorphBox,
	t: number,
	side: "from" | "to"
): [number, number, number, number, number, number] {
	const own = side === "from" ? from : to
	const cx = from.x + from.w / 2 + (to.x + to.w / 2 - (from.x + from.w / 2)) * t
	const cy = from.y + from.h / 2 + (to.y + to.h / 2 - (from.y + from.h / 2)) * t
	const w = from.w + (to.w - from.w) * t
	const h = from.h + (to.h - from.h) * t
	const rot = from.rot + turn(from.rot, to.rot) * t
	// Turning over: 1 → -1 for the outgoing object, -1 → 1 for the incoming one.
	const flip = (differs: boolean): number => (!differs ? 1 : side === "from" ? 1 - 2 * t : 2 * t - 1)
	const sx = (own.w > 0 ? w / own.w : 1) * flip(from.flipH !== to.flipH)
	const sy = (own.h > 0 ? h / own.h : 1) * flip(from.flipV !== to.flipV)
	const r1 = (-own.rot * Math.PI) / 180
	const r2 = (rot * Math.PI) / 180
	const ox = own.x + own.w / 2
	const oy = own.y + own.h / 2
	// M = T(c) R(r2) S(sx, sy) R(r1) T(-o)
	const c1 = Math.cos(r1)
	const s1 = Math.sin(r1)
	const c2 = Math.cos(r2)
	const s2 = Math.sin(r2)
	// S R(r1): [sx c1, sy s1, -sx s1, sy c1]
	const a0 = sx * c1
	const b0 = sy * s1
	const c0 = -sx * s1
	const d0 = sy * c1
	// R(r2) · that
	const a = c2 * a0 - s2 * b0
	const b = s2 * a0 + c2 * b0
	const c = c2 * c0 - s2 * d0
	const d = s2 * c0 + c2 * d0

	return [a, b, c, d, cx - (a * ox + c * oy), cy - (b * ox + d * oy)]
}

// Per element drawn in a frame, its z rank: matched ones move from their outgoing rank to their incoming one, the
// others keep their own slide's, so the frame at 0 stacks as the outgoing slide and at 1 as the incoming one.
export function morphRank(fromIndex: number, fromCount: number, toIndex: number, toCount: number, t: number): number {
	const a = fromIndex < 0 ? undefined : (fromIndex + 0.5) / Math.max(1, fromCount)
	const b = toIndex < 0 ? undefined : (toIndex + 0.5) / Math.max(1, toCount)

	if (a === undefined) return b ?? 0
	if (b === undefined) return a

	return a + (b - a) * t
}

// --- Atlas pages ---

// Many small layer bitmaps go as a few shared pages (one bitmap and one texture each), as transferring and uploading
// each costs. The side of a page, and the gap kept around each bitmap in it (so filtering never reads a neighbour).
export const ATLAS_PAGE_PX = 1024
const PAD = 1

export interface PackedAtlas {
	// Per bitmap, its page and place (px), undefined for an empty one.
	readonly slots: ({ readonly page: number; readonly x: number; readonly y: number } | undefined)[]
	readonly pages: { w: number; h: number }[]
}

// Shelf-packs bitmaps, tallest first, into pages of at most `side` px; one larger than a page gets a page of its own
// size.
export function packAtlas(sizes: readonly { readonly w: number; readonly h: number }[], side: number): PackedAtlas {
	const slots: PackedAtlas["slots"] = sizes.map(() => undefined)
	const pages: { w: number; h: number }[] = []
	const order = sizes
		.flatMap((size, k) => (size.w > 0 && size.h > 0 ? [k] : []))
		.sort((a, b) => (sizes[b]?.h ?? 0) - (sizes[a]?.h ?? 0) || a - b)
	let shared = -1
	let shelfY = 0
	let shelfH = 0
	let cursor = 0

	for (const k of order) {
		const size = sizes[k] ?? { w: 0, h: 0 }
		const w = size.w + 2 * PAD
		const h = size.h + 2 * PAD

		// Alone on its page, it needs no gap.
		if (w > side || h > side) {
			slots[k] = { page: pages.length, x: 0, y: 0 }
			pages.push({ w: size.w, h: size.h })

			continue
		}

		if (shared >= 0 && cursor + w > side) {
			shelfY += shelfH
			shelfH = 0
			cursor = 0
		}

		if (shared < 0 || shelfY + h > side) {
			shared = pages.length
			pages.push({ w: 0, h: 0 })
			shelfY = 0
			shelfH = 0
			cursor = 0
		}

		const page = pages[shared] as { w: number; h: number }

		slots[k] = { page: shared, x: cursor + PAD, y: shelfY + PAD }
		cursor += w
		shelfH = Math.max(shelfH, h)
		page.w = Math.max(page.w, cursor)
		page.h = Math.max(page.h, shelfY + h)
	}

	return { slots, pages }
}

import { compositeLayout } from "./algorithms/composite"
import { linLayout } from "./algorithms/lin"
import { snakeLayout } from "./algorithms/snake"
import { customScale } from "./algorithms/shared"
import { spLayout } from "./algorithms/sp"
import { txLayout } from "./algorithms/tx"
import { matchesType, resolveChildren, type Cap } from "./constraints"
import { DEFAULT_SMARTART_BUDGETS, SmartArtError, type DataModel, type DataPoint, type SmartArtBudgets } from "./data"
import type { Algorithm, Atom, Body, Constraint, IfDef, IteratorStep, LayoutDefinition, LayoutNodeDef, Rule, ShapeDef } from "./layoutDef"
import type { TextMeasurer } from "./measure"
import { equalizeFonts, relax, resetCaps } from "./rules"
import type { XmlDocument } from "../xml/index"

export type { TextMeasurer } from "./measure"

// The layout interpreter: expands a layout definition against a data model into layout nodes (ECMA-376 §21.4.2.14
// forEach, §21.4.2.6 choose, §21.4.7.33 functions, MS-OI29500 §2.1.1618), then lays them out top-down. Per layout
// node the constraints are resolved (constraints.ts), the node's algorithm places its children, the user's custom
// sizes apply, and the node's rules relax constraints within bounded steps when the content does not fit
// (rules.ts). The user's custom offsets apply last, over the whole tree (applyOffsets).

export interface Box {
	x: number
	y: number
	w: number
	h: number
}

export interface LayoutNode {
	readonly def: LayoutNodeDef
	readonly name: string
	readonly point: DataPoint
	// The presentation point the file holds for this layout node, if any: it carries the user's custom sizes and
	// offsets and variable overrides.
	readonly pres: DataPoint | undefined
	readonly parent: LayoutNode | undefined
	readonly children: LayoutNode[]
	alg: Algorithm
	shape: ShapeDef | undefined
	text: DataPoint[]
	constraints: Constraint[]
	rules: Rule[]
	readonly vars: Map<string, string>
	// Constraint values: geometry in EMU relative to the parent's origin, font sizes in points.
	readonly values: Map<string, number>
	readonly lower: Map<string, number>
	readonly upper: Map<string, number>
	box: Box
	fontPt: number | undefined
	// Whether the node's text overflows its box at fontPt (set by the tx algorithm).
	overflow: boolean
	// The values this node's rules currently impose while they relax (rules.ts).
	readonly caps: Map<Rule, Cap>
	// The size before the user's custom scale (custScaleX/Y), once applied: offsets count in it.
	base: { w: number; h: number } | undefined
	// Whether the parent's algorithm laid the custom scale out itself (a snake flows the scaled sizes), rather than
	// scaling about the centre afterwards.
	scaledInPlace: boolean
}

export interface LaidShape {
	readonly name: string
	readonly assocId: string
	readonly presId: string | undefined
	readonly box: Box
	readonly rot: number
	readonly type: string
	readonly hideGeom: boolean
	readonly styleLbl: string | undefined
	readonly text: readonly DataPoint[]
	readonly fontPt: number | undefined
	readonly node: LayoutNode
}

export interface DiagramLayout {
	readonly root: LayoutNode
	// In drawing order (back to front): document order, chOrder and zOrderOff applied.
	readonly shapes: readonly LaidShape[]
	// The style and colour definitions the diagram was laid out with, for its shapes' styling.
	readonly styleDef: XmlDocument | undefined
	readonly colorsDef: XmlDocument | undefined
	// Rule relaxation steps taken (bounded by SmartArtBudgets.maxRuleSteps).
	readonly ruleSteps: number
}

export interface LayoutContext {
	readonly measurer: TextMeasurer
	readonly budgets: SmartArtBudgets
	// Resolves the constraints of `node`'s children as if `node` were w × h EMU.
	constrain(node: LayoutNode, w: number, h: number): void
	// The box `node`'s children take when `node` is w × h EMU at the origin (their custom scale applied), for an
	// algorithm that sizes a child by its content.
	content(node: LayoutNode, w: number, h: number): Box
	ruleSteps: number
	// Algorithm runs so far, bounded by LAYOUT_WORK_PER_NODE × the layout node budget.
	placements: number
	// Whether a content measurement is running.
	measuring: boolean
}

// How many times over, at most, each layout node may be placed: rule relaxation, lin fitting and content
// measurement lay subtrees out again, and a hostile definition must not multiply that without bound.
const LAYOUT_WORK_PER_NODE = 8

// ---------------------------------------------------------------------------------------------------
// Data navigation (ST_AxisType §21.4.7.6, ST_ElementType §21.4.7.27).

function siblings(point: DataPoint): readonly DataPoint[] {
	return point.parent === undefined ? [point] : point.parent.children
}

function descendants(point: DataPoint, out: DataPoint[]): void {
	for (const child of point.children) {
		out.push(child)
		descendants(child, out)
	}
}

function axisPoints(model: DataModel, point: DataPoint, axis: string): DataPoint[] {
	switch (axis) {
		case "self":
			return [point]
		case "ch":
			return [...point.children]
		case "des": {
			const out: DataPoint[] = []

			descendants(point, out)

			return out
		}
		case "desOrSelf": {
			const out: DataPoint[] = [point]

			descendants(point, out)

			return out
		}
		case "par":
			return point.parent === undefined ? [] : [point.parent]
		case "ancst":
		case "ancstOrSelf": {
			const out: DataPoint[] = axis === "ancstOrSelf" ? [point] : []

			for (let p = point.parent; p !== undefined; p = p.parent) out.push(p)

			return out
		}
		case "followSib": {
			const list = siblings(point)

			return list.slice(list.indexOf(point) + 1)
		}
		case "follow": {
			// The peers after the point, each followed by its descendants.
			const out: DataPoint[] = []
			const list = siblings(point)

			for (const peer of list.slice(list.indexOf(point) + 1)) {
				out.push(peer)
				descendants(peer, out)
			}

			return out
		}
		case "precedSib": {
			const list = siblings(point)

			return list.slice(0, Math.max(0, list.indexOf(point))).reverse()
		}
		case "preced": {
			// The peers before the point, nearest first, each followed by its descendants.
			const out: DataPoint[] = []
			const list = siblings(point)

			for (const peer of list.slice(0, Math.max(0, list.indexOf(point))).reverse()) {
				out.push(peer)
				descendants(peer, out)
			}

			return out
		}
		case "root":
			return [model.root]
		default:
			return []
	}
}

// A sibling transition with no node after it: hidden by hideLastTrans.
function isLastTrans(point: DataPoint): boolean {
	if (point.type !== "sibTrans") return false

	const list = siblings(point)

	for (let i = list.indexOf(point) + 1; i < list.length; i++) {
		const next = list[i] as DataPoint

		if (next.type === "node" || next.type === "asst") return false
	}

	return true
}

function selectStep(model: DataModel, point: DataPoint, step: IteratorStep): DataPoint[] {
	const all = axisPoints(model, point, step.axis).filter(p => matchesType(p, step.ptType) && !(step.hideLastTrans && isLastTrans(p)))
	const start = step.st > 0 ? step.st - 1 : step.st < 0 ? all.length + step.st : 0
	const stride = step.step === 0 ? 1 : step.step
	const out: DataPoint[] = []

	for (let i = start; i >= 0 && i < all.length; i += stride) {
		out.push(all[i] as DataPoint)

		if (step.cnt > 0 && out.length >= step.cnt) break
	}

	return out
}

export function selectPoints(model: DataModel, point: DataPoint, steps: readonly IteratorStep[]): DataPoint[] {
	let current: DataPoint[] = [point]

	for (const step of steps) {
		const next: DataPoint[] = []

		for (const p of current) next.push(...selectStep(model, p, step))

		current = next
	}

	return steps.length === 0 ? [] : current
}

function treeHeight(point: DataPoint, depth: number, limit: number): number {
	if (depth > limit) return depth

	let max = 0

	for (const child of point.children) {
		if (child.type === "node" || child.type === "asst") max = Math.max(max, 1 + treeHeight(child, depth + 1, limit))
	}

	return max
}

// ---------------------------------------------------------------------------------------------------
// Expansion.

const VAR_DEFAULTS: Readonly<Record<string, string>> = {
	dir: "norm",
	hierBranch: "std",
	chMax: "-1",
	chPref: "-1",
	bulletEnabled: "0",
	animLvl: "none",
	animOne: "one",
	orgChart: "0",
	resizeHandles: "rel"
}

interface Iteration {
	readonly pos: number
	readonly count: number
}

function compare(op: string, left: number | string, right: string): boolean {
	const number = Number(right)
	const numeric = typeof left === "number" && right.trim() !== "" && !Number.isNaN(number)

	if (!numeric) {
		const a = String(left)
		const b = right === "true" ? "1" : right === "false" ? "0" : right

		return op === "equ" ? a === b : op === "neq" ? a !== b : false
	}

	const a = left as number

	switch (op) {
		case "equ":
			return a === number
		case "neq":
			return a !== number
		case "gt":
			return a > number
		case "lt":
			return a < number
		case "gte":
			return a >= number
		case "lte":
			return a <= number
		default:
			return false
	}
}

class Expander {
	private count = 0

	readonly model: DataModel
	readonly def: LayoutDefinition
	readonly budgets: SmartArtBudgets
	readonly presByKey: ReadonlyMap<string, DataPoint>

	constructor(model: DataModel, def: LayoutDefinition, budgets: SmartArtBudgets, presByKey: ReadonlyMap<string, DataPoint>) {
		this.model = model
		this.def = def
		this.budgets = budgets
		this.presByKey = presByKey
	}

	node(def: LayoutNodeDef, point: DataPoint, parent: LayoutNode | undefined, iteration: Iteration): LayoutNode {
		if (++this.count > this.budgets.maxLayoutNodes) throw new SmartArtError("tooLarge", "too many layout nodes")

		const pres = this.presByKey.get(`${def.name}\u0000${point.id}`)
		const node: LayoutNode = {
			def,
			name: def.name,
			point,
			pres,
			parent,
			children: [],
			alg: { type: "sp", params: new Map() },
			shape: undefined,
			text: [],
			constraints: [],
			rules: [],
			vars: new Map(),
			values: new Map(),
			lower: new Map(),
			upper: new Map(),
			box: { x: 0, y: 0, w: 0, h: 0 },
			fontPt: undefined,
			overflow: false,
			caps: new Map(),
			base: undefined,
			scaledInPlace: false
		}

		if (def.vars !== undefined) for (const [k, v] of def.vars) node.vars.set(k, v)

		if (pres?.props.vars !== undefined) for (const [k, v] of pres.props.vars) node.vars.set(k, v)

		this.body(node, def, point, iteration, 0)

		return node
	}

	// Applies one body (a layoutNode's own, or a taken branch, or a forEach's) to `node`.
	private body(node: LayoutNode, body: Body, point: DataPoint, iteration: Iteration, depth: number): void {
		if (body.alg !== undefined) node.alg = body.alg
		if (body.shape !== undefined) node.shape = body.shape
		if (body.presOf !== undefined) node.text = selectPoints(this.model, point, body.presOf)
		if (body.constraints !== undefined) node.constraints = [...node.constraints, ...body.constraints]
		if (body.rules !== undefined) node.rules = [...node.rules, ...body.rules]

		for (const atom of body.children) this.atom(node, atom, point, iteration, depth)
	}

	private atom(node: LayoutNode, atom: Atom, point: DataPoint, iteration: Iteration, depth: number): void {
		if (atom.kind === "layoutNode") {
			node.children.push(this.node(atom, point, node, iteration))

			return
		}

		if (atom.kind === "choose") {
			const branch = atom.branches.find(b => this.test(node, b, point, iteration)) ?? atom.otherwise

			if (branch !== undefined) this.body(node, branch, point, iteration, depth)

			return
		}

		if (depth + 1 > this.budgets.maxForEachDepth) throw new SmartArtError("tooDeep", "forEach nested too deeply")

		const source = atom.ref !== undefined && atom.ref !== "" ? (this.def.forEachByName.get(atom.ref) ?? atom) : atom
		const points = selectPoints(this.model, point, atom.steps.length > 0 ? atom.steps : source.steps)

		points.forEach((p, index) => {
			this.body(node, source, p, { pos: index + 1, count: points.length }, depth + 1)
		})
	}

	private test(node: LayoutNode, branch: IfDef, point: DataPoint, iteration: Iteration): boolean {
		switch (branch.func) {
			case "var": {
				// A variable a layout node does not set is its ancestors' (the root's dir reaches every branch).
				let value: string | undefined

				for (let at: LayoutNode | undefined = node; at !== undefined && value === undefined; at = at.parent)
					value = at.vars.get(branch.arg)

				value ??= VAR_DEFAULTS[branch.arg] ?? ""
				const normalized = value === "" ? (VAR_DEFAULTS[branch.arg] ?? "") : value

				return compare(branch.op, Number.isNaN(Number(normalized)) ? normalized : Number(normalized), branch.val)
			}
			case "cnt":
				return compare(branch.op, selectPoints(this.model, point, branch.steps).length, branch.val)
			case "pos":
				return compare(branch.op, iteration.pos, branch.val)
			case "revPos":
				return compare(branch.op, iteration.count - iteration.pos + 1, branch.val)
			case "posEven":
				return compare(branch.op, iteration.pos % 2 === 0 ? 1 : 0, branch.val)
			case "posOdd":
				return compare(branch.op, iteration.pos % 2 === 1 ? 1 : 0, branch.val)
			case "depth":
				return compare(branch.op, point.depth, branch.val)
			case "maxDepth": {
				const targets = branch.steps.length > 0 ? selectPoints(this.model, point, branch.steps) : [point]
				let max = 0

				for (const target of targets) max = Math.max(max, target.depth - point.depth + treeHeight(target, 0, 64))

				return compare(branch.op, max, branch.val)
			}
			default:
				return false
		}
	}
}

// ---------------------------------------------------------------------------------------------------
// Layout.

function place(node: LayoutNode, context: LayoutContext): void {
	if (++context.placements > context.budgets.maxLayoutNodes * LAYOUT_WORK_PER_NODE)
		throw new SmartArtError("tooLarge", "too much layout work")

	switch (node.alg.type) {
		case "composite":
			compositeLayout(node, context)
			break
		case "lin":
			linLayout(node, context)
			break
		case "snake":
			snakeLayout(node, context)
			break
		case "tx":
			txLayout(node, context)
			break
		default:
			// Algorithms without an implementation yet give every child its constraint size at the node's origin.
			spLayout(node, context)
	}
}

// Scales a child's box about its centre by the user's custom scale, unless its parent's algorithm laid the scaled
// size out itself.
function scaleAboutCentre(node: LayoutNode): void {
	if (node.scaledInPlace) return

	const { x, y } = customScale(node)

	if (x === 1 && y === 1) return

	const box = node.box

	node.base = { w: box.w, h: box.h }
	node.box = { x: box.x + (box.w - box.w * x) / 2, y: box.y + (box.h - box.h * y) / 2, w: box.w * x, h: box.h * y }
}

function contentOf(node: LayoutNode, w: number, h: number, context: LayoutContext): Box {
	// One level only: the content's own children take their constraint sizes, so nested lines cost linear work.
	if (context.measuring) return { x: 0, y: 0, w, h }

	const saved = node.box

	context.measuring = true

	node.box = { x: 0, y: 0, w, h }
	context.constrain(node, w, h)

	for (const child of node.children) {
		child.base = undefined
		child.scaledInPlace = false
	}

	place(node, context)

	let x0 = Number.POSITIVE_INFINITY
	let y0 = Number.POSITIVE_INFINITY
	let x1 = Number.NEGATIVE_INFINITY
	let y1 = Number.NEGATIVE_INFINITY

	for (const child of node.children) {
		scaleAboutCentre(child)

		const box = child.box
		const shape = child.shape
		// What draws: a spacer (no geometry, text or children) holds a place but no content.
		const draws =
			(shape !== undefined && shape.type !== "none" && !shape.hideGeom) ||
			(child.text.length > 0 && child.alg.type === "tx") ||
			child.children.length > 0

		if (!draws || !(box.w > 0 && box.h > 0)) continue

		x0 = Math.min(x0, box.x)
		y0 = Math.min(y0, box.y)
		x1 = Math.max(x1, box.x + box.w)
		y1 = Math.max(y1, box.y + box.h)
	}

	node.box = saved
	context.measuring = false

	return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w, h }
}

function layoutOnce(node: LayoutNode, context: LayoutContext): boolean {
	context.constrain(node, node.box.w, node.box.h)

	for (const child of node.children) {
		child.base = undefined
		child.scaledInPlace = false
	}

	place(node, context)

	let overflow = node.overflow

	for (const child of node.children) {
		scaleAboutCentre(child)

		if (layoutNode(child, context)) overflow = true
	}

	equalizeFonts(node)

	return overflow
}

// Lays out `node`'s subtree; true when text still overflows in it.
function layoutNode(node: LayoutNode, context: LayoutContext): boolean {
	resetCaps(node)

	return relax(node, context, layoutOnce(node, context), () => layoutOnce(node, context))
}

function translate(node: LayoutNode, dx: number, dy: number): void {
	const stack = [node]

	while (stack.length > 0) {
		const at = stack.pop() as LayoutNode

		at.box = { ...at.box, x: at.box.x + dx, y: at.box.y + dy }

		for (const child of at.children) stack.push(child)
	}
}

// The user's custom offsets (§21.4.3.4 custLinFactNeighborX/Y, in 1/1000 % of the node's size before its custom
// scale) and the extent they live in. Measured on PowerPoint's caches: a child of the root scaled about its centre
// past the frame grows the diagram's extent to hold it, and that extent stays centred on the frame, so the whole
// diagram shifts by half the difference between the growth on either side (a bottom node whose height grows by 2Δ
// about its centre reaches Δ past the edge and moves the diagram up by Δ/2); an offset node is then kept inside that
// extent when it fits. Deeper nodes grow
// only their own parent's box, which the root's extent does not see (hList1's scaled headers stay clamped to the
// frame).
function applyOffsets(root: LayoutNode, frame: Box): void {
	let x0 = frame.x
	let y0 = frame.y
	let x1 = frame.x + frame.w
	let y1 = frame.y + frame.h
	const all: LayoutNode[] = []
	const stack = [root]

	while (stack.length > 0) {
		const node = stack.pop() as LayoutNode

		all.push(node)

		for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i] as LayoutNode)
	}

	for (const node of root.children) {
		if (node.base === undefined || node.scaledInPlace) continue

		x0 = Math.min(x0, node.box.x)
		y0 = Math.min(y0, node.box.y)
		x1 = Math.max(x1, node.box.x + node.box.w)
		y1 = Math.max(y1, node.box.y + node.box.h)
	}

	for (const node of all) {
		const props = node.pres?.props

		if (props === undefined || (props.custLinFactNeighborX === undefined && props.custLinFactNeighborY === undefined)) continue

		const box = node.box
		const base = node.base ?? box
		let x = box.x + ((props.custLinFactNeighborX ?? 0) / 100000) * base.w
		let y = box.y + ((props.custLinFactNeighborY ?? 0) / 100000) * base.h

		if (box.w <= x1 - x0) x = Math.min(Math.max(x, x0), x1 - box.w)
		if (box.h <= y1 - y0) y = Math.min(Math.max(y, y0), y1 - box.h)

		translate(node, x - box.x, y - box.y)
	}

	const dx = frame.x + frame.w / 2 - (x0 + x1) / 2
	const dy = frame.y + frame.h / 2 - (y0 + y1) / 2

	if (dx !== 0 || dy !== 0) translate(root, dx, dy)
}

function collect(node: LayoutNode, out: LaidShape[]): void {
	const shape = node.shape
	const visible = shape !== undefined && shape.type !== "none" && shape.type !== "conn" && !shape.hideGeom

	if (visible || (shape?.hideGeom !== true && node.text.length > 0 && node.alg.type === "tx")) {
		const rot = shape?.rot ?? 0
		const quarter = Math.abs(Math.round(rot / 90)) % 2 === 1 && Math.abs(rot % 90) < 1e-9
		const box = node.box
		// A shape turned a quarter turn fills its layout box with its rotated footprint: the unrotated box (what xfrm
		// holds) has the sides swapped about the same centre.
		const drawn = quarter ? { x: box.x + (box.w - box.h) / 2, y: box.y + (box.h - box.w) / 2, w: box.h, h: box.w } : { ...box }

		out.push({
			name: node.name,
			assocId: node.point.id,
			presId: node.pres?.id,
			box: drawn,
			rot,
			type: shape?.type ?? "rect",
			hideGeom: shape?.hideGeom ?? false,
			styleLbl: node.def.styleLbl ?? node.pres?.props.presStyleLbl,
			text: node.text,
			fontPt: node.fontPt,
			node
		})
	}

	// chOrder="t" (§21.4.2.15): the children are stacked top-first, so the first child draws last.
	const children = node.def.chOrder === "t" ? [...node.children].reverse() : node.children

	for (const child of children) collect(child, out)
}

// zOrderOff (§21.4.2.27) moves a shape that many places back (negative) or forward in the drawing order, ahead of
// the shape already at that place.
function zOrdered(shapes: LaidShape[]): LaidShape[] {
	if (!shapes.some(s => (s.node.shape?.zOrderOff ?? 0) !== 0)) return shapes

	const keyed = shapes.map((shape, index) => {
		const off = shape.node.shape?.zOrderOff ?? 0

		return { shape, index, key: index + off + (off < 0 ? -0.5 : off > 0 ? 0.5 : 0) }
	})

	keyed.sort((a, b) => a.key - b.key || a.index - b.index)

	return keyed.map(k => k.shape)
}

export interface LayoutOptions {
	readonly budgets?: SmartArtBudgets | undefined
}

// Expands `layoutDef` over `data` and lays it out in `box` (EMU; a dsp:drawing's shapes are relative to the
// graphic frame, so its box is at 0, 0). `styleDef` and `colorsDef` style the shapes and are carried to them; the
// geometry depends only on the data, the layout definition, the box and the text measurer. Refuses
// (SmartArtError) past the budgets.
export function layoutDiagram(
	data: DataModel,
	layoutDef: LayoutDefinition,
	styleDef: XmlDocument | undefined,
	colorsDef: XmlDocument | undefined,
	box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
	text: TextMeasurer,
	options: LayoutOptions = {}
): DiagramLayout {
	const budgets = options.budgets ?? DEFAULT_SMARTART_BUDGETS
	const presByKey = new Map<string, DataPoint>()

	for (const pres of data.pres) {
		const { presName, presAssocID } = pres.props

		if (presName === undefined || presAssocID === undefined) continue

		const key = `${presName}\u0000${presAssocID}`

		if (!presByKey.has(key)) presByKey.set(key, pres)
	}

	const expander = new Expander(data, layoutDef, budgets, presByKey)
	const root = expander.node(layoutDef.root, data.root, undefined, { pos: 1, count: 1 })
	const frame: Box = { x: box.x, y: box.y, w: Math.max(0, box.w), h: Math.max(0, box.h) }
	const context: LayoutContext = {
		measurer: text,
		budgets,
		constrain: (node, w, h) => resolveChildren(node, w, h, budgets),
		content: (node, w, h) => contentOf(node, w, h, context),
		ruleSteps: 0,
		placements: 0,
		measuring: false
	}

	root.box = { ...frame }
	layoutNode(root, context)
	applyOffsets(root, frame)

	const shapes: LaidShape[] = []

	collect(root, shapes)

	return { root, shapes: zOrdered(shapes), styleDef, colorsDef, ruleSteps: context.ruleSteps }
}

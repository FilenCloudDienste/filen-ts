import { compositeLayout } from "./algorithms/composite"
import { linLayout } from "./algorithms/lin"
import { snakeLayout } from "./algorithms/snake"
import { spLayout } from "./algorithms/sp"
import { txLayout } from "./algorithms/tx"
import { DEFAULT_SMARTART_BUDGETS, SmartArtError, type DataModel, type DataPoint, type SmartArtBudgets } from "./data"
import type { Algorithm, Atom, Body, Constraint, IfDef, IteratorStep, LayoutDefinition, LayoutNodeDef, Rule, ShapeDef } from "./layoutDef"

// The layout interpreter: expands a layout definition against a data model into layout nodes
// (ECMA-376 §21.4.2.14 forEach, §21.4.2.6 choose, §21.4.7.33 functions, MS-OI29500 §2.1.1618), then
// lays them out top-down. Per layout node, constraints are a deterministic ordered pass in constrLst
// order (references to values not yet known are retried, bounded by the pass budget); the node's
// algorithm then places its children, and its rules relax constraints within bounded steps
// (L.4.15.6.3.22) when the children do not fit.

export interface Box {
	x: number
	y: number
	w: number
	h: number
}

// Measures text for the tx algorithm: the height in EMU of `text` set at `fontPt` and wrapped at
// `width` EMU, and the widest line.
export interface TextMeasurer {
	measure(text: string, fontPt: number, width: number): { readonly width: number; readonly height: number }
}

export interface LayoutNode {
	readonly def: LayoutNodeDef
	readonly name: string
	readonly point: DataPoint
	// The presentation point the file holds for this layout node, if any: it carries the user's custom
	// sizes and offsets and variable overrides.
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
	// Font size caps this node's rules currently impose on their targets, while the rules relax.
	readonly caps: Map<Rule, number>
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
}

export interface DiagramLayout {
	readonly root: LayoutNode
	readonly shapes: readonly LaidShape[]
}

export interface LayoutContext {
	readonly measurer: TextMeasurer
	readonly budgets: SmartArtBudgets
	// Resolves the constraints of `node`'s children as if `node` were w × h EMU.
	constrain(node: LayoutNode, w: number, h: number): void
	ruleSteps: number
}

const EMU_PER_MM = 36000
const EMU_PER_PT = 12700

const FONT_TYPES: ReadonlySet<string> = new Set(["primFontSz", "secFontSz"])
const MARGIN_TYPES: ReadonlySet<string> = new Set(["lMarg", "rMarg", "tMarg", "bMarg", "begMarg", "endMarg"])
const SIZE_TYPES: ReadonlySet<string> = new Set(["w", "h"])
const RAW_TYPES: ReadonlySet<string> = new Set(["pyraAcctRatio", "unknown", "none"])

type UnitClass = "emu" | "pt" | "raw"

function unitOf(type: string): UnitClass {
	if (FONT_TYPES.has(type)) return "pt"
	if (RAW_TYPES.has(type) || type.startsWith("user")) return "raw"

	return "emu"
}

// A literal constraint value in its type's unit: geometry in millimetres, margins and fonts in points.
function literal(type: string, val: number): number {
	if (FONT_TYPES.has(type)) return val
	if (MARGIN_TYPES.has(type)) return val * EMU_PER_PT
	if (unitOf(type) === "raw") return val

	return val * EMU_PER_MM
}

// A referenced value in the unit of the constraint it sets. A font size read by a margin is points of
// inset (the cached bodyPr insets are fact × size in points); read by any other geometry it counts as
// millimetres (the cached heights of hList1-style text boxes are fact × size in millimetres).
function convert(value: number, from: UnitClass, to: UnitClass, type: string): number {
	if (from === to || from === "raw" || to === "raw") return value
	if (from === "pt") return value * (MARGIN_TYPES.has(type) ? EMU_PER_PT : EMU_PER_MM)

	return value / EMU_PER_MM
}

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
		case "followSib":
		case "follow": {
			const list = siblings(point)

			return list.slice(list.indexOf(point) + 1)
		}
		case "precedSib":
		case "preced": {
			const list = siblings(point)

			return list.slice(0, Math.max(0, list.indexOf(point))).reverse()
		}
		case "root":
			return [model.root]
		default:
			return []
	}
}

function matchesType(point: DataPoint, ptType: string): boolean {
	switch (ptType) {
		case "all":
			return true
		case "node":
			return point.type === "node" || point.type === "asst"
		case "norm":
			return point.type === "node"
		case "nonNorm":
			return point.type !== "node"
		case "nonAsst":
			return point.type !== "asst"
		default:
			return point.type === ptType
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
			caps: new Map()
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
				const value = node.vars.get(branch.arg) ?? VAR_DEFAULTS[branch.arg] ?? ""
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
// Constraints.

function matchName(node: LayoutNode, name: string, ptType: string): boolean {
	return (name === "" || node.name === name) && matchesType(node.point, ptType)
}

function targets(owner: LayoutNode, rel: "self" | "ch" | "des", name: string, ptType: string): LayoutNode[] {
	if (rel === "self") return name === "" || owner.name === name ? [owner] : []

	if (rel === "ch") return owner.children.filter(c => matchName(c, name, ptType))

	const out: LayoutNode[] = []
	const stack = [...owner.children].reverse()

	while (stack.length > 0) {
		const node = stack.pop() as LayoutNode

		if (matchName(node, name, ptType)) out.push(node)

		for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i] as LayoutNode)
	}

	return out
}

// A value of `node` for a reference: set values first, then what follows from the others.
function valueOf(node: LayoutNode, type: string, selfBox: { w: number; h: number } | undefined): number | undefined {
	const values = node.values
	const direct = values.get(type)

	if (direct !== undefined) return direct

	if (selfBox !== undefined) {
		switch (type) {
			case "w":
				return selfBox.w
			case "h":
				return selfBox.h
			case "l":
			case "t":
				return 0
			case "r":
				return selfBox.w
			case "b":
				return selfBox.h
			case "ctrX":
				return selfBox.w / 2
			case "ctrY":
				return selfBox.h / 2
		}
	}

	return inferred(
		values,
		type,
		type === "l" || type === "r" || type === "w" || type === "ctrX" ? ["l", "ctrX", "r", "w"] : ["t", "ctrY", "b", "h"]
	)
}

// One axis value from the two others that fix it: near edge, centre, far edge, extent.
function inferred(values: ReadonlyMap<string, number>, type: string, keys: readonly [string, string, string, string]): number | undefined {
	const [near, center, far, size] = keys
	const n = values.get(near)
	const c = values.get(center)
	const f = values.get(far)
	const s = values.get(size)

	switch (type) {
		case near:
			return s !== undefined
				? c !== undefined
					? c - s / 2
					: f !== undefined
						? f - s
						: undefined
				: c !== undefined && f !== undefined
					? 2 * c - f
					: undefined
		case far:
			return s !== undefined
				? n !== undefined
					? n + s
					: c !== undefined
						? c + s / 2
						: undefined
				: n !== undefined && c !== undefined
					? 2 * c - n
					: undefined
		case center:
			return s !== undefined
				? n !== undefined
					? n + s / 2
					: f !== undefined
						? f - s / 2
						: undefined
				: n !== undefined && f !== undefined
					? (n + f) / 2
					: undefined
		case size:
			return n !== undefined && f !== undefined
				? f - n
				: n !== undefined && c !== undefined
					? 2 * (c - n)
					: c !== undefined && f !== undefined
						? 2 * (f - c)
						: undefined
		default:
			return undefined
	}
}

// The lowest cap a relaxing font rule of an ancestor puts on `node`'s `type`.
function capOf(node: LayoutNode, type: string): number {
	let cap = Number.POSITIVE_INFINITY

	for (let owner = node.parent; owner !== undefined; owner = owner.parent) {
		for (const [rule, value] of owner.caps) {
			if (rule.type === type && value < cap && targets(owner, rule.for, rule.forName, rule.ptType).includes(node)) cap = value
		}
	}

	return cap
}

function set(node: LayoutNode, constraint: Constraint, value: number): void {
	// An unbounded or undefined value (val="INF", a NaN factor) bounds nothing and sets nothing.
	if (!Number.isFinite(value)) return

	const capped = FONT_TYPES.has(constraint.type) ? Math.min(value, capOf(node, constraint.type)) : value

	if (constraint.op === "gte") node.lower.set(constraint.type, capped)
	else if (constraint.op === "lte") node.upper.set(constraint.type, capped)
	else node.values.set(constraint.type, capped)
}

// One constraint of `owner` (whose own size is `box`); false when its reference is not known yet.
function applyConstraint(owner: LayoutNode, constraint: Constraint, box: { w: number; h: number }, only?: LayoutNode): boolean {
	const hits = targets(owner, constraint.for, constraint.forName, constraint.ptType).filter(n => only === undefined || n === only)

	if (hits.length === 0) return true

	let value: number

	if (constraint.refType === "none" || constraint.refType === "unknown") {
		// A size of 0 without a reference only groups the targets (op equ) or leaves the size to the
		// algorithm and the rules; it is not a size.
		if (constraint.val === 0 && SIZE_TYPES.has(constraint.type)) return true

		value = literal(constraint.type, constraint.val)
	} else {
		const refs = targets(owner, constraint.refFor, constraint.refForName, constraint.refPtType)
		const ref = refs[0]

		if (ref === undefined) return true

		const raw = valueOf(ref, constraint.refType, ref === owner ? box : undefined)

		if (raw === undefined) return false

		value = convert(raw, unitOf(constraint.refType), unitOf(constraint.type), constraint.type) * constraint.fact
	}

	for (const hit of hits) {
		// A target's own constraints are evaluated against its own values, so a self reference of the
		// target (h = 0.4 w) needs w set first; the owner's are never overridden by a child default.
		set(hit, constraint, value)
	}

	return true
}

function resolveChildren(node: LayoutNode, w: number, h: number, budgets: SmartArtBudgets): void {
	for (const child of node.children) {
		child.values.clear()
		child.lower.clear()
		child.upper.clear()
	}

	// Constraints `des` of ancestors reach this node's children before its own.
	const inherited: { owner: LayoutNode; constraint: Constraint }[] = []

	for (let a = node.parent; a !== undefined; a = a.parent) {
		for (const constraint of a.constraints) if (constraint.for === "des") inherited.unshift({ owner: a, constraint })
	}

	let pending: { owner: LayoutNode; constraint: Constraint; only?: LayoutNode }[] = []

	for (const { owner, constraint } of inherited) {
		for (const child of node.children) pending.push({ owner, constraint, only: child })
	}

	for (const constraint of node.constraints) {
		if (constraint.for !== "self") pending.push({ owner: node, constraint })
	}

	// The node's constraints on itself that read its children (a snake's row gap from a spacer's width).
	for (const constraint of node.constraints) {
		if (constraint.for === "self" && constraint.refFor !== "self") pending.push({ owner: node, constraint })
	}

	// The children's own constraints come last and only fill what the parent left open.
	const own: { owner: LayoutNode; constraint: Constraint }[] = []

	for (const child of node.children) {
		for (const constraint of child.constraints) {
			if (constraint.for === "self" && constraint.forName === "") own.push({ owner: child, constraint })
		}
	}

	for (let pass = 0; pending.length > 0; pass++) {
		if (pass >= budgets.maxConstraintPasses) break

		const deferred: typeof pending = []

		for (const item of pending) {
			const box = item.owner === node ? { w, h } : item.owner.box

			if (!applyConstraint(item.owner, item.constraint, box, item.only)) deferred.push(item)
		}

		if (deferred.length === pending.length) break

		pending = deferred
	}

	let open = own

	for (let pass = 0; open.length > 0 && pass < budgets.maxConstraintPasses; pass++) {
		const deferred: typeof open = []

		for (const item of open) {
			const { owner, constraint } = item
			const isGeometryDefault = constraint.refType === "none" && constraint.val === 0 && constraint.op === "none"

			if (owner.values.has(constraint.type) || isGeometryDefault) continue

			if (constraint.refType !== "none" && constraint.refType !== "unknown") {
				const raw = valueOf(owner, constraint.refType, undefined)

				if (raw === undefined) {
					deferred.push(item)

					continue
				}

				set(owner, constraint, convert(raw, unitOf(constraint.refType), unitOf(constraint.type), constraint.type) * constraint.fact)
			} else {
				set(owner, constraint, literal(constraint.type, constraint.val))
			}
		}

		if (deferred.length === open.length) break

		open = deferred
	}

	for (const child of node.children) {
		for (const [type, max] of child.upper) {
			const value = child.values.get(type)

			if (value !== undefined && value > max) child.values.set(type, max)
		}

		for (const [type, min] of child.lower) {
			const value = child.values.get(type)

			if (value !== undefined && value < min) child.values.set(type, min)
		}
	}
}

// ---------------------------------------------------------------------------------------------------
// Layout.

function place(node: LayoutNode, context: LayoutContext): void {
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
			// Algorithms without a draft yet give every child the whole box, like sp.
			spLayout(node, context)
	}
}

// The user's own size and offset edits on the presentation point (§21.4.3.4 custScaleX/Y,
// custLinFactNeighborX/Y): a scale about the box centre, then a shift in units of the unscaled size,
// kept inside the diagram when the shape fits.
function applyCustom(node: LayoutNode, frame: Box): void {
	const props = node.pres?.props

	if (props === undefined) return

	const box = node.box
	const baseW = box.w
	const baseH = box.h
	const sx = props.custScaleX === undefined ? 1 : props.custScaleX / 100000
	const sy = props.custScaleY === undefined ? 1 : props.custScaleY / 100000
	const cx = box.x + box.w / 2
	const cy = box.y + box.h / 2
	const moved = props.custLinFactNeighborX !== undefined || props.custLinFactNeighborY !== undefined

	box.w = baseW * sx
	box.h = baseH * sy
	box.x = cx - box.w / 2 + ((props.custLinFactNeighborX ?? 0) / 100000) * baseW
	box.y = cy - box.h / 2 + ((props.custLinFactNeighborY ?? 0) / 100000) * baseH

	if (moved) {
		if (box.w <= frame.w) box.x = Math.min(Math.max(box.x, frame.x), frame.x + frame.w - box.w)
		if (box.h <= frame.h) box.y = Math.min(Math.max(box.y, frame.y), frame.y + frame.h - box.h)
	}
}

function layoutOnce(node: LayoutNode, context: LayoutContext, frame: Box): boolean {
	context.constrain(node, node.box.w, node.box.h)
	place(node, context)

	let overflow = node.overflow

	for (const child of node.children) {
		applyCustom(child, frame)

		if (layoutNode(child, context, frame)) overflow = true
	}

	equalizeFonts(node)

	return overflow
}

// Lays out `node`'s subtree; true when text still overflows in it. A font rule of the node on its
// descendants (primFontSz/secFontSz for ch/des, L.4.15.6.3.22) relaxes when the subtree overflows: the
// targets' size is capped and bisected in half points between the rule's value and the constraint's,
// relaying the subtree each step, within the rule step budget.
function layoutNode(node: LayoutNode, context: LayoutContext, frame: Box): boolean {
	let overflow = layoutOnce(node, context, frame)

	for (const rule of node.rules) {
		if (!overflow) break
		if (!FONT_TYPES.has(rule.type) || rule.for === "self" || !Number.isFinite(rule.val)) continue

		let high = 0

		for (const target of targets(node, rule.for, rule.forName, rule.ptType)) high = Math.max(high, target.values.get(rule.type) ?? 0)

		let low = rule.val

		if (high <= low) continue

		node.caps.set(rule, low)

		if (layoutOnce(node, context, frame)) continue

		for (let step = 0; step < context.budgets.maxRuleSteps && high - low > 0.5; step++) {
			context.ruleSteps++

			const mid = Math.round(low + high) / 2

			node.caps.set(rule, mid)

			if (layoutOnce(node, context, frame)) high = mid
			else low = mid
		}

		node.caps.set(rule, low)
		overflow = layoutOnce(node, context, frame)
	}

	return overflow
}

// primFontSz/secFontSz constraints with op equ share one size: the smallest any target came to.
function equalizeFonts(node: LayoutNode): void {
	for (const constraint of node.constraints) {
		if (constraint.op !== "equ" || constraint.type !== "primFontSz" || constraint.for === "self") continue

		const group = targets(node, constraint.for, constraint.forName, constraint.ptType).filter(t => t.fontPt !== undefined)
		let min = Number.POSITIVE_INFINITY

		for (const target of group) min = Math.min(min, target.fontPt as number)

		for (const target of group) target.fontPt = min
	}
}

function collect(node: LayoutNode, out: LaidShape[]): void {
	const shape = node.shape
	const visible = shape !== undefined && shape.type !== "none" && shape.type !== "conn" && !shape.hideGeom

	if (visible || (shape?.hideGeom !== true && node.text.length > 0 && node.alg.type === "tx")) {
		const rot = shape?.rot ?? 0
		const quarter = Math.abs(Math.round(rot / 90)) % 2 === 1 && Math.abs(rot % 90) < 1e-9
		const box = node.box
		// A shape turned a quarter turn fills its layout box with its rotated footprint: the unrotated
		// box (what xfrm holds) has the sides swapped about the same centre.
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
			fontPt: node.fontPt
		})
	}

	const children = node.def.chOrder === "t" ? [...node.children].reverse() : node.children

	for (const child of children) collect(child, out)
}

export interface LayoutOptions {
	readonly measurer: TextMeasurer
	readonly budgets?: SmartArtBudgets | undefined
}

// Expands `def` over `model` and lays it out in a `width` × `height` EMU frame.
export function layoutDiagram(
	model: DataModel,
	def: LayoutDefinition,
	width: number,
	height: number,
	options: LayoutOptions
): DiagramLayout {
	const budgets = options.budgets ?? DEFAULT_SMARTART_BUDGETS
	const presByKey = new Map<string, DataPoint>()

	for (const pres of model.pres) {
		const { presName, presAssocID } = pres.props

		if (presName === undefined || presAssocID === undefined) continue

		const key = `${presName}\u0000${presAssocID}`

		if (!presByKey.has(key)) presByKey.set(key, pres)
	}

	const expander = new Expander(model, def, budgets, presByKey)
	const root = expander.node(def.root, model.root, undefined, { pos: 1, count: 1 })
	const frame: Box = { x: 0, y: 0, w: width, h: height }
	const context: LayoutContext = {
		measurer: options.measurer,
		budgets,
		constrain: (node, w, h) => resolveChildren(node, w, h, budgets),
		ruleSteps: 0
	}

	root.box = { ...frame }
	layoutNode(root, context, frame)

	const shapes: LaidShape[] = []

	collect(root, shapes)

	return { root, shapes }
}

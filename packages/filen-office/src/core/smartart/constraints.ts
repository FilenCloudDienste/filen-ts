import type { DataPoint, SmartArtBudgets } from "./data"
import type { LayoutNode } from "./interp"
import type { Constraint } from "./layoutDef"

// The constraint solver (ECMA-376 §21.4.2.8 constr, §21.4.7.19 ST_ConstraintType, L.4.15.6.2): one deterministic
// ordered pass per layout node. Ancestors' `des` constraints reach the node's children first, then the node's own
// `ch`/`des` constraints and its self constraints that read its children, in constrLst order; a reference to a
// value not known yet (and not inferable from two others on its axis) is deferred and retried until a pass makes
// no progress, bounded by the pass budget. The children's own self constraints then fill only what the parent
// left open. Constraints with op lte/gte are bounds on how far rules may move a value, not clamps on the values
// constraints set: PowerPoint's caches keep list1's overlap at -0.41 × the font size although a gte/lte pair on the
// same value would make it -0.82 × the header's height.

export const EMU_PER_MM = 36000
export const EMU_PER_PT = 12700

export const FONT_TYPES: ReadonlySet<string> = new Set(["primFontSz", "secFontSz"])
const MARGIN_TYPES: ReadonlySet<string> = new Set(["lMarg", "rMarg", "tMarg", "bMarg", "begMarg", "endMarg"])
const SIZE_TYPES: ReadonlySet<string> = new Set(["w", "h"])
// Ratios and the user's own variables carry no unit.
const RAW_TYPES: ReadonlySet<string> = new Set(["pyraAcctRatio", "unknown", "none"])

type UnitClass = "emu" | "pt" | "raw"

function unitOf(type: string): UnitClass {
	if (FONT_TYPES.has(type)) return "pt"
	if (RAW_TYPES.has(type) || type.startsWith("user")) return "raw"

	return "emu"
}

// A literal constraint value in its type's unit: geometry in millimetres, margins and fonts in points.
export function literal(type: string, val: number): number {
	if (FONT_TYPES.has(type)) return val
	if (MARGIN_TYPES.has(type)) return val * EMU_PER_PT
	if (unitOf(type) === "raw") return val

	return val * EMU_PER_MM
}

// A referenced value in the unit of the constraint it sets. A font size read by a margin is points of inset (the
// cached bodyPr insets are fact × size in points); read by any other geometry it counts as millimetres (the cached
// heights of hList1-style text boxes are fact × size in millimetres).
export function convert(value: number, fromType: string, toType: string): number {
	const from = unitOf(fromType)
	const to = unitOf(toType)

	if (from === to || from === "raw" || to === "raw") return value
	if (from === "pt") return value * (MARGIN_TYPES.has(toType) ? EMU_PER_PT : EMU_PER_MM)

	return value / EMU_PER_MM
}

// ST_ElementType (§21.4.7.27) on a data point.
export function matchesType(point: DataPoint, ptType: string): boolean {
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

function matchName(node: LayoutNode, name: string, ptType: string): boolean {
	return (name === "" || node.name === name) && matchesType(node.point, ptType)
}

// The layout nodes a constraint or rule of `owner` names (§21.4.7.43 ST_ConstraintRelationship): itself, its
// children or its descendants in document order, filtered by layout node name and point type.
export function targets(owner: LayoutNode, rel: "self" | "ch" | "des", name: string, ptType: string): LayoutNode[] {
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

const X_AXIS = ["l", "ctrX", "r", "w"] as const
const Y_AXIS = ["t", "ctrY", "b", "h"] as const

// One axis value from the two others that fix it: near edge, centre, far edge, extent.
export function inferred(values: ReadonlyMap<string, number>, type: string): number | undefined {
	const [near, center, far, size] = type === "l" || type === "r" || type === "w" || type === "ctrX" ? X_AXIS : Y_AXIS
	const n = values.get(near)
	const c = values.get(center)
	const f = values.get(far)
	const s = values.get(size)

	switch (type) {
		case near:
			if (s !== undefined) return c !== undefined ? c - s / 2 : f !== undefined ? f - s : undefined

			return c !== undefined && f !== undefined ? 2 * c - f : undefined
		case far:
			if (s !== undefined) return n !== undefined ? n + s : c !== undefined ? c + s / 2 : undefined

			return n !== undefined && c !== undefined ? 2 * c - n : undefined
		case center:
			if (s !== undefined) return n !== undefined ? n + s / 2 : f !== undefined ? f - s / 2 : undefined

			return n !== undefined && f !== undefined ? (n + f) / 2 : undefined
		case size:
			if (n !== undefined && f !== undefined) return f - n
			if (n !== undefined && c !== undefined) return 2 * (c - n)

			return c !== undefined && f !== undefined ? 2 * (f - c) : undefined
		default:
			return undefined
	}
}

// A value of `node` for a reference: set values first, then the node's own extent when it is the owner being
// resolved (its edges are relative to itself), then what follows from the others on the axis.
export function valueOf(
	node: LayoutNode,
	type: string,
	selfBox: { readonly w: number; readonly h: number } | undefined
): number | undefined {
	const direct = node.values.get(type)

	// An unbounded size is not known until the content is laid out.
	if (direct !== undefined) return Number.isFinite(direct) ? direct : undefined

	if (selfBox !== undefined) {
		switch (type) {
			case "w":
			case "r":
				return selfBox.w
			case "h":
			case "b":
				return selfBox.h
			case "l":
			case "t":
				return 0
			case "ctrX":
				return selfBox.w / 2
			case "ctrY":
				return selfBox.h / 2
		}
	}

	return inferred(node.values, type)
}

// Caps rules put on constraint values while they relax (rules.ts).
export interface Cap {
	readonly value: number
	// Whether the rule raises the value (a limit above it) rather than lowering it.
	readonly grow: boolean
}

// The value a constraint takes under the caps of the rules relaxing it: the owners are `node` itself (self rules)
// and its ancestors (ch/des rules) whose rule targets `node`.
export function cappedValue(node: LayoutNode, type: string, value: number): number {
	let out = value

	for (let owner: LayoutNode | undefined = node; owner !== undefined; owner = owner.parent) {
		if (owner.caps.size === 0) continue

		for (const [rule, cap] of owner.caps) {
			if (rule.type !== type) continue
			if (owner === node ? rule.for !== "self" : rule.for === "self") continue
			if (owner !== node && !targets(owner, rule.for, rule.forName, rule.ptType).includes(node)) continue

			out = cap.grow ? Math.max(out, cap.value) : Math.min(out, cap.value)
		}
	}

	return out
}

// Applies self caps to a geometry value the parent left implicit (the full extent): a shrinking w or h rule then
// sets the size.
export function capImplicit(node: LayoutNode, parentBox: { readonly w: number; readonly h: number }): void {
	if (node.caps.size === 0) return

	for (const [rule, cap] of node.caps) {
		if (rule.for !== "self" || FONT_TYPES.has(rule.type)) continue

		const current = node.values.get(rule.type) ?? (rule.type === "w" ? parentBox.w : rule.type === "h" ? parentBox.h : undefined)

		if (current === undefined) continue

		node.values.set(rule.type, cap.grow ? Math.max(current, cap.value) : Math.min(current, cap.value))
	}
}

export function setValue(node: LayoutNode, constraint: Constraint, value: number): void {
	// An unbounded or undefined value (val="INF", a NaN factor) bounds nothing and sets nothing, except an unbounded
	// size: the node is then as large as its content (lin measures it).
	if (!Number.isFinite(value)) {
		if (value === Number.POSITIVE_INFINITY && constraint.op === "none" && SIZE_TYPES.has(constraint.type)) {
			node.values.set(constraint.type, value)
		}

		return
	}

	const capped = cappedValue(node, constraint.type, value)

	if (constraint.op === "gte") node.lower.set(constraint.type, capped)
	else if (constraint.op === "lte") node.upper.set(constraint.type, capped)
	else node.values.set(constraint.type, capped)
}

// One constraint of `owner` (whose own extent is `box`); false when its reference is not known yet.
function applyConstraint(owner: LayoutNode, constraint: Constraint, box: { w: number; h: number }, only?: LayoutNode): boolean {
	const hits = targets(owner, constraint.for, constraint.forName, constraint.ptType).filter(n => only === undefined || n === only)

	if (hits.length === 0) return true

	let value: number

	if (constraint.refType === "none" || constraint.refType === "unknown") {
		// A size of 0 without a reference only groups the targets (op equ) or leaves the size to the algorithm
		// and the rules; it is not a size.
		if (constraint.val === 0 && SIZE_TYPES.has(constraint.type)) return true

		value = literal(constraint.type, constraint.val)
	} else {
		const ref = targets(owner, constraint.refFor, constraint.refForName, constraint.refPtType)[0]

		if (ref === undefined) return true

		const raw = valueOf(ref, constraint.refType, ref === owner ? box : undefined)

		if (raw === undefined) return false

		value = convert(raw, constraint.refType, constraint.type) * constraint.fact
	}

	for (const hit of hits) setValue(hit, constraint, value)

	return true
}

interface Pending {
	readonly owner: LayoutNode
	readonly constraint: Constraint
	readonly only?: LayoutNode
}

// Resolves the constraints that size and place `node`'s children as if `node` were w × h EMU.
export function resolveChildren(node: LayoutNode, w: number, h: number, budgets: SmartArtBudgets): void {
	for (const child of node.children) {
		child.values.clear()
		child.lower.clear()
		child.upper.clear()
	}

	let pending: Pending[] = []

	// Ancestors' `des` constraints reach this node's children before its own, outermost first.
	const chain: LayoutNode[] = []

	for (let a = node.parent; a !== undefined; a = a.parent) chain.unshift(a)

	for (const owner of chain) {
		for (const constraint of owner.constraints) {
			if (constraint.for !== "des") continue

			for (const child of node.children) pending.push({ owner, constraint, only: child })
		}
	}

	for (const constraint of node.constraints) if (constraint.for !== "self") pending.push({ owner: node, constraint })

	// The node's constraints on itself that read its children (a snake's row gap from a spacer's width).
	for (const constraint of node.constraints) {
		if (constraint.for === "self" && constraint.refFor !== "self") pending.push({ owner: node, constraint })
	}

	for (let pass = 0; pending.length > 0 && pass < budgets.maxConstraintPasses; pass++) {
		const deferred: Pending[] = []

		for (const item of pending) {
			const box = item.owner === node ? { w, h } : item.owner.box

			if (!applyConstraint(item.owner, item.constraint, box, item.only)) deferred.push(item)
		}

		if (deferred.length === pending.length) break

		pending = deferred
	}

	// The children's own constraints come last and only fill what the parent left open.
	let open: Pending[] = []

	for (const child of node.children) {
		for (const constraint of child.constraints) {
			if (constraint.for === "self" && constraint.forName === "") open.push({ owner: child, constraint })
		}
	}

	for (let pass = 0; open.length > 0 && pass < budgets.maxConstraintPasses; pass++) {
		const deferred: Pending[] = []

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

				setValue(owner, constraint, convert(raw, constraint.refType, constraint.type) * constraint.fact)
			} else {
				setValue(owner, constraint, literal(constraint.type, constraint.val))
			}
		}

		if (deferred.length === open.length) break

		open = deferred
	}

	for (const child of node.children) capImplicit(child, { w, h })
}

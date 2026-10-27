import { FONT_TYPES, literal, targets } from "./constraints"
import type { LayoutContext, LayoutNode } from "./interp"
import type { Rule } from "./layoutDef"
import { settleFontSize } from "./algorithms/tx"

// Rules (ECMA-376 §21.4.2.24, L.4.15.6.3.22) run after the diagram is laid out and change the value of an existing
// constraint when the content does not fit: towards `val` (an absolute limit, in the constraint's unit) or `fact`
// times the constraint's value, never past `max`. Rules are tried in ruleLst order. Each one first goes to its
// limit; when that fits, a bounded bisection finds the least change that still fits (half points for font sizes),
// re-laying the subtree each step. A font rule that cannot make the content fit stays at its floor; a geometry rule
// that cannot is undone. Relaxation stops at the rule step budget.
//
// The rules relaxed at a layout node are its own rules on its children or descendants (for="ch"/"des") and its
// children's rules on themselves (for="self", geometry only: a tx node fits its own font size), since the node's
// algorithm is what places its children.

// Geometry rules settle to a tenth of a millimetre.
const GEOMETRY_RESOLUTION = 3600

interface Relaxable {
	readonly owner: LayoutNode
	readonly rule: Rule
	readonly targets: readonly LayoutNode[]
}

// A column (lin fromT/fromB) already gives a text child whose height may grow without bound the height of its text
// (lin.ts): relaxing that rule again would lay the whole column out once per child (list1's child texts).
function grownByLine(node: LayoutNode, rule: Rule): boolean {
	if (node.alg.type !== "lin" || rule.val !== Number.POSITIVE_INFINITY) return false

	const dir = node.alg.params.get("linDir") ?? "fromL"

	return rule.type === (dir === "fromT" || dir === "fromB" ? "h" : "w") && rule.type === "h"
}

function relaxables(node: LayoutNode): Relaxable[] {
	const out: Relaxable[] = []

	for (const child of node.children) {
		for (const rule of child.rules) {
			if (child.alg.type === "tx" && grownByLine(node, rule)) continue

			if (rule.for === "self" && !FONT_TYPES.has(rule.type) && (rule.forName === "" || rule.forName === child.name)) {
				out.push({ owner: child, rule, targets: [child] })
			}
		}
	}

	for (const rule of node.rules) {
		if (rule.for !== "self") out.push({ owner: node, rule, targets: targets(node, rule.for, rule.forName, rule.ptType) })
	}

	return out
}

function currentValue(targets: readonly LayoutNode[], type: string): number | undefined {
	let value: number | undefined

	for (const target of targets) {
		const v =
			target.values.get(type) ??
			(type === "w" ? target.box.w : type === "h" ? target.box.h : FONT_TYPES.has(type) ? target.fontPt : undefined)

		if (v !== undefined && (value === undefined || v > value)) value = v
	}

	return value
}

// The rule's limit for a constraint now at `current`: val in the constraint's unit, else fact × current, bounded by
// max; undefined when the rule sets no finite limit.
function limitOf(rule: Rule, current: number): number | undefined {
	let limit = Number.isFinite(rule.val) ? literal(rule.type, rule.val) : Number.isFinite(rule.fact) ? rule.fact * current : undefined

	if (limit === undefined && rule.val === Number.POSITIVE_INFINITY) limit = rule.val

	if (limit === undefined) return undefined

	if (Number.isFinite(rule.max)) limit = Math.min(limit, literal(rule.type, rule.max))

	return limit
}

function room(node: LayoutNode, hits: readonly LayoutNode[], type: string): number {
	let out = Number.POSITIVE_INFINITY

	for (const hit of hits) {
		out = Math.min(out, type === "w" || type === "r" ? node.box.x + node.box.w - hit.box.x : node.box.y + node.box.h - hit.box.y)
	}

	return Math.max(0, out)
}

// Relaxes the rules of `node` while its subtree overflows; `relayout` lays the subtree out again and returns
// whether it still overflows. Returns the final overflow.
export function relax(node: LayoutNode, context: LayoutContext, overflow: boolean, relayout: () => boolean): boolean {
	if (!overflow) return false

	const budgets = context.budgets

	for (const { owner, rule, targets: hits } of relaxables(node)) {
		if (context.ruleSteps >= budgets.maxRuleSteps) break
		if (hits.length === 0) continue

		const current = currentValue(hits, rule.type)

		if (current === undefined) continue

		let limit = limitOf(rule, current)

		if (limit === undefined || limit === current) continue

		const grow = limit > current

		// Growing without bound: as far as the room left in the node that holds the targets.
		if (!Number.isFinite(limit)) limit = room(node, hits, rule.type)

		// The targets' lte/gte constraints bound the relaxation.
		for (const hit of hits) {
			const bound = grow ? hit.upper.get(rule.type) : hit.lower.get(rule.type)

			if (bound !== undefined) limit = grow ? Math.min(limit, bound) : Math.max(limit, bound)
		}

		if (grow ? limit <= current : limit >= current) continue

		context.ruleSteps++
		owner.caps.set(rule, { value: limit, grow })

		if (relayout()) {
			// A font size at its floor is the best the rule can do; a geometry change that does not make the
			// content fit is undone.
			if (!FONT_TYPES.has(rule.type)) {
				owner.caps.delete(rule)
				relayout()
			}

			continue
		}

		// The limit fits: the least change that still fits.
		let fits = limit
		let fails = current
		const font = FONT_TYPES.has(rule.type)
		const resolution = font ? 0.5 : GEOMETRY_RESOLUTION

		while (Math.abs(fails - fits) > resolution && context.ruleSteps < budgets.maxRuleSteps) {
			context.ruleSteps++

			const mid = font ? Math.round(fits + fails) / 2 : (fits + fails) / 2

			if (mid === fits || mid === fails) break

			owner.caps.set(rule, { value: mid, grow })

			if (relayout()) fails = mid
			else fits = mid
		}

		owner.caps.set(rule, { value: fits, grow })

		return relayout()
	}

	return overflow
}

// The nodes one primFontSz/secFontSz constraint sets (for ch/des) share one size: the smallest any of them came to
// (PowerPoint's caches give every hierarchy4 text box of a level, and every node a list's constraint sizes, one size,
// whether or not the constraint says op="equ"). A size bounded by another node's (op lte, txTwo no larger than txOne)
// then takes no more than that node's.
export function equalizeFonts(node: LayoutNode): void {
	for (const constraint of node.constraints) {
		if (!FONT_TYPES.has(constraint.type) || constraint.for === "self") continue
		if (constraint.op === "gte") continue

		const group = targets(node, constraint.for, constraint.forName, constraint.ptType).filter(t => t.fontPt !== undefined)

		if (group.length === 0) continue

		let size = Number.POSITIVE_INFINITY

		for (const target of group) size = Math.min(size, target.fontPt as number)

		if (constraint.op === "lte" && constraint.refType !== "none" && constraint.refType !== "unknown") {
			const ref = targets(node, constraint.refFor, constraint.refForName, constraint.refPtType)[0]
			const bound = ref?.fontPt

			if (bound === undefined || !Number.isFinite(constraint.fact)) continue

			size = Math.min(size, bound * constraint.fact)

			for (const target of group) if ((target.fontPt as number) > size) settleFontSize(target, size)

			continue
		}

		if (constraint.op === "lte" || group.length < 2) continue

		for (const target of group) settleFontSize(target, size)
	}
}

// Drops the caps `node`'s last relaxation left (its own ch/des rules and its children's self rules), so a relayout
// from above relaxes again from the constraints' own values.
export function resetCaps(node: LayoutNode): void {
	for (const rule of [...node.caps.keys()]) if (rule.for !== "self") node.caps.delete(rule)

	for (const child of node.children) {
		for (const rule of [...child.caps.keys()]) if (rule.for === "self") child.caps.delete(rule)
	}
}

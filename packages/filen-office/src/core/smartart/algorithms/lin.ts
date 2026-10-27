import { literal, matchesType, targets } from "../constraints"
import type { LayoutContext, LayoutNode } from "../interp"
import { customScale, param, sizeOf } from "./shared"
import { textHeight } from "./tx"

const MAX_FIT_STEPS = 4

interface Flow {
	readonly child: LayoutNode
	// The size the child's own layout runs in (its constraints), finite.
	readonly w: number
	readonly h: number
	// What the child takes along the line and across it, and where that starts inside the child's box.
	readonly main: number
	readonly cross: number
	readonly offMain: number
	// Laid out from the child's content rather than its own size.
	readonly content: boolean
	// The child's own custom scale, laid out here rather than about its centre afterwards.
	readonly scaled: boolean
}

function hasScaledChildren(child: LayoutNode): boolean {
	return child.children.some(c => {
		const scale = customScale(c)

		return scale.x !== 1 || scale.y !== 1
	})
}

function flowOf(child: LayoutNode, node: LayoutNode, vertical: boolean, mainAvail: number, context: LayoutContext): Flow {
	const size = sizeOf(child, node)
	const unbounded = (vertical ? child.values.get("h") : child.values.get("w")) === Number.POSITIVE_INFINITY
	const w = Number.isFinite(size.w) ? size.w : vertical ? node.box.w : mainAvail
	let h = Number.isFinite(size.h) ? size.h : vertical ? mainAvail : node.box.h

	// A text node of a column whose own rule lets it grow down without bound is as high as its text (list1's child
	// text): the column, and the rules of the node above it, see that height.
	if (vertical && child.alg.type === "tx" && growsDown(child)) {
		const need = textHeight(child, w, context)

		if (need !== undefined && need > h) h = need
	}

	// A child whose extent is its content (h or w INF) or whose own children carry the user's custom scale takes
	// the extent of its laid-out children along the line, as PowerPoint's caches show (vList5's rows are as tall
	// as their scaled shapes).
	if ((unbounded || hasScaledChildren(child)) && child.children.length > 0) {
		const content = context.content(child, w, h)

		return {
			child,
			w,
			h,
			main: vertical ? content.h : content.w,
			cross: vertical ? w : h,
			offMain: vertical ? content.y : content.x,
			content: true,
			scaled: false
		}
	}

	const scale = customScale(child)
	const scaled = scale.x !== 1 || scale.y !== 1
	// A composite with an aspect ratio takes the largest box of that shape inside its own.
	const ar = child.alg.type === "composite" ? Number(child.alg.params.get("ar") ?? "0") : 0
	const fw = ar > 0 && Number.isFinite(ar) ? Math.min(w, h * ar) : w
	const fh = ar > 0 && Number.isFinite(ar) ? fw / ar : h
	const sw = fw * scale.x
	const sh = fh * scale.y

	return { child, w: fw, h: fh, main: vertical ? sh : sw, cross: vertical ? sw : sh, offMain: 0, content: false, scaled }
}

// A line inside a line (hierarchy4 nests rows of columns of rows) is as large as its own children laid out at their
// constraint sizes, recursively, and never smaller than its own constraints: PowerPoint's caches lay every level of
// such a tree out at the sizes its constraints give (every box as wide as the diagram, the spaces fractions of it)
// and scale the whole line to fit, along and across it, so a text box spans the leaves under it and the leaves share
// one width.
function isLine(node: LayoutNode): boolean {
	return node.alg.type === "lin" && node.children.length > 0
}

// The lines laid out as part of a tree of nested lines (marked by the line above them).
const NESTED = new WeakSet<LayoutNode>()

// A line whose lines hold lines again is the top of such a tree, and so is a line of lines that no constraint sizes
// (lProcess3's rows are as wide as their chevrons, which the top line's constraints size); lines the parent sizes
// (vList5's rows) keep their own layout.
function nestsLines(node: LayoutNode): boolean {
	return (
		NESTED.has(node) ||
		node.children.some(child => isLine(child) && (child.children.some(isLine) || (!child.values.has("w") && !child.values.has("h"))))
	)
}

interface Extent {
	w: number
	h: number
	// Before the child's custom scale.
	baseW?: number
	baseH?: number
}

function finite(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) ? value : undefined
}

// The extent `node`'s children take laid out as a line at their natural sizes.
function lineExtent(node: LayoutNode, extents: readonly Extent[]): Extent {
	const dir = param(node, "linDir", "fromL")
	const vertical = dir === "fromT" || dir === "fromB"
	let main = 0
	let cross = 0

	for (const extent of extents) {
		main += vertical ? extent.h : extent.w
		cross = Math.max(cross, vertical ? extent.w : extent.h)
	}

	return vertical ? { w: cross, h: main } : { w: main, h: cross }
}

// The natural extent of each of `node`'s children (their constraints resolved): a nested line's is its content's
// (not its constraint size: vList5's rows are as tall as their custom-scaled shapes); a size no constraint sets is nothing; a child's gte constraint on a sibling's size
// (a text box at least as wide as the row under it) holds against the sibling's natural size. The user's custom
// scale applies.
function naturalExtents(node: LayoutNode, context: LayoutContext, depth: number): Extent[] {
	const extents = node.children.map(child => {
		// An empty line (the row under a leaf) takes no room: hierarchy4's custom-scaled leaves are narrower than
		// the constraint width their empty row has.
		if (child.alg.type === "lin" && child.children.length === 0) return { w: 0, h: 0 }

		let w = finite(child.values.get("w"))
		let h = finite(child.values.get("h"))

		if (isLine(child) && depth < context.budgets.maxForEachDepth) {
			context.constrain(child, w ?? node.box.w, h ?? node.box.h)

			const content = lineExtent(child, naturalExtents(child, context, depth + 1))

			if (content.w > 0) w = content.w
			if (content.h > 0) h = content.h
		}

		return { w: w ?? 0, h: h ?? 0 }
	})

	for (const constraint of node.constraints) {
		// A size taken from a sibling's (gte: at least it; equ or none: it), read against the sibling's natural extent:
		// the Pitchbook hierarchy's txOne is as wide as the row of columns under it.
		if (constraint.op === "lte" || constraint.for === "self" || constraint.refFor !== "ch") continue
		if (constraint.type !== "w" && constraint.type !== "h") continue
		if (constraint.refType !== "w" && constraint.refType !== "h") continue

		const ref = node.children.findIndex(c => c.name === constraint.refForName && matchesType(c.point, constraint.refPtType))

		if (ref < 0) continue

		const bound = (extents[ref] as Extent)[constraint.refType] * constraint.fact

		node.children.forEach((child, index) => {
			if ((constraint.forName !== "" && child.name !== constraint.forName) || !matchesType(child.point, constraint.ptType)) return

			const extent = extents[index] as Extent

			extent[constraint.type as "w" | "h"] = constraint.op === "gte" ? Math.max(extent[constraint.type as "w" | "h"], bound) : bound
		})
	}

	node.children.forEach((child, index) => {
		const scale = customScale(child)
		const extent = extents[index] as Extent

		extent.baseW = extent.w
		extent.baseH = extent.h
		extent.w *= Math.max(0, scale.x)
		extent.h *= Math.max(0, scale.y)
	})

	return extents
}

// A line of nested lines: the children at their natural extents, scaled along and across the line to fit it.
function nestedLineLayout(node: LayoutNode, context: LayoutContext, vertical: boolean, reverse: boolean): void {
	const box = node.box
	const extents = naturalExtents(node, context, 0)
	const mainAvail = vertical ? box.h : box.w
	const crossAvail = vertical ? box.w : box.h
	let total = 0
	let cross = 0

	for (const extent of extents) {
		total += vertical ? extent.h : extent.w
		cross = Math.max(cross, vertical ? extent.w : extent.h)
	}

	const fitMain = total > mainAvail && total > 0 ? mainAvail / total : 1
	const fitCross = cross > crossAvail && cross > 0 ? crossAvail / cross : 1
	const fitX = vertical ? fitCross : fitMain
	const fitY = vertical ? fitMain : fitCross
	const along = vertical ? param(node, "vertAlign", "mid") : param(node, "horzAlign", "ctr")
	const laid = total * fitMain
	const start = along === "l" || along === "t" ? 0 : along === "r" || along === "b" ? mainAvail - laid : (mainAvail - laid) / 2
	const vAlign = param(node, "nodeVertAlign", "mid")
	const hAlign = param(node, "nodeHorzAlign", "ctr")
	const crossAlign = vertical ? (hAlign === "l" ? 0 : hAlign === "r" ? 1 : 0.5) : vAlign === "t" ? 0 : vAlign === "b" ? 1 : 0.5
	let cursor = reverse ? mainAvail - start : start

	node.children.forEach((child, index) => {
		const extent = extents[index] as Extent
		const w = extent.w * fitX
		const h = extent.h * fitY
		const along = vertical ? h : w
		const at = reverse ? cursor - along : cursor
		const across = (crossAvail - (vertical ? w : h)) * crossAlign

		child.box = vertical ? { x: box.x + across, y: box.y + at, w, h } : { x: box.x + at, y: box.y + across, w, h }

		if (isLine(child)) NESTED.add(child)

		const scale = customScale(child)

		if (scale.x !== 1 || scale.y !== 1) {
			child.base = { w: (extent.baseW ?? extent.w) * fitX, h: (extent.baseH ?? extent.h) * fitY }
			child.scaledInPlace = true
		}

		cursor += reverse ? -along : along
	})
}

function growsDown(child: LayoutNode): boolean {
	return child.rules.some(rule => rule.type === "h" && rule.forName === "" && rule.val === Number.POSITIVE_INFINITY)
}

function growsAcross(child: LayoutNode, vertical: boolean): boolean {
	const type = vertical ? "w" : "h"

	return child.rules.some(rule => rule.type === type && rule.forName === "" && rule.val === Number.POSITIVE_INFINITY)
}

// A line that does not fit first relaxes its own rule on its children's size along it (hProcess3's `w for ch linV
// val 0`): the size goes down, no further than the rule's value, until the line fits, the spaces that follow it
// shrinking with it. The line is linear in that size, so two layouts of the constraints solve it. Undefined when
// no rule applies.
function shrinkByRule(
	node: LayoutNode,
	context: LayoutContext,
	vertical: boolean,
	mainAvail: number,
	flows: Flow[],
	extent: (list: readonly Flow[]) => { total: number; cross: number }
): Flow[] | undefined {
	const type = vertical ? "h" : "w"
	const rule = node.rules.find(r => r.for === "ch" && r.type === type && Number.isFinite(r.val))
	const total0 = extent(flows).total

	if (rule === undefined || !(total0 > mainAvail)) return undefined

	const hits = targets(node, rule.for, rule.forName, rule.ptType)
	let v0: number | undefined

	for (const hit of hits) {
		const value = hit.values.get(type)

		if (value !== undefined && Number.isFinite(value)) v0 = Math.max(v0 ?? value, value)
	}

	const floor = literal(type, rule.val)

	if (v0 === undefined || !(v0 > floor)) return undefined

	const relayout = (value: number): Flow[] => {
		node.caps.set(rule, { value, grow: false })
		context.constrain(node, node.box.w, node.box.h)

		return node.children.map(child => flowOf(child, node, vertical, mainAvail, context))
	}
	const v1 = (v0 + floor) / 2
	const total1 = extent(relayout(v1)).total
	const slope = (total0 - total1) / (v0 - v1)

	if (!(slope > 0)) {
		node.caps.delete(rule)
		context.constrain(node, node.box.w, node.box.h)

		return node.children.map(child => flowOf(child, node, vertical, mainAvail, context))
	}

	return relayout(Math.max(floor, v0 - (total0 - mainAvail) / slope))
}

// The linear algorithm (L.4.15.6.1.1 lin): children in a row (linDir fromL/fromR) or a column (fromT/fromB) at
// their constraint sizes. When they do not fit, the constraints are re-resolved against a proportionally smaller
// main extent (sizes are linear in it), within bounded steps. The line is aligned on the main axis by horzAlign
// (rows) or vertAlign (columns) and each child across it by nodeVertAlign/nodeHorzAlign (defaults per MS-OI29500
// §2.1.1639: fromL, ctr, mid). Like the snake, the line flows the user's custom-scaled sizes.
export function linLayout(node: LayoutNode, context: LayoutContext): void {
	const box = node.box
	const dir = param(node, "linDir", "fromL")
	const vertical = dir === "fromT" || dir === "fromB"
	const reverse = dir === "fromR" || dir === "fromB"

	if (nestsLines(node)) {
		nestedLineLayout(node, context, vertical, reverse)

		return
	}

	const mainAvail = vertical ? box.h : box.w
	const crossAvail = vertical ? box.w : box.h
	let main = mainAvail
	let flows = node.children.map(child => flowOf(child, node, vertical, mainAvail, context))
	let uniform = false
	const extent = (list: readonly Flow[]): { total: number; cross: number } => {
		let total = 0
		let cross = 0

		let at = 0

		for (const flow of list) {
			at += flow.main
			// A line reaches as far as its cursor goes: a negative child after the last pulls back without shortening it
			// (hProcess3's column ends in a -0.4 font-size spacer; PowerPoint starts it at the top of its 2 font sizes).
			total = Math.max(total, at)
			// A child whose rule lets it grow across without bound (process3's composite, h = 1000 w with h INF) is as
			// deep as the line allows: its depth never makes the line smaller.
			cross = Math.max(cross, growsAcross(flow.child, vertical) ? Math.min(flow.cross, crossAvail) : flow.cross)
		}

		return { total, cross }
	}
	const refit = (): void => {
		const k = main / mainAvail

		if (uniform) context.constrain(node, box.w * k, box.h * k)
		else context.constrain(node, vertical ? box.w : main, vertical ? main : box.h)
		flows = node.children.map(child => flowOf(child, node, vertical, main, context))
	}

	flows = shrinkByRule(node, context, vertical, mainAvail, flows, extent) ?? flows

	for (let step = 0; step < MAX_FIT_STEPS; step++) {
		const { total, cross } = extent(flows)
		const fit = Math.min(
			total > mainAvail && total > 0 ? mainAvail / total : 1,
			cross > crossAvail && cross > 0 ? crossAvail / cross : 1
		)

		if (fit >= 1 - 1e-9) break

		main *= fit
		refit()

		// Sizes that do not follow the line's extent along it but are tied to the extent across it (a composite's
		// aspect ratio, a height that is a fraction of a width the line's parent sets): PowerPoint scales the whole
		// line down, both ways.
		if (!uniform && extent(flows).total >= total * (1 - 1e-6)) {
			uniform = true
			refit()

			// Sizes tied to neither extent (heights from a font size): the line's rules shrink them, not the scale.
			if (extent(flows).total >= total * (1 - 1e-6)) {
				uniform = false
				refit()
				break
			}
		}
	}

	// Sizes that do not follow the line's own extent (constraints on an ancestor's width, as nested lines of a
	// table hierarchy or a picture list have) shrink along the line until it fits; across it they keep their size
	// (pList2's picture boxes keep their height in PowerPoint's caches).
	let total = 0

	for (const flow of flows) total += flow.main

	let shrunk = false

	if (total > mainAvail && total > 0) {
		const fit = mainAvail / total

		shrunk = true
		// A child sized by its content shrinks with the line: it is laid out again in its shorter box.
		flows = flows.map(flow =>
			flow.content
				? { ...flow, main: flow.main * fit, offMain: flow.offMain * fit, ...(vertical ? { h: flow.h * fit } : { w: flow.w * fit }) }
				: { ...flow, main: flow.main * fit, ...(vertical ? { h: flow.h * fit } : { w: flow.w * fit }) }
		)
	}

	total = extent(flows).total

	const along = vertical ? param(node, "vertAlign", "mid") : param(node, "horzAlign", "ctr")
	const start = along === "l" || along === "t" ? 0 : along === "r" || along === "b" ? mainAvail - total : (mainAvail - total) / 2
	let cursor = reverse ? mainAvail - start : start
	const vAlign = param(node, "nodeVertAlign", "mid")
	const hAlign = param(node, "nodeHorzAlign", "ctr")
	const crossAlign = vertical ? (hAlign === "l" ? 0 : hAlign === "r" ? 1 : 0.5) : vAlign === "t" ? 0 : vAlign === "b" ? 1 : 0.5

	for (const flow of flows) {
		const child = flow.child
		const at = (reverse ? cursor - flow.main : cursor) - flow.offMain
		// A content-sized child keeps its own size so its constraints hold, placed so its content lands on the line.
		const mainSize = flow.content ? (vertical ? flow.h : flow.w) : flow.main
		const crossSize = Math.min(flow.cross, crossAvail)
		const across = (crossAvail - crossSize) * crossAlign

		child.box = vertical
			? { x: box.x + across, y: box.y + at, w: crossSize, h: mainSize }
			: { x: box.x + at, y: box.y + across, w: mainSize, h: crossSize }

		// The fitted size is the child's size from now on: its own children's constraints on it read this one.
		if (shrunk && !flow.content) {
			child.values.set("w", vertical ? crossSize : mainSize)
			child.values.set("h", vertical ? mainSize : crossSize)
		}

		if (flow.scaled) {
			child.base = { w: flow.w, h: flow.h }
			child.scaledInPlace = true
		}

		cursor += reverse ? -flow.main : flow.main
	}
}

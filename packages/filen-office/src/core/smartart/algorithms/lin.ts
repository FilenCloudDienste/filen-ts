import type { LayoutContext, LayoutNode } from "../interp"
import { customScale, param, sizeOf } from "./shared"

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
	const h = Number.isFinite(size.h) ? size.h : vertical ? mainAvail : node.box.h

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
	const sw = w * scale.x
	const sh = h * scale.y

	return { child, w, h, main: vertical ? sh : sw, cross: vertical ? sw : sh, offMain: 0, content: false, scaled }
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
	const mainAvail = vertical ? box.h : box.w
	const crossAvail = vertical ? box.w : box.h
	let main = mainAvail
	let flows = node.children.map(child => flowOf(child, node, vertical, mainAvail, context))

	for (let step = 0; step < MAX_FIT_STEPS; step++) {
		let total = 0
		let cross = 0

		for (const flow of flows) {
			total += flow.main
			cross = Math.max(cross, flow.cross)
		}

		const fit = Math.min(
			total > mainAvail && total > 0 ? mainAvail / total : 1,
			cross > crossAvail && cross > 0 ? crossAvail / cross : 1
		)

		if (fit >= 1 - 1e-9) break

		main *= fit
		context.constrain(node, vertical ? box.w : main, vertical ? main : box.h)
		flows = node.children.map(child => flowOf(child, node, vertical, main, context))
	}

	let total = 0

	for (const flow of flows) total += flow.main

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

		if (flow.scaled) {
			child.base = { w: flow.w, h: flow.h }
			child.scaledInPlace = true
		}

		cursor += reverse ? -flow.main : flow.main
	}
}

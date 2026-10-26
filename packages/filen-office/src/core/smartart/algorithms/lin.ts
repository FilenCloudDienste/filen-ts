import type { LayoutContext, LayoutNode } from "../interp"
import { param, sizeOf } from "./shared"

const MAX_FIT_STEPS = 4

// The linear algorithm (L.4.15.6.1.1 lin): children in a row (linDir fromL/fromR) or a column
// (fromT/fromB) at their constraint sizes. When they do not fit, the constraints are re-resolved
// against a proportionally smaller main extent (sizes are linear in it), within bounded steps; the row
// is centred on the main axis and aligned on the other by nodeVertAlign/nodeHorzAlign (defaults per
// MS-OI29500 §2.1.1639: fromL, mid, ctr).
export function linLayout(node: LayoutNode, context: LayoutContext): void {
	const box = node.box
	const dir = param(node, "linDir", "fromL")
	const vertical = dir === "fromT" || dir === "fromB"
	const reverse = dir === "fromR" || dir === "fromB"
	const mainAvail = vertical ? box.h : box.w
	const crossAvail = vertical ? box.w : box.h
	let main = mainAvail
	let sizes = node.children.map(child => sizeOf(child, node))

	for (let step = 0; step < MAX_FIT_STEPS; step++) {
		let total = 0
		let cross = 0

		for (const size of sizes) {
			total += vertical ? size.h : size.w
			cross = Math.max(cross, vertical ? size.w : size.h)
		}

		const fit = Math.min(
			total > mainAvail && total > 0 ? mainAvail / total : 1,
			cross > crossAvail && cross > 0 ? crossAvail / cross : 1
		)

		if (fit >= 1 - 1e-9) break

		main *= fit
		context.ruleSteps++
		context.constrain(node, vertical ? box.w : main, vertical ? main : box.h)
		sizes = node.children.map(child => sizeOf(child, node))
	}

	let total = 0

	for (const size of sizes) total += vertical ? size.h : size.w

	let cursor = (mainAvail - total) / 2
	const vAlign = param(node, "nodeVertAlign", "mid")
	const hAlign = param(node, "nodeHorzAlign", "ctr")
	const order = node.children.map((child, index) => ({ child, size: sizes[index] as { w: number; h: number } }))

	if (reverse) order.reverse()

	for (const { child, size } of order) {
		const w = Math.min(size.w, vertical ? crossAvail : size.w)
		const h = Math.min(size.h, vertical ? size.h : crossAvail)

		if (vertical) {
			const x = hAlign === "l" ? 0 : hAlign === "r" ? crossAvail - w : (crossAvail - w) / 2

			child.box = { x: box.x + x, y: box.y + cursor, w, h }
			cursor += h
		} else {
			const y = vAlign === "t" ? 0 : vAlign === "b" ? crossAvail - h : (crossAvail - h) / 2

			child.box = { x: box.x + cursor, y: box.y + y, w, h }
			cursor += w
		}
	}
}

import type { LayoutContext, LayoutNode } from "../interp"
import { param, sizeOf } from "./shared"

function isSpacer(child: LayoutNode): boolean {
	return child.alg.type === "sp" && (child.shape === undefined || child.shape.type === "none") && child.children.length === 0
}

// The snake algorithm (L.4.15.6.1.1 snake): nodes along rows (flowDir row) or columns (col) that wrap
// across the box, starting at the grDir corner, each row in the same direction or alternating (contDir).
// The break point (bkpt) is where the nodes come out largest (endCnv, the default per MS-OI29500
// §2.1.1639) or a fixed count (fixed, bkPtFixedVal); spacers between nodes give the gap along the
// flow, the node's sp constraint the gap between rows; off=ctr centres a short last row.
export function snakeLayout(node: LayoutNode, _context: LayoutContext): void {
	const box = node.box
	const items = node.children.filter(child => !isSpacer(child))
	const spacers = node.children.filter(isSpacer)

	if (items.length === 0) {
		for (const child of node.children) child.box = { x: box.x, y: box.y, w: 0, h: 0 }

		return
	}

	const byRow = param(node, "flowDir", "row") !== "col"
	const sizes = items.map(child => sizeOf(child, node))
	const first = sizes[0] as { w: number; h: number }
	// Along the flow (a) and across it (b).
	const a0 = byRow ? first.w : first.h
	const b0 = byRow ? first.h : first.w
	const spacer = spacers[0]
	const gapA = spacer === undefined ? 0 : byRow ? (spacer.values.get("w") ?? 0) : (spacer.values.get("h") ?? spacer.values.get("w") ?? 0)
	const gapB = node.values.get("sp") ?? gapA
	const availA = byRow ? box.w : box.h
	const availB = byRow ? box.h : box.w
	const n = items.length
	const fixed = param(node, "bkpt", "endCnv") === "fixed"
	let best = 1
	let bestFit = -1

	for (let perRow = 1; perRow <= n; perRow++) {
		if (fixed && perRow !== Math.min(n, Math.max(1, Math.trunc(Number(param(node, "bkPtFixedVal", "2")))))) continue

		const rows = Math.ceil(n / perRow)
		const needA = perRow * a0 + (perRow - 1) * gapA
		const needB = rows * b0 + (rows - 1) * gapB
		const fit = Math.min(needA > 0 ? availA / needA : 1, needB > 0 ? availB / needB : 1)

		if (fit > bestFit + 1e-9) {
			bestFit = fit
			best = perRow
		}
	}

	const scale = Math.min(1, bestFit)
	const a = a0 * scale
	const b = b0 * scale
	const ga = gapA * scale
	const gb = gapB * scale
	const rows = Math.ceil(n / best)
	const blockA = best * a + (best - 1) * ga
	const blockB = rows * b + (rows - 1) * gb
	const startA = (availA - blockA) / 2
	const startB = (availB - blockB) / 2
	const grow = param(node, "grDir", "tL")
	const reverseA = byRow ? grow === "tR" || grow === "bR" : grow === "bL" || grow === "bR"
	const reverseB = byRow ? grow === "bL" || grow === "bR" : grow === "tR" || grow === "bR"
	const alternate = param(node, "contDir", "sameDir") === "revDir"
	const center = param(node, "off", "off") === "ctr"

	items.forEach((child, index) => {
		const row = Math.floor(index / best)
		const inRow = Math.min(best, n - row * best)
		let col = index - row * best
		const flip = reverseA !== (alternate && row % 2 === 1)

		if (flip) col = inRow - 1 - col

		const rowShift = center ? ((best - inRow) * (a + ga)) / 2 : flip ? (best - inRow) * (a + ga) : 0
		let pa = startA + rowShift + col * (a + ga)
		let pb = startB + row * (b + gb)

		if (reverseA && !center) pa = startA + (best - 1 - (index - row * best)) * (a + ga)
		if (reverseB) pb = availB - pb - b

		child.box = byRow ? { x: box.x + pa, y: box.y + pb, w: a, h: b } : { x: box.x + pb, y: box.y + pa, w: b, h: a }
	})

	for (const child of spacers) {
		child.box = { x: box.x, y: box.y, w: byRow ? ga : b, h: byRow ? b : ga }
	}
}

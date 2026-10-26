import type { Box, LayoutContext, LayoutNode } from "../interp"
import { customScale, param, sizeOf } from "./shared"

function isSpacer(child: LayoutNode): boolean {
	return child.alg.type === "sp" && (child.shape === undefined || child.shape.type === "none") && child.children.length === 0
}

function isConnector(child: LayoutNode): boolean {
	return child.alg.type === "conn" || child.shape?.type === "conn"
}

interface Item {
	readonly child: LayoutNode
	// Along the flow (a) and across it (b), with the user's custom scale, and without it.
	readonly a: number
	readonly b: number
	readonly baseA: number
	readonly baseB: number
}

interface Arrangement {
	readonly rows: readonly (readonly Item[])[]
	readonly rowA: readonly number[]
	readonly rowB: readonly number[]
	readonly blockA: number
	readonly blockB: number
}

function arrange(items: readonly Item[], perRow: number, gapA: number, gapB: number): Arrangement {
	const rows: Item[][] = []

	for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow))

	const rowA = rows.map(row => row.reduce((sum, item) => sum + item.a, 0) + (row.length - 1) * gapA)
	const rowB = rows.map(row => row.reduce((max, item) => Math.max(max, item.b), 0))

	return {
		rows,
		rowA,
		rowB,
		blockA: rowA.reduce((max, a) => Math.max(max, a), 0),
		blockB: rowB.reduce((sum, b) => sum + b, 0) + (rows.length - 1) * gapB
	}
}

// The breakpoint's candidates for the number of nodes per row (ST_Breakpoint §21.4.7.11).
function perRowCandidates(node: LayoutNode, n: number): number[] {
	switch (param(node, "bkpt", "endCnv")) {
		case "fixed":
			return [Math.min(n, Math.max(1, Math.trunc(Number(param(node, "bkPtFixedVal", "2"))) || 1))]
		case "bal":
			return [Math.ceil(Math.sqrt(n))]
		default:
			return Array.from({ length: n }, (_, i) => i + 1)
	}
}

// The snake algorithm (L.4.15.6.1.1 snake): nodes along rows (flowDir row) or columns (col) that wrap across the
// box, starting at the grDir corner, each row in the same direction or alternating (contDir). The break point
// (bkpt) is where the nodes come out largest (endCnv, the default per MS-OI29500 §2.1.1639), as many rows as
// columns (bal), or a fixed count (fixed, bkPtFixedVal). Spacers or connectors between nodes give the gap along
// the flow, the node's sp constraint the gap between rows; off=ctr centres a short row.
//
// The user's custom scale (custScaleX/Y) is part of the flow, as PowerPoint's caches show: each node takes its
// scaled size, a row is as deep as its deepest node with the nodes centred in it, and the whole block is fitted
// and centred in the box.
export function snakeLayout(node: LayoutNode, _context: LayoutContext): void {
	const box = node.box
	const flow = node.children.filter(child => !isSpacer(child) && !isConnector(child))
	const spacers = node.children.filter(isSpacer)

	if (flow.length === 0) {
		for (const child of node.children) child.box = { x: box.x, y: box.y, w: 0, h: 0 }

		return
	}

	const byRow = param(node, "flowDir", "row") !== "col"
	const items: Item[] = flow.map(child => {
		const size = sizeOf(child, node)
		const scale = customScale(child)
		const baseA = byRow ? size.w : size.h
		const baseB = byRow ? size.h : size.w

		return { child, baseA, baseB, a: baseA * (byRow ? scale.x : scale.y), b: baseB * (byRow ? scale.y : scale.x) }
	})
	const gapNode = spacers[0] ?? node.children.find(isConnector)
	const gapA =
		gapNode === undefined ? 0 : byRow ? (gapNode.values.get("w") ?? 0) : (gapNode.values.get("h") ?? gapNode.values.get("w") ?? 0)
	const gapB = node.values.get("sp") ?? gapA
	const availA = byRow ? box.w : box.h
	const availB = byRow ? box.h : box.w
	let best: Arrangement | undefined
	let bestFit = -1

	for (const perRow of perRowCandidates(node, items.length)) {
		const candidate = arrange(items, perRow, gapA, gapB)
		const fit = Math.min(candidate.blockA > 0 ? availA / candidate.blockA : 1, candidate.blockB > 0 ? availB / candidate.blockB : 1)

		if (fit > bestFit + 1e-9) {
			bestFit = fit
			best = candidate
		}
	}

	const chosen = best as Arrangement
	const scale = Math.min(1, bestFit)
	const startA = (availA - chosen.blockA * scale) / 2
	let cursorB = (availB - chosen.blockB * scale) / 2
	const grow = param(node, "grDir", "tL")
	const reverseA = byRow ? grow === "tR" || grow === "bR" : grow === "bL" || grow === "bR"
	const reverseB = byRow ? grow === "bL" || grow === "bR" : grow === "tR" || grow === "bR"
	const alternate = param(node, "contDir", "sameDir") === "revDir"
	const center = param(node, "off", "off") === "ctr"
	const placed = new Map<LayoutNode, Box>()

	chosen.rows.forEach((row, r) => {
		const flip = reverseA !== (alternate && r % 2 === 1)
		const rowA = (chosen.rowA[r] ?? 0) * scale
		const rowB = (chosen.rowB[r] ?? 0) * scale
		const slack = chosen.blockA * scale - rowA
		let cursorA = startA + (center ? slack / 2 : flip ? slack : 0)

		for (const item of flip ? [...row].reverse() : row) {
			const a = item.a * scale
			const b = item.b * scale
			let pb = cursorB + (rowB - b) / 2

			if (reverseB) pb = availB - pb - b

			const child = item.child

			child.box = byRow ? { x: box.x + cursorA, y: box.y + pb, w: a, h: b } : { x: box.x + pb, y: box.y + cursorA, w: b, h: a }
			child.base = byRow ? { w: item.baseA * scale, h: item.baseB * scale } : { w: item.baseB * scale, h: item.baseA * scale }
			child.scaledInPlace = true
			placed.set(child, child.box)
			cursorA += a + gapA * scale
		}

		cursorB += rowB + gapB * scale
	})

	for (const child of spacers) child.box = { x: box.x, y: box.y, w: byRow ? gapA * scale : 0, h: byRow ? 0 : gapA * scale }

	// A connector spans from the node before it to the node after it in the flow; its route is the conn algorithm's.
	let previous: Box | undefined

	node.children.forEach((child, index) => {
		const at = placed.get(child)

		if (at !== undefined) {
			previous = at

			return
		}

		if (!isConnector(child)) return

		const next = node.children.slice(index + 1).find(c => placed.has(c))
		const to = next === undefined ? undefined : placed.get(next)

		child.box = previous === undefined || to === undefined ? { x: box.x, y: box.y, w: 0, h: 0 } : spanBetween(previous, to)
	})
}

// The box between two nodes' centres; in one row, between their facing edges.
function spanBetween(from: Box, to: Box): Box {
	const ay = from.y + from.h / 2
	const by = to.y + to.h / 2

	if (Math.abs(ay - by) < Math.min(from.h, to.h) / 2) {
		const x0 = from.x <= to.x ? from.x + from.w : to.x + to.w
		const x1 = from.x <= to.x ? to.x : from.x

		return { x: Math.min(x0, x1), y: Math.min(ay, by), w: Math.abs(x1 - x0), h: Math.abs(ay - by) }
	}

	const ax = from.x + from.w / 2
	const bx = to.x + to.w / 2

	return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(ax - bx), h: Math.abs(ay - by) }
}

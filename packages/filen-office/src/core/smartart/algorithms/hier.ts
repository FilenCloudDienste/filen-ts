import type { Box, LayoutContext, LayoutNode } from "../interp"
import { isConnector } from "./conn"
import { ownValue, param, sizeOf } from "./shared"

// The hierarchy algorithms (ECMA-376 L.4.15.6.1.1 hierRoot and hierChild, §21.4.7.32 ST_HierarchyAlignment,
// §21.4.7.17 ST_ChildAlignment, §21.4.7.38 ST_LinearDirection, §21.4.7.31 ST_HierBranchStyle): a tree laid out
// from its leaves up. A hierRoot node holds a node's own shape (its first child that is not a hierChild) and the
// hierChild nodes below it; a hierChild node holds the subtrees of the node's children, side by side along linDir
// with the sibSp constraint between them, aligned across the line by chAlign. The root shape goes before the
// children (hierAlign t*: above them, b*: below, l*: left, r*: right) with the sp constraint between, placed at
// their start or end or centred over them (tCtrCh, tCtrDes). The hierBranch variable of a node's own shape turns
// its children into a column (l, r: hanging on that side, hang: two columns about the stem).
//
// The tree is laid out whole by its outermost hierRoot, at the constraint sizes, then scaled down to fit that
// node's box and centred in it; every node of it takes its box then, so connectors see their ends however the
// interpreter reaches them, and the nodes inside it are placed from the same plan when the interpreter lays them
// out.

interface Extent {
	readonly w: number
	readonly h: number
}

interface Plan {
	// Boxes relative to the subtree's origin, unscaled.
	readonly boxes: Map<LayoutNode, Box>
	readonly extent: Extent
}

// The boxes the outermost hierRoot gave its tree (absolute), consulted when the interpreter places inner nodes.
const planned = new WeakMap<LayoutNode, Box>()

function isHier(node: LayoutNode): boolean {
	return node.alg.type === "hierRoot" || node.alg.type === "hierChild"
}

function translate(plan: Plan, dx: number, dy: number, into: Map<LayoutNode, Box>): void {
	for (const [node, box] of plan.boxes) into.set(node, { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h })
}

// A hierarchy variable as the node or the nearest ancestor sets it.
function variable(node: LayoutNode, name: string, fallback: string): string {
	for (let at: LayoutNode | undefined = node; at !== undefined; at = at.parent) {
		const value = at.vars.get(name)

		if (value !== undefined && value !== "") return value
	}

	return fallback
}

const MAX_TREE_DEPTH = 128

function planNode(node: LayoutNode, context: LayoutContext, depth: number): Plan {
	if (depth > MAX_TREE_DEPTH || !isHier(node)) {
		const size = node.parent === undefined ? { w: node.box.w, h: node.box.h } : sizeOf(node, node.parent)

		return { boxes: new Map([[node, { x: 0, y: 0, w: size.w, h: size.h }]]), extent: size }
	}

	// The node's children are sized by its own constraints (and its ancestors' for des).
	context.constrain(node, node.box.w, node.box.h)

	return node.alg.type === "hierRoot" ? planRoot(node, context, depth) : planChildren(node, context, depth)
}

function assistants(block: LayoutNode): boolean {
	const members = block.children.filter(child => !isConnector(child))

	return members.length > 0 && members.every(child => child.point.type === "asst")
}

function planRoot(node: LayoutNode, context: LayoutContext, depth: number): Plan {
	// An assistants' block (hierChild of asst points) comes next to the root, before the other children (the org
	// chart's assistant hangs between the manager and the staff in PowerPoint and LibreOffice).
	const blocks = node.children
		.filter(child => child.alg.type === "hierChild")
		.sort((a, b) => Number(!assistants(a)) - Number(!assistants(b)))
	const own = node.children.find(child => child.alg.type !== "hierChild" && !isConnector(child))
	const rest = node.children.filter(child => child !== own && !blocks.includes(child))
	const ownSize = own === undefined ? { w: 0, h: 0 } : sizeOf(own, node)
	const align = param(node, "hierAlign", "tCtrCh")
	const side = align[0] === "b" ? "b" : align[0] === "l" ? "l" : align[0] === "r" ? "r" : "t"
	const vertical = side === "t" || side === "b"
	const gap = ownValue(node, "sp") ?? 0
	const plans = blocks.map(block => planNode(block, context, depth + 1))
	// Blocks of one root (its children, its assistants) follow each other away from the root.
	let blockMain = 0
	let blockCross = 0

	for (const plan of plans) {
		blockMain += vertical ? plan.extent.h : plan.extent.w
		blockCross = Math.max(blockCross, vertical ? plan.extent.w : plan.extent.h)
	}

	const hasBlocks = plans.some(plan => plan.extent.w > 0 && plan.extent.h > 0)
	const ownMain = vertical ? ownSize.h : ownSize.w
	const ownCross = vertical ? ownSize.w : ownSize.h
	const position = align.slice(1)
	const toStart = position === "L" || position === "T"
	const toEnd = position === "R" || position === "B"
	// alignOff (§21.4.7.17 ST_ConstraintType, a fraction of the root's own extent across): blocks under a root aligned
	// to their start or end are set in by it, so the line from the root's connector drops beside them (orgChart1's
	// staff hanging under their manager at 0.25 or 0.65 of its width).
	const alignOff = toStart || toEnd ? Math.max(0, (ownValue(node, "alignOff") ?? 0) * ownCross) : 0
	const cross = Math.max(ownCross, blockCross + alignOff)
	// Where the root sits across the line, over the blocks: their start, their end, or their centre.
	const at = (extent: number): number => (toStart ? 0 : toEnd ? cross - extent : (cross - extent) / 2)
	const blockAt = (extent: number): number => (toStart ? alignOff : toEnd ? cross - extent - alignOff : (cross - extent) / 2)
	const boxes = new Map<LayoutNode, Box>()
	// The blocks keep sp apart from each other too (an assistants' block before the staff, as from the root).
	const filled = plans.filter(plan => plan.extent.w > 0 && plan.extent.h > 0).length
	const main = ownMain + (hasBlocks ? gap + blockMain + Math.max(0, filled - 1) * gap : 0)
	const ownStart = side === "t" || side === "l" ? 0 : main - ownMain
	const ownBox: Box = vertical
		? { x: at(ownCross), y: ownStart, w: ownSize.w, h: ownSize.h }
		: { x: ownStart, y: at(ownCross), w: ownSize.w, h: ownSize.h }

	if (own !== undefined) boxes.set(own, ownBox)

	let cursor = side === "t" || side === "l" ? ownMain + gap : 0

	for (const plan of plans) {
		const extentMain = vertical ? plan.extent.h : plan.extent.w
		const extentCross = vertical ? plan.extent.w : plan.extent.h
		const crossAt = blockAt(extentCross)

		translate(plan, vertical ? crossAt : cursor, vertical ? cursor : crossAt, boxes)

		if (plan.extent.w > 0 && plan.extent.h > 0) cursor += extentMain + gap
	}

	const extent = vertical ? { w: cross, h: main } : { w: main, h: cross }

	for (const child of rest) boxes.set(child, { x: 0, y: 0, w: 0, h: 0 })

	boxes.set(node, { x: 0, y: 0, ...extent })

	return { boxes, extent }
}

function planChildren(node: LayoutNode, context: LayoutContext, depth: number): Plan {
	const items = node.children.filter(child => !isConnector(child))
	const plans = items.map(child => planNode(child, context, depth + 1))
	// The parent's shape decides a hanging branch.
	const branch = variable(node, "hierBranch", "std")
	const hanging = branch === "l" || branch === "r" || branch === "hang"
	const dir = param(node, "linDir", "fromL")
	const vertical = hanging || dir === "fromT" || dir === "fromB"
	const reverse = !hanging && (dir === "fromR" || dir === "fromB")
	const gap = ownValue(node, "sibSp") ?? 0
	const secondGap = ownValue(node, "secSibSp") ?? gap
	const align = param(node, "chAlign", vertical ? "l" : "t")
	const boxes = new Map<LayoutNode, Box>()
	let extent: Extent

	if (branch === "hang" && plans.length > 1) {
		// Two columns, alternating, either side of the stem.
		const columns: Plan[][] = [[], []]

		plans.forEach((plan, i) => (columns[i % 2] as Plan[]).push(plan))

		const widths = columns.map(column => column.reduce((max, plan) => Math.max(max, plan.extent.w), 0))
		const heights = columns.map(column => column.reduce((sum, plan) => sum + plan.extent.h, 0) + Math.max(0, column.length - 1) * gap)
		const left = widths[0] as number

		columns.forEach((column, c) => {
			let y = 0

			for (const plan of column) {
				const x = c === 0 ? left - plan.extent.w : left + secondGap

				translate(plan, x, y, boxes)
				y += plan.extent.h + gap
			}
		})

		extent = { w: left + secondGap + (widths[1] as number), h: Math.max(heights[0] as number, heights[1] as number) }
	} else {
		let main = 0
		let cross = 0

		plans.forEach((plan, i) => {
			main += (vertical ? plan.extent.h : plan.extent.w) + (i > 0 ? gap : 0)
			cross = Math.max(cross, vertical ? plan.extent.w : plan.extent.h)
		})

		let cursor = reverse ? main : 0

		for (const plan of plans) {
			const extentMain = vertical ? plan.extent.h : plan.extent.w
			const extentCross = vertical ? plan.extent.w : plan.extent.h
			const crossAt = align === "ctr" ? (cross - extentCross) / 2 : align === "b" || align === "r" ? cross - extentCross : 0
			const start = reverse ? cursor - extentMain : cursor

			translate(plan, vertical ? crossAt : start, vertical ? start : crossAt, boxes)
			cursor += reverse ? -(extentMain + gap) : extentMain + gap
		}

		extent = vertical ? { w: cross, h: main } : { w: main, h: cross }
	}

	for (const child of node.children) if (isConnector(child)) boxes.set(child, { x: 0, y: 0, w: 0, h: 0 })

	boxes.set(node, { x: 0, y: 0, ...extent })

	return { boxes, extent }
}

function outermost(node: LayoutNode): boolean {
	for (let at = node.parent; at !== undefined; at = at.parent) if (isHier(at)) return false

	return true
}

function applyPlanned(node: LayoutNode): boolean {
	let any = false

	for (const child of node.children) {
		const box = planned.get(child)

		if (box === undefined) continue

		child.box = { ...box }
		// The planned (fitted) size is the child's size from now on: its own children's constraints on it read it.
		child.values.set("w", box.w)
		child.values.set("h", box.h)
		any = true
	}

	return any
}

function layoutTree(node: LayoutNode, context: LayoutContext): void {
	const box = { ...node.box }
	const plan = planNode(node, context, 0)
	const { w, h } = plan.extent
	const scale = Math.min(1, w > 0 ? box.w / w : 1, h > 0 ? box.h / h : 1)
	const ox = box.x + (box.w - w * scale) / 2
	const oy = box.y + (box.h - h * scale) / 2

	for (const [at, b] of plan.boxes) {
		if (at === node) continue

		const placed: Box = { x: ox + b.x * scale, y: oy + b.y * scale, w: b.w * scale, h: b.h * scale }

		planned.set(at, placed)
		at.box = { ...placed }
	}

	// The plan resolved the constraints of every node below against nominal extents: the node's own children are
	// resolved again for the interpreter as it goes on.
	node.box = box
	context.constrain(node, box.w, box.h)
	applyPlanned(node)
}

export function hierRootLayout(node: LayoutNode, context: LayoutContext): void {
	if (outermost(node) || !applyPlanned(node)) layoutTree(node, context)
}

export function hierChildLayout(node: LayoutNode, context: LayoutContext): void {
	if (outermost(node) || !applyPlanned(node)) layoutTree(node, context)
}

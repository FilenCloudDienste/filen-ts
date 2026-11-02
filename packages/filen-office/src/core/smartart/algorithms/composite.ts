import type { Box, LayoutContext, LayoutNode } from "../interp"
import { pyraSlot } from "./pyra"
import { param } from "./shared"

// One axis of a composite child: the extent from w, or from both edges; the start from the near edge,
// the centre or the far edge, in that order, each moved by its offset constraint.
function axis(values: ReadonlyMap<string, number>, keys: readonly [string, string, string, string], full: number): [number, number] {
	const [near, center, far, size] = keys
	const nearValue = values.get(near)
	const farValue = values.get(far)
	const centerValue = values.get(center)
	const own = values.get(size)
	let extent = own !== undefined && Number.isFinite(own) ? own : undefined

	if (extent === undefined) {
		if (nearValue !== undefined && farValue !== undefined) extent = farValue - nearValue
		else extent = full
	}

	extent += values.get(`${size}Off`) ?? 0

	let start: number

	if (nearValue !== undefined) {
		start = nearValue + (values.get(`${near}Off`) ?? 0)

		if (farValue !== undefined && own === undefined) extent = farValue + (values.get(`${far}Off`) ?? 0) - start
	} else if (centerValue !== undefined) {
		start = centerValue + (values.get(`${center}Off`) ?? 0) - extent / 2
	} else if (farValue !== undefined) {
		start = farValue + (values.get(`${far}Off`) ?? 0) - extent
	} else {
		start = 0
	}

	return [start, extent]
}

function growsDown(child: LayoutNode): boolean {
	return child.rules.some(rule => rule.type === "h" && rule.forName === "" && rule.val === Number.POSITIVE_INFINITY)
}

// The composite algorithm (L.4.15.6.1.1): every child at the size and position its constraints give,
// relative to the node's box. A rule letting a child's height grow without bound (h INF) lets the
// lowest such child take the height left below it, as PowerPoint's cached hList1 drawings show.
export function compositeLayout(node: LayoutNode, context: LayoutContext): void {
	const ratio = Number(param(node, "ar", "0"))

	// ar (§21.4.7.4 width over height): the node takes the largest box of that shape centred in the one it was
	// given, and its children are laid out in it (venn2's circles are square in PowerPoint's caches whatever the
	// frame).
	if (ratio > 0 && Number.isFinite(ratio) && node.box.w > 0 && node.box.h > 0 && Math.abs(node.box.w / node.box.h - ratio) > 1e-9) {
		const { x, y, w, h } = node.box
		const fitted =
			w / h > ratio ? { x: x + (w - h * ratio) / 2, y, w: h * ratio, h } : { x, y: y + (h - w / ratio) / 2, w, h: w / ratio }

		node.box = fitted
		context.constrain(node, fitted.w, fitted.h)
	}

	const box = node.box
	let lowest: LayoutNode | undefined

	for (const child of node.children) {
		const [x, w] = axis(child.values, ["l", "ctrX", "r", "w"], box.w)
		const [y, h] = axis(child.values, ["t", "ctrY", "b", "h"], box.h)

		child.box = { x: box.x + x, y: box.y + y, w: Math.max(0, w), h: Math.max(0, h) }

		if (growsDown(child) && child.values.has("t") && !child.values.has("b") && (lowest === undefined || child.box.y > lowest.box.y))
			lowest = child
	}

	if (lowest !== undefined && lowest.box.y + lowest.box.h < box.y + box.h) lowest.box.h = box.y + box.h - lowest.box.y

	for (const child of node.children) fitLineAcross(child, context)

	placeFromSiblings(node)

	const slot = pyraSlot(node)

	if (slot !== undefined) placeSlot(node, slot.boxes)
	else keepInside(node)
}

// A line positioned by its centre across its direction is as deep as its content there (hProcess3's row of columns
// over its arrow: its constraint height is the diagram's, but PowerPoint's cache centres the 2-font-size-high
// content on the diagram's middle and starts the row at its top).
function fitLineAcross(child: LayoutNode, context: LayoutContext): void {
	if (child.alg.type !== "lin" || child.children.length === 0) return

	const dir = param(child, "linDir", "fromL")
	const vertical = dir === "fromT" || dir === "fromB"
	const centre = child.values.get(vertical ? "ctrX" : "ctrY")

	if (centre === undefined) return

	const box = child.box

	// The deepest of the line's children that has a size of its own across it (a child without one, a column of
	// its own, takes the line's).
	context.constrain(child, box.w, box.h)

	let across = 0

	for (const grand of child.children) {
		const size = grand.values.get(vertical ? "w" : "h")

		if (size !== undefined && Number.isFinite(size) && size > across) across = size
	}

	if (!(across > 0) || across >= (vertical ? box.w : box.h)) return

	child.box = vertical
		? { x: box.x + (box.w - across) / 2, y: box.y, w: across, h: box.h }
		: { x: box.x, y: box.y + (box.h - across) / 2, w: box.w, h: across }
}

// Children whose constraints carry them past the node's box on an axis, as a whole no larger than the box, are
// centred in it on that axis (or aligned as the composite's horzAlign/vertAlign say) (venn1's circles, positioned from the box's centre, stand clear of its top in
// PowerPoint's caches by the same margin as of its bottom).
function keepInside(node: LayoutNode): void {
	const box = node.box
	let x0 = Infinity
	let y0 = Infinity
	let x1 = -Infinity
	let y1 = -Infinity

	for (const child of node.children) {
		const b = child.box

		if (!(b.w > 0 && b.h > 0)) continue

		x0 = Math.min(x0, b.x)
		y0 = Math.min(y0, b.y)
		x1 = Math.max(x1, b.x + b.w)
		y1 = Math.max(y1, b.y + b.h)
	}

	if (!(x1 > x0 && y1 > y0)) return

	const slack = 1
	// A composite that names its alignment (horzAlign, vertAlign) aligns its children as a group within its box:
	// chart3's exploded wedge leaves the pie's bounds off the square, and PowerPoint's cache centres those bounds.
	const aligned = (name: string, near: string, far: string, start: number, extent: number, from: number, to: number): number => {
		const value = node.alg.params.get(name)

		if (value === undefined || to - from > extent) return Number.NaN

		return value === near ? start - from : value === far ? start + extent - to : start + (extent - (to - from)) / 2 - from
	}
	const alignX = aligned("horzAlign", "l", "r", box.x, box.w, x0, x1)
	const alignY = aligned("vertAlign", "t", "b", box.y, box.h, y0, y1)
	const dx = Number.isFinite(alignX)
		? alignX
		: (x0 < box.x - slack || x1 > box.x + box.w + slack) && x1 - x0 <= box.w
			? box.x + (box.w - (x1 - x0)) / 2 - x0
			: 0
	const dy = Number.isFinite(alignY)
		? alignY
		: (y0 < box.y - slack || y1 > box.y + box.h + slack) && y1 - y0 <= box.h
			? box.y + (box.h - (y1 - y0)) / 2 - y0
			: 0

	if (dx === 0 && dy === 0) return

	for (const child of node.children) child.box = { ...child.box, x: child.box.x + dx, y: child.box.y + dy }
}

// A value of a placed box relative to its parent's origin.
function geometry(box: Box, parent: Box, type: string): number | undefined {
	switch (type) {
		case "l":
			return box.x - parent.x
		case "t":
			return box.y - parent.y
		case "r":
			return box.x + box.w - parent.x
		case "b":
			return box.y + box.h - parent.y
		case "w":
			return box.w
		case "h":
			return box.h
		case "ctrX":
			return box.x + box.w / 2 - parent.x
		case "ctrY":
			return box.y + box.h / 2 - parent.y
		default:
			return undefined
	}
}

// Constraints on a sibling's position that resolution could not answer (the sibling's position was left to the
// algorithm: an unplaced child starts at the top left) are taken from where the sibling was placed, in constrLst
// order: venn2's inner circles are centred on the outer one and share its bottom.
function placeFromSiblings(node: LayoutNode): void {
	const box = node.box
	const byName = new Map<string, LayoutNode>()

	for (const child of node.children) if (!byName.has(child.name)) byName.set(child.name, child)

	const moved = new Set<LayoutNode>()

	for (const constraint of node.constraints) {
		if (constraint.for !== "ch" || constraint.refFor !== "ch" || constraint.refForName === "" || constraint.op !== "none") continue

		const ref = byName.get(constraint.refForName)

		if (ref === undefined) continue

		for (const child of node.children) {
			if (child === ref || (constraint.forName !== "" && child.name !== constraint.forName)) continue
			if (child.values.has(constraint.type) && !moved.has(child)) continue

			const value = geometry(ref.box, box, constraint.refType)

			if (value === undefined || geometry(child.box, box, constraint.type) === undefined) continue

			child.values.set(constraint.type, value * (Number.isFinite(constraint.fact) ? constraint.fact : 1))
			moved.add(child)

			const [x, w] = axis(child.values, ["l", "ctrX", "r", "w"], box.w)
			const [y, h] = axis(child.values, ["t", "ctrY", "b", "h"], box.h)

			child.box = { x: box.x + x, y: box.y + y, w: Math.max(0, w), h: Math.max(0, h) }
		}
	}
}

// A pyramid level: its named nodes take the pyramid's boxes, and its other children's constraints on them are
// taken again from those boxes (pyramid1's level text is centred on its level and 0.65 of its width).
function placeSlot(node: LayoutNode, boxes: ReadonlyMap<string, Box>): void {
	const box = node.box

	for (const child of node.children) {
		const given = boxes.get(child.name)

		if (given !== undefined) child.box = { ...given }
	}

	for (const child of node.children) {
		if (boxes.has(child.name)) continue

		let moved = false

		for (const constraint of node.constraints) {
			if (constraint.for !== "ch" || constraint.forName !== child.name || constraint.refFor !== "ch") continue

			const ref = boxes.get(constraint.refForName)
			const value = ref === undefined ? undefined : geometry(ref, box, constraint.refType)

			if (value === undefined || geometry(ref as Box, box, constraint.type) === undefined) continue

			child.values.set(constraint.type, value * (Number.isFinite(constraint.fact) ? constraint.fact : 1))
			moved = true
		}

		if (!moved) continue

		const [x, w] = axis(child.values, ["l", "ctrX", "r", "w"], box.w)
		const [y, h] = axis(child.values, ["t", "ctrY", "b", "h"], box.h)

		child.box = { x: box.x + x, y: box.y + y, w: Math.max(0, w), h: Math.max(0, h) }
	}
}

import type { LayoutContext, LayoutNode } from "../interp"

// One axis of a composite child: the extent from w, or from both edges; the start from the near edge,
// the centre or the far edge, in that order, each moved by its offset constraint.
function axis(values: ReadonlyMap<string, number>, keys: readonly [string, string, string, string], full: number): [number, number] {
	const [near, center, far, size] = keys
	const nearValue = values.get(near)
	const farValue = values.get(far)
	const centerValue = values.get(center)
	let extent = values.get(size)

	if (extent === undefined) {
		if (nearValue !== undefined && farValue !== undefined) extent = farValue - nearValue
		else extent = full
	}

	extent += values.get(`${size}Off`) ?? 0

	let start: number

	if (nearValue !== undefined) {
		start = nearValue + (values.get(`${near}Off`) ?? 0)

		if (farValue !== undefined && !values.has(size)) extent = farValue + (values.get(`${far}Off`) ?? 0) - start
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
export function compositeLayout(node: LayoutNode, _context: LayoutContext): void {
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
}

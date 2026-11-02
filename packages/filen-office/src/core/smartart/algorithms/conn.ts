import type { DataPoint } from "../data"
import type { Box, LayoutContext, LayoutNode } from "../interp"
import { originalShape, param, reshape, sizeOf } from "./shared"

// The connector algorithm (ECMA-376 L.4.15.6.1.1 conn, §21.4.7.13 ST_ConnectorPoint, §21.4.7.14
// ST_ConnectorRouting, §21.4.7.10 ST_ArrowheadStyle, §21.4.7.15 ST_ConnectorDimension): a transition drawn between
// the two layout nodes it connects. The ends are its data point's: a parent transition joins its parent's node to
// its child's, a sibling transition the node before it to the node after it (srcNode/dstNode name them instead).
// Of the begPts and endPts candidates the nearest pair that leaves each node outwards is taken; the begPad and
// endPad constraints move the ends along the connector (connDist, the distance between the two points, is what
// they and the children's constraints may refer to).
//
// A two-dimensional connector (dim 2D, the default) is an arrow shape spanning the padded points, as high as its
// h constraint, turned to the line between them; a one-dimensional one is a line routed straight, bent at the
// middle (bend) or curved through it (curve, longCurve), its box the route's extent, at least 0.1 in deep
// (PowerPoint's caches). The connector's children (its text) sit at the middle of the route.

export interface Point {
	readonly x: number
	readonly y: number
}

export interface ConnectorRoute {
	readonly dim: "1D" | "2D"
	readonly routing: "stra" | "bend" | "curve" | "longCurve"
	// Absolute, in EMU: the padded begin point, the bends, the padded end point.
	readonly points: readonly Point[]
	readonly begArrow: boolean
	readonly endArrow: boolean
}

// The least extent of a one-dimensional connector's box (0.1 in).
export const MIN_CONNECTOR_EXTENT = 91440

const routes = new WeakMap<LayoutNode, ConnectorRoute>()

// The route the conn algorithm gave `node` the last time it was laid out.
export function connectorRoute(node: LayoutNode): ConnectorRoute | undefined {
	return routes.get(node)
}

export function isConnector(node: LayoutNode): boolean {
	return node.alg.type === "conn" || originalShape(node)?.type === "conn"
}

// Whether a layout node draws: a geometry, text, or children of its own.
function draws(node: LayoutNode): boolean {
	const shape = node.shape

	return (
		(shape !== undefined && shape.type !== "none" && shape.type !== "conn" && !shape.hideGeom) ||
		node.text.length > 0 ||
		node.children.length > 0
	)
}

function isNode(point: DataPoint): boolean {
	return point.type === "node" || point.type === "asst"
}

// The data points a transition joins.
function joined(point: DataPoint): [DataPoint | undefined, DataPoint | undefined] {
	const parent = point.parent

	if (parent === undefined) return [undefined, undefined]

	const list = parent.children
	const at = list.indexOf(point)

	if (point.type === "parTrans") return [parent, list.slice(at + 1).find(isNode)]

	if (point.type === "sibTrans") {
		let before: DataPoint | undefined

		for (let i = at - 1; i >= 0 && before === undefined; i--) if (isNode(list[i] as DataPoint)) before = list[i]

		// The last node's sibling transition, kept by a cycle (forEach hideLastTrans="0"), closes the cycle on the first.
		return [before, list.slice(at + 1).find(isNode) ?? list.find(isNode)]
	}

	return [undefined, undefined]
}

// Breadth-first visits per scope, so a hostile tree cannot make one connector search without bound.
const MAX_SEARCH = 100_000

// The shallowest layout node of `point` under the connector's parent, else under each ancestor in turn, that draws
// a shape or text of its own; else the shallowest that holds drawn children (an org chart's line joins the boxes,
// not the subtrees holding them).
function nodeOf(connector: LayoutNode, point: DataPoint): LayoutNode | undefined {
	let container: LayoutNode | undefined
	let searched = 0

	for (let scope = connector.parent; scope !== undefined; scope = scope.parent) {
		const queue: LayoutNode[] = [...scope.children]

		for (let i = 0; i < queue.length && searched < MAX_SEARCH; i++, searched++) {
			const at = queue[i] as LayoutNode

			if (at === connector) continue

			if (!isConnector(at) && at.point === point) {
				if (drawsItself(at)) return at
				if (container === undefined && draws(at)) container = at
			}

			for (const child of at.children) queue.push(child)
		}
	}

	// The org chart's line from a manager whose staff hangs in a column: the manager's box sits outside the column's
	// own subtree (the container holding the staff carries the manager's point but draws nothing itself).
	return container
}

function drawsItself(node: LayoutNode): boolean {
	const shape = node.shape

	return (
		(shape !== undefined && shape.type !== "none" && shape.type !== "conn" && !shape.hideGeom) ||
		(node.text.length > 0 && node.alg.type === "tx")
	)
}

function sibling(connector: LayoutNode, name: string, after: boolean, deep = true): LayoutNode | undefined {
	const list = connector.parent?.children ?? []
	const at = list.indexOf(connector)
	const range = after ? list.slice(at + 1) : list.slice(0, Math.max(0, at)).reverse()

	for (const node of range) {
		if (isConnector(node)) continue
		if (name === "" || node.name === name) return node

		// A named end inside the nearest sibling that holds one (process3's arrow joins the parTx of the composites
		// either side of it).
		const inside = name === "" || !deep ? undefined : descendantNamed(node, name)

		if (inside !== undefined) return inside
	}

	return undefined
}

function descendantNamed(root: LayoutNode, name: string): LayoutNode | undefined {
	const queue = [...root.children]

	for (let i = 0; i < queue.length && i < MAX_SEARCH; i++) {
		const at = queue[i] as LayoutNode

		if (at.name === name && !isConnector(at)) return at

		for (const child of at.children) queue.push(child)
	}

	return undefined
}

// The layout node named `name` that presents `point`, nearest the connector first (its own scope, then each
// ancestor's).
function namedOf(connector: LayoutNode, point: DataPoint, name: string): LayoutNode | undefined {
	let searched = 0

	for (let scope = connector.parent; scope !== undefined; scope = scope.parent) {
		const queue: LayoutNode[] = [...scope.children]

		for (let i = 0; i < queue.length && searched < MAX_SEARCH; i++, searched++) {
			const at = queue[i] as LayoutNode

			if (at !== connector && at.name === name && at.point === point) return at

			for (const child of at.children) queue.push(child)
		}
	}

	return undefined
}

function ends(node: LayoutNode): [LayoutNode | undefined, LayoutNode | undefined] {
	const srcName = param(node, "srcNode", "")
	const dstName = param(node, "dstNode", "")

	if (srcName !== "" || dstName !== "") {
		// A transition's named end is the one of the point it joins (orgChart1's hanging staff line starts at their
		// manager's rootConnector, not at the nearest node of that name, which is a staff member's own).
		const [from, to] = joined(node.point)
		// In order: the named node of the joined point; a sibling of that name (gear1's srcNode/dstNode sit beside their
		// connector); the joined point's own box (an assistant's connector is named rootConnector3); a named node inside
		// a neighbouring sibling (process3).
		const end = (name: string, point: DataPoint | undefined, after: boolean): LayoutNode | undefined => {
			if (name === "") return (point === undefined ? undefined : nodeOf(node, point)) ?? sibling(node, "", after)

			return (
				(point === undefined ? undefined : namedOf(node, point, name)) ??
				sibling(node, name, after, false) ??
				sibling(node, name, !after, false) ??
				(point === undefined ? undefined : nodeOf(node, point)) ??
				sibling(node, name, after) ??
				sibling(node, name, !after)
			)
		}

		return [end(srcName, from, false), end(dstName, to, true)]
	}

	const [from, to] = joined(node.point)
	const src = from === undefined ? undefined : nodeOf(node, from)
	const dst = to === undefined ? undefined : nodeOf(node, to)

	return [src ?? sibling(node, "", false), dst ?? sibling(node, "", true)]
}

const NORMALS: Readonly<Record<string, Point>> = {
	midL: { x: -1, y: 0 },
	midR: { x: 1, y: 0 },
	tCtr: { x: 0, y: -1 },
	bCtr: { x: 0, y: 1 },
	tL: { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
	tR: { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
	bL: { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
	bR: { x: Math.SQRT1_2, y: Math.SQRT1_2 }
}

interface Candidate {
	readonly at: Point
	// Outwards from the node; undefined: any direction (the centre, or the boundary towards the other node).
	readonly normal: Point | undefined
}

function centre(box: Box): Point {
	return { x: box.x + box.w / 2, y: box.y + box.h / 2 }
}

// Where the ray from the centre of `box` towards `toward` leaves it (an ellipse leaves at its outline).
export function boundary(box: Box, toward: Point, round: boolean): Point {
	const c = centre(box)
	const dx = toward.x - c.x
	const dy = toward.y - c.y
	const a = box.w / 2
	const b = box.h / 2

	if ((dx === 0 && dy === 0) || a <= 0 || b <= 0) return c

	const t = round
		? 1 / Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (b * b))
		: Math.min(dx === 0 ? Infinity : a / Math.abs(dx), dy === 0 ? Infinity : b / Math.abs(dy))

	return { x: c.x + dx * t, y: c.y + dy * t }
}

export function isRound(node: LayoutNode): boolean {
	const type = node.shape?.type

	return type === "ellipse" || type === "donut" || type === "pie" || type === "blockArc" || type === "chord"
}

function point(name: string, box: Box): Point | undefined {
	switch (name) {
		case "ctr":
			return centre(box)
		case "midL":
			return { x: box.x, y: box.y + box.h / 2 }
		case "midR":
			return { x: box.x + box.w, y: box.y + box.h / 2 }
		case "tCtr":
			return { x: box.x + box.w / 2, y: box.y }
		case "bCtr":
			return { x: box.x + box.w / 2, y: box.y + box.h }
		case "tL":
			return { x: box.x, y: box.y }
		case "tR":
			return { x: box.x + box.w, y: box.y }
		case "bL":
			return { x: box.x, y: box.y + box.h }
		case "bR":
			return { x: box.x + box.w, y: box.y + box.h }
		default:
			return undefined
	}
}

function candidates(names: readonly string[], node: LayoutNode, other: LayoutNode): Candidate[] {
	const out: Candidate[] = []
	// auto and radial (and anything unknown): where the line between the centres leaves the node.
	const auto: Candidate = { at: boundary(node.box, centre(other.box), isRound(node)), normal: undefined }

	for (const name of names) {
		const at = point(name, node.box)

		out.push(at === undefined ? auto : { at, normal: NORMALS[name] })
	}

	return out.length > 0 ? out : [auto]
}

function list(text: string): string[] {
	return text
		.trim()
		.split(/\s+/u)
		.filter(item => item !== "")
}

// The nearest begin/end pair whose ends both leave their node outwards; the nearest of all when none does.
function choose(begs: readonly Candidate[], endsList: readonly Candidate[]): [Candidate, Candidate] {
	let best: [Candidate, Candidate] | undefined
	let bestDistance = Infinity
	let fallback: [Candidate, Candidate] = [begs[0] as Candidate, endsList[0] as Candidate]
	let fallbackDistance = Infinity

	for (const beg of begs) {
		for (const end of endsList) {
			const dx = end.at.x - beg.at.x
			const dy = end.at.y - beg.at.y
			const distance = Math.hypot(dx, dy)
			const out = beg.normal === undefined || beg.normal.x * dx + beg.normal.y * dy > 1e-6
			const into = end.normal === undefined || end.normal.x * -dx + end.normal.y * -dy > 1e-6

			if (distance < fallbackDistance) {
				fallbackDistance = distance
				fallback = [beg, end]
			}

			if (out && into && distance < bestDistance) {
				bestDistance = distance
				best = [beg, end]
			}
		}
	}

	return best ?? fallback
}

function along(at: Point, direction: Point, distance: number): Point {
	return { x: at.x + direction.x * distance, y: at.y + direction.y * distance }
}

function unit(from: Point, to: Point): Point {
	const length = Math.hypot(to.x - from.x, to.y - from.y)

	return length > 0 ? { x: (to.x - from.x) / length, y: (to.y - from.y) / length } : { x: 1, y: 0 }
}

// The connector's self constraints that read connDist (begPad, endPad, a size), which only it knows.
function resolveOwn(node: LayoutNode, connDist: number): void {
	node.values.set("connDist", connDist)

	for (const constraint of node.constraints) {
		if (constraint.for !== "self" || constraint.refType !== "connDist" || constraint.refFor !== "self") continue
		if (!Number.isFinite(constraint.fact)) continue

		node.values.set(constraint.type, connDist * constraint.fact)
	}
}

function arrowShape(beg: boolean, end: boolean): string {
	return beg && end ? "leftRightArrow" : beg ? "leftArrow" : end ? "rightArrow" : "rect"
}

function arrowhead(node: LayoutNode, name: string, fallback: string): boolean {
	const style = param(node, name, fallback)

	return style === "arr" || (style === "auto" && name === "endSty")
}

function bbox(points: readonly Point[], min: number): Box {
	let x0 = Infinity
	let y0 = Infinity
	let x1 = -Infinity
	let y1 = -Infinity

	for (const p of points) {
		x0 = Math.min(x0, p.x)
		y0 = Math.min(y0, p.y)
		x1 = Math.max(x1, p.x)
		y1 = Math.max(y1, p.y)
	}

	const w = x1 - x0
	const h = y1 - y0

	return {
		x: w < min ? (x0 + x1) / 2 - min / 2 : x0,
		y: h < min ? (y0 + y1) / 2 - min / 2 : y0,
		w: Math.max(w, min),
		h: Math.max(h, min)
	}
}

// The middle of a route, by length.
function midpoint(points: readonly Point[]): Point {
	let total = 0

	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1] as Point
		const b = points[i] as Point

		total += Math.hypot(b.x - a.x, b.y - a.y)
	}

	let left = total / 2

	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1] as Point
		const b = points[i] as Point
		const length = Math.hypot(b.x - a.x, b.y - a.y)

		if (length >= left && length > 0) return { x: a.x + ((b.x - a.x) * left) / length, y: a.y + ((b.y - a.y) * left) / length }

		left -= length
	}

	return points[0] ?? { x: 0, y: 0 }
}

function hide(node: LayoutNode): void {
	const at = node.box

	routes.delete(node)
	node.box = { x: at.x, y: at.y, w: 0, h: 0 }

	for (const child of node.children) child.box = { x: at.x, y: at.y, w: 0, h: 0 }
}

// ST_Angle units per radian (60000ths of a degree).
const ANGLE = (180 * 60000) / Math.PI
const TURN = 21600000

// An angle as a layout adjustment: degrees, as dgm:adj gives a rotation handle's (MS-OI29500 §2.1.1615(b)), within one
// turn and to the 60000th of a degree the guide holds.
function angle(radians: number): number {
	return (((Math.round(radians * ANGLE) % TURN) + TURN) % TURN) / 60000
}

// A curved two-dimensional connector with a diameter (diam, §21.4.7.17 ST_ConstraintType), as PowerPoint caches
// gear1's: a circular arrow on the circle of that diameter through both ends, clockwise for a positive diam
// (circularArrow) and anticlockwise for a negative one (leftCircularArrow), along the shorter arc; its tail on the
// begin point and its head's tip on the end point. The connector's h is the arrow's width: the band is 0.6 h, the
// head 1.4 h across and h / 2 long (as a chord), so the shape's box is the circle grown by 0.65 h all round. The
// pads shorten the arc at either end.
function circularArrow(node: LayoutNode, from: Point, to: Point, diam: number, begPad: number, endPad: number): void {
	const clockwise = diam > 0
	const chord = Math.hypot(to.x - from.x, to.y - from.y)
	const r = Math.max(Math.abs(diam) / 2, chord / 2)
	const own = node.values.get("h")
	const h = own !== undefined && Number.isFinite(own) && own > 0 ? own : r / 5
	// The centre on the side of the chord that makes the arc from `from` to `to` in the arrow's direction the shorter.
	const off = Math.sqrt(Math.max(0, r * r - (chord * chord) / 4))
	const nx = chord > 0 ? -(to.y - from.y) / chord : 0
	const ny = chord > 0 ? (to.x - from.x) / chord : 0
	const side = clockwise ? 1 : -1
	const cx = (from.x + to.x) / 2 + side * off * nx
	const cy = (from.y + to.y) / 2 + side * off * ny
	const head = 2 * Math.asin(Math.min(1, h / 2 / (2 * r)))
	const direction = clockwise ? 1 : -1
	const start = Math.atan2(from.y - cy, from.x - cx) + (direction * begPad) / r
	const tip = Math.atan2(to.y - cy, to.x - cx) - (direction * endPad) / r
	const size = 2 * r + 1.3 * h

	node.box = { x: cx - size / 2, y: cy - size / 2, w: size, h: size }
	reshape(node, {
		type: clockwise ? "circularArrow" : "leftCircularArrow",
		rot: 0,
		adj: [
			{ idx: 1, val: Math.round(((0.6 * h) / size) * 100000) / 100000 },
			{ idx: 2, val: angle(head) },
			{ idx: 3, val: angle(tip - direction * head) },
			{ idx: 4, val: angle(start) },
			{ idx: 5, val: Math.round(((0.7 * h) / size) * 100000) / 100000 }
		]
	})
}

export function connLayout(node: LayoutNode, context: LayoutContext): void {
	const [src, dst] = ends(node)

	if (src === undefined || dst === undefined || src === dst) {
		hide(node)

		return
	}

	const [beg, end] = choose(
		candidates(list(param(node, "begPts", "auto")), src, dst),
		candidates(list(param(node, "endPts", "auto")), dst, src)
	)

	resolveOwn(node, Math.hypot(end.at.x - beg.at.x, end.at.y - beg.at.y))

	const begPad = node.values.get("begPad") ?? 0
	const endPad = node.values.get("endPad") ?? 0
	const dim = param(node, "dim", "2D") === "1D" ? "1D" : "2D"
	const rout = param(node, "connRout", "stra")
	const routing = rout === "bend" || rout === "curve" || rout === "longCurve" ? rout : "stra"
	const begArrow = arrowhead(node, "begSty", "noArr")
	const endArrow = arrowhead(node, "endSty", "arr")
	const line = unit(beg.at, end.at)
	let points: Point[]

	if (dim === "2D" || routing === "stra") {
		points = [along(beg.at, line, begPad), along(end.at, line, -endPad)]
	} else {
		// A bent or curved line leaves each node along its side's normal and turns at the middle.
		const p0 = along(beg.at, beg.normal ?? line, begPad)
		const p1 = along(end.at, end.normal === undefined ? line : { x: -end.normal.x, y: -end.normal.y }, -endPad)
		const horizontal =
			beg.normal === undefined ? Math.abs(line.x) >= Math.abs(line.y) : Math.abs(beg.normal.x) >= Math.abs(beg.normal.y)
		const endHorizontal = end.normal === undefined ? horizontal : Math.abs(end.normal.x) >= Math.abs(end.normal.y)
		const mx = (p0.x + p1.x) / 2
		const my = (p0.y + p1.y) / 2

		// Ends leaving on crossing axes meet at one corner (an org chart's hanging staff line drops from the manager's
		// bottom and turns into the side of each staff box); ends on the same axis turn twice, at the middle.
		points =
			horizontal !== endHorizontal
				? horizontal
					? [p0, { x: p1.x, y: p0.y }, p1]
					: [p0, { x: p0.x, y: p1.y }, p1]
				: horizontal
					? [p0, { x: mx, y: p0.y }, { x: mx, y: p1.y }, p1]
					: [p0, { x: p0.x, y: my }, { x: p1.x, y: my }, p1]
	}

	routes.set(node, { dim, routing, points, begArrow, endArrow })

	const shape = originalShape(node)
	const chosen = shape === undefined || shape.type === "conn"
	const diam = node.values.get("diam")

	if (dim === "2D" && routing !== "stra" && routing !== "bend" && chosen && diam !== undefined && Number.isFinite(diam) && diam !== 0) {
		circularArrow(node, beg.at, end.at, diam, begPad, endPad)
	} else if (dim === "2D") {
		const p0 = points[0] as Point
		const p1 = points[1] as Point
		const length = Math.hypot(p1.x - p0.x, p1.y - p0.y)
		const own = node.values.get("h")
		const height = own !== undefined && Number.isFinite(own) ? own : length / 2
		const angle = (Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI
		const rot = ((angle % 360) + 360) % 360
		const c = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }
		const quarter = Math.abs(Math.round(rot / 90)) % 2 === 1 && Math.abs(rot % 90) < 1e-6

		// A quarter-turned shape's box is its turned footprint (the interpreter swaps the sides back).
		node.box = quarter
			? { x: c.x - height / 2, y: c.y - length / 2, w: height, h: length }
			: { x: c.x - length / 2, y: c.y - height / 2, w: length, h: height }
		reshape(node, { ...(chosen ? { type: arrowShape(begArrow, endArrow) } : {}), rot: (shape?.rot ?? 0) + rot })
	} else {
		node.box = bbox(points, MIN_CONNECTOR_EXTENT)
		reshape(node, chosen ? { type: "line" } : {})
	}

	// The children (the transition's text) sit at the middle of the route, at their constraint sizes.
	context.constrain(node, node.box.w, node.box.h)

	const middle = midpoint(points)

	for (const child of node.children) {
		const size = sizeOf(child, node)

		child.box = { x: middle.x - size.w / 2, y: middle.y - size.h / 2, w: size.w, h: size.h }
	}
}

// Routes every connector of the tree again from where its ends finally are: the user's custom offsets move nodes
// after the algorithms ran, and PowerPoint's connectors follow them (bProcess3's caches).
export function rerouteConnectors(root: LayoutNode, context: LayoutContext): void {
	const stack = [root]

	for (let visited = 0; stack.length > 0 && visited <= context.budgets.maxLayoutNodes; visited++) {
		const node = stack.pop() as LayoutNode

		if (node.alg.type === "conn") connLayout(node, context)

		for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i] as LayoutNode)
	}
}

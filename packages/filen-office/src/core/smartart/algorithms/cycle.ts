import type { Box, LayoutContext, LayoutNode } from "../interp"
import { isConnector } from "./conn"
import { originalShape, ownValue, param, reshape, sizeOf } from "./shared"

// The cycle algorithm (ECMA-376 L.4.15.6.1.1 cycle): the children around a circle, or an arc of it, at equal
// angles. stAng is where the first one goes (degrees clockwise from the top), spanAng how far the others reach: a
// full turn divides it by the count, an arc by the count less one, so both ends are taken. ctrShpMap fNode puts the
// first child in the centre; rotPath alongPath turns each child to its angle.
//
// The circle is the diam constraint when one is given. Otherwise it is the smallest radius at which every child on
// it keeps sp clear of the centre child, or, without one, sibSp clear of its neighbours, measured along the line
// between their centres (the extent a box shows in a direction): PowerPoint's radial caches put every node at the
// radius the furthest-reaching one needs. The whole drawing, at the children's constraint sizes, is then scaled down to fit the
// node's box and centred in it. Connectors are left to the conn algorithm.

interface Placed {
	readonly child: LayoutNode
	readonly w: number
	readonly h: number
	cx: number
	cy: number
}

const RADIANS = Math.PI / 180

function elliptic(node: LayoutNode): boolean {
	const type = node.shape?.type

	return type === "ellipse" || type === "donut" || type === "pie" || type === "blockArc" || type === "chord"
}

// How far a w × h shape centred at the origin reaches in the direction (ux, uy) (a unit vector).
function reach(w: number, h: number, ux: number, uy: number, round: boolean): number {
	if (round) return Math.hypot((w / 2) * ux, (h / 2) * uy)

	return (Math.abs(ux) * w) / 2 + (Math.abs(uy) * h) / 2
}

export function cycleLayout(node: LayoutNode, _context: LayoutContext): void {
	const box = node.box
	const flow = node.children.filter(child => !isConnector(child))
	const startAngle = Number(param(node, "stAng", "0")) || 0
	const span = Number(param(node, "spanAng", "360"))
	const spanAngle = Number.isFinite(span) ? span : 360
	const centred = param(node, "ctrShpMap", "none") === "fNode" && flow.length > 0
	const along = param(node, "rotPath", "none") === "alongPath"
	const centre = centred ? flow[0] : undefined
	const ring = centred ? flow.slice(1) : flow
	const n = ring.length
	const step = Math.abs(spanAngle) >= 360 ? spanAngle / Math.max(1, n) : n > 1 ? spanAngle / (n - 1) : 0
	const sp = ownValue(node, "sp") ?? 0
	const sibSp = ownValue(node, "sibSp") ?? 0
	const placed: Placed[] = []
	const centreSize = centre === undefined ? undefined : sizeOf(centre, node)

	if (centre !== undefined && centreSize !== undefined) placed.push({ child: centre, w: centreSize.w, h: centreSize.h, cx: 0, cy: 0 })

	const angles = ring.map((_, i) => startAngle + i * step)
	const sizes = ring.map(child => sizeOf(child, node))
	const diam = ownValue(node, "diam")
	let radius = 0

	// A diam the node's rule lets grow (cycle2's diam 150 mm with rule diam INF) is the least radius: the spacing
	// below still applies. Without such a rule the diameter is the circle.
	const growable = node.rules.some(rule => rule.type === "diam" && rule.for === "self" && rule.val === Number.POSITIVE_INFINITY)

	if (diam !== undefined && Number.isFinite(diam) && diam > 0 && !growable) {
		radius = diam / 2
	} else {
		if (diam !== undefined && Number.isFinite(diam) && diam > 0) radius = diam / 2

		for (let i = 0; i < n; i++) {
			const size = sizes[i] as { w: number; h: number }
			const a = (angles[i] as number) * RADIANS
			const ux = Math.sin(a)
			const uy = -Math.cos(a)
			const own = reach(size.w, size.h, ux, uy, elliptic(ring[i] as LayoutNode))

			if (centre !== undefined && centreSize !== undefined) {
				radius = Math.max(radius, reach(centreSize.w, centreSize.h, ux, uy, elliptic(centre)) + sp + own)
			}

			// Without a centre child, neighbours along the arc (and the last with the first on a full turn) keep sibSp
			// apart along the chord between them; around a centre child its clearance alone sets the radius
			// (radial4's caches put the ring nearer than sibSp would allow).
			const j = centre !== undefined ? -1 : i + 1 < n ? i + 1 : Math.abs(spanAngle) >= 360 && n > 2 ? 0 : -1

			if (j < 0 || j === i) continue

			const next = sizes[j] as { w: number; h: number }
			const b = (angles[j] as number) * RADIANS
			const dx = Math.sin(b) - ux
			const dy = -Math.cos(b) + -uy
			const chord = Math.hypot(dx, dy)

			if (chord <= 1e-9) continue

			const need =
				reach(size.w, size.h, dx / chord, dy / chord, elliptic(ring[i] as LayoutNode)) +
				reach(next.w, next.h, dx / chord, dy / chord, elliptic(ring[j] as LayoutNode)) +
				sibSp

			radius = Math.max(radius, need / chord)
		}
	}

	ring.forEach((child, i) => {
		const size = sizes[i] as { w: number; h: number }
		const a = (angles[i] as number) * RADIANS

		placed.push({ child, w: size.w, h: size.h, cx: radius * Math.sin(a), cy: -radius * Math.cos(a) })

		if (along && originalShape(child) !== undefined) reshape(child, { rot: (originalShape(child)?.rot ?? 0) + (angles[i] as number) })
	})

	let x0 = Infinity
	let y0 = Infinity
	let x1 = -Infinity
	let y1 = -Infinity

	for (const p of placed) {
		x0 = Math.min(x0, p.cx - p.w / 2)
		y0 = Math.min(y0, p.cy - p.h / 2)
		x1 = Math.max(x1, p.cx + p.w / 2)
		y1 = Math.max(y1, p.cy + p.h / 2)
	}

	const width = x1 - x0
	const height = y1 - y0
	const scale = placed.length === 0 ? 1 : Math.min(1, width > 0 ? box.w / width : 1, height > 0 ? box.h / height : 1)
	const ox = box.x + (box.w - width * scale) / 2 - x0 * scale
	const oy = box.y + (box.h - height * scale) / 2 - y0 * scale

	for (const p of placed) {
		const w = p.w * scale
		const h = p.h * scale
		const placedBox: Box = { x: ox + p.cx * scale - w / 2, y: oy + p.cy * scale - h / 2, w, h }

		p.child.box = placedBox

		// The scaled size is the child's from now on: its own children's constraints on it read this one.
		if (scale !== 1) {
			p.child.values.set("w", w)
			p.child.values.set("h", h)
		}
	}

	const middle = { x: box.x + box.w / 2, y: box.y + box.h / 2 }

	for (const child of node.children) {
		if (!isConnector(child)) continue

		child.box = { x: middle.x, y: middle.y, w: 0, h: 0 }

		// Connectors scale with the drawing (their depth comes from the same constraints).
		for (const type of ["w", "h"]) {
			const value = child.values.get(type)

			if (value !== undefined && Number.isFinite(value) && scale !== 1) child.values.set(type, value * scale)
		}
	}
}

import { groupBounds } from "./groupBounds"
import type { ShapeNode, Xfrm } from "./model"

// A group's child space (ECMA-376 Part 1 §20.1.7.5 a:chOff/a:chExt) and its parent's: a member's box is scaled from
// the child extent onto the group's extent, mirrored by the group's flips and turned with the group about its centre,
// as PowerPoint places it (a turned member keeps its own box, scaled along the parent's axes). `chain` lists the
// enclosing groups' own boxes, outermost first: what the editor needs to show a member on the slide and to write the
// box a drag of it gives back into its group's terms.

export const FULL_TURN = 21_600_000

function scaleOf(group: Xfrm): { sx: number; sy: number } {
	return {
		sx: group.chCx === undefined || group.chCx === 0 ? 1 : group.cx / group.chCx,
		sy: group.chCy === undefined || group.chCy === 0 ? 1 : group.cy / group.chCy
	}
}

function normalizedTurn(rot: number): number {
	return ((rot % FULL_TURN) + FULL_TURN) % FULL_TURN
}

// A point of a group's child space in its parent's space: scaled, mirrored, then turned about the group's centre.
export function toParent(group: Xfrm, px: number, py: number): { x: number; y: number } {
	const { sx, sy } = scaleOf(group)
	let x = group.x + (px - (group.chX ?? group.x)) * sx
	let y = group.y + (py - (group.chY ?? group.y)) * sy
	const cx = group.x + group.cx / 2
	const cy = group.y + group.cy / 2

	if (group.flipH) x = 2 * cx - x
	if (group.flipV) y = 2 * cy - y

	if (group.rot !== 0) {
		const angle = ((group.rot / 60000) * Math.PI) / 180
		const dx = x - cx
		const dy = y - cy

		x = cx + dx * Math.cos(angle) - dy * Math.sin(angle)
		y = cy + dx * Math.sin(angle) + dy * Math.cos(angle)
	}

	return { x, y }
}

// toParent undone: a point of the group's parent space in its child space.
export function fromParent(group: Xfrm, px: number, py: number): { x: number; y: number } {
	const { sx, sy } = scaleOf(group)
	const cx = group.x + group.cx / 2
	const cy = group.y + group.cy / 2
	let x = px
	let y = py

	if (group.rot !== 0) {
		const angle = (-(group.rot / 60000) * Math.PI) / 180
		const dx = x - cx
		const dy = y - cy

		x = cx + dx * Math.cos(angle) - dy * Math.sin(angle)
		y = cy + dx * Math.sin(angle) + dy * Math.cos(angle)
	}

	if (group.flipH) x = 2 * cx - x
	if (group.flipV) y = 2 * cy - y

	return { x: (group.chX ?? group.x) + (x - group.x) / sx, y: (group.chY ?? group.y) + (y - group.y) / sy }
}

function withChildFields(out: Xfrm, child: Xfrm): Xfrm {
	if (child.chX !== undefined) out.chX = child.chX
	if (child.chY !== undefined) out.chY = child.chY
	if (child.chCx !== undefined) out.chCx = child.chCx
	if (child.chCy !== undefined) out.chCy = child.chCy

	return out
}

// A member's box in its group's parent space. A mirrored group mirrors its members: each flips too, and its turn runs
// the other way. A member group keeps its own child space.
export function childInParent(group: Xfrm, child: Xfrm): Xfrm {
	const { sx, sy } = scaleOf(group)
	const centre = toParent(group, child.x + child.cx / 2, child.y + child.cy / 2)
	const cx = Math.round(child.cx * sx)
	const cy = Math.round(child.cy * sy)
	const mirrored = group.flipH !== group.flipV

	return withChildFields(
		{
			x: Math.round(centre.x - cx / 2),
			y: Math.round(centre.y - cy / 2),
			cx,
			cy,
			rot: normalizedTurn((mirrored ? -child.rot : child.rot) + group.rot),
			flipH: group.flipH !== child.flipH,
			flipV: group.flipV !== child.flipV
		},
		child
	)
}

// childInParent undone: the member's own box for a box in its group's parent space.
export function childFromParent(group: Xfrm, shown: Xfrm): Xfrm {
	const { sx, sy } = scaleOf(group)
	const centre = fromParent(group, shown.x + shown.cx / 2, shown.y + shown.cy / 2)
	const cx = Math.round(shown.cx / sx)
	const cy = Math.round(shown.cy / sy)
	const mirrored = group.flipH !== group.flipV
	const turn = shown.rot - group.rot

	return withChildFields(
		{
			x: Math.round(centre.x - cx / 2),
			y: Math.round(centre.y - cy / 2),
			cx,
			cy,
			rot: normalizedTurn(mirrored ? -turn : turn),
			flipH: group.flipH !== shown.flipH,
			flipV: group.flipV !== shown.flipV
		},
		shown
	)
}

// A member's box as it shows on the slide: its own box through every enclosing group, innermost first.
export function shownThrough(chain: readonly Xfrm[], own: Xfrm): Xfrm {
	let xfrm = own

	for (let k = chain.length - 1; k >= 0; k--) xfrm = childInParent(chain[k] as Xfrm, xfrm)

	return xfrm
}

// The member's own box for a box shown on the slide (shownThrough undone).
export function ownThrough(chain: readonly Xfrm[], shown: Xfrm): Xfrm {
	let xfrm = shown

	for (const group of chain) xfrm = childFromParent(group, xfrm)

	return xfrm
}

// A move by (dx, dy) on the slide in the innermost group's child space.
export function ownDelta(chain: readonly Xfrm[], dx: number, dy: number): { dx: number; dy: number } {
	let from = { x: 0, y: 0 }
	let to = { x: dx, y: dy }

	for (const group of chain) {
		from = fromParent(group, from.x, from.y)
		to = fromParent(group, to.x, to.y)
	}

	return { dx: Math.round(to.x - from.x), dy: Math.round(to.y - from.y) }
}

// The groups holding a shape of `ids` however deep, innermost first (a deeper group before any that holds it).
export function holdingGroups(shapes: readonly ShapeNode[], ids: ReadonlySet<number>): ShapeNode[] {
	const found = new Map<ShapeNode, number>()
	const walk = (members: readonly ShapeNode[], groups: readonly ShapeNode[]): void => {
		for (const shape of members) {
			if (ids.has(shape.id)) groups.forEach((group, depth) => found.set(group, depth))
			if (shape.children !== undefined && groups.length < 256) walk(shape.children, [...groups, shape])
		}
	}

	walk(shapes, [])

	return [...found].sort((a, b) => b[1] - a[1]).map(([group]) => group)
}

// A group's box fitted to its members as PowerPoint keeps it: the child space becomes the members' bounds and the box
// is where the old mapping places them (the centre through the old turn and flips, the extent at the old scale), so
// nothing moves on the slide. Undefined when it has no box, no placed member, members of no extent on an axis (their
// scale could not be kept), or the box already fits.
export function fittedGroupXfrm(group: ShapeNode): Xfrm | undefined {
	const xfrm = group.xfrm

	if (xfrm === undefined || group.children === undefined || !group.children.some(child => child.xfrm !== undefined)) return undefined

	const bounds = groupBounds(group.children)

	if (bounds.cx <= 0 || bounds.cy <= 0) return undefined
	if (
		bounds.x === (xfrm.chX ?? xfrm.x) &&
		bounds.y === (xfrm.chY ?? xfrm.y) &&
		bounds.cx === (xfrm.chCx ?? xfrm.cx) &&
		bounds.cy === (xfrm.chCy ?? xfrm.cy)
	)
		return undefined

	const { sx, sy } = scaleOf(xfrm)
	const centre = toParent(xfrm, bounds.x + bounds.cx / 2, bounds.y + bounds.cy / 2)
	const cx = Math.round(bounds.cx * sx)
	const cy = Math.round(bounds.cy * sy)

	return {
		x: Math.round(centre.x - cx / 2),
		y: Math.round(centre.y - cy / 2),
		cx,
		cy,
		rot: xfrm.rot,
		flipH: xfrm.flipH,
		flipV: xfrm.flipV,
		chX: bounds.x,
		chY: bounds.y,
		chCx: bounds.cx,
		chCy: bounds.cy
	}
}

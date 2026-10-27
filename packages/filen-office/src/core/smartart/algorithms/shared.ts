import type { Box, LayoutNode } from "../interp"
import { literal } from "../constraints"
import type { ShapeDef } from "../layoutDef"

// The child size an algorithm uses: the constraint value, else the parent's (an unbounded size, INF, is its
// content's, which only lin measures).
export function sizeOf(child: LayoutNode, parent: LayoutNode): { w: number; h: number } {
	const w = child.values.get("w")
	const h = child.values.get("h")

	return { w: w !== undefined && Number.isFinite(w) ? w : parent.box.w, h: h !== undefined && Number.isFinite(h) ? h : parent.box.h }
}

export function param(node: LayoutNode, name: string, fallback: string): string {
	return node.alg.params.get(name) ?? fallback
}

// The user's custom scale (§21.4.3.4 custScaleX/Y, in 1/1000 %) of a layout node, 1 when absent.
export function customScale(node: LayoutNode): { readonly x: number; readonly y: number } {
	const props = node.pres?.props

	return {
		x: props?.custScaleX === undefined ? 1 : props.custScaleX / 100000,
		y: props?.custScaleY === undefined ? 1 : props.custScaleY / 100000
	}
}

const ORIGINAL = new WeakMap<LayoutNode, ShapeDef | undefined>()

// The shape a layout node's definition gave it, before an algorithm turned it or chose its geometry (layout runs
// again as rules relax, so changes are made from this, never on top of the last).
export function originalShape(node: LayoutNode): ShapeDef | undefined {
	if (!ORIGINAL.has(node)) ORIGINAL.set(node, node.shape)

	return ORIGINAL.get(node)
}

// Gives `node` its definition's shape with `change` applied.
export function reshape(node: LayoutNode, change: Partial<ShapeDef>): void {
	const base = originalShape(node)

	node.shape = {
		type: base?.type ?? "rect",
		rot: base?.rot ?? 0,
		hideGeom: base?.hideGeom ?? false,
		zOrderOff: base?.zOrderOff ?? 0,
		adj: base?.adj ?? [],
		...change
	}
}

// The unturned box (what xfrm holds) of a shape turned `rot` degrees that fills its layout box with its turned
// footprint, about the same centre. A quarter turn swaps the sides (an algorithm that turns a shape a quarter turn
// gives it its footprint for that). A turn the layout definition gives the shape (§21.4.2.29 shape rot) is drawn
// inside its box: the sides whose turned footprint is the box (gear1's gear3, turned -15°, is box / (cos 15° +
// sin 15°) in PowerPoint's cache); where none is (near 45° on an oblong box), the box scaled until its footprint
// fits. A turn an algorithm chose (connectors, cycle's alongPath) already has its unturned box.
export function turnedBox(node: LayoutNode, box: Box, rot: number): Box {
	const radians = (rot * Math.PI) / 180
	const c = Math.abs(Math.cos(radians))
	const s = Math.abs(Math.sin(radians))

	if (s < 1e-9) return { ...box }
	if (c < 1e-9) return { x: box.x + (box.w - box.h) / 2, y: box.y + (box.h - box.w) / 2, w: box.h, h: box.w }
	if (originalShape(node)?.rot !== rot) return { ...box }

	const det = c * c - s * s
	let w = Math.abs(det) > 1e-6 ? (box.w * c - box.h * s) / det : 0
	let h = Math.abs(det) > 1e-6 ? (box.h * c - box.w * s) / det : 0

	if (!(w > 0 && h > 0)) {
		const across = box.w * c + box.h * s
		const down = box.w * s + box.h * c
		const k = across > 0 && down > 0 ? Math.min(box.w / across, box.h / down) : 0

		w = box.w * k
		h = box.h * k
	}

	return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h }
}

// A value of `node` for its own algorithm: set by the constraints, else a literal constraint the node puts on
// itself (a root's own constraints have no parent to resolve them).
export function ownValue(node: LayoutNode, type: string): number | undefined {
	const set = node.values.get(type)

	if (set !== undefined) return set

	for (const constraint of node.constraints) {
		if (constraint.for !== "self" || constraint.type !== type || constraint.forName !== "") continue
		if (constraint.refType !== "none" && constraint.refType !== "unknown") continue
		if (constraint.op !== "none" || !Number.isFinite(constraint.val)) continue

		return literal(type, constraint.val)
	}

	return undefined
}

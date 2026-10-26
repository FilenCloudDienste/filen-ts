import type { LayoutNode } from "../interp"

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

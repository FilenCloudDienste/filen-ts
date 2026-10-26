import type { LayoutNode } from "../interp"

// The child size an algorithm uses: the constraint value, else the parent's.
export function sizeOf(child: LayoutNode, parent: LayoutNode): { w: number; h: number } {
	return { w: child.values.get("w") ?? parent.box.w, h: child.values.get("h") ?? parent.box.h }
}

export function param(node: LayoutNode, name: string, fallback: string): string {
	return node.alg.params.get(name) ?? fallback
}

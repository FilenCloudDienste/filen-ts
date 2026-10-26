import type { LayoutContext, LayoutNode } from "../interp"
import { sizeOf } from "./shared"

// The space algorithm (ECMA-376 L.4.15.6.1.1 sp): no layout of its own. Children it carries get their
// constraint size at the node's origin, else the whole box.
export function spLayout(node: LayoutNode, _context: LayoutContext): void {
	for (const child of node.children) {
		const size = sizeOf(child, node)

		child.box = { x: node.box.x + (child.values.get("l") ?? 0), y: node.box.y + (child.values.get("t") ?? 0), w: size.w, h: size.h }
	}
}

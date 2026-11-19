import { DEFAULT_PRESENTATION_BUDGETS } from "./budget"
import type { ShapeNode } from "./model"

// Walks of a slide's shape tree, to the depth the readers admit: group levels below the top one up to the group-depth
// budget (a deeper tree never reaches the model).
const MAX_GROUP_DEPTH = DEFAULT_PRESENTATION_BUDGETS.groupDepth

// The shape with `id` at any depth of its groups (the first in document order).
export function shapeById(shapes: readonly ShapeNode[], id: number, depth = 0): ShapeNode | undefined {
	if (depth > MAX_GROUP_DEPTH) return undefined

	for (const shape of shapes) {
		if (shape.id === id) return shape

		const inner = shape.children === undefined ? undefined : shapeById(shape.children, id, depth + 1)

		if (inner !== undefined) return inner
	}

	return undefined
}

// Every shape at any depth of its groups, in document order (a group before its children).
export function forEachShape(shapes: readonly ShapeNode[], visit: (shape: ShapeNode) => void, depth = 0): void {
	if (depth > MAX_GROUP_DEPTH) return

	for (const shape of shapes) {
		visit(shape)

		if (shape.children !== undefined) forEachShape(shape.children, visit, depth + 1)
	}
}

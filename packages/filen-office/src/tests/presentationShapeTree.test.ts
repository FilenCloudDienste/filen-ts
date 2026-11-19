import { describe, expect, it } from "vitest"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import type { ShapeNode } from "../core/presentation/model"
import { forEachShape, shapeById } from "../core/presentation/shapes"
import { shape } from "./animFixtures"

// The shared shape-tree walks: a lookup by id and a visit of every shape, through nested groups, to the readers'
// group-depth budget.

function group(id: number, children: readonly ShapeNode[]): ShapeNode {
	return { ...shape(id), kind: "grpSp", children: [...children] }
}

// A chain of groups `levels` deep under the top level, with shape `id` at its bottom.
function nested(levels: number, id: number): ShapeNode[] {
	let level: ShapeNode[] = [shape(id)]

	for (let depth = levels; depth > 0; depth--) level = [group(10_000 + depth, level)]

	return level
}

describe("shape tree", () => {
	it("finds a shape inside nested groups, the first in document order, and nothing for a missing id", () => {
		const tree = [shape(2), group(3, [shape(4), group(5, [shape(6)])]), shape(7)]

		expect(shapeById(tree, 6)?.id).toBe(6)
		expect(shapeById(tree, 5)?.kind).toBe("grpSp")
		expect(shapeById(tree, 7)?.id).toBe(7)
		expect(shapeById(tree, 99)).toBeUndefined()
		expect(
			shapeById(
				[
					{ ...shape(8), name: "first" },
					{ ...shape(8), name: "second" }
				],
				8
			)?.name
		).toBe("first")
	})

	it("visits every shape, a group before its children", () => {
		const ids: number[] = []

		forEachShape([shape(2), group(3, [shape(4), group(5, [shape(6)])]), shape(7)], visited => ids.push(visited.id))

		expect(ids).toEqual([2, 3, 4, 5, 6, 7])
	})

	it("reaches a shape at the group-depth budget, and none past it", () => {
		const depth = DEFAULT_PRESENTATION_BUDGETS.groupDepth
		const ids: number[] = []

		expect(shapeById(nested(depth, 1), 1)?.id).toBe(1)
		expect(shapeById(nested(depth + 1, 1), 1)).toBeUndefined()
		forEachShape(nested(depth, 1), visited => ids.push(visited.id))
		expect(ids).toContain(1)
		ids.length = 0
		forEachShape(nested(depth + 1, 1), visited => ids.push(visited.id))
		expect(ids).not.toContain(1)
	})
})

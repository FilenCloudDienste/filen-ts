import type { ShapeNode } from "../../model"

// The shape a re-read of held markup gives for each shape of a typed copy, among siblings: by order when both lists
// are the same shapes in the same order (kind and name at every place); else by id (a pptx shape's own; an ODP shape's only
// with the same name, its reader numbering shapes by place), as when an edit changed the order, else by a name and kind only one shape has. ODP readers number
// shapes by their place in the page, so after a save took a shape out the same ids name other shapes. A shape found
// no way has no match.
export function matchShapes(typed: readonly ShapeNode[], read: readonly ShapeNode[]): (ShapeNode | undefined)[] {
	const inOrder = typed.length === read.length && typed.every((shape, k) => shape.kind === read[k]?.kind && shape.name === read[k]?.name)

	if (inOrder) return [...read]

	const byId = new Map<number, ShapeNode>()
	const byName = new Map<string, ShapeNode[]>()
	const used = new Set<ShapeNode>()

	for (const shape of read) {
		byId.set(shape.sourceId ?? shape.id, shape)

		const key = `${shape.kind}\u0000${shape.name}`
		const list = byName.get(key)

		if (list === undefined) byName.set(key, [shape])
		else list.push(shape)
	}

	const same = (a: ShapeNode, b: ShapeNode): boolean => a.kind === b.kind && a.name === b.name

	return typed.map(shape => {
		const byIdMatch = byId.get(shape.sourceId ?? shape.id)

		// A pptx id is the shape's own (cNvPr id); an ODP reader's is its place, so its name must agree too.
		const trusted =
			byIdMatch !== undefined && (byIdMatch.src?.format === "pptx" ? byIdMatch.kind === shape.kind : same(byIdMatch, shape))

		if (byIdMatch !== undefined && trusted && !used.has(byIdMatch)) {
			used.add(byIdMatch)

			return byIdMatch
		}

		const named = byName.get(`${shape.kind}\u0000${shape.name}`)

		if (named?.length === 1 && shape.name !== "" && !used.has(named[0] as ShapeNode)) {
			used.add(named[0] as ShapeNode)

			return named[0]
		}

		return undefined
	})
}

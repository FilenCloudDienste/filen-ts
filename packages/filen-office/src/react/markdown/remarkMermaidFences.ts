// Marks each ```mermaid fence with its place among the document's diagrams (0, 1, …) as `data-mermaid` on its `code`
// element, for the host's slot to render it as a diagram (or to wait for a click past the first few).

// The parts of an mdast tree this touches (mdast's types are not a dependency here).
interface Node {
	type: string
	lang?: string | null
	data?: { hProperties?: Record<string, unknown> }
	children?: Node[]
}

function mark(node: Node, next: { ordinal: number }): void {
	if (node.type === "code" && node.lang?.toLowerCase() === "mermaid") {
		node.data = { ...node.data, hProperties: { ...node.data?.hProperties, dataMermaid: String(next.ordinal++) } }

		return
	}

	for (const child of node.children ?? []) {
		mark(child, next)
	}
}

export function remarkMermaidFences(): (tree: Node) => void {
	return tree => {
		mark(tree, { ordinal: 0 })
	}
}

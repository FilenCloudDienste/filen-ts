// Inline math as GitHub reads it: `$…$` is math only when the dollar signs hug the formula (no space right inside
// either one) and the closing one is not followed by a digit, so prices ("$5 and $10") stay text. A rejected span
// becomes its source text again. Display math (`$$` on lines of its own) is left alone.

interface MathNode {
	type: string
	value?: string
	position?: { start: { offset?: number }; end: { offset?: number } }
	children?: MathNode[]
}

const SPACE = /\s/
const DIGIT = /\d/

// Read from the source: the parser drops one space of padding inside the dollar signs, as for code spans.
function isMath(node: MathNode, source: string): boolean {
	const start = node.position?.start.offset
	const end = node.position?.end.offset

	if (start === undefined || end === undefined) {
		return true
	}

	const raw = source.slice(start, end)
	const fence = /^\$+/.exec(raw)?.[0].length ?? 1
	const inner = raw.slice(fence, raw.length - fence)

	return inner.length > 0 && !SPACE.test(inner[0] ?? "") && !SPACE.test(inner[inner.length - 1] ?? "") && !DIGIT.test(source[end] ?? "")
}

// The span's own source ("$5 and $"), else the value between single dollar signs.
function sourceText(node: MathNode, source: string): MathNode {
	const start = node.position?.start.offset
	const end = node.position?.end.offset

	return { type: "text", value: start === undefined || end === undefined ? `$${node.value ?? ""}$` : source.slice(start, end) }
}

export function remarkMathGuard() {
	return (tree: MathNode, file: { value: unknown }): void => {
		const source = typeof file.value === "string" ? file.value : ""
		const pending: MathNode[] = [tree]

		for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
			const children = node.children

			if (children === undefined) {
				continue
			}

			for (let i = 0; i < children.length; i++) {
				const child = children[i]

				if (child === undefined) {
					continue
				}

				if (child.type === "inlineMath" && !isMath(child, source)) {
					children[i] = sourceText(child, source)
				} else {
					pending.push(child)
				}
			}
		}
	}
}

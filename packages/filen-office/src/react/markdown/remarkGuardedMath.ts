import remarkMath from "remark-math"

// remark-math with inline math as GitHub reads it: `$…$` is math only when the dollar signs hug the formula (no space
// or line break right inside either one) and the closing one is not followed by a digit, so prices ("$5 and $10")
// stay text. The check runs in the tokenizer: a span it refuses never becomes math, so micromark reads the `$` as a
// plain character and parses what follows as usual (links, code, emphasis, a blockquote's continuation). A ```math fence
// is display math too, as on GitHub.

// The parts of micromark's tokenizer API the guard touches (micromark-util-types, not a dependency here).
type Code = number | null
type State = (code: Code) => State | undefined
interface Effects {
	consume: (code: Code) => void
}
type Tokenize = (this: unknown, effects: Effects, ok: State, nok: State) => State
interface Construct {
	tokenize: Tokenize
}

const DOLLAR = 36

// Spaces, tabs and line endings (micromark codes line endings and virtual spaces as negatives).
function isSpace(code: Code | undefined): boolean {
	return code === 32 || (typeof code === "number" && code < 0)
}

function isDigit(code: Code): boolean {
	return code !== null && code >= 48 && code <= 57
}

// The construct's own tokenizer, watching what it consumes: on success, refused unless the formula hugs its dollar
// signs and no digit follows.
function guard(construct: Construct): Construct {
	return {
		...construct,
		tokenize(effects, ok, nok) {
			const consumed: Code[] = []
			const watched = Object.create(effects, {
				consume: {
					value: (code: Code) => {
						consumed.push(code)
						effects.consume(code)
					}
				}
			}) as Effects

			const accept: State = code => {
				let fence = 0

				while (consumed[fence] === DOLLAR) {
					fence++
				}

				const first = consumed[fence]
				const last = consumed[consumed.length - fence - 1]

				return consumed.length > 2 * fence && !isSpace(first) && !isSpace(last) && !isDigit(code) ? ok(code) : nok(code)
			}

			return construct.tokenize.call(this, watched, accept, nok)
		}
	}
}

// The processor as remark plugins see it: its data, where remark-math registers its syntax (unified's types are not
// a dependency here).
interface Processor {
	data(): { micromarkExtensions?: { text?: Record<number, Construct> }[] }
}

// The parts of an mdast tree the fence pass touches (mdast's types are not a dependency here).
interface MdNode {
	type: string
	lang?: string | null
	meta?: string | null
	value?: string
	data?: Record<string, unknown>
	children?: MdNode[]
}

// A ```math fence as the display math node remark-math makes of `$$…$$` (mdast-util-math's math: pre > code.math-display).
function mathFences(node: MdNode): void {
	if (node.type === "code" && node.lang?.toLowerCase() === "math") {
		const value = node.value ?? ""

		node.type = "math"
		node.meta = null
		delete node.lang
		node.data = {
			hName: "pre",
			hChildren: [
				{
					type: "element",
					tagName: "code",
					properties: { className: ["language-math", "math-display"] },
					children: [{ type: "text", value }]
				}
			]
		}

		return
	}

	for (const child of node.children ?? []) {
		mathFences(child)
	}
}

export function remarkGuardedMath(this: unknown): (tree: MdNode) => void {
	const processor = this as Processor

	;(remarkMath as unknown as (this: Processor) => void).call(processor)

	const extensions = processor.data().micromarkExtensions
	const text = extensions?.[extensions.length - 1]?.text
	const inline = text?.[DOLLAR]

	if (text === undefined || inline === undefined) {
		throw new Error("remark-math added no inline math construct")
	}

	text[DOLLAR] = guard(inline)

	return mathFences
}

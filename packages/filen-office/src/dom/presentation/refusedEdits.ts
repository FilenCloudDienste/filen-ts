import { partKey } from "../../core/opc/index"
import { parseTouchKey } from "../../core/presentation/edit/changes"
import type { Deck, Format, ShapeNode, SlideRef } from "../../core/presentation/model"

// The edits a writer's check refused, from its detail (pptx verify.ts: "<part> reads back differently at
// .shapes[2].fill…"; ODP meaning.ts: "page 1 (<parts>) reads back differently: shape 2 (<name>) fill"), resolved
// against the outline of the deck the snapshot was taken of: tests of history touch keys ("s:<slide>:<shape>:<dirt>",
// "n:<slide>:…"), so a save's revert takes back those steps alone, the first tier any step since the save has:
// `changes`, a key that changes the group of properties that read back otherwise of the shape named (any of its
// members; any group when the detail names none); `alters`, its node changed whole in place (a diagram restyled, a
// chart edited); `makes`, its node, or a group holding it, made (an insert, a slide copied).
// Undefined when the detail names no shape or slide of the deck: the caller reverts by part.

export interface RefusedEdits {
	// `made`: the key is a whole node's, which the step made (absent before it).
	readonly changes: (key: string, made: boolean) => boolean
	readonly alters: (key: string, made: boolean) => boolean
	readonly makes: (key: string, made: boolean) => boolean
}

// The shapes of the slides a snapshot changed, as it saw them (a refusal comes after later commands may have run).
interface OutlineShape {
	readonly id: number
	readonly name: string | undefined
	readonly synthetic: boolean
	readonly children: readonly OutlineShape[]
}

interface OutlineNode {
	readonly ref: SlideRef
	readonly notes: OutlineNode | undefined
	readonly shapes: readonly OutlineShape[]
}

export interface DeckOutline {
	readonly format: Format
	// By part key.
	readonly nodes: ReadonlyMap<string, OutlineNode>
}

function outlineShape(shape: ShapeNode): OutlineShape {
	return { id: shape.id, name: shape.name, synthetic: shape.synthetic === true, children: (shape.children ?? []).map(outlineShape) }
}

// The outline of the nodes whose parts, or whose notes' parts, are `parts` (a snapshot's changes), with their notes.
export function deckOutline(deck: Deck, parts: Iterable<string>): DeckOutline {
	const wanted = new Set([...parts].map(part => partKey(part)))
	const nodes = new Map<string, OutlineNode>()

	for (const node of deck.nodes.values()) {
		const notesNode = node.notes === undefined ? undefined : deck.nodes.get(node.notes)

		if (node.part === undefined) continue
		if (!wanted.has(partKey(node.part)) && (notesNode?.part === undefined || !wanted.has(partKey(notesNode.part)))) continue
		const notes =
			notesNode === undefined ? undefined : { ref: notesNode.ref, notes: undefined, shapes: notesNode.shapes.map(outlineShape) }

		nodes.set(partKey(node.part), { ref: node.ref, notes, shapes: node.shapes.map(outlineShape) })
	}

	return { format: deck.format === "odp" ? "odp" : "pptx", nodes }
}

interface Culprit {
	readonly slide: SlideRef
	// The shape that differs and the dirt codes that can change what differed (undefined: any).
	readonly shape: number
	readonly codes: ReadonlySet<string> | undefined
	// Its groups (a node replaced whole moves it) and, when it is a group, its members (any change).
	readonly ancestors: readonly number[]
	readonly members: ReadonlySet<number>
}

const NODE = "n"
const TEXT = ["t", "p.bodyPr"]

// The dirt codes (history.ts dirtKey) of what a difference names first: a model key (pptx) or a word (ODP).
function codesOf(what: string): ReadonlySet<string> | undefined {
	switch (what) {
		case "fill":
		case "ln":
		case "geometry":
		case "effects":
		case "style":
			return new Set([`p.${what}`])
		case "bodyPr":
			return new Set(TEXT)
		case "xfrm":
		case "box":
		case "line":
			return new Set(["x"])
		case "text":
		case "paragraph":
		case "paragraphs":
		case "run":
		case "runs":
			return new Set(TEXT)
		default:
			return undefined
	}
}

function membersOf(shape: OutlineShape, out: Set<number>): Set<number> {
	for (const child of shape.children ?? []) {
		out.add(child.id)
		membersOf(child, out)
	}

	return out
}

function culprit(slide: SlideRef, path: readonly OutlineShape[], what: string): Culprit {
	const shape = path[path.length - 1] as OutlineShape

	return {
		slide,
		shape: shape.id,
		codes: codesOf(what),
		ancestors: path.slice(0, -1).map(each => each.id),
		members: membersOf(shape, new Set())
	}
}

// The slide node itself differs (its name, hidden, layout…): shape -1.
function slideCulprit(slide: SlideRef): Culprit {
	return { slide, shape: -1, codes: undefined, ancestors: [], members: new Set() }
}

function nodeOfPart(outline: DeckOutline, part: string): OutlineNode | undefined {
	return outline.nodes.get(partKey(part))
}

// pptx: the slide the part is, the path into its normal value (.shapes[k](.children[j])*.key…).
function pptxCulprit(outline: DeckOutline, detail: string): Culprit | undefined {
	const match = /^(\S+) reads back differently at (\S+)/u.exec(detail)

	if (match === null) return undefined

	const node = nodeOfPart(outline, match[1] as string)

	if (node === undefined) return undefined

	const tokens = [...(match[2] as string).matchAll(/\.(\w+)|\[(\d+)\]/gu)].map(token => token[1] ?? Number(token[2]))

	if (tokens[0] !== "shapes") return slideCulprit(node.ref)

	const path: OutlineShape[] = []
	let shapes: readonly OutlineShape[] = node.shapes
	let at = 1

	while (typeof tokens[at] === "number") {
		const shape = shapes[tokens[at] as number]

		if (shape === undefined) return undefined

		path.push(shape)
		at++

		if (tokens[at] !== "children" || typeof tokens[at + 1] !== "number") break

		shapes = shape.children
		at++
	}

	if (path.length === 0) return undefined

	return culprit(node.ref, path, typeof tokens[at] === "string" ? (tokens[at] as string) : "")
}

// ODP: the page (or its notes) and the shapes named "shape k (name)" in turn, k among the shapes that are not
// synthetic (meaning.ts shapesDiffer).
function odpCulprit(outline: DeckOutline, detail: string): Culprit | undefined {
	const match = /^page \d+ \(([^)]*)\) reads back differently: (.*)$/su.exec(detail)

	if (match === null) return undefined

	const page = nodeOfPart(outline, (match[1] as string).split(" ")[0] ?? "")

	if (page === undefined) return undefined

	let rest = match[2] as string
	let node: OutlineNode | undefined = page

	if (rest.startsWith("notes ")) {
		node = page.notes
		rest = rest.slice("notes ".length)
	}

	if (node === undefined) return undefined
	if (/^(?:name |hidden$|master shapes$)/u.test(rest)) return slideCulprit(node.ref)

	const path: OutlineShape[] = []
	let shapes: readonly OutlineShape[] = node.shapes

	for (;;) {
		const head = /^shape (\d+) \(/u.exec(rest)

		if (head === null) break

		const shape = shapes.filter(each => !each.synthetic)[Number(head[1])]
		const named = shape === undefined ? undefined : `${head[0]}${String(shape.name)}) `

		if (shape === undefined || named === undefined || !(rest.startsWith(named) || rest === named.trimEnd())) return undefined

		path.push(shape)
		rest = rest.slice(named.length)
		shapes = shape.children
	}

	if (path.length === 0) return undefined

	return culprit(node.ref, path, /^\w+/u.exec(rest)?.[0] ?? "")
}

export function refusedEdits(outline: DeckOutline, detail: string): RefusedEdits | undefined {
	const found = outline.format === "odp" ? odpCulprit(outline, detail) : pptxCulprit(outline, detail)

	if (found === undefined) return undefined

	if (found.shape < 0)
		return {
			changes: key => {
				const parsed = parseTouchKey(key)

				return parsed.kind === "slide" && parsed.slide === found.slide
			},
			alters: () => false,
			makes: () => false
		}

	const shapeKey = (key: string): Extract<ReturnType<typeof parseTouchKey>, { kind: "shape" }> | undefined => {
		const parsed = parseTouchKey(key)

		return parsed.kind === "shape" && parsed.slide === found.slide ? parsed : undefined
	}
	const named = (shape: number): boolean => shape === found.shape || found.members.has(shape)

	return {
		changes: (key, made) => {
			const parsed = shapeKey(key)

			if (parsed === undefined || made || !named(parsed.shape)) return false
			if (parsed.shape !== found.shape) return parsed.dirt !== NODE

			return found.codes === undefined || found.codes.has(parsed.dirt)
		},
		alters: (key, made) => {
			const parsed = shapeKey(key)

			return !made && parsed?.dirt === NODE && named(parsed.shape)
		},
		makes: (key, made) => {
			const parsed = shapeKey(key)

			return made && parsed?.dirt === NODE && (named(parsed.shape) || found.ancestors.includes(parsed.shape))
		}
	}
}

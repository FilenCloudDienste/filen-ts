import { Schema, type DOMOutputSpec, type Mark, type MarkType, type Node } from "prosemirror-model"
import type { Paragraph, ParaProps, Run, RunProps, SourceRef, TextBody } from "../model"
import { editableParagraphs } from "./editable"

// The editing schema of one DrawingML text body (a shape's p:txBody, a notes body): the document is the body's
// paragraphs; text carries one `run` mark holding its a:rPr; a:br, a:fld and content kept as source (a14:m math,
// unknown run content) are inline atoms. a:bodyPr and a:lstStyle are not in the document: they stay with the body the
// editor was seeded with.
//
// A paragraph node built from the body keeps `origin`, its index in that body. Converting back, a paragraph whose
// node is still the one built from its origin is that origin paragraph, unchanged and with its source ref (so the
// writer copies its bytes); an edited one keeps the source ref of its origin once (the first node naming it), so
// the writer keeps what the model does not read of the a:p it came from, and a split never duplicates it.

export const NO_ORIGIN = -1

const EMPTY_RUN_PROPS: RunProps = Object.freeze({})
const EMPTY_PARA_PROPS: ParaProps = Object.freeze({})

export const presentationTextSchema = new Schema({
	nodes: {
		doc: { content: "paragraph+" },
		paragraph: {
			content: "inline*",
			attrs: {
				pPr: { default: EMPTY_PARA_PROPS },
				endRPr: { default: null },
				origin: { default: NO_ORIGIN }
			},
			parseDOM: [{ tag: "p" }, { tag: "pre", preserveWhitespace: "full" }],
			toDOM: () => ["p", 0]
		},
		text: { group: "inline" },
		br: {
			group: "inline",
			inline: true,
			atom: true,
			selectable: false,
			attrs: { rPr: { default: EMPTY_RUN_PROPS } },
			parseDOM: [{ tag: "br" }],
			toDOM: () => ["br"],
			leafText: () => "\n"
		},
		field: {
			group: "inline",
			inline: true,
			atom: true,
			attrs: { type: { default: "" }, id: { default: "" }, text: { default: "" }, rPr: { default: EMPTY_RUN_PROPS } },
			toDOM: node => ["span", { "data-fo-field": String(node.attrs["type"]) }, String(node.attrs["text"])],
			leafText: node => String(node.attrs["text"])
		},
		opaque: {
			group: "inline",
			inline: true,
			atom: true,
			attrs: { src: { default: null }, text: { default: "" } },
			toDOM: node => ["span", { "data-fo-opaque": "" }, String(node.attrs["text"])],
			leafText: node => String(node.attrs["text"])
		}
	},
	marks: {
		run: {
			attrs: { rPr: { default: EMPTY_RUN_PROPS } },
			// Copied text carries the formatting a sanitized paste reads back (b, i, u, s).
			toDOM: mark => {
				const rPr = mark.attrs["rPr"] as RunProps
				const tags: string[] = []

				if (rPr.b === true) tags.push("b")
				if (rPr.i === true) tags.push("i")
				if (rPr.u !== undefined && rPr.u !== "none") tags.push("u")
				if (rPr.strike !== undefined && rPr.strike !== "noStrike") tags.push("s")

				return tags.length === 0 ? ["span", 0] : nested(tags, 0)
			}
		}
	}
})

function nested(tags: readonly string[], index: number): DOMOutputSpec {
	return [tags[index] ?? "span", index + 1 < tags.length ? nested(tags, index + 1) : 0]
}

export const RUN_MARK: MarkType = presentationTextSchema.marks.run as MarkType

// A body as an editing document, with the paragraph node built from each of its paragraphs.
export interface TextDocument {
	readonly doc: Node
	readonly origins: readonly Node[]
}

function runMark(rPr: RunProps): readonly Mark[] {
	return [RUN_MARK.create({ rPr })]
}

function inlineOf(run: Run): Node | undefined {
	const schema = presentationTextSchema

	switch (run.kind) {
		case "r":
			return run.text.length === 0 ? undefined : schema.text(run.text, runMark(run.rPr))
		case "br":
			return schema.nodes.br.create({ rPr: run.rPr })
		case "fld":
			return schema.nodes.field.create({ type: run.type, id: run.id, text: run.text, rPr: run.rPr })
		case "opaque":
			return schema.nodes.opaque.create({ src: run.src, text: run.text })
	}
}

export function paragraphNode(paragraph: Paragraph, origin: number): Node {
	const inline: Node[] = []

	for (const run of paragraph.runs) {
		const node = inlineOf(run)

		if (node !== undefined) inline.push(node)
	}

	return presentationTextSchema.nodes.paragraph.create({ pPr: paragraph.pPr, endRPr: paragraph.endRPr ?? null, origin }, inline)
}

export function bodyToDoc(body: TextBody): TextDocument {
	const paragraphs = editableParagraphs(body)
	const origins = paragraphs.map((paragraph, index) => paragraphNode(paragraph, body.paragraphs.length === 0 ? NO_ORIGIN : index))

	return { doc: presentationTextSchema.nodes.doc.create(null, origins), origins }
}

// A text node's run properties: its run mark's; a text node without one (pasted or typed where no run was) takes the
// paragraph mark's, as PowerPoint gives typing in an empty paragraph a:endParaRPr.
export function runPropsOf(marks: readonly Mark[], fallback: RunProps | null): RunProps {
	for (const mark of marks) if (mark.type === RUN_MARK) return mark.attrs["rPr"] as RunProps

	return fallback ?? EMPTY_RUN_PROPS
}

function runsOf(node: Node): Run[] {
	const runs: Run[] = []
	const endRPr = node.attrs["endRPr"] as RunProps | null

	node.forEach(child => {
		if (child.isText) {
			runs.push({ kind: "r", text: child.text ?? "", rPr: runPropsOf(child.marks, endRPr) })
		} else if (child.type.name === "br") {
			runs.push({ kind: "br", rPr: child.attrs["rPr"] as RunProps })
		} else if (child.type.name === "field") {
			runs.push({
				kind: "fld",
				type: String(child.attrs["type"]),
				id: String(child.attrs["id"]),
				text: String(child.attrs["text"]),
				rPr: child.attrs["rPr"] as RunProps
			})
		} else if (child.type.name === "opaque" && child.attrs["src"] !== null) {
			runs.push({ kind: "opaque", src: child.attrs["src"] as SourceRef, text: String(child.attrs["text"]) })
		}
	})

	return runs
}

// The body a document holds: `seed`'s bodyPr and lstStyle with the document's paragraphs. `origins` are the nodes
// bodyToDoc built from `seed` (unchanged ones are seed's own paragraphs, by identity).
export function docToBody(doc: Node, seed: TextBody, origins: readonly Node[]): TextBody {
	const paragraphs: Paragraph[] = []
	const used = new Set<number>()

	doc.forEach(node => {
		const origin = node.attrs["origin"] as number
		const source = origin === NO_ORIGIN ? undefined : seed.paragraphs[origin]

		if (source !== undefined && !used.has(origin) && origins[origin] === node) {
			used.add(origin)
			paragraphs.push(source)

			return
		}

		const endRPr = node.attrs["endRPr"] as RunProps | null
		const paragraph: Paragraph = { pPr: node.attrs["pPr"] as ParaProps, runs: runsOf(node) }

		if (endRPr !== null) paragraph.endRPr = endRPr

		if (source?.src !== undefined && !used.has(origin)) {
			used.add(origin)
			paragraph.src = source.src
		}

		paragraphs.push(paragraph)
	})

	const body: TextBody = { bodyPr: seed.bodyPr, paragraphs }

	if (seed.lstStyle !== undefined) body.lstStyle = seed.lstStyle

	return body
}

// The plain text of a body (paragraphs joined by "\n", a:br as "\n", fields as shown last, kept content as its text):
// what find, copy as text and the outline read.
export function paragraphText(paragraph: Paragraph): string {
	let text = ""

	for (const run of paragraph.runs) text += run.kind === "br" ? "\n" : run.text

	return text
}

// A run's length in editing positions: text by its UTF-16 units; a break, a field and kept content are one position.
export function runLength(run: Run): number {
	return run.kind === "r" ? run.text.length : 1
}

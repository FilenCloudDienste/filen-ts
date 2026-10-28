import type { Paragraph, PlaceholderType, RunProps, ShapeNode, TextBody } from "../model"
import type { PlaceholderLevel } from "./services"

// The prompt an empty placeholder shows in the editor ("Click to add title"), never in the show, a thumbnail, an
// export or the file. Its text is the layout placeholder's own when that placeholder or the slide's has
// hasCustomPrompt (ECMA-376 Part 1 §19.3.1.36), else the page's locale string for the placeholder's type. The body is
// laid out as the placeholder's own would be (its list style, its first paragraph's level and end-of-paragraph run
// properties), so it shows in the resolved font, size, colour, alignment and anchoring.

export type PromptKind = "title" | "subtitle" | "text" | "picture" | "chart" | "table" | "smartart" | "media" | "clipArt"

export type PlaceholderPrompts = Readonly<Record<PromptKind, string>>

// Date, footer, slide number, header and slide image placeholders show no prompt on a slide.
const KINDS: Partial<Readonly<Record<PlaceholderType, PromptKind>>> = {
	title: "title",
	ctrTitle: "title",
	subTitle: "subtitle",
	body: "text",
	obj: "text",
	pic: "picture",
	chart: "chart",
	tbl: "table",
	dgm: "smartart",
	media: "media",
	clipArt: "clipArt"
}

export function promptKind(type: PlaceholderType): PromptKind | undefined {
	return KINDS[type]
}

function visible(body: TextBody | undefined): body is TextBody {
	return body?.paragraphs.some(paragraph => paragraph.runs.some(run => run.kind !== "br" && run.text !== "")) === true
}

// The prompt body of an empty slide placeholder; undefined when it shows none. `chain` is the shape's placeholder
// chain, nearest first (its layout placeholder).
export function promptBody(shape: ShapeNode, chain: readonly PlaceholderLevel[], prompts: PlaceholderPrompts): TextBody | undefined {
	const ph = shape.ph

	if (ph === undefined) return undefined

	const own = shape.text
	const frame = { bodyPr: own?.bodyPr ?? {}, ...(own?.lstStyle === undefined ? {} : { lstStyle: own.lstStyle }) }
	// PowerPoint writes the flag on the layout's placeholder (its text is the prompt); a slide's own flag is honoured too.
	const layout = chain[0]?.shape
	const custom = ph.hasCustomPrompt === true || layout?.ph?.hasCustomPrompt === true ? layout?.text : undefined

	if (visible(custom)) return { ...frame, paragraphs: custom.paragraphs }

	const kind = promptKind(ph.type)

	if (kind === undefined) return undefined

	const first = own?.paragraphs[0]
	const rPr: RunProps = first?.endRPr ?? {}
	const paragraph: Paragraph = { pPr: first?.pPr ?? {}, runs: [{ kind: "r", text: prompts[kind], rPr }], endRPr: rPr }

	return { ...frame, paragraphs: [paragraph] }
}

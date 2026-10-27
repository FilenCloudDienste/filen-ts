import type { TextBody } from "../presentation/model"
import { isMediaBehavior } from "./attributes"
import type { AnimTarget, LayerIndex, TimeNode, TimingTree } from "./model"

// By-letter and by-word builds (ECMA-376 Part 1 §19.5.49 p:iterate, ODF anim:iterate): an iterated effect plays on
// each letter or word of its target in turn. The show lays a built body out as runs (layers of one or more letters or
// words, LayerIndex.ranges unit "char" in charRg offsets: a paragraph's text then one character for its end), and the
// timegraph offsets each run by its first element's ordinal. Letters are code points (spaces and line breaks
// included); a word is a run of non-space letters with the spaces after it (spaces before the first word belong to
// it).

// LayerIndex.runs per layer.
export const RUN_INTS = 5
export const RunInt = { PARAGRAPH: 0, LETTER: 1, LETTERS: 2, WORD: 3, WORDS: 4 } as const

export type IterateUnit = "lt" | "wd"

// A run [-1, -1]: its shape's drawing without the text (a whole-shape build plays it as the first element).
export const DRAWING_RUN = -1

// The text a paragraph counts in charRg offsets: its runs' text, a line break one character.
export function paragraphText(paragraph: TextBody["paragraphs"][number]): string {
	let text = ""

	for (const run of paragraph.runs) text += run.kind === "br" ? "\n" : run.text

	return text
}

// Per paragraph, its first character's charRg offset; one more entry: the body's length.
export function paragraphStarts(body: TextBody): Int32Array {
	const out = new Int32Array(body.paragraphs.length + 1)
	let at = 0

	body.paragraphs.forEach((paragraph, k) => {
		out[k] = at
		at += paragraphText(paragraph).length + 1
	})
	out[body.paragraphs.length] = at

	return out
}

function isSpace(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0d || code === 0xa0 || code === 0x3000
}

// The elements of a paragraph's text: per letter its offset, and whether a word starts there.
export interface ParagraphElements {
	// Offset of each letter, then the text's length.
	readonly letters: Int32Array
	// Per letter, 1 where a word starts.
	readonly wordStart: Uint8Array
}

export function paragraphElements(text: string): ParagraphElements {
	const offsets: number[] = []
	const starts: number[] = []
	let previousSpace = false
	// Whether the current word has a letter that is no space yet.
	let worded = false

	for (let at = 0; at < text.length;) {
		const code = text.codePointAt(at) ?? 0
		const space = isSpace(code)
		const opens = offsets.length === 0 || (!space && previousSpace && worded)

		offsets.push(at)
		starts.push(opens ? 1 : 0)

		if (opens) worded = false
		if (!space) worded = true

		previousSpace = space
		at += code > 0xffff ? 2 : 1
	}

	offsets.push(text.length)

	return { letters: Int32Array.from(offsets), wordStart: Uint8Array.from(starts) }
}

// The effective iterate of each behaviour (its own or its nearest container's), "el" and none skipped.
export function forEachIterated(
	timing: TimingTree | undefined,
	visit: (target: AnimTarget, unit: IterateUnit, iterated: TimeNode) => void
): void {
	if (timing === undefined) return

	const stack: { node: TimeNode; iterated: TimeNode | undefined }[] = [{ node: timing.root, iterated: undefined }]

	for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
		const node = item.node
		const own = node.ctn.iterate
		const iterated = own !== undefined && own.type !== "el" ? node : item.iterated

		if (node.kind === "behavior" && iterated !== undefined) {
			const behavior = node.behavior
			const target = isMediaBehavior(behavior) ? behavior.target : behavior.common.target
			const type = iterated.ctn.iterate?.type

			if (type === "lt" || type === "wd") visit(target, type, iterated)
		}

		for (const child of node.ctn.children) stack.push({ node: child, iterated })
		for (const child of node.ctn.subTnLst ?? []) stack.push({ node: child, iterated })
	}
}

// Whether layer `k` of an index is a run (a by-letter or by-word layer, or its shape's drawing run).
export function isRunLayer(layers: LayerIndex, k: number): boolean {
	return (layers.runs?.[k * RUN_INTS + RunInt.LETTERS] ?? -1) >= 0
}

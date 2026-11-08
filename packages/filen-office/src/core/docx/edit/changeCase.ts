import type { Node } from "prosemirror-model"
import { TextSelection, type Transaction } from "prosemirror-state"
import { isDeleted } from "../review/track"
import { wordAround } from "./formats"
import type { StoryCommandContext } from "./registry"
import { docxSchema } from "./schema"

// Word's Change Case (Shift+F3): the text of the selection, or of the word the caret is inside of, changed
// in place. All lower case becomes title case (each word capitalised), all upper case lower case, anything
// else upper case; a step that would change nothing gives way to the next. Each run keeps its formatting and
// is mapped with its own language (w:lang), so length-changing mappings ("ß" to "SS") and surrogate pairs
// hold. Deleted revisions and what is not run text (fields, objects) are left as they are.

export type CaseMode = "title" | "upper" | "lower"

const nodes = docxSchema.nodes
const marks = docxSchema.marks
const NEXT: Readonly<Record<CaseMode, CaseMode>> = { lower: "title", title: "upper", upper: "lower" }
const UPPER = /\p{Lu}/u
const LOWER = /\p{Ll}/u
const LETTER = /[\p{L}\p{N}]/u
// Validated language tags (an invalid one throws from toLocale*Case): undefined maps without a locale.
const LOCALES = new Map<string, string | undefined>()

interface TextPiece {
	readonly from: number
	readonly to: number
	readonly node: Node
	readonly text: string
	// Where the piece starts in the joined text.
	readonly offset: number
}

function localeOf(node: Node): string | undefined {
	const tag = marks.lang.isInSet(node.marks)?.attrs["latin"] as string | null | undefined

	if (tag === null || tag === undefined || tag === "") return undefined

	if (!LOCALES.has(tag)) {
		let locale: string | undefined

		try {
			locale = Intl.getCanonicalLocales(tag)[0]
		} catch {
			locale = undefined
		}

		LOCALES.set(tag, locale)
	}

	return LOCALES.get(tag)
}

// The case Change Case gives `text` first: undefined when it has no cased letters.
export function firstCaseMode(text: string): CaseMode | undefined {
	const upper = UPPER.test(text)
	const lower = LOWER.test(text)

	if (!upper && !lower) return undefined

	return lower && !upper ? "title" : upper && !lower ? "lower" : "upper"
}

// Where words start in `text` (1 at a word's first character).
function wordStarts(text: string): Uint8Array {
	const starts = new Uint8Array(text.length)
	const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter

	if (Segmenter !== undefined) {
		for (const segment of new Segmenter(undefined, { granularity: "word" }).segment(text)) {
			if (segment.isWordLike === true) starts[segment.index] = 1
		}

		return starts
	}

	for (let k = 0; k < text.length; k++) {
		if (LETTER.test(text.charAt(k)) && (k === 0 || !/[\p{L}\p{N}\p{M}'’]/u.test(text.charAt(k - 1)))) starts[k] = 1
	}

	return starts
}

function mapped(piece: TextPiece, mode: CaseMode, starts: Uint8Array | undefined): string {
	const locale = localeOf(piece.node)
	const text = piece.text

	if (mode === "upper") return text.toLocaleUpperCase(locale)
	if (mode === "lower" || starts === undefined) return text.toLocaleLowerCase(locale)

	let out = ""
	let k = 0

	while (k < text.length) {
		if (starts[piece.offset + k] === 1) {
			const pair = (text.charCodeAt(k) & 0xfc00) === 0xd800 && (text.charCodeAt(k + 1) & 0xfc00) === 0xdc00

			out += text.slice(k, k + (pair ? 2 : 1)).toLocaleUpperCase(locale)
			k += pair ? 2 : 1

			continue
		}

		let end = k + 1

		while (end < text.length && starts[piece.offset + end] !== 1) end++

		out += text.slice(k, end).toLocaleLowerCase(locale)
		k = end
	}

	return out
}

// The run text of `ranges`, in document order.
function textPieces(doc: Node, ranges: readonly { readonly from: number; readonly to: number }[]): { pieces: TextPiece[]; text: string } {
	const pieces: TextPiece[] = []
	let text = ""

	for (const { from, to } of ranges) {
		doc.nodesBetween(from, to, (node, pos, parent) => {
			if (!node.isInline) return node.type !== nodes.locked_block

			if (node.isText && parent !== null && parent.type === nodes.paragraph && !isDeleted(node)) {
				const start = Math.max(from, pos)
				const end = Math.min(to, pos + node.nodeSize)
				const last = pieces[pieces.length - 1]

				if (end > start) {
					// Text apart (another paragraph, an object between) is another word.
					if (last !== undefined && last.to !== start) text += "\n"

					const slice = (node.text ?? "").slice(start - pos, end - pos)

					pieces.push({ from: start, to: end, node, text: slice, offset: text.length })
					text += slice
				}
			}

			return false
		})
	}

	return { pieces, text }
}

// Replaces only what differs between `before` and `after` (never splitting a surrogate pair), so the rest of
// the run, and a tracked change's record of it, stays.
function replaceDiff(tr: Transaction, piece: TextPiece, after: string): void {
	const before = piece.text
	let head = 0

	while (head < before.length && head < after.length && before.charCodeAt(head) === after.charCodeAt(head)) head++

	if (head > 0 && (before.charCodeAt(head - 1) & 0xfc00) === 0xd800) head--

	let tail = 0

	while (
		tail < before.length - head &&
		tail < after.length - head &&
		before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
	)
		tail++

	if (tail > 0 && (before.charCodeAt(before.length - tail) & 0xfc00) === 0xdc00) tail--

	const from = piece.from + head
	const to = piece.to - tail
	const middle = after.slice(head, after.length - tail)

	if (middle === "") tr.delete(from, to)
	else tr.replaceWith(from, to, docxSchema.text(middle, piece.node.marks))
}

export function changeCase(context: StoryCommandContext): Transaction | null {
	const state = context.state
	const selection = state.selection
	const word = selection.empty ? wordAround(state) : undefined

	if (selection.empty && word === undefined) return null

	const ranges = word === undefined ? selection.ranges.map(range => ({ from: range.$from.pos, to: range.$to.pos })) : [word]
	const { pieces, text } = textPieces(state.doc, ranges)
	let mode = firstCaseMode(text)

	if (mode === undefined) return null

	let starts: Uint8Array | undefined
	let results: string[] = []

	for (let tries = 0; tries < 3; tries++, mode = NEXT[mode]) {
		if (mode === "title") starts ??= wordStarts(text)

		const current = mode

		results = pieces.map(piece => mapped(piece, current, starts))

		if (results.some((result, k) => result !== pieces[k]?.text)) break
	}

	const tr = state.tr
	const caret = selection.empty ? selection.from : undefined
	let shift = 0

	for (let k = pieces.length - 1; k >= 0; k--) {
		const piece = pieces[k] as TextPiece
		const result = results[k] ?? piece.text

		if (result === piece.text) continue

		replaceDiff(tr, piece, result)

		if (caret !== undefined) {
			if (piece.to <= caret) shift += result.length - piece.text.length
			else if (piece.from < caret) shift += Math.min(caret - piece.from, result.length) - (caret - piece.from)
		}
	}

	if (!tr.docChanged) return null

	// The caret stays where it was in the word (a replaced span would carry it to its end).
	if (caret !== undefined) tr.setSelection(TextSelection.create(tr.doc, caret + shift))

	return tr.scrollIntoView()
}

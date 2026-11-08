import { Slice, type Mark, type Node } from "prosemirror-model"
import { AllSelection, TextSelection } from "prosemirror-state"
import { canJoin, canSplit } from "prosemirror-transform"
import {
	DOCX_PARAGRAPH_STYLES,
	docxSchema,
	enterStory,
	exitStory,
	freshSlice,
	joinBackward,
	splitParagraph,
	storiesOf,
	type DocxEditorSession,
	type DocxParagraphStyle
} from "../harness"
import { replaceAll } from "@filen/office/core/docx/edit"
import type { EditOp, OpContext, Rand } from "./index"

// The edits of the editing foundations: typing, deleting, paragraphs, formatting, styles, lists, links, table
// cells, undo, paste and header/footer/note stories.

const nodes = docxSchema.nodes
const marks = docxSchema.marks

function pick<T>(rand: Rand, list: readonly T[]): T {
	return list[Math.floor(rand() * list.length)] as T
}

// ---- paged: what a user does ----

const WORDS = ["lorem", "ipsum", "Filen", "Kraków", "naïve", "dolor", "sit", "amet,", "consectetur", "x", "W", "—", "supercalifragilistic"]

function words(rand: Rand, count: number): string {
	return Array.from({ length: count }, () => pick(rand, WORDS)).join(" ")
}

function selectBetween(session: DocxEditorSession, a: number, b: number = a): void {
	const doc = session.state.doc

	session.dispatch(session.state.tr.setSelection(TextSelection.between(doc.resolve(Math.min(a, b)), doc.resolve(Math.max(a, b)))))
}

// Positions inside text (and in empty textblocks), in table cells only, outside them only, or anywhere.
export function textPositions(doc: Node, inCells?: boolean): number[] {
	const out: number[] = []

	doc.descendants((node, pos, parent) => {
		if (!node.isTextblock) return true

		if (inCells === undefined || inCells === (parent?.type === nodes.table_cell)) {
			const before = out.length

			node.forEach((child, offset) => {
				if (child.isText) for (let k = 0; k <= child.nodeSize; k++) out.push(pos + 1 + offset + k)
			})

			// A paragraph without text (empty, or only a picture or a break) is typed into at its start and end.
			if (out.length === before) out.push(...(node.content.size === 0 ? [pos + 1] : [pos + 1, pos + node.nodeSize - 1]))
		}

		return false
	})

	return out
}

function positionIn(context: OpContext, cells?: boolean): number | undefined {
	const positions = textPositions(context.session.state.doc, cells)

	return positions.length === 0 ? undefined : pick(context.rand, positions)
}

// Every textblock's start (`end` false) or end position.
function textblockEdges(doc: Node, end: boolean): number[] {
	const out: number[] = []

	doc.descendants((node, pos) => {
		if (!node.isTextblock) return true

		out.push(end ? pos + node.nodeSize - 1 : pos + 1)

		return false
	})

	return out
}

const FORMAT_COMMANDS = [
	"format.bold",
	"format.italic",
	"format.underline",
	"format.strike",
	"format.clear",
	"align.center",
	"align.justify",
	"align.end"
] as const
const PAGED_STYLES = ["heading1", "heading2", "normal"] as const
const LIST_COMMANDS = ["list.bullet", "list.numbered", "list.indent", "list.outdent"] as const
const NOTE_KINDS = new Set(["header", "footer", "footnote", "endnote"])

// ---- scripted suite: one edit per op, each on its own paragraph ----

// Body (or table cell) paragraphs that start with text of at least 8 characters.
function scriptParagraphs(doc: Node, inTables: boolean): { node: Node; pos: number }[] {
	const out: { node: Node; pos: number }[] = []

	doc.descendants((node, pos, parent) => {
		if (node.type === nodes.paragraph) {
			if ((parent?.type === nodes.table_cell) === inTables && node.textContent.length >= 8 && node.firstChild?.isText === true)
				out.push({ node, pos })

			return false
		}

		return !node.isInline
	})

	return out
}

function scriptParagraph(session: DocxEditorSession, index: number, inTables = false): { node: Node; pos: number } | undefined {
	const list = scriptParagraphs(session.state.doc, inTables)

	return list[Math.min(list.length - 1, index)]
}

function selectRange(session: DocxEditorSession, from: number, to: number = from): void {
	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
}

// ---- damage: raw transactions ----

const DAMAGE_WORDS = [
	"Filen",
	" ",
	"  lead",
	"trail  ",
	"a",
	"<&>\"'",
	"ü€\u{1f600}",
	" ",
	"x\ty",
	"tab\t",
	"​",
	"lorem ipsum ",
	" ",
	"]]>",
	"Z"
]

function damageText(rand: Rand): string {
	let text = ""
	const count = 1 + Math.floor(rand() * 3)

	for (let i = 0; i < count; i++) text += DAMAGE_WORDS[Math.floor(rand() * DAMAGE_WORDS.length)]

	return text
}

// Paragraphs, not inside locked blocks.
export function textblocks(doc: Node): { node: Node; pos: number }[] {
	const out: { node: Node; pos: number }[] = []

	doc.descendants((node, pos) => {
		if (node.type === nodes.paragraph) {
			out.push({ node, pos })

			return false
		}

		return !node.isInline && node.type !== nodes.locked_block
	})

	return out
}

export function inlinePosition(rand: Rand, doc: Node): number | undefined {
	const blocks = textblocks(doc)

	if (blocks.length === 0) return undefined

	const block = blocks[Math.floor(rand() * blocks.length)] as { node: Node; pos: number }

	return block.pos + 1 + Math.floor(rand() * (block.node.content.size + 1))
}

// A second inline position after `from`, within a few paragraphs.
export function nearPosition(rand: Rand, doc: Node, from: number): number | undefined {
	const blocks = textblocks(doc)
	const index = blocks.findIndex(block => block.pos + block.node.nodeSize > from)

	if (index < 0) return undefined

	const k = Math.min(blocks.length - 1, index + (rand() < 0.5 ? 0 : Math.floor(rand() * 4)))
	const block = blocks[k] as { node: Node; pos: number }
	const low = Math.max(0, k === index ? from - block.pos - 1 : 0)

	return block.pos + 1 + low + Math.floor(rand() * (block.node.content.size - low + 1))
}

const DAMAGE_COMMANDS = [
	"format.bold",
	"format.italic",
	"format.underline",
	"format.strike",
	"format.clear",
	"align.start",
	"align.center",
	"align.end",
	"align.justify",
	"list.bullet",
	"list.numbered",
	"list.indent",
	"list.outdent",
	"history.undo",
	"history.redo"
] as const

function undoRedo(context: OpContext, most: number): string {
	const rand = context.rand
	const type = rand() < 0.6 ? "history.undo" : "history.redo"
	const count = 1 + Math.floor(rand() * most)

	for (let i = 0; i < count; i++) context.session.execute({ type })

	return `${type} x${count}`
}

// Types `text` at a random inline position, as an author (where changes are tracked typing needs one), trying
// others where typing is refused (a locked block, a control); whether it typed.
export function typeSomewhere(session: DocxEditorSession, rand: Rand, text: string): boolean {
	if (!session.context.identity.author) session.context.identity.author = "Fuzz"

	for (let attempt = 0; attempt < 16; attempt++) {
		const position = inlinePosition(rand, session.state.doc)

		if (position === undefined) return false

		const before = session.state.doc

		session.dispatch(session.state.tr.insertText(text, position))

		if (session.state.doc !== before) return true
	}

	return false
}

// Drops whole top-level blocks somewhere else, as a drag and drop does.
function blockMove(context: OpContext): string {
	const rand = context.rand
	const doc = context.session.state.doc
	const count = doc.childCount

	// A paragraph ending a section moves only with a section command (an edit taking it out is refused).
	const movable = (k: number): boolean => ((doc.child(k).attrs["sectPr"] as number | undefined) ?? -1) < 0
	const firsts: number[] = []

	for (let k = 0; k < count - 1; k++) if (movable(k)) firsts.push(k)

	if (firsts.length === 0) return "noop"

	const first = firsts[Math.floor(rand() * firsts.length)] ?? 0
	let last = first

	for (let more = Math.floor(rand() * 3); more > 0 && last < count - 2 && movable(last + 1); more--) last++

	// Before any block, or after the last.
	const target = Math.floor(rand() * (count + 1))

	if (target >= first && target <= last + 1) return "noop"

	let from = 0

	for (let k = 0; k < first; k++) from += doc.child(k).nodeSize

	let to = from

	for (let k = first; k <= last; k++) to += doc.child(k).nodeSize

	let at = 0

	for (let k = 0; k < target; k++) at += doc.child(k).nodeSize

	const slice = doc.slice(from, to)
	const label = `blockMove(${first}..${last} -> ${target})`
	const review = context.session.context.review

	// Moves are checked as blocks kept byte for byte: untracked (a tracked move records a deletion and an
	// insertion instead), as with tracking switched off for the move; the document's setting stays as it was.
	const tracking = review.tracking

	review.tracking = false

	try {
		return `${label} -> ${context.transact(label, tr => {
			tr.delete(from, to)

			const mapped = tr.mapping.map(at)

			return tr.replaceRange(mapped, mapped, slice).setMeta("uiEvent", "drop")
		})}`
	} finally {
		review.tracking = tracking
	}
}

function range(context: OpContext): { doc: Node; a: number; b: number } | undefined {
	const doc = context.session.state.doc
	const a = inlinePosition(context.rand, doc)

	if (a === undefined) return undefined

	return { doc, a, b: nearPosition(context.rand, doc, a) ?? a }
}

function damage(name: string, weight: number, run: (context: OpContext) => string): EditOp {
	return { name, harness: "damage", weight, run }
}

// What typing into a bound content control may write besides the main part: the custom XML item or properties part
// the control stores its value in.
export const BOUND_WRITES = [
	"application/xml",
	"application/vnd.openxmlformats-officedocument.extended-properties+xml",
	"application/vnd.openxmlformats-package.core-properties+xml"
]

export const baseOps: readonly EditOp[] = [
	{
		name: "type",
		harness: "paged",
		run(context) {
			const session = context.session
			const p = positionIn(context)

			if (p === undefined) return "noop"

			selectBetween(session, p)

			const text =
				(context.rand() < 0.2
					? words(context.rand, 60 + Math.floor(context.rand() * 200))
					: words(context.rand, 1 + Math.floor(context.rand() * 4))) + " "

			session.dispatch(session.state.tr.insertText(text))

			return `type@${p} ${text.length}`
		},
		script: {
			order: 10,
			run({ session }) {
				const target = scriptParagraph(session, 0)

				return target !== undefined && session.dispatch(session.state.tr.insertText("Filen ", target.pos + 1))
			}
		},
		writes: BOUND_WRITES
	},
	{
		name: "typeEnd",
		harness: "paged",
		run(context) {
			const session = context.session
			const ends = textblockEdges(session.state.doc, true)

			if (ends.length === 0) return "noop"

			const p = pick(context.rand, ends)

			selectBetween(session, p)
			session.dispatch(session.state.tr.insertText(words(context.rand, 3) + " "))

			return `typeEnd@${p}`
		}
	},
	{
		name: "delete",
		harness: "paged",
		run(context) {
			const session = context.session
			const rand = context.rand
			const size = session.state.doc.content.size
			const a = Math.floor(rand() * size)
			const b = Math.min(size, a + Math.floor(rand() * (rand() < 0.3 ? 2000 : 40)))

			selectBetween(session, a, b)
			session.dispatch(session.state.tr.deleteSelection())

			return `delete ${a}-${b}`
		},
		script: {
			order: 20,
			run({ session }) {
				const target = scriptParagraph(session, 1)

				return target !== undefined && session.dispatch(session.state.tr.delete(target.pos + 2, target.pos + 5))
			}
		}
	},
	{
		name: "enter",
		harness: "paged",
		run(context) {
			const session = context.session
			const p = positionIn(context)

			if (p === undefined) return "noop"

			selectBetween(session, p)

			const tr = splitParagraph(session.state, session.formats)

			if (tr) session.dispatch(tr)

			return `enter@${p}`
		},
		script: {
			order: 60,
			run({ session }) {
				const target = scriptParagraph(session, 5)

				return target !== undefined && session.dispatch(session.state.tr.split(target.pos + 4))
			}
		}
	},
	{
		name: "join",
		harness: "paged",
		run(context) {
			const session = context.session
			const starts = textblockEdges(session.state.doc, false)

			if (starts.length === 0) return "noop"

			const p = pick(context.rand, starts)

			selectBetween(session, p)

			const tr = joinBackward(session.state, session.formats)

			if (tr) session.dispatch(tr)

			return `join@${p}`
		},
		script: {
			order: 70,
			run({ session }) {
				const list = scriptParagraphs(session.state.doc, false)

				for (let k = 6; k + 1 < list.length; k++) {
					const first = list[k]
					const second = list[k + 1]

					if (first === undefined || second === undefined || first.pos + first.node.nodeSize !== second.pos) continue
					if (session.dispatch(session.state.tr.join(second.pos))) return true
				}

				return false
			}
		}
	},
	{
		name: "format",
		harness: "paged",
		run(context) {
			const session = context.session
			const p = positionIn(context)

			if (p === undefined) return "noop"

			const q = Math.min(session.state.doc.content.size, p + Math.floor(context.rand() * 300))

			selectBetween(session, p, q)

			const type = pick(context.rand, FORMAT_COMMANDS)

			context.execute(type, { type })

			return `${type} ${p}-${q}`
		},
		script: {
			order: 30,
			run({ session }) {
				const target = scriptParagraph(session, 2)

				if (target === undefined) return false

				selectRange(session, target.pos + 1, target.pos + 5)

				return session.execute({ type: "format.bold" })
			}
		}
	},
	{
		// The whole document formatted (laid out in the idle slices after it); named in the op filter to run.
		name: "formatAll",
		harness: "paged",
		weight: 0,
		run(context) {
			const session = context.session

			session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))

			const type = pick(context.rand, FORMAT_COMMANDS)

			context.execute(type, { type })

			return `${type} all`
		}
	},
	{
		// Replace All of a common letter, word or space over the story; named in the op filter to run.
		name: "replaceAll",
		harness: "paged",
		weight: 0,
		run(context) {
			const session = context.session
			const query = pick(context.rand, ["e", "the", " "])
			const replaced = replaceAll(session.state, query, pick(context.rand, ["E", "", "  "]))

			return replaced === null || !("tr" in replaced)
				? "noop"
				: `replaceAll ${JSON.stringify(query)} ${String(session.dispatch(replaced.tr))}`
		}
	},
	{
		name: "style",
		harness: "paged",
		run(context) {
			const session = context.session
			const p = positionIn(context)

			if (p === undefined) return "noop"

			selectBetween(session, p)

			const style = pick(context.rand, PAGED_STYLES)

			context.execute("style.set", { type: "style.set", style })

			return `style ${style}@${p}`
		},
		script: {
			order: 40,
			run({ session }) {
				const target = scriptParagraph(session, 3)

				if (target === undefined) return false

				selectRange(session, target.pos + 1)

				return session.execute({ type: "style.set", style: "heading2" })
			}
		}
	},
	{
		name: "list",
		harness: "paged",
		run(context) {
			const session = context.session
			const p = positionIn(context)

			if (p === undefined) return "noop"

			selectBetween(session, p, Math.min(session.state.doc.content.size, p + Math.floor(context.rand() * 200)))

			const type = pick(context.rand, LIST_COMMANDS)

			context.execute(type, { type })

			return `${type}@${p}`
		},
		script: {
			order: 50,
			run({ session }) {
				const target = scriptParagraph(session, 4)

				if (target === undefined) return false

				selectRange(session, target.pos + 1)

				return session.execute({ type: "list.bullet" })
			}
		}
	},
	{
		name: "link",
		harness: "paged",
		run(context) {
			const session = context.session
			const p = positionIn(context)

			if (p === undefined) return "noop"

			const q = Math.min(session.state.doc.content.size, p + 10)
			const link = marks.link.create({ src: -1, target: "https://filen.io/", anchor: null, tooltip: null })

			try {
				session.dispatch(session.state.tr.addMark(p, q, link))
			} catch (error) {
				return `link-fail ${String(error)}`
			}

			return `link ${p}-${q}`
		},
		script: {
			order: 90,
			run({ session }) {
				const target = scriptParagraph(session, 7)

				if (target === undefined) return false

				const link = marks.link.create({ target: "https://filen.io/" })

				return session.dispatch(session.state.tr.addMark(target.pos + 1, target.pos + 4, link))
			}
		}
	},
	{
		name: "cell",
		harness: "paged",
		run(context) {
			const session = context.session
			const p = positionIn(context, true)

			if (p === undefined) return "noop"

			selectBetween(session, p)

			if (context.rand() < 0.3) {
				const tr = splitParagraph(session.state, session.formats)

				if (tr) session.dispatch(tr)

				return `cellEnter@${p}`
			}

			session.dispatch(session.state.tr.insertText(words(context.rand, 2 + Math.floor(context.rand() * 30)) + " "))

			return `cell@${p}`
		},
		script: {
			order: 80,
			run({ session }) {
				const target = scriptParagraph(session, 0, true)

				return target !== undefined && session.dispatch(session.state.tr.insertText("cell ", target.pos + 1))
			}
		}
	},
	{
		name: "undo",
		harness: "paged",
		run(context) {
			context.execute("history.undo", { type: "history.undo" })

			return "undo"
		}
	},
	{
		name: "redo",
		harness: "paged",
		run(context) {
			context.execute("history.redo", { type: "history.redo" })

			return "redo"
		}
	},
	{
		name: "paste",
		harness: "paged",
		run(context) {
			const session = context.session
			const size = session.state.doc.content.size
			const a = Math.floor(context.rand() * size)
			const b = Math.min(size, a + Math.floor(context.rand() * 600))
			let slice: Slice

			try {
				slice = session.state.doc.slice(a, b)
			} catch {
				return "noop"
			}

			const p = positionIn(context)

			if (p === undefined) return "noop"

			selectBetween(session, p)

			try {
				session.dispatch(session.state.tr.replaceSelection(slice))
			} catch {
				return "paste-fail"
			}

			return `paste ${a}-${b}@${p}`
		}
	},
	{
		name: "story",
		harness: "paged",
		run(context) {
			const editor = context.editor

			if (editor === undefined) return "noop"

			const stories = storiesOf(editor)
			const candidates: number[] = []

			stories.forEach((story, index) => {
				if (NOTE_KINDS.has(story.kind)) candidates.push(index)
			})

			if (candidates.length === 0) return "noop"

			const index = pick(context.rand, candidates)

			if (!enterStory(editor, index)) return `enter-fail ${index}`

			const session = editor.session
			const p = positionIn(context)

			if (p !== undefined) {
				selectBetween(session, p)
				session.dispatch(
					session.state.tr.insertText((context.rand() < 0.3 ? words(context.rand, 40) : words(context.rand, 2)) + " ")
				)
			}

			if (context.rand() < 0.2 && p !== undefined) {
				const tr = splitParagraph(session.state, session.formats)

				if (tr) session.dispatch(tr)
			}

			exitStory(editor)

			return `story ${stories[index]?.kind}#${index}@${p}`
		}
	},
	damage("insertText", 2, context => {
		const position = inlinePosition(context.rand, context.session.state.doc)

		if (position === undefined) return "noop"

		const text = damageText(context.rand)
		const label = `insertText(${JSON.stringify(text)}@${position})`

		return `${label} -> ${context.transact(label, tr => tr.insertText(text, position))}`
	}),
	damage("delete", 1, context => {
		const doc = context.session.state.doc
		const a = inlinePosition(context.rand, doc)

		if (a === undefined) return "noop"

		const b = nearPosition(context.rand, doc, a)

		if (b === undefined || b <= a) return "noop"

		const label = `delete(${a},${b})`

		return `${label} -> ${context.transact(label, tr => tr.delete(a, b))}`
	}),
	damage("rawDelete", 1, context => {
		const rand = context.rand
		const size = context.session.state.doc.content.size
		const a = 1 + Math.floor(rand() * (size - 1))
		const b = Math.min(size, a + 1 + Math.floor(rand() * rand() * 400))
		const label = `rawDelete(${a},${b})`

		return `${label} -> ${context.transact(label, tr => tr.delete(a, b))}`
	}),
	damage("deleteRange", 1, context => {
		const rand = context.rand
		const size = context.session.state.doc.content.size
		const a = 1 + Math.floor(rand() * (size - 1))
		const b = Math.min(size, a + 1 + Math.floor(rand() * rand() * 400))
		const label = `deleteRange(${a},${b})`

		return `${label} -> ${context.transact(label, tr => tr.deleteRange(a, b))}`
	}),
	damage("command", 3, context => {
		const target = range(context)

		if (target === undefined) return "noop"

		const type = DAMAGE_COMMANDS[Math.floor(context.rand() * DAMAGE_COMMANDS.length)] as (typeof DAMAGE_COMMANDS)[number]

		selectRange(context.session, target.a, Math.max(target.a, target.b))

		const label = `sel(${target.a},${target.b}) ${type}`

		return `${label} -> ${context.execute(label, { type })}`
	}),
	damage("style", 1, context => {
		const target = range(context)

		if (target === undefined) return "noop"

		const style = DOCX_PARAGRAPH_STYLES[Math.floor(context.rand() * DOCX_PARAGRAPH_STYLES.length)] as DocxParagraphStyle

		selectRange(context.session, target.a, Math.max(target.a, target.b))

		const label = `sel(${target.a},${target.b}) style.set ${style}`

		return `${label} -> ${context.execute(label, { type: "style.set", style })}`
	}),
	damage("split", 1, context => {
		const position = inlinePosition(context.rand, context.session.state.doc)

		if (position === undefined) return "noop"

		const depth = context.rand() < 0.8 ? 1 : 2
		const label = `split(${position},${depth})`

		return `${label} -> ${context.transact(label, tr => (canSplit(tr.doc, position, depth) ? tr.split(position, depth) : tr))}`
	}),
	damage("join", 1, context => {
		const blocks = textblocks(context.session.state.doc)

		if (blocks.length < 2) return "noop"

		const at = (blocks[1 + Math.floor(context.rand() * (blocks.length - 1))] as { pos: number }).pos
		const label = `join(${at})`

		return `${label} -> ${context.transact(label, tr => (canJoin(tr.doc, at) ? tr.join(at) : tr))}`
	}),
	// Internal paste (sanitised, as the clipboard does).
	damage("paste", 2, context => {
		const source = range(context)

		if (source === undefined) return "noop"

		const slice = freshSlice(source.doc.slice(source.a, Math.max(source.a, source.b)))
		const at = inlinePosition(context.rand, source.doc) as number
		const to = context.rand() < 0.5 ? at : (nearPosition(context.rand, source.doc, at) ?? at)
		const label = `paste(${source.a},${source.b} -> ${at},${to})`

		return `${label} -> ${context.transact(label, tr => tr.replaceRange(at, Math.max(at, to), slice))}`
	}),
	// Drag-move: identity kept, as ProseMirror's drop does.
	damage("move", 1, context => {
		const source = range(context)

		if (source === undefined || source.b <= source.a) return "noop"

		const { doc, a, b } = source
		const slice = doc.slice(a, b)
		const at = inlinePosition(context.rand, doc) as number

		if (at >= a && at <= b) return "noop"

		const label = `move(${a},${b} -> ${at})`

		return `${label} -> ${context.transact(label, tr => {
			tr.setSelection(TextSelection.create(tr.doc, a, b)).deleteSelection()

			const mapped = tr.mapping.map(at)

			return tr.replaceRange(mapped, mapped, slice).setMeta("uiEvent", "drop")
		})}`
	}),
	// Unsanitised copy (a host transaction, a drag-copy without handleDrop).
	damage("rawCopy", 1, context => {
		const source = range(context)

		if (source === undefined) return "noop"

		const slice = source.doc.slice(source.a, Math.max(source.a, source.b))
		const at = inlinePosition(context.rand, source.doc) as number
		const label = `rawCopy(${source.a},${source.b} -> ${at})`

		return `${label} -> ${context.transact(label, tr => tr.replaceRange(at, at, slice))}`
	}),
	damage("link", 1, context => {
		const source = range(context)

		if (source === undefined || source.b <= source.a) return "noop"

		const { a, b } = source
		const rand = context.rand
		const choices = [
			{ target: "https://filen.io/" + damageText(rand).replace(/\s/g, ""), anchor: null },
			{ target: 'https://e.x/?a=1&b="2"<3>', anchor: null },
			{ target: null, anchor: "_Toc" + Math.floor(rand() * 1000) },
			{ target: "mailto:x@y.z", anchor: null, tooltip: "tip & <t>" },
			{ target: "", anchor: null }
		]
		const attrs = pick(rand, choices)

		if (rand() < 0.3) {
			const label = `removeLink(${a},${b})`

			return `${label} -> ${context.transact(label, tr => tr.removeMark(a, b, marks.link))}`
		}

		const label = `link(${a},${b},${JSON.stringify(attrs)})`

		return `${label} -> ${context.transact(label, tr => tr.addMark(a, b, marks.link.create(attrs)))}`
	}),
	damage("insertNode", 1, context => {
		const position = inlinePosition(context.rand, context.session.state.doc)

		if (position === undefined) return "noop"

		const choices: [string, () => Node][] = [
			["tab", () => nodes.tab.create()],
			["br", () => nodes.break.create()],
			["pageBr", () => nodes.break.create({ type: "page" })],
			["field", () => nodes.field.create({ instruction: " PAGE ", result: "1", type: "PAGE" })],
			["fieldEmpty", () => nodes.field.create({ instruction: 'DATE \\@ "d"', result: "", type: "DATE" })],
			["sym", () => nodes.symbol.create({ char: 0xf04a, font: "Wingdings" })],
			["hyphen", () => nodes.hyphen.create()]
		]
		const [name, make] = pick(context.rand, choices)
		const label = `insertNode(${name}@${position})`

		return `${label} -> ${context.transact(label, tr => tr.insert(position, make()))}`
	}),
	// Paragraph attributes set directly, including ids the document lacks.
	damage("setAttrs", 1, context => {
		const rand = context.rand
		const blocks = textblocks(context.session.state.doc)

		if (blocks.length === 0) return "noop"

		const block = pick(rand, blocks)
		const which = Math.floor(rand() * 5)
		const attrs: Record<string, unknown> = { ...block.node.attrs }
		let change: string

		if (which === 0) {
			attrs["align"] = ["center", "both", "left", "end", null][Math.floor(rand() * 5)]
			change = `align=${String(attrs["align"])}`
		} else if (which === 1) {
			attrs["indent"] = rand() < 0.3 ? null : { start: Math.floor(rand() * 2000), hanging: rand() < 0.5 ? 360 : undefined }
			change = `indent=${JSON.stringify(attrs["indent"])}`
		} else if (which === 2) {
			attrs["styleId"] =
				context.styleIds.length > 0 && rand() < 0.8 ? pick(rand, context.styleIds) : rand() < 0.5 ? null : "NoSuchStyle"
			change = `styleId=${String(attrs["styleId"])}`
		} else if (which === 3) {
			attrs["numId"] = context.numIds.length > 0 && rand() < 0.7 ? pick(rand, context.numIds) : rand() < 0.5 ? null : 9999
			attrs["ilvl"] = attrs["numId"] === null ? null : Math.floor(rand() * 3)
			change = `numId=${String(attrs["numId"])},ilvl=${String(attrs["ilvl"])}`
		} else {
			attrs["numId"] = 0
			attrs["ilvl"] = 0
			change = "numId=0"
		}

		const label = `setAttrs(${block.pos},${change})`

		return `${label} -> ${context.transact(label, tr => tr.setNodeMarkup(block.pos, null, attrs))}`
	}),
	// Formatting marks added or removed directly.
	damage("rawMarks", 1, context => {
		const source = range(context)

		if (source === undefined || source.b <= source.a) return "noop"

		const { a, b } = source
		const rand = context.rand
		const makers: [string, () => Mark][] = [
			["bold", () => marks.bold.create({ value: rand() < 0.7 })],
			["italicCs", () => marks.italic.create({ value: null, cs: true })],
			["u-double", () => marks.underline.create({ style: "double" })],
			["color", () => marks.color.create({ value: "FF0000" })],
			["size", () => marks.size.create({ value: 40 })],
			["highlight", () => marks.highlight.create({ value: "yellow" })],
			["charStyle", () => marks.char_style.create({ styleId: context.styleIds[0] ?? "X" })],
			["vert", () => marks.vert_align.create({ value: "superscript" })]
		]
		const [name, make] = pick(rand, makers)

		if (rand() < 0.3) {
			const types = [
				marks.bold,
				marks.italic,
				marks.run,
				marks.content_control,
				marks.insertion,
				marks.deletion,
				marks.wrapper,
				marks.format_change,
				marks.char_style
			]
			const type = pick(rand, types)
			const label = `removeMark(${type.name},${a},${b})`

			return `${label} -> ${context.transact(label, tr => tr.removeMark(a, b, type))}`
		}

		const label = `addMark(${name},${a},${b})`

		return `${label} -> ${context.transact(label, tr => tr.addMark(a, b, make()))}`
	}),
	// A new 2x2 table before a paragraph.
	damage("insertTable", 1, context => {
		const doc = context.session.state.doc
		const blocks = textblocks(doc)

		if (blocks.length === 0) return "noop"

		const block = pick(context.rand, blocks)
		const depth = doc.resolve(block.pos).depth
		const cell = (): Node => nodes.table_cell.create(null, nodes.paragraph.create(null, docxSchema.text("c")))
		const table = nodes.table.create(null, [
			nodes.table_row.create(null, [cell(), cell()]),
			nodes.table_row.create(null, [cell(), cell()])
		])
		const label = `insertTable(${block.pos} depth ${depth})`

		return `${label} -> ${context.transact(label, tr => tr.insert(block.pos, table))}`
	}),
	damage("undoRedo", 1, context => undoRedo(context, 4)),
	// Typing over a selection that may span paragraphs.
	damage("insertTextOver", 1, context => {
		const source = range(context)

		if (source === undefined) return "noop"

		const text = damageText(context.rand)
		const label = `insertTextOver(${source.a},${source.b},${JSON.stringify(text)})`

		return `${label} -> ${context.transact(label, tr => tr.insertText(text, source.a, Math.max(source.a, source.b)))}`
	}),
	damage("blockMove", 0, blockMove)
]

// Undo/redo bursts the damage fuzz's undo mode puts before ops.
export function undoBurst(context: OpContext): string {
	return undoRedo(context, 3)
}

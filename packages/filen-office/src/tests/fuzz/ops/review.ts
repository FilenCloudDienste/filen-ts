import type { Node } from "prosemirror-model"
import { AllSelection, TextSelection } from "prosemirror-state"
import { resolveChanges, reviewIndexWanted, storyReviewIndex, type ReviewScope } from "../../../core/docx/review/accept"
import { ReviewKind } from "../../../core/docx/review/index"
import { flushComposition } from "../../../core/docx/review/track"
import { docxSchema, splitParagraph, type DocxEditorSession } from "../harness"
import { inlinePosition, nearPosition, textPositions } from "./base"
import type { EditOp, OpContext, Rand } from "./index"

// Tracked changes: switching tracking (with the author's name the app asks for), edits recorded while it is on,
// accepting and rejecting at the caret, a selection, by id or all, moving between changes, the markup view and
// IME composition; raw tracked edits and resolutions for the damage fuzz; and a scripted tracked edit of each
// kind.

const nodes = docxSchema.nodes
const AUTHOR = "Filen Fuzz"
const WORDS = ["tracked", "Filen", "x", "naïve", "Kraków", "insertion"]
const MODES = ["all", "simple", "none", "original"] as const

function pick<T>(rand: Rand, list: readonly T[]): T {
	return list[Math.floor(rand() * list.length)] as T
}

// The name an app asks for before anything records it (here it stands for the user's answer).
function withAuthor(session: DocxEditorSession): void {
	const identity = session.context.identity

	if ((identity.author ?? "") === "") {
		identity.author = AUTHOR
		identity.initials = "FF"
	}
}

function trackOn(context: OpContext): void {
	withAuthor(context.session)

	if (!context.session.context.review.tracking) context.execute("review.track", { type: "review.track", on: true })
}

function select(session: DocxEditorSession, from: number, to = from): void {
	const doc = session.state.doc

	session.dispatch(session.state.tr.setSelection(TextSelection.between(doc.resolve(Math.min(from, to)), doc.resolve(Math.max(from, to)))))
}

function words(rand: Rand): string {
	return `${pick(rand, WORDS)} ${pick(rand, WORDS)} `
}

// An id of a change in the story being edited, or undefined.
function changeId(session: DocxEditorSession, rand: Rand): string | undefined {
	if (!reviewIndexWanted(session)) return undefined

	const entries = storyReviewIndex(session)
		.entries()
		.filter(entry => entry.kind > ReviewKind.COMMENT_REFERENCE)

	return entries.length === 0 ? undefined : pick(rand, entries).id
}

function resolveOne(context: OpContext, accept: boolean): string {
	const session = context.session
	const rand = context.rand
	const type = accept ? "review.accept" : "review.reject"
	const choice = rand()

	if (choice < 0.3) {
		const id = changeId(session, rand)

		if (id !== undefined) return `${type} #${id} ${context.execute(type, { type, id })}`
	}

	const a = inlinePosition(rand, session.state.doc)

	if (a === undefined) return "noop"

	const b = choice < 0.65 ? a : (nearPosition(rand, session.state.doc, a) ?? a)

	select(session, a, b)

	return `${type} ${a}-${b} ${context.execute(type, { type })}`
}

// Paragraphs of the story (not in table cells) starting with at least eight characters: the scripted edits'
// targets.
function scriptParagraph(session: DocxEditorSession, index: number): { node: Node; pos: number } | undefined {
	const out: { node: Node; pos: number }[] = []

	session.state.doc.descendants((node, pos, parent) => {
		if (out.length > index) return false

		if (node.type === nodes.paragraph) {
			if (parent?.type !== nodes.table_cell && node.textContent.length >= 8 && node.firstChild?.isText === true)
				out.push({ node, pos })

			return false
		}

		return !node.isInline
	})

	return out[index]
}

function resolveScript(session: DocxEditorSession, index: number, accept: boolean): boolean {
	const target = scriptParagraph(session, index)

	if (target === undefined || !reviewIndexWanted(session)) return false

	const outcome = resolveChanges(session, storyReviewIndex(session), { from: target.pos + 2, to: target.pos + 2 }, accept)

	return outcome.tr !== null && session.dispatch(outcome.tr)
}

function damageScope(rand: Rand, session: DocxEditorSession): ReviewScope | undefined {
	const choice = rand()

	if (choice < 0.25) return { all: true }

	if (choice < 0.5) {
		const id = changeId(session, rand)

		if (id !== undefined) return { id }
	}

	const doc = session.state.doc
	const a = inlinePosition(rand, doc)

	if (a === undefined) return undefined

	return { from: a, to: rand() < 0.5 ? a : Math.max(a, nearPosition(rand, doc, a) ?? a) }
}

export const reviewOps: readonly EditOp[] = [
	{
		name: "track",
		harness: "paged",
		weight: 3,
		run(context) {
			withAuthor(context.session)

			const on = context.rand() < 0.8

			return `track ${String(on)} ${context.execute("review.track", { type: "review.track", on })}`
		},
		// The app has the author's name before the first edit: documents that track revisions record the suite's
		// edits (no edit of its own).
		script: {
			order: 1,
			run({ session }) {
				withAuthor(session)

				return false
			}
		}
	},
	{
		name: "trackedType",
		harness: "paged",
		weight: 3,
		run(context) {
			trackOn(context)

			const session = context.session
			const positions = textPositions(session.state.doc)

			if (positions.length === 0) return "noop"

			const p = pick(context.rand, positions)
			const text = words(context.rand)

			select(session, p)
			session.dispatch(session.state.tr.insertText(text))

			// Taking some of it back again.
			if (context.rand() < 0.4) {
				const head = session.state.selection.head

				session.dispatch(session.state.tr.delete(Math.max(head - 3, session.state.selection.$head.start()), head))
			}

			return `trackedType@${p}`
		},
		script: {
			order: 200,
			run({ session }) {
				const target = scriptParagraph(session, 9)

				if (target === undefined) return false

				withAuthor(session)
				session.context.review.tracking = true

				return session.dispatch(session.state.tr.insertText("Tracked ", target.pos + 1))
			}
		}
	},
	{
		name: "trackedDelete",
		harness: "paged",
		weight: 3,
		run(context) {
			trackOn(context)

			const session = context.session
			const doc = session.state.doc
			const a = inlinePosition(context.rand, doc)

			if (a === undefined) return "noop"

			if (context.rand() < 0.5) {
				// Backspace, a few times.
				let count = 0

				select(session, a)

				for (let k = 0; k < 1 + Math.floor(context.rand() * 4); k++) {
					const head = session.state.selection.head

					if (session.state.doc.resolve(head).parentOffset === 0) break

					session.dispatch(session.state.tr.delete(head - 1, head))
					count++
				}

				return `backspace@${a} x${count}`
			}

			const b = nearPosition(context.rand, doc, a) ?? a

			select(session, a, b)
			session.dispatch(session.state.tr.deleteSelection())

			return `trackedDelete ${a}-${b}`
		},
		script: {
			order: 210,
			run({ session }) {
				const target = scriptParagraph(session, 10)

				return target !== undefined && session.dispatch(session.state.tr.delete(target.pos + 2, target.pos + 5))
			}
		}
	},
	{
		name: "trackedDeleteBlocks",
		harness: "paged",
		run(context) {
			trackOn(context)

			const session = context.session
			const doc = session.state.doc

			// Ctrl+A, Delete: everything stays, marked (section breaks, tables and their rows included).
			if (context.rand() < 0.25) {
				session.dispatch(session.state.tr.setSelection(new AllSelection(doc)).deleteSelection())

				return "trackedDeleteAll"
			}

			// From a text position to one several blocks on (tables between are taken whole).
			const positions = textPositions(doc)

			if (positions.length === 0) return "noop"

			const a = pick(context.rand, positions)
			const later = positions.filter(pos => pos > a + 40).slice(0, 4000)
			const b = later.length === 0 ? (positions[positions.length - 1] ?? a) : pick(context.rand, later)

			select(session, a, b)
			session.dispatch(session.state.tr.deleteSelection())

			return `trackedDeleteBlocks ${a}-${b}`
		}
	},
	{
		name: "trackedEnter",
		harness: "paged",
		run(context) {
			trackOn(context)

			const session = context.session
			const positions = textPositions(session.state.doc)

			if (positions.length === 0) return "noop"

			const p = pick(context.rand, positions)

			select(session, p)

			const tr = splitParagraph(session.state, session.formats)

			if (tr) session.dispatch(tr)

			return `trackedEnter@${p}`
		},
		script: {
			order: 220,
			run({ session }) {
				const target = scriptParagraph(session, 11)

				return target !== undefined && session.dispatch(session.state.tr.split(target.pos + 4))
			}
		}
	},
	{
		name: "trackedFormat",
		harness: "paged",
		run(context) {
			trackOn(context)

			const session = context.session
			const a = inlinePosition(context.rand, session.state.doc)

			if (a === undefined) return "noop"

			const b = nearPosition(context.rand, session.state.doc, a) ?? a
			const type = pick(context.rand, [
				"format.bold",
				"format.italic",
				"format.underline",
				"style.set",
				"align.center",
				"list.bullet"
			] as const)

			select(session, a, b)

			const done = type === "style.set" ? context.execute(type, { type, style: "heading2" }) : context.execute(type, { type })

			return `${type} ${a}-${b} ${done}`
		},
		script: {
			order: 230,
			run({ session }) {
				const target = scriptParagraph(session, 12)

				if (target === undefined) return false

				select(session, target.pos + 1, target.pos + 5)

				return session.execute({ type: "format.bold" })
			}
		}
	},
	{
		name: "trackedStyle",
		harness: "paged",
		weight: 0,
		run: () => "noop",
		script: {
			order: 240,
			run({ session }) {
				const target = scriptParagraph(session, 13)

				if (target === undefined) return false

				select(session, target.pos + 1)

				return session.execute({ type: "style.set", style: "heading2" })
			}
		}
	},
	{
		name: "accept",
		harness: "paged",
		weight: 2,
		run: context => resolveOne(context, true),
		// The scripted format change is accepted.
		script: { order: 250, run: ({ session }) => resolveScript(session, 12, true) }
	},
	{
		name: "reject",
		harness: "paged",
		weight: 2,
		run: context => resolveOne(context, false),
		// The scripted insertion is rejected (gone again); recording stops, so later edits of the suite are not
		// tracked by this one's.
		script: {
			order: 260,
			run({ session }) {
				const done = resolveScript(session, 9, false)

				session.context.review.tracking = session.context.model.settings.trackRevisions

				return done
			}
		}
	},
	{
		name: "resolveAll",
		harness: "paged",
		run(context) {
			const type = context.rand() < 0.5 ? "review.acceptAll" : "review.rejectAll"

			return `${type} ${context.execute(type, { type })}`
		},
		// Last of the suite: the switch turned on is saved into settings.xml.
		script: {
			order: 900,
			run({ session }) {
				const review = session.context.review

				if (review.tracking) return false

				withAuthor(session)
				review.tracking = true

				return true
			}
		},
		writes: ["settings"]
	},
	{
		name: "changeStep",
		harness: "paged",
		run(context) {
			const type = context.rand() < 0.5 ? "review.next" : "review.prev"

			return `${type} ${context.execute(type, { type })}`
		}
	},
	{
		name: "markup",
		harness: "paged",
		run(context) {
			const mode = pick(context.rand, MODES)

			return `markup ${mode} ${context.execute("view.markup", { type: "view.markup", mode })}`
		}
	},
	{
		name: "composition",
		harness: "paged",
		run(context) {
			trackOn(context)

			const session = context.session
			const positions = textPositions(session.state.doc)

			if (positions.length === 0) return "noop"

			const p = pick(context.rand, positions)

			select(session, p)
			session.dispatch(session.state.tr.insertText("か").setMeta("composition", 1))
			session.dispatch(session.state.tr.insertText("な").setMeta("composition", 1))

			return `composition@${p} ${String(flushComposition(session))}`
		}
	},
	// Tracking switched on for a few raw edits of the damage fuzz, then off again (the context is the file's).
	{
		name: "trackedRaw",
		harness: "damage",
		weight: 3,
		run(context) {
			const session = context.session
			const review = session.context.review
			const was = review.tracking
			const log: string[] = []

			withAuthor(session)
			review.tracking = true

			try {
				for (let k = 0; k < 1 + Math.floor(context.rand() * 4); k++) {
					const doc = session.state.doc
					const a = inlinePosition(context.rand, doc)

					if (a === undefined) break

					const b = nearPosition(context.rand, doc, a) ?? a
					const choice = context.rand()

					if (choice < 0.35) log.push(`insert@${a} ${context.transact("insert", tr => tr.insertText(words(context.rand), a))}`)
					else if (choice < 0.7 && b > a) log.push(`delete ${a}-${b} ${context.transact("delete", tr => tr.delete(a, b))}`)
					else if (choice < 0.85) log.push(`split@${a} ${context.transact("split", tr => tr.split(a))}`)
					else {
						select(session, a, b)
						log.push(`bold ${a}-${b} ${context.execute("format.bold", { type: "format.bold" })}`)
					}
				}
			} finally {
				review.tracking = was
			}

			return `trackedRaw ${log.join("; ")}`
		}
	},
	{
		name: "resolveRaw",
		harness: "damage",
		weight: 2,
		run(context) {
			const session = context.session

			if (!reviewIndexWanted(session)) return "noop"

			const scope = damageScope(context.rand, session)

			if (scope === undefined) return "noop"

			const accept = context.rand() < 0.5
			const outcome = resolveChanges(session, storyReviewIndex(session), scope, accept)
			const tr = outcome.tr

			if (tr === null) return "noop"

			return `${accept ? "accept" : "reject"} ${JSON.stringify(scope)} -> ${context.transact("resolve", () => tr)}`
		}
	}
]

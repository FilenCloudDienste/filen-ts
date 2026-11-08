import { Selection, TextSelection } from "prosemirror-state"
import { storyHasTrackedEquations } from "../../math/edit"
import type { PagedEditor } from "../../paged/editor"
import { RevisionView } from "../../model/index"
import {
	movedChange,
	rememberMovedChange,
	resolveChanges,
	reviewIndexWanted,
	storyReviewIndex,
	wantReviewIndex,
	type ReviewScope
} from "../../review/accept"
import { ReviewKind } from "../../review/index"
import { trackTransaction } from "../../review/track"
import type { DocxMarkupView } from "../commands/review"
import type { DocumentCommandContext, DocumentCommandHandler, DocxTransactionTransformer, FeatureHandlers } from "../registry"
import type { DocxEditorSession } from "../session"

// Tracked changes: recording (the transformer), the track switch, accept and reject (at the selection, by id,
// all), moving between changes, and the markup view.

const VIEWS: Readonly<Record<DocxMarkupView, RevisionView>> = {
	all: RevisionView.Markup,
	simple: RevisionView.Final,
	none: RevisionView.Final,
	original: RevisionView.Original
}

function revisionCount(session: DocxEditorSession): number {
	return reviewIndexWanted(session) ? storyReviewIndex(session).revisionCount : 0
}

// The context changed outside a transaction (tracking switched): every session makes its snapshot again.
function refresh(editor: PagedEditor): void {
	for (const session of editor.sessions) session.invalidate()
}

// The stories of a model (by index) whose source has tracked changes (inside its equations too): read once per
// model.
const changedStoriesOf = new WeakMap<object, readonly number[]>()

function changedStories(editor: PagedEditor): readonly number[] {
	const model = editor.body.session.context.model
	let found = changedStoriesOf.get(model)

	if (found !== undefined) return found

	const out = new Set<number>()

	for (const story of model.stories) {
		const part = model.parts[story.part]

		if (part === undefined || story.parent >= 0 || story.item < 0) continue

		// Tracked changes inside its equations (one item each, in no revision table).
		if (storyHasTrackedEquations(part, story.item)) {
			out.add(story.index)

			continue
		}

		if (part.revisions.count === 0) continue

		const document = part.document
		const start = document.start(part.node(story.item))
		const end = document.end(part.node(story.item))

		for (let k = 0; k < part.revisions.count; k++) {
			const at = document.start(part.revisions.node[k] ?? -1)

			if (at >= start && at < end) {
				out.add(story.index)

				break
			}
		}
	}

	found = [...out]
	changedStoriesOf.set(model, found)

	return found
}

// Whether the document has changes: a session's index counts its story (resolved ones are gone), the source
// counts stories no session indexes.
function hasChanges(editor: PagedEditor): boolean {
	const indexed = new Set<number>()

	for (const session of editor.sessions) {
		if (!reviewIndexWanted(session)) continue
		if (storyReviewIndex(session).revisionCount > 0) return true

		indexed.add(session.story.story.index)
	}

	return changedStories(editor).some(index => !indexed.has(index))
}

// Every editable session with changes: those the editor has, and the stories whose source has changes.
function sessionsWithChanges(editor: PagedEditor): DocxEditorSession[] {
	const out = editor.sessions.filter(session => !session.readOnly)
	const opened = new Set(out.map(session => session.story.story.index))

	for (const index of changedStories(editor)) {
		if (opened.has(index)) continue

		const session = editor.storySession(index)

		if (session !== undefined && !session.readOnly) out.push(session)
	}

	return out
}

function resolve(sessions: readonly DocxEditorSession[], scope: ReviewScope, accept: boolean): boolean {
	let done = false

	for (const session of sessions) {
		if (!reviewIndexWanted(session)) continue

		const outcome = resolveChanges(session, storyReviewIndex(session), scope, accept)

		if (outcome.tr !== null && session.dispatch(outcome.tr)) done = true
	}

	return done
}

const resolveOne = <T extends "review.accept" | "review.reject">(accept: boolean): DocumentCommandHandler<T> => ({
	enabled: context => revisionCount(context.session) > 0,
	run(context, command) {
		const selection = context.session.state.selection
		const { id, next } = command as { readonly id?: string; readonly next?: boolean }
		const scope: ReviewScope = id !== undefined ? { id } : { from: selection.from, to: selection.to }

		if (!resolve([context.session], scope, accept)) return false
		// The resolved change is gone: the next one after where it was (none left: done all the same).
		if (next === true) step(context, true)

		return true
	}
})

const resolveAll = <T extends "review.acceptAll" | "review.rejectAll">(accept: boolean): DocumentCommandHandler<T> => ({
	enabled: context => hasChanges(context.editor),
	run: context => resolve(sessionsWithChanges(context.editor), { all: true }, accept)
})

interface Change {
	readonly session: DocxEditorSession
	// The story's place in the order (the body first, then by story index), as comment navigation ranks.
	readonly rank: number
	readonly id: string
	readonly from: number
	readonly to: number
}

function rankOf(editor: PagedEditor, session: DocxEditorSession): number {
	return session === editor.body.session ? -1 : session.story.story.index
}

// The sessions a move can enter (the body and stories on the pages), with those of stories whose source has
// changes made: in the order of their ranks.
function navigableSessions(editor: PagedEditor): DocxEditorSession[] {
	const body = editor.body.session
	const sessions = editor.sessions
	const out = sessions.filter(session => session === body || editor.storyOnPages(session.story.story.index) !== undefined)
	const opened = new Set(sessions.map(session => session.story.story.index))

	for (const index of changedStories(editor)) {
		if (opened.has(index)) continue

		const story = editor.storyOnPages(index)

		if (story !== undefined) out.push(story.session)
	}

	return out.sort((a, b) => rankOf(editor, a) - rankOf(editor, b))
}

// Session `session`'s changes, whole (from the first piece to the last), in the order of their first pieces
// (one inside another's span, as a paragraph's property change inside a deletion across paragraphs, after it).
function storyChanges(editor: PagedEditor, session: DocxEditorSession, out: Change[]): void {
	const spans = new Map<string, { from: number; to: number }>()

	for (const entry of storyReviewIndex(session).entries()) {
		if (entry.kind <= ReviewKind.COMMENT_REFERENCE) continue

		const span = spans.get(entry.id)

		if (span === undefined) spans.set(entry.id, { from: entry.from, to: entry.to })
		else {
			span.from = Math.min(span.from, entry.from)
			span.to = Math.max(span.to, entry.to)
		}
	}

	const rank = rankOf(editor, session)
	const sorted = [...spans].sort((a, b) => a[1].from - b[1].from || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

	for (const [id, span] of sorted) out.push({ session, rank, id, from: span.from, to: span.to })
}

// The change at session `session`'s selection: the one a move selected, or the narrowest the caret is inside.
function currentChange(session: DocxEditorSession, changes: readonly Change[]): string | undefined {
	const last = movedChange(session)

	if (last !== undefined && changes.some(change => change.session === session && change.id === last)) return last

	const { from, to } = session.state.selection
	const here = storyReviewIndex(session).changeAt(from)

	return here !== undefined && (from < to || (here.from < from && Math.max(here.to, here.from + 1) > from)) ? here.id : undefined
}

// Selects change `change` whole, in its story (entered first).
function selectChange(editor: PagedEditor, change: Change): boolean {
	const session = change.session

	if (session !== editor.session && !editor.enterStory(session.story.story.index, -1)) return false

	const state = session.state
	const doc = state.doc
	const size = doc.content.size
	const start = Math.min(size, change.from)
	const end = Math.min(size, change.to)
	const $from = doc.resolve(start)
	// A paragraph mark's entry ends past its paragraph.
	const stop = doc.resolve(end).parent.inlineContent || end === start ? end : end - 1
	const selection =
		$from.parent.inlineContent && doc.resolve(stop).parent.inlineContent
			? TextSelection.create(doc, start, stop)
			: Selection.near($from)
	const tr = state.tr.setSelection(selection).scrollIntoView()

	rememberMovedChange(session, tr.doc, tr.selection, change.id)

	return session.dispatch(tr)
}

// Selects the next (previous) change of the document, across stories (the body, then the other stories on the
// pages by index); past the last (first) one, the first (last) again. The change at the selection is skipped.
function step(context: DocumentCommandContext, forward: boolean): boolean {
	const editor = context.editor
	const active = context.session
	const changes: Change[] = []
	let activeIndexed = false

	for (const session of navigableSessions(editor)) {
		if (!reviewIndexWanted(session)) continue
		if (session === active) activeIndexed = true

		storyChanges(editor, session, changes)
	}

	if (changes.length === 0) return false

	const current = activeIndexed ? currentChange(active, changes) : undefined
	const at = current === undefined ? -1 : changes.findIndex(change => change.session === active && change.id === current)
	let next: number

	if (at >= 0) next = (at + (forward ? 1 : -1) + changes.length) % changes.length
	else {
		const here = rankOf(editor, active)
		const { from, to } = active.state.selection

		next = forward
			? changes.findIndex(change => change.rank > here || (change.rank === here && change.from >= to))
			: changes.findLastIndex(change => change.rank < here || (change.rank === here && change.from < from))

		if (next < 0) next = forward ? 0 : changes.length - 1
	}

	const target = changes[next]

	return target !== undefined && selectChange(editor, target)
}

const move = <T extends "review.next" | "review.prev">(forward: boolean): DocumentCommandHandler<T> => ({
	enabled: context => hasChanges(context.editor),
	run: context => step(context, forward)
})

export const REVIEW_HANDLERS: FeatureHandlers = {
	document: {
		"review.track": {
			enabled: () => true,
			run(context, command) {
				const review = context.context.review
				const on = command.on ?? !review.tracking

				// Recording names its author (the app asks for it first).
				if (on && (context.context.identity.author ?? "") === "") return false
				if (review.tracking === on) return true

				review.tracking = on

				if (on) for (const session of context.editor.sessions) wantReviewIndex(session)

				refresh(context.editor)

				return true
			}
		},
		"review.accept": resolveOne(true),
		"review.reject": resolveOne(false),
		"review.acceptAll": resolveAll(true),
		"review.rejectAll": resolveAll(false),
		"review.next": move(true),
		"review.prev": move(false),
		"view.markup": {
			enabled: () => true,
			run(context, command) {
				context.editor.setView(VIEWS[command.mode])

				return true
			}
		}
	}
}

// Records edits as tracked changes while the document's review.tracking is on.
export const REVIEW_TRANSFORMER: DocxTransactionTransformer | null = trackTransaction

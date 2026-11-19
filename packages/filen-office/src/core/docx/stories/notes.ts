import { Fragment, Slice, type Mark, type Node } from "prosemirror-model"
import { NodeSelection, TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import { MAX_NOTE_MARK, type DocxNoteKind } from "../edit/commands/notes"
import type { DocxEditContext } from "../edit/context"
import { builtInStyleId } from "../edit/formats"
import { freshSlice, markCommand, markInternal, writableNew } from "../edit/invariants/index"
import { wantReviewIndex } from "../review/index"
import { NO_SOURCE, WRAPPER_MARKS, docxSchema } from "../edit/schema"
import { sourceCopies, type DocxEditorSession } from "../edit/session"
import type { Story } from "../model/index"
import type { PagedEditor } from "../paged/editor"
import { cloneNote, copySessions } from "./clone"
import { revisionStamp } from "../review/track"
import { hasStyleDefinition } from "../write/styles"

// Footnotes and endnotes: a note is a story of its own (Word's w:footnote / w:endnote) and a reference to it in
// the body (a note_ref). Inserting one adds the story through the paged editor (it is saved only while a
// reference to it exists) and the reference at the caret; deleting the reference deletes the note, as Word does
// (the save leaves out a note nothing refers to). Converting moves a note's content into a new note of the
// other kind. Notes live in the main document's text only, as in Word (not in headers, footers, comments or
// other notes).

const nodes = docxSchema.nodes
const marks = docxSchema.marks
const WRAPPERS: ReadonlySet<unknown> = new Set(WRAPPER_MARKS.map(name => marks[name]))
const MARK_KINDS: Readonly<Record<DocxNoteKind, string>> = { footnote: "FootnoteMark", endnote: "EndnoteMark" }

// A note as the caret finds it: its kind and id, its story, and where its reference is in the body.
export interface DocxNoteAt {
	readonly kind: DocxNoteKind
	readonly id: string
	readonly story: number
	// The reference's position in the body, -1 when there is none.
	readonly reference: number
}

function otherKind(kind: DocxNoteKind): DocxNoteKind {
	return kind === "footnote" ? "endnote" : "footnote"
}

// A built-in style's id where the document has it or the writer can define it, else undefined.
function styleOf(context: DocxEditContext, name: string, type: "paragraph" | "character"): string | undefined {
	const existing = context.styles.byName(name, type)

	if (existing !== undefined) return existing.id

	return hasStyleDefinition(name) ? builtInStyleId(context, name) : undefined
}

// The marks of a note's number (its reference, and its mark in the note): the reference style, else (a
// document that cannot get it) superscript as the style makes it.
function referenceMarks(context: DocxEditContext, kind: DocxNoteKind): readonly Mark[] {
	const style = styleOf(context, `${kind} reference`, "character")

	return style === undefined ? [marks.vert_align.create({ value: "superscript" })] : [marks.char_style.create({ styleId: style })]
}

// What a copy of a note keeps of an atom freshSlice leaves out of a paste (content kept as its source bytes,
// what the editor made): the atom to stand where it stood, undefined to leave it out as a paste does (a range
// marker or comment reference stays with the original; a spelling mark, a rendered break), or null where it
// cannot be kept (the copy is refused: nothing is dropped).
type KeepAtom = (atom: Node) => Node | undefined | null

// Atoms a copy leaves out as a paste does.
const LEFT_WITH_ORIGINAL = new Set([nodes.marker, nodes.comment_ref, nodes.proof_err, nodes.rendered_break])
// Atoms written from their source bytes (or, made by the editor, from what they carry).
const BYTE_ATOMS = new Set([nodes.drawing, nodes.run_object, nodes.math, nodes.opaque_inline])
// Stands for a kept atom while the rest is made new: U+FFFF, which no XML text holds.
const KEPT = "\uffff"

// `content` (built from part `origin`) made new as freshSlice makes a copy of it for part `target`, each atom it
// leaves out kept as `keep` says where it stood; undefined where something cannot be kept (a block kept as its
// bytes, an atom `keep` refuses).
function renewedKeeping(content: Fragment, context: DocxEditContext, origin: number, target: number, keep: KeepAtom): Fragment | undefined {
	const kept: Node[] = []
	let refused = false
	const stand = (fragment: Fragment): Fragment => {
		const out: Node[] = []

		fragment.forEach(child => {
			if (refused) return

			if (child.type === nodes.locked_block || child.type === nodes.note_ref) {
				refused = true

				return
			}

			if (child.isInline && (BYTE_ATOMS.has(child.type) || LEFT_WITH_ORIGINAL.has(child.type))) {
				const atom = LEFT_WITH_ORIGINAL.has(child.type) ? undefined : keep(child)

				if (atom === null) refused = true
				if (atom === undefined || atom === null) return

				kept.push(atom)
				out.push(docxSchema.text(KEPT, child.marks))

				return
			}

			out.push(child.isLeaf || child.isText ? child : child.copy(stand(child.content)))
		})

		return Fragment.fromArray(out)
	}
	const stood = stand(content)

	if (refused) return undefined

	const fresh = freshSlice(new Slice(stood, 0, 0), sourceCopies(context), origin, target).content
	let next = 0
	const back = (fragment: Fragment): Fragment => {
		const out: Node[] = []

		fragment.forEach(child => {
			if (child.isText) {
				const text = child.text ?? ""
				let from = 0

				for (let at = text.indexOf(KEPT); at >= 0; at = text.indexOf(KEPT, from)) {
					if (at > from) out.push(child.cut(from, at))

					const atom = kept[next++]

					if (atom !== undefined) out.push(atom)

					from = at + 1
				}

				if (from < text.length) out.push(from === 0 ? child : child.cut(from))
			} else {
				out.push(child.isLeaf ? child : child.copy(back(child.content)))
			}
		})

		return Fragment.fromArray(out)
	}

	return back(fresh)
}

// The atoms of a story document written from bytes (with `source`, those of the source only), in document order.
function byteAtoms(doc: Node, source: boolean): Node[] {
	const out: Node[] = []

	doc.descendants(node => {
		if (BYTE_ATOMS.has(node.type) && (!source || node.attrs["src"] !== NO_SOURCE)) out.push(node)

		return !node.isInline
	})

	return out
}

// An atom the editor made that a copy can hold as it is (writableNew): a picture with a drawing id of its own.
function keptNew(atom: Node, context: DocxEditContext): Node | null {
	if (atom.attrs["src"] !== NO_SOURCE || !writableNew(atom)) return null
	if (atom.type !== nodes.drawing) return atom

	const overrides = atom.attrs["overrides"] as Record<string, unknown>

	return atom.type.create({ ...atom.attrs, overrides: { ...overrides, docPr: context.ids.next("docPr") } }, null, atom.marks)
}

// `node` with character style mark `from` (a reference style) made `to` wherever it stands.
function withReferenceStyle(node: Node, from: Mark, to: Mark): Node {
	if (node.isText || node.isLeaf) return from.isInSet(node.marks) ? node.mark(to.addToSet(from.removeFromSet(node.marks))) : node

	let changed = false
	const children: Node[] = []

	node.forEach(child => {
		const next = withReferenceStyle(child, from, to)

		if (next !== child) changed = true

		children.push(next)
	})

	return changed ? node.copy(Fragment.fromArray(children)) : node
}

function textStyle(context: DocxEditContext, kind: DocxNoteKind): string | null {
	return styleOf(context, `${kind} text`, "paragraph") ?? null
}

// The note references of a story document, with their positions, in order.
export function noteReferences(doc: Node): { readonly node: Node; readonly pos: number }[] {
	const out: { node: Node; pos: number }[] = []

	doc.descendants((node, pos) => {
		if (node.type === nodes.note_ref) out.push({ node, pos })

		return !node.isInline
	})

	return out
}

function referenceOf(doc: Node, kind: DocxNoteKind, id: string): number {
	for (const reference of noteReferences(doc))
		if (reference.node.attrs["kind"] === kind && reference.node.attrs["id"] === id) return reference.pos

	return -1
}

// The reference at a selection: the one selected, or the one right after or before its start (enablement asks
// with every snapshot: nothing walks the selection).
function referenceAt(state: EditorState): { readonly node: Node; readonly pos: number } | undefined {
	const selection = state.selection

	if (selection instanceof NodeSelection && selection.node.type === nodes.note_ref) return { node: selection.node, pos: selection.from }

	const { $from } = selection
	const after = $from.nodeAfter
	const before = $from.nodeBefore

	if (after?.type === nodes.note_ref) return { node: after, pos: $from.pos }
	if (before?.type === nodes.note_ref && selection.empty) return { node: before, pos: $from.pos - before.nodeSize }

	return undefined
}

// The size of the custom mark following a reference (the text after it in the reference's style), or 0.
function customMarkSize(doc: Node, pos: number): number {
	const reference = doc.nodeAt(pos)

	if (reference?.type !== nodes.note_ref || reference.attrs["custom"] !== true) return 0

	const after = doc.resolve(pos + 1).nodeAfter
	const style = reference.marks.find(mark => mark.type === marks.char_style || mark.type === marks.vert_align)

	return after?.isText === true && style?.isInSet(after.marks) === true ? Math.min(after.nodeSize, MAX_NOTE_MARK) : 0
}

const STORES = new WeakMap<PagedEditor, DocxNotes>()

// The notes of the document `editor` edits.
export function docxNotes(editor: PagedEditor): DocxNotes {
	let store = STORES.get(editor)

	if (store === undefined) {
		store = new DocxNotes(editor)
		STORES.set(editor, store)
	}

	return store
}

export class DocxNotes {
	private readonly editor: PagedEditor

	constructor(editor: PagedEditor) {
		this.editor = editor
	}

	private get body(): DocxEditorSession {
		return this.editor.body.session
	}

	private get context(): DocxEditContext {
		return this.body.context
	}

	// The story of note `id` of `kind` (the document's or one the editor added), or undefined.
	storyOf(kind: DocxNoteKind, id: string): Story | undefined {
		const map = kind === "footnote" ? this.editor.edits.model.footnotes : this.editor.edits.model.endnotes

		return map.get(id)
	}

	// The note at the caret: the one being edited, or the one whose reference the caret is at.
	at(): DocxNoteAt | undefined {
		const session = this.editor.session
		const story = session.story.story

		if ((story.kind === "footnote" || story.kind === "endnote") && story.id !== undefined && story.noteType === "normal")
			return { kind: story.kind, id: story.id, story: story.index, reference: referenceOf(this.body.state.doc, story.kind, story.id) }

		if (session !== this.body) return undefined

		const found = referenceAt(session.state)
		const kind = found?.node.attrs["kind"] === "endnote" ? "endnote" : "footnote"
		const id = found?.node.attrs["id"]
		const note = typeof id === "string" ? this.storyOf(kind, id) : undefined

		return found === undefined || note === undefined || typeof id !== "string"
			? undefined
			: { kind, id, story: note.index, reference: found.pos }
	}

	// Whether a note can be inserted at the caret: in the body's text, where it can be edited.
	canInsert(): boolean {
		const session = this.editor.session

		if (session !== this.body || session.readOnly) return false

		const $to = session.state.selection.$to

		return $to.parent.type === nodes.paragraph && (!this.context.review.tracking || revisionStamp(this.context.identity) !== undefined)
	}

	// A new note of `kind` at the caret (after the selection), numbered or with `mark`; the caret goes into it.
	insert(kind: DocxNoteKind, mark?: string): boolean {
		if (!this.canInsert()) return false
		// A custom mark needs w:customMarkFollows on the reference, which the schema must hold.
		if (mark !== undefined && !Object.hasOwn(nodes.note_ref.spec.attrs ?? {}, "custom")) return false

		const session = this.body
		const context = this.context
		const at = session.state.selection.to
		const made = this.newNote(kind, mark, undefined)

		if (made === undefined) return false

		const tr = session.state.tr
		const reference = this.referenceNode(kind, made.id, mark !== undefined, tr.doc, at)
		// A custom mark is the text right after the reference (w:customMarkFollows), in its style.
		const content =
			mark === undefined
				? Fragment.from(reference)
				: Fragment.from(reference).append(Fragment.from(docxSchema.text(mark, reference.marks)))

		tr.insert(at, content)
		tr.setSelection(TextSelection.create(tr.doc, at + content.size))

		// A command transaction: tracked changes record the reference as inserted.
		if (!session.dispatch(markCommand(this.tracked(tr, at, at + content.size, context)))) return false

		return this.enter(made.story)
	}

	// Moves between a note and its reference: into the note of the reference at the caret, or back to the
	// reference of the note being edited (the caret after it).
	goto(): boolean {
		const note = this.at()

		if (note === undefined) return false

		const editor = this.editor

		if (editor.session !== this.body) {
			if (note.reference < 0) return false

			editor.exitStory()

			const doc = this.body.state.doc

			return this.body.dispatch(this.body.state.tr.setSelection(TextSelection.create(doc, note.reference + 1)).scrollIntoView())
		}

		return this.enter(note.story)
	}

	// Deletes the note at the caret by deleting its reference (tracked as a deletion while tracking is on).
	remove(): boolean {
		const note = this.at()

		if (note === undefined || note.reference < 0 || this.body.readOnly) return false
		if (this.editor.session !== this.body) this.editor.exitStory()

		const session = this.body
		const doc = session.state.doc

		return session.dispatch(session.state.tr.delete(note.reference, note.reference + 1 + customMarkSize(doc, note.reference)))
	}

	// Pasted references in `tr` (a paste or drop into the body) to a note another reference also refers to become
	// references to a copy of that note, as Word's paste makes one (a cut pasted keeps its note: nothing else
	// refers to it). The copy is the note whole (noteCopy), made outside the undo history and tracked while
	// tracking: the pasted references are what undoes. False where a copy cannot be made whole: the paste is
	// refused. Only paste and drop call this; it reads the inserted ranges alone, and the document's references
	// only when a pasted reference is among them.
	pasted(tr: Transaction): boolean {
		if (this.editor.session !== this.body || this.body.readOnly || !tr.docChanged) return true

		const maps = tr.mapping.maps
		const found: { pos: number; node: Node }[] = []

		maps.forEach((map, index) => {
			map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
				let from = newStart
				let to = newEnd

				for (let later = index + 1; later < maps.length; later++) {
					from = maps[later]?.map(from, 1) ?? from
					to = maps[later]?.map(to, -1) ?? to
				}

				if (to <= from) return

				tr.doc.nodesBetween(from, to, (node, pos) => {
					if (
						node.type === nodes.note_ref &&
						pos >= from &&
						node.attrs["src"] === NO_SOURCE &&
						typeof node.attrs["id"] === "string"
					)
						found.push({ pos, node })

					return !node.isInline
				})
			})
		})

		if (found.length === 0) return true

		const counts = new Map<string, number>()

		for (const { node } of noteReferences(tr.doc)) {
			const key = `${String(node.attrs["kind"])}:${String(node.attrs["id"])}`

			counts.set(key, (counts.get(key) ?? 0) + 1)
		}

		const seen = new Set<number>()

		for (const { pos, node } of found) {
			if (seen.has(pos)) continue

			seen.add(pos)

			const kind: DocxNoteKind = node.attrs["kind"] === "endnote" ? "endnote" : "footnote"
			const id = node.attrs["id"] as string
			const key = `${kind}:${id}`
			const count = counts.get(key) ?? 0
			const story = this.storyOf(kind, id)

			// Only this reference refers to it: the note moved here.
			if (count < 2 || story === undefined) continue

			const made = this.noteCopy(kind, story, node.attrs["custom"] === true)

			// Refused: a copy would leave something out.
			if (made === undefined) return false

			counts.set(key, count - 1)
			tr.setNodeAttribute(pos, "id", made.id)
		}

		return true
	}

	// Whether the note at the caret can become one of the other kind.
	canConvert(): boolean {
		const note = this.at()

		return note !== undefined && note.reference >= 0 && !this.body.readOnly
	}

	// The note at the caret becomes one of the other kind, its content moved (as a paste moves it).
	convert(): boolean {
		const note = this.at()

		if (note === undefined || note.reference < 0 || this.body.readOnly) return false
		if (this.editor.session !== this.body) this.editor.exitStory()

		return this.convertNotes([{ kind: note.kind, id: note.id, pos: note.reference }])
	}

	// Every note of the other kind becomes one of kind `to`.
	convertAll(to: DocxNoteKind): boolean {
		if (this.body.readOnly) return false

		const from = otherKind(to)
		const found = noteReferences(this.body.state.doc)
			.filter(reference => reference.node.attrs["kind"] === from && typeof reference.node.attrs["id"] === "string")
			.map(reference => ({ kind: from, id: reference.node.attrs["id"] as string, pos: reference.pos }))

		if (found.length === 0) return false
		if (this.editor.session !== this.body) this.editor.exitStory()

		return this.convertNotes(found)
	}

	// Whether the document has notes of `kind` (references in the body).
	any(kind?: DocxNoteKind): boolean {
		return noteReferences(this.body.state.doc).some(reference => kind === undefined || reference.node.attrs["kind"] === kind)
	}

	// ---- internals -----------------------------------------------------------------------------------------

	private enter(story: number): boolean {
		const editor = this.editor

		if (!editor.enterStory(story, -1)) return false

		const session = editor.session
		const doc = session.state.doc
		const first = doc.firstChild
		// After the note's mark and the space after it: where Word puts the caret in a new note.
		const end = first === null ? 1 : first.nodeSize - 1

		return session.dispatch(session.state.tr.setSelection(TextSelection.create(doc, Math.max(1, end))).scrollIntoView())
	}

	// Insertion marks for `from`..`to` of `tr` while tracking.
	private tracked(tr: Transaction, from: number, to: number, context: DocxEditContext): Transaction {
		const stamp = context.review.tracking ? revisionStamp(context.identity) : undefined

		if (stamp === undefined) return tr

		return tr.addMark(from, to, marks.insertion.create({ src: NO_SOURCE, id: context.ids.next("revision"), ...stamp }))
	}

	private referenceNode(kind: DocxNoteKind, id: string, custom: boolean, doc: Node, at: number): Node {
		const $at = doc.resolve(at)
		const around = [...($at.nodeBefore?.marks ?? $at.nodeAfter?.marks ?? [])].filter(mark => WRAPPERS.has(mark.type))
		let nodeMarks: readonly Mark[] = referenceMarks(this.context, kind)

		for (const mark of around) nodeMarks = mark.addToSet(nodeMarks)

		return nodes.note_ref.create({ src: NO_SOURCE, kind, id, custom }, null, nodeMarks)
	}

	// A new note's story holding `content` (blocks, or made for the part the note is on; by default one paragraph
	// of the note's text style with its mark and a space, as Word starts a note), outside the undo history: the
	// reference that refers to it is what undoes.
	private newNote(
		kind: DocxNoteKind,
		mark: string | undefined,
		content: Fragment | ((part: number) => Fragment | undefined) | undefined
	): { id: string; story: number } | undefined {
		const context = this.context
		const session = this.editor.addStory(kind)
		const id = session === undefined ? undefined : context.newStories.get(session.story.story)?.id

		if (session === undefined || id === undefined) return undefined

		const made = typeof content === "function" ? content(session.story.part.index) : content

		// Nothing refers to the story: it is left out of the save.
		if (typeof content === "function" && made === undefined) return undefined

		const blocks = made ?? Fragment.from(this.firstParagraph(kind, mark, Fragment.from(docxSchema.text(" "))))
		const tr = session.state.tr.replaceWith(0, session.state.doc.content.size, blocks)
		const tracked = this.tracked(tr, 0, tr.doc.content.size, context)

		if (!session.dispatch(markInternal(tracked).setMeta("addToHistory", false))) return undefined
		// What tracking recorded is counted (an internal step passes no transformer).
		if (context.review.tracking) wantReviewIndex(session)

		return { id, story: session.story.story.index }
	}

	// A new note of `kind` holding note story `story` whole (a paste copies it into a note of its kind, a
	// conversion moves it into one of the other): what it holds as source bytes with what a document needs unique
	// made new and the parts it owns copied by the save (stories/clone.ts cloneNote), what the editor made in it
	// (writableNew) kept; outside the undo history and marked inserted while tracking. Undefined where it cannot
	// be made whole: the caller refuses, nothing is dropped.
	private noteCopy(kind: DocxNoteKind, story: Story, custom: boolean): { id: string; story: number } | undefined {
		const context = this.context
		const editor = this.editor
		const from: DocxNoteKind = story.kind === "endnote" ? "endnote" : "footnote"
		const { session: source, textboxes } = copySessions(editor, story.index)
		const live = source ?? editor.storySession(story.index)
		const part = editor.edits.model.parts[story.part]
		const into = editor.notePart(kind)

		if (live === undefined || part === undefined || into === undefined) return undefined

		const id = String(context.ids.next(kind))
		const target = { part: into, kind }
		let session: DocxEditorSession | undefined
		let content: Fragment | undefined

		if (story.item >= 0) {
			// As written now (the note's edits, its text boxes'): the copy holds it as its own source.
			let template = cloneNote(context, part, story.item, id, source, textboxes, target)
			// Else (it holds what only a save can place, as a new picture): its source as opened, the edits made
			// since laid over it, each source atom standing for its copy.
			const byPlace = template === undefined

			if (byPlace) {
				if (textboxes.some(candidate => candidate.state.doc !== candidate.story.doc)) return undefined

				template = cloneNote(context, part, story.item, id, undefined, [], target)
			}

			session = template === undefined ? undefined : editor.addStory(kind, id, template)

			if (session === undefined) return undefined

			// The note as the editor holds it, each source atom standing for its copy (the copy's own bytes, made
			// unique), containers carrying what their source had as data (their copy goes into the notes part,
			// write/parts/notes.ts).
			const copies = byteAtoms(session.state.doc, false)
			const keep: KeepAtom = byPlace
				? (() => {
						// The source's atoms as opened stand for theirs; what the editor made is kept as it is.
						const opened = byteAtoms(live.story.doc, true)
						const map = new Map(opened.map((atom, k) => [atom.attrs["src"] as number, copies[k]]))

						return atom =>
							atom.attrs["src"] === NO_SOURCE
								? keptNew(atom, context)
								: opened.length !== copies.length
									? null
									: (map.get(atom.attrs["src"] as number) ?? null)
					})()
				: (() => {
						// The copy was written from the note as it is: its atoms one for one.
						const now = byteAtoms(live.state.doc, false)
						const map = new Map(now.map((atom, k) => [atom, copies[k]]))

						return atom => (now.length !== copies.length ? null : (map.get(atom) ?? null))
					})()

			content = renewedKeeping(live.state.doc.content, context, live.story.part.index, into.index, atom => {
				const copied = keep(atom)

				return copied === null || copied === undefined ? copied : copied.type.create(copied.attrs, null, atom.marks)
			})
		} else {
			const made = editor.addStory(kind)

			session = made
			content =
				made === undefined
					? undefined
					: renewedKeeping(live.state.doc.content, context, live.story.part.index, made.story.part.index, atom =>
							atom.attrs["src"] === NO_SOURCE ? keptNew(atom, context) : null
						)
		}

		const madeId = session === undefined ? undefined : context.newStories.get(session.story.story)?.id

		if (session === undefined || content === undefined || madeId === undefined) return undefined

		const blocks = kind === from ? content : this.converted(content, kind, from, custom)
		const tr = session.state.tr.replaceWith(0, session.state.doc.content.size, blocks)

		if (!session.dispatch(markInternal(this.tracked(tr, 0, tr.doc.content.size, context)).setMeta("addToHistory", false)))
			return undefined
		if (context.review.tracking) wantReviewIndex(session)

		return { id: madeId, story: session.story.story.index }
	}

	// A note's first paragraph: its mark, then `rest`.
	private firstParagraph(kind: DocxNoteKind, mark: string | undefined, rest: Fragment, attrs?: Readonly<Record<string, unknown>>): Node {
		const context = this.context
		const style = referenceMarks(context, kind)
		const lead =
			mark === undefined
				? nodes.run_object.create({ src: NO_SOURCE, kind: MARK_KINDS[kind], text: "" }, null, style)
				: docxSchema.text(mark, style)

		return nodes.paragraph.create(
			{ ...attrs, styleId: attrs?.["styleId"] ?? textStyle(context, kind) },
			Fragment.from(lead).append(rest)
		)
	}

	// The blocks of a note of kind `from`, made new, as content of a note of `kind`: the note's mark of the new kind,
	// the text style mapped from the old kind's, as Word maps them; a note with a custom mark keeps its content
	// (the mark is its text) and its reference stays custom.
	private converted(content: Fragment, kind: DocxNoteKind, from: DocxNoteKind, custom: boolean): Fragment {
		const context = this.context
		const fromStyle = textStyle(context, from)
		const toStyle = textStyle(context, kind)
		// Runs of the old kind's reference style (a custom mark's text) take the new kind's, as Word maps styles.
		const fromReference = referenceMarks(context, from)[0]
		const toReference = referenceMarks(context, kind)[0]
		const restyled = (node: Node): Node =>
			fromReference?.type !== marks.char_style || toReference === undefined
				? node
				: withReferenceStyle(node, fromReference, toReference)
		const blocks: Node[] = []
		let marked = false

		content.forEach(block => {
			const fresh = restyled(block)
			const style = fresh.attrs["styleId"]
			const attrs = style !== null && style === fromStyle ? { ...fresh.attrs, styleId: toStyle } : fresh.attrs

			if (!marked && !custom && fresh.type === nodes.paragraph) {
				marked = true

				// Its own mark (and the space Word puts after it) gives way to the new kind's.
				const rest: Node[] = []

				fresh.forEach((child, _offset, index) => {
					if (
						index === 0 &&
						child.type === nodes.run_object &&
						(child.attrs["kind"] === "FootnoteMark" || child.attrs["kind"] === "EndnoteMark")
					)
						return

					rest.push(child)
				})

				blocks.push(this.firstParagraph(kind, undefined, Fragment.fromArray(rest), attrs))

				return
			}

			blocks.push(fresh.type.create(attrs, fresh.content, fresh.marks))
		})

		return Fragment.fromArray(blocks)
	}

	// The notes `found` (their references) become notes of the other kind, whole (noteCopy); refused, with
	// nothing changed, where one cannot.
	private convertNotes(found: readonly { readonly kind: DocxNoteKind; readonly id: string; readonly pos: number }[]): boolean {
		const session = this.body
		const tr = session.state.tr

		for (const note of found) {
			const story = this.storyOf(note.kind, note.id)
			const kind = otherKind(note.kind)
			const pos = tr.mapping.map(note.pos)
			const old = tr.doc.nodeAt(pos)
			const custom = old?.attrs["custom"] === true
			const made = story === undefined || old?.type !== nodes.note_ref ? undefined : this.noteCopy(kind, story, custom)

			if (made === undefined || old === null) return false

			const style = referenceMarks(this.context, kind)[0]
			const nodeMarks = old.marks.map(mark => (mark.type === marks.char_style ? (style ?? mark) : mark))
			// The custom mark is the text after the reference in its style: it takes the new style with it, or it would
			// be written in a run of its own, which readers show as text after a numbered reference.
			const markSize = customMarkSize(tr.doc, pos)
			const oldStyle = old.marks.find(mark => mark.type === marks.char_style)

			tr.replaceWith(pos, pos + 1, nodes.note_ref.create({ src: NO_SOURCE, kind, id: made.id, custom }, null, nodeMarks))

			if (markSize > 0 && style !== undefined && oldStyle !== undefined && !oldStyle.eq(style)) {
				tr.removeMark(pos + 1, pos + 1 + markSize, oldStyle)
				tr.addMark(pos + 1, pos + 1 + markSize, style)
			}
		}

		return found.length > 0 && session.dispatch(markInternal(tr))
	}
}

import { closeHistory } from "prosemirror-history"
import { Fragment, Slice, type Node } from "prosemirror-model"
import { NodeSelection, type EditorState, type Transaction } from "prosemirror-state"
import { addBookmark, bookmarkIndex, canAddBookmark, deleteBookmark, renameBookmark } from "../../fields/bookmarks"
import { FieldEvaluation, fieldUpdateOf, pagedFieldHost, parseFieldCode, updatableField, type FieldHost } from "../../fields/evaluate"
import type { FieldUpdate } from "../../fields/result"
import {
	addTocBookmarks,
	buildToc,
	mayHoldToc,
	takenElsewhere,
	tocAt,
	tocInserted,
	tocEntries,
	tocInstruction,
	tocOptions,
	tocRegions,
	type TocRegion
} from "../../fields/toc"
import { shownFieldText } from "../../layout/fields"
import type { PagedEditor } from "../../paged/editor"
import { isDeleted, revisionStamp, type RevisionStamp } from "../../review/track"
import { AttrChanges } from "../attrs"
import { markCommand, markInternal } from "../invariants/index"
import type { DocumentCommandContext, DocumentHandlers, FeatureHandlers } from "../registry"
import { NO_MARKERS, NO_SOURCE, docxSchema } from "../schema"
import type { DocxEditorSession } from "../session"

// Fields, bookmarks and tables of contents (document commands: an update reads the laid-out pages). Updates
// are Word's manual ones: Update Field (F9) on the selection or the field at the caret, Update All on the
// story, Update Table on a table of contents (its page numbers alone, or the table rebuilt). Each waits for
// layout to settle once, computes every result from the pages as they are and applies them as one step (no
// layout per field); a table rebuilt or inserted lays out once more and gets its page numbers in a second step
// that undoes with the first. While tracking changes an update is recorded as Word records it: a field's old
// result deleted and the new one inserted (its tracked update), a table rebuilt as the old table deleted and
// the new one inserted; results of fields inserted while tracking are part of their insertion.

const nodes = docxSchema.nodes

// An undo step a command began: the document it left, and an empty transaction a later step names as the one
// it is appended to (the step's own would keep every intermediate document while layout catches up).
interface Joined {
	readonly doc: Node
	readonly tr: Transaction
}

function writable(context: DocumentCommandContext): boolean {
	return !context.editor.body.session.readOnly && !context.session.readOnly
}

function inParagraph(state: EditorState): boolean {
	const { $from, $to } = state.selection

	return $from.parent.type === nodes.paragraph && $to.parent.type === nodes.paragraph
}

// The field atom at the caret (selected, or just before or after it).
function fieldAtCaret(state: EditorState): { node: Node; pos: number } | undefined {
	const selection = state.selection

	if (selection instanceof NodeSelection)
		return selection.node.type === nodes.field ? { node: selection.node, pos: selection.from } : undefined
	if (!selection.empty) return undefined

	const $pos = selection.$from
	const after = $pos.nodeAfter
	const before = $pos.nodeBefore

	if (after?.type === nodes.field) return { node: after, pos: $pos.pos }
	if (before?.type === nodes.field) return { node: before, pos: $pos.pos - before.nodeSize }

	return undefined
}

// Whether the selection is on a table of contents: a locked block of one of the file's selected, or a paragraph
// holding field characters of one built as paragraphs (`entries`: or a page number reference, as its entries
// between the first and the last hold; looked at in the selection's paragraph alone).
function onToc(state: EditorState, entries = false): boolean {
	const { $from } = state.selection
	const selected = $from.nodeAfter

	if (selected?.type === nodes.locked_block && selected.attrs["reason"] === "fieldSpansBlocks") return true

	let found = false

	$from.parent.forEach(child => {
		if (child.type === nodes.field_char || (entries && child.type === nodes.field && child.attrs["type"] === "PAGEREF")) found = true
	})

	return found
}

// The fields Shift+F9 switches: those of the selection (field atoms and the begin characters of fields
// spanning paragraphs), else the field at the caret, else the table of contents the caret is in; with the
// range of the document they are in (a table of contents whole).
function fieldsToSwitch(session: DocxEditorSession): { readonly fields: Node[]; readonly from: number; readonly to: number } {
	const state = session.state
	const { from, to, empty } = state.selection
	const out: Node[] = []
	let spans = false

	if (!empty)
		state.doc.nodesBetween(from, to, node => {
			if (node.type === nodes.field) out.push(node)
			else if (node.type === nodes.field_char && node.attrs["kind"] === "begin") {
				out.push(node)
				spans = true
			}

			return !node.isLeaf
		})

	if (out.length > 0) {
		if (!spans) return { fields: out, from, to }

		// A field spanning paragraphs changes how all of them are shown.
		let start = from
		let end = to

		for (const region of tocRegions(session)) {
			if (region.from >= to || region.to <= from) continue

			start = Math.min(start, region.from)
			end = Math.max(end, region.to)
		}

		return { fields: out, from: start, to: end }
	}

	const caret = fieldAtCaret(state)

	if (caret !== undefined) return { fields: [caret.node], from: caret.pos, to: caret.pos + caret.node.nodeSize }

	const region = onToc(state) ? tocAt(session) : undefined
	const first = region === undefined || region.source ? undefined : state.doc.nodeAt(region.from)

	first?.forEach(child => {
		if (out.length === 0 && child.type === nodes.field_char && child.attrs["kind"] === "begin") out.push(child)
	})

	return { fields: out, from: region?.from ?? from, to: region?.to ?? to }
}

// Update Table stays offered in a story a table was inserted into.
function hasToc(session: DocxEditorSession): boolean {
	return mayHoldToc(session) || onToc(session.state)
}

// Applies `tr` to `session` as part of the undo step `joined` began, when nothing changed the document since.
function dispatchJoined(session: DocxEditorSession, tr: Transaction, joined: Joined | undefined): Joined | undefined {
	if (joined !== undefined && session.state.doc === joined.doc) tr.setMeta("appendedTransaction", joined.tr)
	else closeHistory(tr)

	return session.dispatch(tr) ? { doc: session.state.doc, tr: session.state.tr } : undefined
}

// Who records the session's updates: undefined while not tracking, null while tracking without an author name
// (nothing can be recorded then).
function updateStamp(session: DocxEditorSession): RevisionStamp | null | undefined {
	return session.context.review.tracking ? (revisionStamp(session.context.identity) ?? null) : undefined
}

// A field's attributes for a new result: while tracking (`stamp`), with its tracked update (the result before
// its first tracked update, the latest stamp; none when the result is back to that and its code holds no tracked
// change), except for a field inserted while tracking, whose result is part of its insertion. An update not
// tracked leaves tracked changes in the code pending, its result not tracked.
function updated(session: DocxEditorSession, node: Node, result: string, stamp: RevisionStamp | undefined): Record<string, unknown> {
	const update = fieldUpdateOf(node)
	const codeOnly = update?.code !== undefined && update.result === node.attrs["result"]

	if (stamp === undefined || docxSchema.marks.insertion.isInSet(node.marks) !== undefined)
		return codeOnly ? { result, update: Object.freeze({ ...update, result }) } : { result }

	const before = update?.result ?? (node.attrs["result"] as string)

	if (before === result && update?.code !== undefined) return { result, update: Object.freeze({ ...update, result }) }

	const next: FieldUpdate | null =
		before === result
			? null
			: Object.freeze({
					result: before,
					author: stamp.author,
					date: stamp.date,
					id: update?.id ?? String(session.context.ids.next("revision")),
					...(update?.code === undefined ? {} : { code: update.code })
				})

	return { result, update: next }
}

// New results for the fields of [from, to) of the session's document (deleted fields stay as they are).
function fieldChanges(host: FieldHost, session: DocxEditorSession, from: number, to: number, stamp?: RevisionStamp): AttrChanges {
	const evaluation = new FieldEvaluation(host, session, session.context.identity.now())
	const changes = new AttrChanges()

	session.state.doc.nodesBetween(from, to, (node, pos) => {
		if (node.type !== nodes.field) return !node.isLeaf
		if (!updatableField(session, node) || isDeleted(node)) return false

		const result = evaluation.result(node, pos)

		if (result !== undefined && result !== node.attrs["result"]) {
			evaluation.results.set(pos, result)
			changes.set(node, pos, updated(session, node, result, stamp))
		}

		return false
	})

	return changes
}

function applyChanges(session: DocxEditorSession, changes: AttrChanges, joined: Joined | undefined): Joined | undefined {
	if (changes.empty) return joined

	const tr = session.state.tr

	changes.step(tr)

	return dispatchJoined(session, markCommand(tr), joined)
}

// The page number a heading is on, as shown.
function headingPage(host: FieldHost, session: DocxEditorSession, pos: number): string {
	const pages = host.pages
	const index = pages?.pageAt(session, pos + 1)

	return (index === undefined ? undefined : pages?.page(index))?.numberText ?? ""
}

// Where a new table goes: before the caret's paragraph when the caret is at its start, after it at its end,
// else between its halves (a section break stays with the second).
function insertionPoint(tr: Transaction): number | undefined {
	const { $from } = tr.selection

	if ($from.parent.type !== nodes.paragraph) return undefined
	if ($from.parentOffset === 0) return $from.before()
	if ($from.parentOffset === $from.parent.content.size && ($from.parent.attrs["sectPr"] as number) === NO_SOURCE) return $from.after()

	const pos = $from.pos

	tr.split(pos)

	return pos + 1
}

// The page numbers of the table at `pos` (or the first after it: a table rebuilt while tracking follows the
// old one, deleted), once layout caught up with it.
async function refreshToc(editor: PagedEditor, session: DocxEditorSession, pos: number, joined: Joined): Promise<Joined> {
	await editor.whenSettled()

	const region = tocRegions(session).find(candidate => pos < candidate.to)
	const stamp = updateStamp(session)

	if (region === undefined || session.readOnly || stamp === null) return joined

	return applyChanges(session, fieldChanges(pagedFieldHost(editor), session, region.from, region.to, stamp), joined) ?? joined
}

// A table of contents with `instruction` in place of `region` (else at the selection), its entries' page
// numbers given once the pages are laid out again.
async function placeToc(
	editor: PagedEditor,
	session: DocxEditorSession,
	instruction: string,
	region: TocRegion | undefined,
	joined: Joined | undefined
): Promise<Joined | undefined> {
	const options = tocOptions(parseFieldCode(instruction))
	// Rebuilt while tracking: the old result stays, deleted, with its markers and section break, between the
	// table's own code and end (as Word records an update of a field); an empty table read as one field (its
	// code and end inside it) stays whole, deleted, the new table inserted after it.
	const tracked = region !== undefined && session.context.review.tracking
	const atom = region !== undefined && region.atom >= 0

	// A table of the file kept as locked blocks cannot be recorded deleted.
	if (!options.supported || (tracked && !atom && (region.source || region.codeEnd < 0))) return undefined

	let range: { from: number; to: number; head: "title" | "join" | undefined; tail: "whole" | "open" | undefined } | undefined

	if (region !== undefined) {
		range = { from: region.replaceFrom, to: region.replaceTo, head: region.head ? "title" : undefined, tail: region.tail }

		if (tracked && !atom && range.head === undefined) range = { ...range, from: region.codeEnd, head: "join" }
		if (tracked && !atom && range.tail === undefined) range = { ...range, to: region.endAt, tail: "open" }
	}

	const host = pagedFieldHost(editor)
	const entries = tocEntries(host, session, options, region?.from ?? -1, region?.to ?? -1)
	const tr = session.state.tr
	let at: number | undefined = region?.from

	if (region === undefined) {
		if (!tr.selection.empty) tr.deleteSelection()

		at = insertionPoint(tr)
	}

	if (at === undefined) return undefined

	const build = buildToc({
		session,
		host,
		instruction,
		entries,
		pos: at,
		templates: region?.templates ?? new Map<number, number>(),
		markers: tracked ? NO_MARKERS : (region?.markers ?? NO_MARKERS),
		sectPr: tracked ? NO_SOURCE : (region?.sectPr ?? NO_SOURCE),
		taken: takenElsewhere(host.sessions, session),
		page: entry => headingPage(host, session, entry.pos),
		head: range?.head,
		tail: range?.tail
	})

	const steps = tr.steps.length

	if (range === undefined) tr.insert(at, build.paragraphs)
	else {
		// What the table keeps in its first and last paragraphs joins the entries there (see TocRegion). While
		// tracking, the last paragraph keeps its own properties (a rejection could not bring them back).
		const paragraphs = range.head === "title" ? [nodes.paragraph.create(), ...build.paragraphs] : [...build.paragraphs]
		const last = paragraphs[paragraphs.length - 1]

		if (tracked && range.tail === "open" && last !== undefined) {
			const kept = tr.doc.resolve(range.to).parent

			paragraphs[paragraphs.length - 1] = last.type.create(kept.attrs, last.content, kept.marks)
		}

		tr.replace(
			range.from,
			range.to,
			new Slice(Fragment.from(paragraphs), range.head === undefined ? 0 : 1, range.tail === "open" ? 1 : 0)
		)
	}

	addTocBookmarks(tr, build)

	// Inserted as the user's edit (a tracked insertion while tracking); replaced by the session's own step (a
	// table of the file may be locked blocks no edit may delete), or, while tracking, as the user's edit:
	// recorded deleted and inserted.
	const first = dispatchJoined(session, region === undefined ? tr.scrollIntoView() : tracked ? tr : markInternal(tr), joined)

	if (first === undefined) return undefined
	if (region === undefined) tocInserted(session)

	return refreshToc(editor, session, tr.mapping.slice(steps).map(at, -1), first)
}

// Field results of the selection (or the field at the caret), or of the whole story, brought up to date.
async function update(editor: PagedEditor, all: boolean): Promise<boolean> {
	const session = editor.session

	await editor.whenSettled()

	const stamp = updateStamp(session)

	if (session.readOnly || editor.session !== session || stamp === null) return false

	const state = session.state
	const caret = all ? undefined : fieldAtCaret(state)
	const regions = tocRegions(session)
	let from = all ? 0 : (caret?.pos ?? state.selection.from)
	let to = all ? state.doc.content.size : caret === undefined ? state.selection.to : caret.pos + caret.node.nodeSize

	// Anywhere in a table of contents (not on one of its fields), the table's page numbers, as Word's Update Table
	// offers first.
	if (caret === undefined)
		for (const region of regions)
			if (!region.source && region.from <= to && region.to >= from) {
				from = Math.min(from, region.from)
				to = Math.max(to, region.to)
			}

	// A table of the file kept as locked blocks stays as it is: Update Field updates page numbers only (Word's
	// Update Table offers that first), and its entries are bytes; Update Table rebuilds it.
	applyChanges(session, fieldChanges(pagedFieldHost(editor), session, from, to, stamp), undefined)

	return true
}

async function updateToc(editor: PagedEditor, pagesOnly: boolean): Promise<boolean> {
	const session = editor.session

	await editor.whenSettled()

	const stamp = updateStamp(session)

	if (session.readOnly || editor.session !== session || stamp === null) return false

	const region = tocAt(session)

	if (region === undefined || !region.updatable) return false

	// Page numbers alone are the table's PAGEREF fields, updated in place (a table kept as locked blocks has
	// none the editor can reach: it stays as it is; one read as a single field has none).
	if (pagesOnly) {
		if (region.atom < 0) applyChanges(session, fieldChanges(pagedFieldHost(editor), session, region.from, region.to, stamp), undefined)

		return true
	}

	return (await placeToc(editor, session, region.instruction, region, undefined)) !== undefined
}

async function insertToc(editor: PagedEditor, levels: number, hyperlinks: boolean): Promise<boolean> {
	const session = editor.session

	await editor.whenSettled()

	if (session.readOnly || editor.session !== session || !inParagraph(session.state)) return false

	return (await placeToc(editor, session, tocInstruction(levels, hyperlinks), undefined, undefined)) !== undefined
}

// A new field at the selection, its result computed from the pages as they are.
function insertField(editor: PagedEditor, instruction: string): boolean {
	const session = editor.session
	const code = parseFieldCode(instruction)

	if (session.readOnly || !inParagraph(session.state) || code.type === "") return false

	if (code.type === "REF" || code.type === "PAGEREF") {
		const name = code.args[0]?.toLowerCase() ?? ""
		const body = editor.body.session

		if (
			!bookmarkIndex(session.state.doc, session.story.part).byName.has(name) &&
			!bookmarkIndex(body.state.doc, body.story.part).byName.has(name)
		)
			return false
	}

	const field = nodes.field.create({
		src: NO_SOURCE,
		end: NO_SOURCE,
		simple: false,
		type: code.type,
		instruction: ` ${instruction.trim()} `,
		result: ""
	})
	// The field takes the formatting at the caret (its w:lang the language its result is in), as typed text does.
	const tr = session.state.tr.replaceSelectionWith(field, true)
	const pos = tr.selection.from - field.nodeSize
	const inserted = tr.doc.nodeAt(pos)

	if (inserted?.type !== nodes.field) return false

	const result = new FieldEvaluation(pagedFieldHost(editor), session, session.context.identity.now(), tr.doc).result(inserted, pos)

	if (result !== undefined && result !== "") tr.setNodeAttribute(pos, "result", result)

	return session.dispatch(tr.scrollIntoView())
}

// insert.date as text: what a DATE field with the picture shows at the caret now (its language the caret's),
// typed there with the caret's formatting (a tracked insertion while tracking).
function insertDateText(editor: PagedEditor, format: string): boolean {
	const session = editor.session

	if (session.readOnly || !inParagraph(session.state)) return false

	const field = nodes.field.create({ src: NO_SOURCE, end: NO_SOURCE, type: "DATE", instruction: ` DATE \\@ "${format}" ` })
	const probe = session.state.tr.replaceSelectionWith(field, true)
	const pos = probe.selection.from - field.nodeSize
	const inserted = probe.doc.nodeAt(pos)
	// Evaluated as inserted: with the caret's formatting, its w:lang the language the date is in.
	const text =
		inserted?.type === nodes.field
			? new FieldEvaluation(pagedFieldHost(editor), session, session.context.identity.now(), probe.doc).result(inserted, pos)
			: undefined

	return text !== undefined && text !== "" && session.dispatch(session.state.tr.insertText(text).scrollIntoView())
}

// Whether Unlink Fields turns `node` into text: not a field deleted while tracking, nor a legacy check box or
// drop-down (what they show is their form data, not a result).
function unlinkable(node: Node): boolean {
	const type = node.attrs["type"] as string

	return node.type === nodes.field && !isDeleted(node) && type !== "FORMCHECKBOX" && type !== "FORMDROPDOWN"
}

// The fields Unlink Fields takes: those of the selection, else the one at the caret.
function fieldsToUnlink(state: EditorState): { node: Node; pos: number }[] {
	const out: { node: Node; pos: number }[] = []

	if (state.selection.empty || state.selection instanceof NodeSelection) {
		const caret = fieldAtCaret(state)

		if (caret !== undefined && unlinkable(caret.node)) out.push(caret)

		return out
	}

	state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
		if (unlinkable(node)) out.push({ node, pos })

		return !node.isLeaf
	})

	return out
}

// A field's shown result as inline content with the field's marks: tabs and line breaks as their nodes.
function resultContent(node: Node): Node[] {
	const text = shownFieldText(node.attrs["result"] as string, node.attrs["instruction"] as string)
	const out: Node[] = []
	let start = 0

	for (let k = 0; k <= text.length; k++) {
		const code = k < text.length ? text.charCodeAt(k) : -1

		if (code !== -1 && code !== 0x09 && code !== 0x0a) continue
		if (k > start) out.push(docxSchema.text(text.slice(start, k), node.marks))
		if (code === 0x09) out.push(nodes.tab.create(null, null, node.marks))
		else if (code === 0x0a) out.push(nodes.break.create({ type: "textWrapping" }, null, node.marks))

		start = k + 1
	}

	return out
}

// Unlink Fields (Ctrl+Shift+F9): each field replaced by its result as text with the field's formatting, as the
// user's edit (while tracking, the field deleted and its result inserted).
function unlinkFields(session: DocxEditorSession): boolean {
	const targets = fieldsToUnlink(session.state)

	if (targets.length === 0) return false

	const tr = session.state.tr

	for (let k = targets.length - 1; k >= 0; k--) {
		const { node, pos } = targets[k] as { node: Node; pos: number }

		tr.replaceWith(pos, pos + node.nodeSize, resultContent(node))
	}

	return session.dispatch(tr.scrollIntoView())
}

const insertable = (context: DocumentCommandContext): boolean => writable(context) && inParagraph(context.session.state)
// Updates read the laid-out pages and wait for layout to catch up: none while paged layout is suspended (another
// surface shows the document), where they would wait until it resumes.
const updatable = (context: DocumentCommandContext): boolean => writable(context) && !context.editor.suspended

const document: DocumentHandlers = {
	"view.fieldCodes": {
		enabled: () => true,
		run: context => context.editor.setFieldCodes(!context.editor.fieldCodes)
	},
	"view.fieldCode": {
		enabled: context => {
			const state = context.session.state

			return !state.selection.empty || fieldAtCaret(state) !== undefined || onToc(state)
		},
		run: context => {
			const { fields, from, to } = fieldsToSwitch(context.session)

			return context.editor.toggleFieldCodes(fields, { from, to })
		}
	},
	"field.update": {
		enabled: context => {
			const state = context.session.state

			return updatable(context) && (!state.selection.empty || fieldAtCaret(state) !== undefined || onToc(state, true))
		},
		run: context => update(context.editor, false)
	},
	"field.updateAll": {
		enabled: updatable,
		run: context => update(context.editor, true)
	},
	"field.unlink": {
		// As Update Field's: any selection (not walked for each snapshot), or a field at the caret.
		enabled: context => {
			const state = context.session.state
			const selection = state.selection

			if (!writable(context)) return false
			if (!selection.empty && !(selection instanceof NodeSelection)) return true

			const caret = fieldAtCaret(state)

			return caret !== undefined && unlinkable(caret.node)
		},
		run: context => unlinkFields(context.session)
	},
	"toc.insert": {
		enabled: context => insertable(context) && !context.editor.suspended && context.session === context.editor.body.session,
		run: (context, command) => insertToc(context.editor, command.levels, command.hyperlinks)
	},
	"toc.update": {
		enabled: context => updatable(context) && hasToc(context.session),
		run: (context, command) => updateToc(context.editor, command.pagesOnly)
	},
	"insert.pageNumber": {
		enabled: insertable,
		run: context => insertField(context.editor, "PAGE \\* MERGEFORMAT")
	},
	"insert.pageCount": {
		enabled: insertable,
		run: context => insertField(context.editor, "NUMPAGES \\* MERGEFORMAT")
	},
	"insert.date": {
		enabled: insertable,
		run: (context, command) =>
			command.field === false
				? insertDateText(context.editor, command.format)
				: insertField(context.editor, `DATE \\@ "${command.format}"`)
	},
	"insert.field": {
		enabled: insertable,
		run: (context, command) => insertField(context.editor, command.instruction)
	},
	"bookmark.add": {
		enabled: context => writable(context) && canAddBookmark(context.session),
		run: (context, command) => addBookmark(context.session, context.editor.sessions, command.name)
	},
	"bookmark.delete": {
		enabled: writable,
		run: (context, command) => deleteBookmark(context.session, command.name)
	},
	"bookmark.rename": {
		enabled: writable,
		run: (context, command) => renameBookmark(context.session, context.editor.sessions, command.name, command.to)
	}
}

export const FIELD_HANDLERS: FeatureHandlers = { document }

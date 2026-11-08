import { Fragment, Slice } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import type { DocxEditContext } from "../edit/context"
import { builtInStyleId } from "../edit/formats"
import { freshSlice, markInternal } from "../edit/invariants/index"
import { docxSchema } from "../edit/schema"
import { sourceCopies, type DocxEditorSession } from "../edit/session"
import type { HeaderFooterSet, Section } from "../model/index"
import type { PagedEditor } from "../paged/editor"
import { cloneStory, copySessions, type StoryTemplate } from "./clone"
import { hasStyleDefinition } from "../write/styles"
import { resolveSection } from "../styles/index"
import {
	bodySectionsOf,
	docSectionChanges,
	editSections,
	evenAndOddHeaders,
	pageOfCaret,
	registerSectionStory,
	sectionDocument,
	sectionNode,
	sectionProps,
	setEvenAndOddHeaders,
	setTitlePage,
	type DocxHeaderKind,
	type DocxHeaderType,
	type HeaderReferenceEdits,
	type SectionState
} from "./sections"

// Headers and footers: which one a page shows (its section's, of the type the page takes: the first page of a
// section with w:titlePg, an even page where the document has different even and odd ones, else the default),
// entering it, making one where a section shows none, linking a section's to the previous section's (it has
// none of its own) or unlinking it (its own, a copy of what it showed, as Word copies it), and removing one.

const nodes = docxSchema.nodes

// Where the header or footer being edited is shown, for the "Header — Close" chip and its toggles.
export interface DocxHeaderContext {
	readonly kind: DocxHeaderKind
	// The section of the page the caret is on (0-based), of `sections`.
	readonly section: number
	readonly sections: number
	readonly type: DocxHeaderType
	// The section's first page shows its own header and footer (w:titlePg).
	readonly differentFirst: boolean
	// Even pages show their own (document-wide w:evenAndOddHeaders).
	readonly differentOddEven: boolean
	// The section has none of its own of this type: it shows the previous section's ("Same as Previous").
	readonly linkedToPrevious: boolean
	// The first section links to nothing.
	readonly canLink: boolean
}

// The paged editor of each document's context, as the document commands see it (the snapshot's story context
// reads the pages through it).
const EDITORS = new WeakMap<DocxEditContext, PagedEditor>()

export function bindEditor(context: DocxEditContext, editor: PagedEditor): void {
	if (EDITORS.get(context) === editor) return

	EDITORS.set(context, editor)

	// A snapshot made before the editor was known is made again with what it shows.
	const kind = editor.session.story.story.kind

	if (kind === "header" || kind === "footer") editor.session.invalidate()
}

export function boundEditor(context: DocxEditContext): PagedEditor | undefined {
	return EDITORS.get(context)
}

function setOf(section: Section | SectionState, kind: DocxHeaderKind, effective: boolean): HeaderFooterSet {
	if (kind === "header") return effective ? section.effectiveHeaders : section.headers

	return effective ? section.effectiveFooters : section.footers
}

// Whether section `section` (as layout lays it out) shows a different first page.
function titlePageOf(editor: PagedEditor, section: Section): boolean {
	const body = editor.body.session
	const document = sectionDocument(section) ?? body.story.part.document

	return section.sectPr >= 0 && body.context.store.section(document, section.sectPr).titlePage === true
}

// The type of header and footer page `page` shows, and its section (as layout laid it out).
export function shownType(editor: PagedEditor, page: number): { readonly section: number; readonly type: DocxHeaderType } | undefined {
	const list = editor.page(page)
	const sections = editor.edits.model.sections
	const section = list === undefined ? undefined : sections[list.section]

	if (list === undefined || section === undefined) return undefined

	const first = page === 0 || editor.page(page - 1)?.section !== list.section

	if (first && titlePageOf(editor, section)) return { section: list.section, type: "first" }
	if (evenAndOddHeaders(editor.body.session.context, editor.body.session.state.doc) && list.number % 2 === 0)
		return { section: list.section, type: "even" }

	return { section: list.section, type: "default" }
}

// The page the caret is on: the active story's (a header shows on many: the one it was entered on).
function caretPage(editor: PagedEditor): number {
	return pageOfCaret(editor) ?? 0
}

// The header or footer context of the story being edited, or null when it is neither.
export function headerContext(editor: PagedEditor): DocxHeaderContext | null {
	const kind = editor.session.story.story.kind

	// The pages resting (another surface shows the document), none is placed on them.
	if ((kind !== "header" && kind !== "footer") || editor.suspended) return null

	const shown = shownType(editor, caretPage(editor))
	const sections = editor.edits.model.sections
	const section = shown === undefined ? undefined : sections[shown.section]

	if (shown === undefined || section === undefined) return null

	return {
		kind,
		section: shown.section,
		sections: sections.length,
		type: shown.type,
		differentFirst: titlePageOf(editor, section),
		differentOddEven: evenAndOddHeaders(editor.body.session.context, editor.body.session.state.doc),
		linkedToPrevious: shown.section > 0 && setOf(section, kind, false)[shown.type] < 0,
		canLink: shown.section > 0
	}
}

// ---- commands -------------------------------------------------------------------------------------------------

// Headers and footers are edited where they are shown: not in Mobile view, nor while the pages rest (their
// caret's page would be read from pages laid out before the edits since).
function writable(editor: PagedEditor): boolean {
	return !editor.body.session.readOnly && editor.pageCount > 0 && editor.headersShown && !editor.suspended
}

export function canEditHeader(editor: PagedEditor): boolean {
	return writable(editor)
}

type AddStory = (kind: DocxHeaderKind, id?: string, template?: StoryTemplate) => DocxEditorSession | undefined

// A new header or footer story, outside the undo history (the section edit referring to it is what undoes):
// a copy of story `copy` (the one an unlinked section showed, stories/clone.ts), else one empty paragraph of
// the Header or Footer style (added for section `section` when the document lacks it: its tabs are that
// section's).
function newStory(editor: PagedEditor, kind: DocxHeaderKind, section: number, copy?: number): number | undefined {
	const template = copy === undefined ? undefined : copyOf(editor, copy)
	const add: AddStory = editor.addStory.bind(editor)
	const session = add(kind, undefined, template)

	if (session === undefined) return undefined

	const context = session.context

	// Made from the template, the story holds the copy; else its content is set here.
	if (session.story.story.item < 0) {
		const style = context.styles.byName(kind, "paragraph")?.id ?? (hasStyleDefinition(kind) ? builtInStyleId(context, kind) : null)

		// The first section to add the style sets its tabs, as in Word.
		if (style !== null && context.newStyles.has(style) && !context.newStyleWidths.has(style)) {
			const width = textWidth(editor, section)

			if (width !== undefined) context.newStyleWidths.set(style, width)
		}

		const blocks =
			(copy === undefined ? undefined : pastedContent(editor, copy, session.story.part.index)) ??
			Fragment.from(nodes.paragraph.create({ styleId: style }))
		const tr = session.state.tr.replaceWith(0, session.state.doc.content.size, blocks)

		if (!session.dispatch(markInternal(tr).setMeta("addToHistory", false))) return undefined
	}

	registerSectionStory(context, session.story.story)

	return session.story.story.index
}

// The twips of text body section `index` holds across: its page less the side margins and a gutter at a side.
function textWidth(editor: PagedEditor, index: number): number | undefined {
	const state = bodySectionsOf(editor).states[index]

	if (state === undefined) return undefined

	const session = editor.body.session
	const { pageWidth, margins } = resolveSection(sectionProps(session.context, session.story.part, state))
	const gutter = session.context.model.settings.gutterAtTop ? 0 : Math.max(0, margins.gutter)
	const width = Math.round(pageWidth - margins.left - margins.right - gutter)

	return width > 0 ? width : undefined
}

// The part a copy of story `story` makes, as it is now (its session's document, when it has one, with the
// text boxes in it as their sessions have them).
function copyOf(editor: PagedEditor, story: number): StoryTemplate | undefined {
	const stories = editor.edits.model.stories
	const target = stories[story]
	const part = target === undefined ? undefined : editor.edits.model.parts[target.part]

	if (target === undefined || part === undefined || target.item < 0 || (target.kind !== "header" && target.kind !== "footer"))
		return undefined

	const { session, textboxes } = copySessions(editor, story)

	return cloneStory(editor.body.session.context, part, target.item, session, textboxes)
}

// A story's content made new (as a paste into part `target` makes it): what an unlinked section gets where the
// story cannot be copied whole (stories/clone.ts says when).
function pastedContent(editor: PagedEditor, story: number, target: number): Fragment | undefined {
	const session: DocxEditorSession | undefined = editor.storySession(story)

	if (session === undefined) return undefined

	const fresh = freshSlice(
		new Slice(session.state.doc.content, 0, 0),
		sourceCopies(session.context),
		session.story.part.index,
		target
	).content

	return fresh.childCount === 0 ? undefined : fresh
}

function references(
	kind: DocxHeaderKind,
	type: DocxHeaderType,
	story: number | null
): { headers?: HeaderReferenceEdits; footers?: HeaderReferenceEdits } {
	return kind === "header" ? { headers: { [type]: story } } : { footers: { [type]: story } }
}

function withReference(
	edit: { headers?: HeaderReferenceEdits; footers?: HeaderReferenceEdits },
	kind: DocxHeaderKind,
	type: DocxHeaderType,
	story: number | null
): { headers?: HeaderReferenceEdits; footers?: HeaderReferenceEdits } {
	const key = kind === "header" ? "headers" : "footers"

	return { [key]: { ...edit[key], ...references(kind, type, story)[key] } }
}

// Enters the header (or footer) of the caret's page, making one where its section shows none: the reference
// goes to the first section of the run of sections showing none of the type, so all of them show it (they are
// linked), as Word does.
export function editHeader(editor: PagedEditor, kind: DocxHeaderKind, page: number = caretPage(editor)): boolean {
	if (!canEditHeader(editor)) return false

	const shown = shownType(editor, page)

	if (shown === undefined) return false

	const { states } = bodySectionsOf(editor)
	const state = states[shown.section]

	if (state === undefined) return false

	const effective = setOf(state, kind, true)[shown.type]

	if (effective >= 0) return enter(editor, effective, page)

	let first = shown.section

	while (first > 0 && setOf(states[first - 1] as SectionState, kind, false)[shown.type] < 0) first--

	const story = newStory(editor, kind, first)

	if (story === undefined) return false

	const set = editSections(editor, [first], (_state, edit) => ({ ...edit, ...withReference(edit, kind, shown.type, story) }), false)

	return set && enter(editor, story, page)
}

function enter(editor: PagedEditor, story: number, page: number): boolean {
	if (!editor.enterStory(story, page)) return false

	const session = editor.session

	return session.dispatch(session.state.tr.setSelection(TextSelection.atStart(session.state.doc)).scrollIntoView())
}

// Whether the header or footer being edited can be linked to (or unlinked from) the previous section's.
export function canLink(editor: PagedEditor): boolean {
	const kind = editor.session.story.story.kind

	if ((kind !== "header" && kind !== "footer") || !writable(editor)) return false

	const shown = shownType(editor, caretPage(editor))

	return shown !== undefined && shown.section > 0
}

// Link to previous, toggled for the header or footer being edited: a section with its own loses it and shows
// the previous section's; one showing the previous section's gets its own, a copy of it with everything it
// holds (stories/clone.ts).
export function toggleLink(editor: PagedEditor): boolean {
	if (!canLink(editor)) return false

	const kind = editor.session.story.story.kind as DocxHeaderKind
	const page = caretPage(editor)
	const shown = shownType(editor, page)
	const { states } = bodySectionsOf(editor)
	const state = shown === undefined ? undefined : states[shown.section]

	if (shown === undefined || state === undefined) return false

	const own = setOf(state, kind, false)[shown.type]

	if (own >= 0) {
		const linked = editSections(
			editor,
			[shown.section],
			(_state, edit) => ({ ...edit, ...withReference(edit, kind, shown.type, null) }),
			false
		)
		const now = bodySectionsOf(editor).states[shown.section]
		const showing = now === undefined ? -1 : setOf(now, kind, true)[shown.type]

		if (!linked) return false
		if (showing >= 0) return enter(editor, showing, page)

		editor.exitStory()

		return true
	}

	const previous = setOf(state, kind, true)[shown.type]
	const story = newStory(editor, kind, shown.section, previous >= 0 ? previous : undefined)

	if (story === undefined) return false

	const unlinked = editSections(
		editor,
		[shown.section],
		(_state, edit) => ({ ...edit, ...withReference(edit, kind, shown.type, story) }),
		false
	)

	return unlinked && enter(editor, story, page)
}

// Whether the caret's page shows a header (footer) to remove.
export function canRemove(editor: PagedEditor, kind: DocxHeaderKind): boolean {
	if (!writable(editor)) return false

	const shown = shownType(editor, caretPage(editor))
	const section = shown === undefined ? undefined : editor.edits.model.sections[shown.section]

	return shown !== undefined && section !== undefined && setOf(section, kind, true)[shown.type] >= 0
}

// Removes the header (footer) the caret's page shows: every section referring to it loses the reference, so the
// sections linked to it lose it too. Where a section would then show the previous section's instead, it gets
// an empty one of its own: the page shows none, as Word's Remove Header leaves an unlinked section (Microsoft
// support, "Delete a header or footer from a single page").
export function removeHeader(editor: PagedEditor, kind: DocxHeaderKind): boolean {
	if (!canRemove(editor, kind)) return false

	const page = caretPage(editor)
	const shown = shownType(editor, page)
	const { states } = bodySectionsOf(editor)
	const state = shown === undefined ? undefined : states[shown.section]

	if (shown === undefined || state === undefined) return false

	const story = setOf(state, kind, true)[shown.type]
	const holders = new Set(
		states.filter(candidate => setOf(candidate, kind, false)[shown.type] === story).map(candidate => candidate.index)
	)
	// Those that would show a header of the previous sections' without their reference.
	const covered = new Set<number>()
	let showing = -1

	for (const candidate of states) {
		const own = setOf(candidate, kind, false)[shown.type]

		if (!holders.has(candidate.index)) {
			if (own >= 0) showing = own
		} else if (showing >= 0) {
			covered.add(candidate.index)
		}
	}

	const empty = covered.size === 0 ? undefined : newStory(editor, kind, Math.min(...covered))

	if (covered.size > 0 && empty === undefined) return false

	const leaving = editor.session.story.story.index === story

	if (
		!editSections(
			editor,
			[...holders],
			(candidate, edit) => ({
				...edit,
				...withReference(edit, kind, shown.type, covered.has(candidate.index) ? (empty ?? null) : null)
			}),
			false
		)
	)
		return false
	if (leaving) editor.exitStory()

	return true
}

// After a switch that changes which header and footer a page shows: the one the page edited on shows now is
// entered (made where it has none, as Word shows it ready to type in).
function reenter(editor: PagedEditor, kind: DocxHeaderKind | undefined, page: number, done: boolean): boolean {
	if (done && kind !== undefined) editHeader(editor, kind, page)

	return done
}

function editedKind(editor: PagedEditor): DocxHeaderKind | undefined {
	const kind = editor.session.story.story.kind

	return kind === "header" || kind === "footer" ? kind : undefined
}

export function toggleTitlePage(editor: PagedEditor): boolean {
	const page = caretPage(editor)
	const shown = shownType(editor, page)
	const { states } = bodySectionsOf(editor)
	const state = shown === undefined ? undefined : states[shown.section]
	const body = editor.body.session
	const node = state === undefined ? -1 : sectionNode(body.story.part, state.edit?.base ?? state.key)
	const current =
		state?.edit?.titlePage ?? (node >= 0 ? body.context.store.section(body.story.part.document, node).titlePage === true : false)

	return reenter(editor, editedKind(editor), page, setTitlePage(editor, !current))
}

export function toggleEvenAndOdd(editor: PagedEditor): boolean {
	const body = editor.body.session
	const page = caretPage(editor)
	const on = !(docSectionChanges(body.state.doc).evenAndOddHeaders ?? body.context.model.settings.evenAndOddHeaders)

	return reenter(editor, editedKind(editor), page, setEvenAndOddHeaders(editor, on))
}

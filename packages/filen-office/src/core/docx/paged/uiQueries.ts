import { sessionBookmarks, type BookmarkIndex, type DocxBookmark } from "../fields/bookmarks"
import { datePicture } from "../fields/evaluate"
import {
	DOCX_NOTE_NUMBER_FORMATS,
	type DocxNoteKind,
	type DocxNoteNumberFormat,
	type DocxNotePosition,
	type DocxNoteRestart
} from "../edit/commands/notes"
import {
	DOCX_PAGE_NUMBER_FORMATS,
	type DocxLineNumberRestart,
	type DocxOrientation,
	type DocxPageNumberFormat
} from "../edit/commands/sections"
import { docxSchema } from "../edit/schema"
import { NoteNumbering } from "../layout/notes"
import { bodySectionsOf, caretSection, docSectionChanges, mirrorMargins, sectionProps } from "../stories/sections"
import { resolveSection } from "../styles/index"
import type { SectionProps } from "../props/index"
import type { PagedEditor } from "./editor"

// What an app's dialogs show before they change something: the caret's section's page setup and note numbering
// (what page.setup and note.options would change, edits included), the bookmarks a link can go to, and a date
// as a date field's picture shows it. Read on demand (a dialog opening), never per keystroke.

// Every setting of Word's Page Setup dialog, in twips.
export interface DocxCurrentPageSetup {
	readonly size: { readonly width: number; readonly height: number }
	readonly orientation: DocxOrientation
	readonly margins: {
		readonly top: number
		readonly bottom: number
		readonly left: number
		readonly right: number
		readonly header: number
		readonly footer: number
		readonly gutter: number
	}
	readonly columns: { readonly count: number; readonly space: number; readonly separator: boolean }
	// Mirror margins, document-wide: `margins.left` is the inside margin and `margins.right` the outside one.
	readonly mirrorMargins: boolean
	// `start` null: numbering continues from the previous section; `format` null: one the commands do not offer.
	readonly pageNumbers: { readonly start: number | null; readonly format: DocxPageNumberFormat | null }
	readonly lineNumbers: {
		readonly countBy: number
		readonly start: number
		readonly distance: number
		readonly restart: DocxLineNumberRestart
	} | null
}

const PAGE_NUMBER_FORMATS: ReadonlySet<string> = new Set(DOCX_PAGE_NUMBER_FORMATS)
const NOTE_NUMBER_FORMATS: ReadonlySet<string> = new Set(DOCX_NOTE_NUMBER_FORMATS)
const NOTE_POSITIONS: ReadonlySet<string> = new Set(["pageBottom", "beneathText", "sectEnd", "docEnd"])
// Word's line numbers' distance from the text when the file gives none ("Auto": a quarter inch, as layout takes it).
const LINE_NUMBER_DISTANCE = 360

// The properties of the caret's section as edited (from the markup a save writes).
function caretSectionProps(editor: PagedEditor): SectionProps {
	const { session, part, states } = bodySectionsOf(editor)
	const state = states[caretSection(editor)] ?? states[states.length - 1]

	return state === undefined ? {} : sectionProps(session.context, part, state)
}

// The page setup of the caret's section, as layout lays it out: what the file leaves out is Word's (Letter, 1"
// margins, 0.5" header and footer, one column).
export function currentPageSetup(editor: PagedEditor): DocxCurrentPageSetup {
	const props = resolveSection(caretSectionProps(editor))
	const margins = props.margins
	const numbering = props.pageNumbering
	const format = numbering.format ?? "decimal"
	const lines = props.lineNumbering
	// Word shows no line numbers for w:countBy 0.
	const countBy = lines === undefined ? 0 : Math.round(lines.countBy ?? 1)

	return {
		size: { width: Math.round(props.pageWidth), height: Math.round(props.pageHeight) },
		orientation: props.orient,
		margins: {
			top: Math.round(margins.top),
			bottom: Math.round(margins.bottom),
			left: Math.round(margins.left),
			right: Math.round(margins.right),
			header: Math.round(margins.header),
			footer: Math.round(margins.footer),
			gutter: Math.round(margins.gutter)
		},
		columns: { count: props.columns.count, space: Math.round(props.columns.space), separator: props.columns.separator },
		mirrorMargins: mirrorMargins(editor.body.session.context, editor.body.session.state.doc),
		pageNumbers: {
			start: numbering.start ?? null,
			format: PAGE_NUMBER_FORMATS.has(format) ? (format as DocxPageNumberFormat) : null
		},
		lineNumbers:
			lines === undefined || countBy <= 0
				? null
				: {
						countBy,
						// Word numbers from w:start + 1 (MS-OI29500 2.1.215).
						start: (lines.start ?? 0) + 1,
						distance: Math.round(lines.distance ?? LINE_NUMBER_DISTANCE),
						restart: lines.restart ?? "newPage"
					}
	}
}

// Every setting of Word's Footnote and Endnote dialog for one kind of note.
export interface DocxCurrentNoteOptions {
	readonly kind: DocxNoteKind
	// Null: one the commands do not offer.
	readonly format: DocxNoteNumberFormat | null
	readonly start: number
	readonly restart: DocxNoteRestart
	readonly position: DocxNotePosition
}

// The numbering of notes of `kind` in the caret's section, as layout numbers them: the section's w:footnotePr
// (w:endnotePr) over the document's settings; where notes go is the document's alone.
export function currentNoteOptions(editor: PagedEditor, kind: DocxNoteKind): DocxCurrentNoteOptions {
	const endnote = kind === "endnote"
	const numbering = new NoteNumbering(editor.edits.model)
	const base = endnote ? numbering.documentEndnotes : numbering.documentFootnotes
	const section = caretSectionProps(editor)[endnote ? "endnotes" : "footnotes"]
	const format = section?.numFormat ?? base.format
	const restart = section?.numRestart ?? base.restart
	const position = docSectionChanges(editor.body.session.state.doc)[endnote ? "endnotePosition" : "footnotePosition"] ?? base.position

	return {
		kind,
		format: NOTE_NUMBER_FORMATS.has(format) ? (format as DocxNoteNumberFormat) : null,
		start: section?.numStart ?? base.start,
		// Endnotes never restart on each page.
		restart: restart === "eachSect" || (restart === "eachPage" && !endnote) ? restart : "continuous",
		position: NOTE_POSITIONS.has(position) ? (position as DocxNotePosition) : endnote ? "docEnd" : "pageBottom"
	}
}

const shownBookmarks = new WeakMap<BookmarkIndex, readonly DocxBookmark[]>()

// The document's bookmarks a link or cross-reference offers: the body's, hidden ones (_Toc, _Ref) left out, the
// first of a name only (Word's names are case-insensitive), in document order. The same array while the body is.
export function docxBookmarks(editor: PagedEditor): readonly DocxBookmark[] {
	const index = sessionBookmarks(editor.body.session)
	let shown = shownBookmarks.get(index)

	if (shown === undefined) {
		shown = Object.freeze([...index.byName.values()].filter(bookmark => !bookmark.hidden))
		shownBookmarks.set(index, shown)
	}

	return shown
}

// A link a press can follow: its relationship target as written (an external link) and its anchor (a bookmark
// of the document, or the target's fragment).
export interface DocxLinkAt {
	readonly target: string | null
	readonly anchor: string | null
}

// The link at `pos` of the story being edited (the character after it, or the one before it at a link's end),
// for Ctrl/Cmd+Click and Open link; undefined outside a link. Read on a press only.
export function docxLinkAt(editor: PagedEditor, pos: number): DocxLinkAt | undefined {
	const doc = editor.session.state.doc

	if (pos < 0 || pos > doc.content.size) return undefined

	const $pos = doc.resolve(pos)
	const link = docxSchema.marks.link

	if (!$pos.parent.isTextblock) return undefined

	const mark = link.isInSet($pos.nodeAfter?.marks ?? []) ?? link.isInSet($pos.nodeBefore?.marks ?? [])

	if (mark === undefined) return undefined

	const target = mark.attrs["target"] as string | null
	const anchor = mark.attrs["anchor"] as string | null

	return target === null && anchor === null ? undefined : { target, anchor }
}

// Where an internal link goes: the start of the body's bookmark named `name` (names are case-insensitive, the
// first of duplicates wins, as in Word); undefined when the document has none of that name.
export function docxBookmarkStart(editor: PagedEditor, name: string): number | undefined {
	return sessionBookmarks(editor.body.session).byName.get(name.toLowerCase())?.from
}

// The date `ms` (epoch milliseconds) under a \@ date-time picture, month and day names in `language`.
export function formatDatePicture(ms: number, picture: string, language?: string): string {
	return datePicture(new Date(ms), picture, language)
}

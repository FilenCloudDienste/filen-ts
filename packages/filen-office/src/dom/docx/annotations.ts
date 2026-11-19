import type {
	EditAnnotationComment,
	EditAnnotationRevision,
	EditAnnotationRevisionKind,
	EditAnnotationRevisionTarget,
	EditAnnotationRun
} from "../../core/docx/paged/annotations"

// A document's comments and tracked changes as plain data, with where they sit on the laid-out pages: what
// an app needs to draw margin balloons, change bars and highlighted ranges in its own UI. The geometry is
// in the pages' px (unscaled) and belongs to the layout of the view the document was opened in.

// Boxes of annotated text: RECT_FLOATS per box (x, y, width, height on its page), the page in rectPages.
export const RECT_FLOATS = 4

// One definition with the editor's live annotations (core/docx/paged/annotations.ts): the viewer's are the
// same, without a change's id, story and what a formatting change changed.
export type DocxCommentRun = EditAnnotationRun
export type DocxComment = EditAnnotationComment
export type DocxRevisionKind = EditAnnotationRevisionKind
export type DocxRevisionTarget = EditAnnotationRevisionTarget
export type DocxRevision = Omit<EditAnnotationRevision, "id" | "story" | "format">

export interface DocxAnnotations {
	readonly authors: readonly string[]
	readonly comments: readonly DocxComment[]
	readonly revisions: readonly DocxRevision[]
	readonly rectPages: Int32Array
	readonly rectFloats: Float32Array
}

export const EMPTY_ANNOTATIONS: DocxAnnotations = {
	authors: [],
	comments: [],
	revisions: [],
	rectPages: new Int32Array(0),
	rectFloats: new Float32Array(0)
}

// How tracked changes and comments show, as in Word's Review > Display for Review. Simple markup lays out
// the document as if every change were accepted and marks changed lines; all markup lays out insertions
// and deletions inline; no markup shows the accepted result alone; original the text before any change.
export type DocxMarkupMode = "all" | "simple" | "none" | "original"

export interface DocxMarkupInfo {
	readonly mode: DocxMarkupMode
	// The revision view the document is laid out in (DocxOpenOptions.view).
	readonly view: "markup" | "final" | "original"
	// Comment balloons in the margin.
	readonly comments: boolean
	// Balloons for formatting changes.
	readonly formatting: boolean
	// Bars beside changed lines.
	readonly changeBars: boolean
	// Commented text shaded in its author's colour.
	readonly highlights: boolean
}

const SIMPLE_MARKUP: DocxMarkupInfo = {
	mode: "simple",
	view: "final",
	comments: true,
	formatting: false,
	changeBars: true,
	highlights: false
}

export const DOCX_MARKUP_MODES: readonly DocxMarkupInfo[] = [
	{ mode: "all", view: "markup", comments: true, formatting: true, changeBars: true, highlights: true },
	SIMPLE_MARKUP,
	{ mode: "none", view: "final", comments: false, formatting: false, changeBars: false, highlights: false },
	{
		mode: "original",
		view: "original",
		comments: false,
		formatting: false,
		changeBars: false,
		highlights: false
	}
]

// The mode a reviewed document opens in (our default: comments and changed lines shown, no relayout).
export const DEFAULT_MARKUP_MODE: DocxMarkupMode = SIMPLE_MARKUP.mode

export function markupInfo(mode: DocxMarkupMode): DocxMarkupInfo {
	return DOCX_MARKUP_MODES.find(info => info.mode === mode) ?? SIMPLE_MARKUP
}

// Untrusted input (a bridge message) to a mode, or undefined.
export function parseDocxMarkupMode(value: unknown): DocxMarkupMode | undefined {
	return DOCX_MARKUP_MODES.find(info => info.mode === value)?.mode
}

// Authors' colours cycle through this many --fo-revision-<n> variables (1-based).
export const DOCX_REVISION_COLORS = 8

// The CSS colour of an author (-1: no author), as a --fo-revision-<n> variable.
export function revisionColor(author: number): string {
	const slot = author < 0 ? DOCX_REVISION_COLORS : (author % DOCX_REVISION_COLORS) + 1

	return `var(--fo-revision-${slot}, var(--fo-revision-mark, #000))`
}

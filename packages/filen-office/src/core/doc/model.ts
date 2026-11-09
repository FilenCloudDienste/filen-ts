import type { DocFib } from "./fib"
import type { DocFont } from "./fonts"
import type { DocLists, ListLabel } from "./lists"
import type { DocChar, DocPara, DocRow, DocSectionProps } from "./props"
import type { DocStyleSheet } from "./styles"

// The intermediate model of a Word binary document: CP-indexed text with resolved properties, and every
// structure needed to emit WordprocessingML. CPs are global (all stories share one CP space, §2.3.1).

export type DocStoryKind = "main" | "footnotes" | "headers" | "macro" | "comments" | "endnotes" | "textboxes" | "headerTextboxes"

export interface DocStory {
	readonly kind: DocStoryKind
	readonly start: number
	readonly end: number
}

export interface DocRun {
	readonly start: number
	readonly end: number
	readonly props: DocChar
	// The direct grpprl (Chpx) and the piece's Prm grpprl, views into the file.
	readonly direct: Uint8Array | undefined
	readonly pieceDirect: Uint8Array | undefined
}

// How a paragraph ends (§2.4.3).
export type DocParagraphEnd = "paragraph" | "cell" | "row" | "section" | "none"

export interface DocParagraph {
	readonly start: number
	// Exclusive; includes the mark.
	readonly end: number
	readonly ending: DocParagraphEnd
	readonly props: DocPara
	// Table depth (0 outside tables).
	readonly depth: number
	// Row properties, on row (TTP) marks.
	readonly row: DocRow | undefined
	readonly list: ListLabel | undefined
	readonly direct: Uint8Array | undefined
	readonly pieceDirect: Uint8Array | undefined
}

export type DocBlock = { readonly kind: "paragraph"; readonly index: number } | DocTable

export interface DocTable {
	readonly kind: "table"
	readonly depth: number
	readonly rows: readonly DocTableRow[]
}

export interface DocTableRow {
	// Index of the row's TTP paragraph (holding the row properties).
	readonly mark: number
	readonly cells: readonly (readonly DocBlock[])[]
}

export interface DocSection {
	readonly start: number
	readonly end: number
	readonly props: DocSectionProps
	readonly direct: Uint8Array | undefined
	// Header story ranges (absolute CPs) by kind; undefined when the section inherits.
	readonly headers: DocHeaderSet
}

export interface DocHeaderSet {
	readonly evenHeader: DocStory | undefined
	readonly oddHeader: DocStory | undefined
	readonly evenFooter: DocStory | undefined
	readonly oddFooter: DocStory | undefined
	readonly firstHeader: DocStory | undefined
	readonly firstFooter: DocStory | undefined
}

export interface DocNoteSeparators {
	readonly footnoteSeparator: DocStory | undefined
	readonly footnoteContinuationSeparator: DocStory | undefined
	readonly footnoteContinuationNotice: DocStory | undefined
	readonly endnoteSeparator: DocStory | undefined
	readonly endnoteContinuationSeparator: DocStory | undefined
	readonly endnoteContinuationNotice: DocStory | undefined
}

export interface DocNote {
	// The reference character in the main document.
	readonly reference: number
	// Auto-numbered (FRD.nAuto > 0), else the reference text is a custom mark.
	readonly auto: boolean
	// The number shown for an auto-numbered note (section numbering format, restart and start value).
	readonly label: string | undefined
	readonly text: DocStory
}

export interface DocComment {
	readonly reference: number
	readonly text: DocStory
	readonly author: string
	readonly initials: string
	// ATRDPost10.dttm (AtrdExtra, Word 2002+) as an ISO 8601 local time; undefined when absent or zero.
	readonly date: string | undefined
	// Commented range when the comment has one (SttbfAtnBkmk + PlcfAtnBkf/Bkl).
	readonly rangeStart: number | undefined
	readonly rangeEnd: number | undefined
}

export interface DocField {
	readonly begin: number
	readonly separator: number | undefined
	readonly end: number
	// flt (§2.9.90) from the begin character.
	readonly type: number
	// grffldEnd from the end character.
	readonly flags: number
	readonly story: DocStoryKind
}

export interface DocBookmark {
	readonly name: string
	readonly start: number
	readonly end: number
	readonly column: number | undefined
}

// Content this reader recognises but leaves to later stages, at its anchor CP: never dropped silently.
export type DocPlaceholder =
	// An inline picture (fSpec 0x01 with sprmCPicLocation): PICF at `dataOffset` in the Data stream.
	| { readonly kind: "picture"; readonly cp: number; readonly dataOffset: number }
	// Form field data (fData): FFData (§2.9.75) after a 68-byte header at `dataOffset` in the Data stream.
	| { readonly kind: "formField"; readonly cp: number; readonly dataOffset: number }
	// An embedded OLE object: the ObjectPool storage "_<objectId>".
	| { readonly kind: "ole"; readonly cp: number; readonly objectId: number }
	// A floating OfficeArt shape (fSpec 0x08 + PlcSpa): shape id and anchor rectangle in twips.
	| {
			readonly kind: "shape"
			readonly cp: number
			readonly spid: number
			readonly header: boolean
			readonly left: number
			readonly top: number
			readonly right: number
			readonly bottom: number
			// FSPA bx: 0 margin, 1 page, 2 column; by: 0 margin, 1 page, 2 paragraph.
			readonly relativeH: number
			readonly relativeV: number
			// FSPA wr (0–5) and wrk (0 both sides, 1 left, 2 right, 3 largest).
			readonly wrap: number
			readonly wrapSide: number
			readonly behindText: boolean
	  }
	// An fSpec 0x08 anchor without a PlcSpa entry, or a 0x01 without a picture location.
	| { readonly kind: "unresolvedObject"; readonly cp: number; readonly char: number }

export interface DocTextBox {
	readonly story: DocStory
	readonly header: boolean
	// The shape id (FTXBXS.lid / txidUndo) when the box is not a reusable continuation.
	readonly spid: number
}

export type DocIssueCode =
	// Characters of a piece lie outside the WordDocument stream and read as U+FFFD.
	| "damagedText"
	// An optional structure could not be read; its content is not represented.
	| "unreadableStructure"
	// Field begin/separator/end characters that do not nest.
	| "unbalancedField"
	// Table marks without a matching row.
	| "unbalancedTable"

export interface DocIssue {
	readonly code: DocIssueCode
	readonly message: string
}

export interface DocModel {
	readonly fib: DocFib
	// The whole CP space as text.
	readonly text: string
	readonly stories: readonly DocStory[]
	readonly paragraphs: readonly DocParagraph[]
	readonly runs: readonly DocRun[]
	// Block structure per story, in story order (paragraph indexes into `paragraphs`).
	readonly blocks: ReadonlyMap<DocStoryKind, readonly DocBlock[]>
	readonly styles: DocStyleSheet
	readonly fonts: readonly DocFont[]
	readonly lists: DocLists
	readonly sections: readonly DocSection[]
	readonly noteSeparators: DocNoteSeparators
	readonly footnotes: readonly DocNote[]
	readonly endnotes: readonly DocNote[]
	readonly comments: readonly DocComment[]
	readonly fields: readonly DocField[]
	readonly bookmarks: readonly DocBookmark[]
	// SttbfRMark: revision authors (DocRevision.author indexes this).
	readonly revisionAuthors: readonly string[]
	readonly textBoxes: readonly DocTextBox[]
	readonly placeholders: readonly DocPlaceholder[]
	// The Dop (§2.7.1), a view, for document settings.
	readonly dop: Uint8Array
	// The default character properties (STSHI fonts) and, per sprm name, counts of sprms seen that no typed
	// property takes (they stay in each run's or paragraph's direct grpprl).
	readonly defaultChar: DocChar
	readonly untypedSprms: ReadonlyMap<string, number>
	readonly issues: readonly DocIssue[]
}

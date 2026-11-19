// What one model item is. Items are stored in document (pre-)order per part; a container's descendants
// are the items after it up to its end.
export const Item = {
	// Story roots
	Body: 1,
	Header: 2,
	Footer: 3,
	Note: 4,
	Comment: 5,
	Textbox: 6,
	// Blocks
	Paragraph: 10,
	Table: 11,
	Row: 12,
	Cell: 13,
	SectionProperties: 14,
	AltChunk: 15,
	// Wrappers: at any level, children are of the wrapper's own level
	Sdt: 20,
	CustomXml: 21,
	SmartTag: 22,
	Hyperlink: 23,
	FieldSimple: 24,
	Insertion: 25,
	Deletion: 26,
	MoveFrom: 27,
	MoveTo: 28,
	Bidi: 29,
	AlternateContent: 30,
	// Runs and their content
	Run: 40,
	Text: 41,
	DeletedText: 42,
	InstrText: 43,
	DeletedInstrText: 44,
	Tab: 45,
	Break: 46,
	CarriageReturn: 47,
	LastRenderedPageBreak: 48,
	Symbol: 49,
	SoftHyphen: 50,
	NoBreakHyphen: 51,
	PositionalTab: 52,
	FieldChar: 53,
	FootnoteReference: 54,
	EndnoteReference: 55,
	FootnoteMark: 56,
	EndnoteMark: 57,
	Separator: 58,
	ContinuationSeparator: 59,
	CommentReference: 60,
	AnnotationMark: 61,
	Drawing: 62,
	VmlPicture: 63,
	EmbeddedObject: 64,
	Ruby: 65,
	RubyText: 66,
	RubyBase: 67,
	PageNumber: 68,
	DateTimePart: 69,
	ContentPart: 70,
	// Range markers
	BookmarkStart: 75,
	BookmarkEnd: 76,
	CommentRangeStart: 77,
	CommentRangeEnd: 78,
	MoveFromRangeStart: 79,
	MoveFromRangeEnd: 80,
	MoveToRangeStart: 81,
	MoveToRangeEnd: 82,
	PermissionStart: 83,
	PermissionEnd: 84,
	CustomXmlRangeMarker: 85,
	// Math: one item per equation (m:oMathPara, m:oMath), its OMML read by core/math and edited by docx/math/edit.ts
	MathParagraph: 90,
	Math: 91,
	// Anything not modelled: kept by span, never rendered as content
	Opaque: 99
} as const

export type Item = (typeof Item)[keyof typeof Item]

export const ITEM_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(Item).map(([name, code]) => [code, name]))

// Containers whose children layout walks through as if they were not there.
export const TRANSPARENT: Uint8Array = (() => {
	const out = new Uint8Array(128)

	for (const kind of [
		Item.Sdt,
		Item.CustomXml,
		Item.SmartTag,
		Item.Hyperlink,
		Item.FieldSimple,
		Item.Insertion,
		Item.Deletion,
		Item.MoveFrom,
		Item.MoveTo,
		Item.Bidi,
		Item.AlternateContent,
		Item.Run
	]) {
		out[kind] = 1
	}

	return out
})()

// Break@type.
export const BreakType = { TextWrapping: 0, Page: 1, Column: 2 } as const
// Break@clear.
export const BreakClear = { None: 0, Left: 1, Right: 2, All: 3 } as const
// FieldChar@fldCharType.
export const FieldCharType = { Unknown: 0, Begin: 1, Separate: 2, End: 3 } as const

export const SdtLevel = { Block: 0, Run: 1, Row: 2, Cell: 3 } as const
export type SdtLevel = (typeof SdtLevel)[keyof typeof SdtLevel]

export const Revision = {
	Insertion: 1,
	Deletion: 2,
	MoveFrom: 3,
	MoveTo: 4,
	MoveFromRange: 5,
	MoveToRange: 6,
	// Revisions recorded inside property elements of the item that owns them
	RunProperties: 10,
	ParagraphProperties: 11,
	SectionProperties: 12,
	TableProperties: 13,
	RowProperties: 14,
	CellProperties: 15,
	TableGrid: 16,
	TablePropertiesException: 17,
	Numbering: 18,
	ParagraphMarkInsertion: 20,
	ParagraphMarkDeletion: 21,
	ParagraphMarkMoveFrom: 22,
	ParagraphMarkMoveTo: 23,
	RowInsertion: 24,
	RowDeletion: 25,
	CellInsertion: 26,
	CellDeletion: 27,
	CellMerge: 28
} as const

export type Revision = (typeof Revision)[keyof typeof Revision]

export const REVISION_NAMES: Readonly<Record<number, string>> = Object.fromEntries(
	Object.entries(Revision).map(([name, code]) => [code, name])
)

// Tracked-change state of a paragraph mark, row or cell, as bit flags.
export const RevisionFlag = { Inserted: 1, Deleted: 2, MovedFrom: 4, MovedTo: 8, Merged: 16 } as const

// What paragraph text and the walker show of tracked changes: everything, the result of accepting all,
// or the result of rejecting all.
export const RevisionView = { Markup: 0, Final: 1, Original: 2 } as const
export type RevisionView = (typeof RevisionView)[keyof typeof RevisionView]

// Whether something carrying `flags` is absent from `view`: deleted or moved-away content from Final,
// inserted or moved-in content from Original.
export function revisionHidden(flags: number, view: RevisionView): boolean {
	if (view === RevisionView.Final) return (flags & (RevisionFlag.Deleted | RevisionFlag.MovedFrom)) !== 0
	if (view === RevisionView.Original) return (flags & (RevisionFlag.Inserted | RevisionFlag.MovedTo)) !== 0

	return false
}

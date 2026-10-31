import type { EntryResult } from "./interop"

// Differences between LibreOffice's reading of an edited save and ours that are LibreOffice's, each shown on a
// minimal document converted by LibreOffice 7.5 and 26.8, kept apart from real failures. A pattern matches a
// failure line ("L2 final: ..."), optionally only for some corpus sources or offices.

export interface Accepted {
	readonly failure: RegExp
	readonly source?: RegExp
	readonly office?: RegExp
	// Only where the original or the edited file holds the construct (a witness count of fuzz/saves.ts).
	readonly witness?: string
	readonly reason: string
}

export const ACCEPTED: readonly Accepted[] = [
	{
		failure: /^(L2 (final|original)|G7 text): .*"(TBLPLACEHOLDER|CHKOLD|W15OLD|DATEOLD|true|Employer|☒)"/,
		source: /docx4j__text-bind-parity\./,
		reason: "LibreOffice shows a data-bound content control's custom XML value (a checkbox's raw \"true\") instead of its content; this file's content and store differ on purpose"
	},
	{
		failure: /^(L2 (final|original)|G7 text): .*"HYPERLINK"/,
		office: /^lo-7\./,
		reason: "LibreOffice 7.5 shows a hyperlink inside a block content control as its field code (fixed in 26.8)"
	},
	{
		failure: /^(L1 (pdf|odt|docx): |G7 (back )?gate: no file$)/,
		office: /^lo-7\./,
		witness: "notesStartingWithTable",
		reason: "LibreOffice 7.5 hangs or aborts laying out a document once a note starts with a table, and then writes no ODT or DOCX to read back (a copy of govuk__LPC202603_Open_Call_2_year_ITT_Document_ with one footnote that starts with a table hangs, and converts with a paragraph before that table; an edited govuk__DfE_Model_PFI_School_Agreement__Faith_Schools_ hangs past 300 s and converts in 4 s once an empty paragraph precedes its note's table; 26.8 converts all). A note may start with a table: CT_FtnEdn holds block-level content (ECMA-376 Part 1 §17.11.10, §17.11.2)"
	},
	{
		failure: /^L1 pdf: timed out$/,
		source: /govuk__20260501_Final_Customs_Tariff_Quotas_Reference_Document__v4\.5\./,
		reason: "LibreOffice loops laying out this document once a picture or an equation is placed in its empty last paragraph, which follows a floating table (w:tblpPr, ECMA-376 Part 1 §17.4.57): the PDF export of the edited save runs past 300 s at full CPU in 25.8 (and past the 60 s limit in 24.2), as does a save with either edit alone, while the original converts in about 1 s, the save without the w:tblpPr converts, and a taller paragraph of text alone does not loop"
	},
	{
		failure: /^L2 original: /,
		office: /^lo-26\./,
		witness: "formattedChangeRuns",
		reason: 'LibreOffice 26.8 loses part of an insertion or deletion with all changes rejected when its runs also record a format change (a minimal document (insertion runs format change): "Durlening", a minimal document (deletion run format change): the deleted word gone, where 7.5 and the file keep "During" and the word); ECMA-376 Part 1 §17.13.5.18 ins, §17.13.5.14 del, §17.13.5.31 rPrChange'
	},
	{
		failure: /^(L2 (final|original)|G7 text): /,
		witness: "longCustomMarks",
		reason: 'LibreOffice shows a custom note mark (w:customMarkFollows, ECMA-376 Part 1 §17.11.7, §17.11.14) of more than one character twice: as the note\'s citation and again as body text after it (a minimal document (custom mark two chars): "ma**rgins" with the citation "**"; a one-character mark reads "margins")'
	},
	{
		failure: /^L2 original: /,
		witness: "nestedDeletions",
		reason: 'LibreOffice keeps one tracked change per text range: text inserted (or moved) and then deleted keeps only the deletion, so with all changes rejected it shows the text that was never there (a minimal document (inserted then deleted): rejected, "AgoneB" where the file says "A  B"; a minimal document (moved then deleted)); ECMA-376 Part 1 §17.13.5.14 del inside §17.13.5.18 ins / §17.13.5.25 moveTo'
	},
	{
		failure: /^L2 original: /,
		witness: "commentMarkRevisions",
		reason: "LibreOffice moves a paragraph mark inserted as a tracked change in a comment out of the comment, into the body, as an insertion without author (a minimal document (comment mark insertion): the body's first paragraph mark becomes inserted, so its paragraphs join with all changes rejected)"
	},
	{
		failure: /^(L2 (final|original)|G7 text): /,
		office: /^lo-7\./,
		witness: "breakAnchors",
		reason: 'LibreOffice 7.5 drops a page or column break that comes after text when the next thing in the paragraph is a floating drawing, joining the text on both sides (a minimal document (page break then anchor): "Text before the break.After", where 26.8 and a minimal document (page break plain) keep two paragraphs); ECMA-376 Part 1 §17.3.3.1 br: the text after a page break starts on the next page'
	},
	{
		failure: /^(L2 (final|original)|G7 text): /,
		office: /^lo-26\./,
		witness: "nestedTocs",
		reason: 'LibreOffice 26.8 ends a table of contents at the end of a TOC field nested in its result and shows the rest of the outer result as body text (a minimal document (toc in toc result): "Outer rest" after the index, where 7.5 keeps it in the index); fields nest, ECMA-376 Part 1 §17.16.18 fldChar, §17.16.5.68 TOC'
	},
	{
		failure: /^L2 (final|original): /,
		office: /^lo-7\./,
		witness: "framedCellParagraphs",
		reason: 'LibreOffice 7.5 drops every tracked change of a document holding a framed paragraph (w:framePr, ECMA-376 Part 1 §17.3.1.11) in a table cell: the text reads as if all changes were rejected (a minimal document (framed cell paragraph loses changes): "If yes" where the w:del (§17.13.5.14) leaves "Ies"; a minimal document (unframed cell paragraph keeps changes), the same without the frame, and 26.8 keep the change)'
	},
	{
		failure: /^(L2 (final|original)|G7 text): /,
		witness: "tocLinks",
		reason: 'LibreOffice writes the text of a link to a "_Toc" bookmark (w:hyperlink w:anchor, ECMA-376 Part 1 §17.16.22) as the result of a PAGEREF field it adds (§17.16.5), so a reader that leaves page numbers out loses the link text (a minimal document (toc bookmark link): "c" in PAGEREF _Toc996 \\h, a link to "Other" kept plain; both versions)'
	},
	{
		failure: /^G7 text: /,
		witness: "bodyWatermarks",
		reason: 'LibreOffice takes Word\'s watermark shape (v:shape id "PowerPlusWaterMarkObject…", ECMA-376 Part 4 §19.1.2) found in the body for a page watermark and writes its paragraph, text included, nowhere in its DOCX (a minimal document (watermark shape paragraph dropped): "Text before" gone; its own text keeps it; a minimal document (watermark shape no spid kept) keeps it; both versions)'
	},
	{
		failure: /^G7 (gate|back gate|text): /,
		office: /^lo-7\./,
		witness: "linkBeforeTextboxGroup",
		reason: 'LibreOffice 7.5 writes malformed XML for a paragraph holding a link and, after it, a drawing group with a text box: the link\'s end tag lands inside the text box (a minimal document (link then textbox group): "mismatched tag"; 26.8 writes it well-formed), which no reader may open (XML 1.0 §2.1 well-formedness; ECMA-376 Part 1 §17.16.22 hyperlink)'
	},
	{
		failure: /^(L2 (final|original)|G7 text): /,
		office: /^lo-7\./,
		witness: "placeholderChanges",
		reason: 'LibreOffice 7.5 reads a block content control showing its placeholder (w:showingPlcHdr, ECMA-376 Part 1 §17.5.2) as an input field whose text ends in a carriage return and moves the tracked changes in it (§17.13.5) to that end: a deletion in the text becomes the deletion of the paragraph mark, which joins the next paragraph with a break between (a minimal document (placeholder tracked change): 7.5 "[Insert text. Cli" and in its DOCX "[Insert text.Cli", where Word and 26.8 read "[ert text." | "Cli"; a minimal document (placeholder mark deleted); a minimal document (placeholder mark kept), no change, reads the same)'
	},
	{
		failure: /^L2 original: /,
		witness: "insertedSectionMarks",
		reason: 'LibreOffice cannot reject a tracked insertion of a paragraph mark that ends a section with headers or footers of its own (the section becomes a page style of its own) and keeps the paragraph (a minimal document (inserted section mark headers): rejected, "you mu" | "st ensure" in both versions, "you must ensure" without the header and footer references: (inserted section mark headers control)); ECMA-376 Part 1 §17.13.5.16 ins (inserted paragraph mark), §17.10.5 headerReference'
	},
	{
		failure: /^L2 original: /,
		witness: "insertedAnchorMarks",
		reason: 'LibreOffice cannot reject a tracked insertion of the mark of a paragraph that holds a floating drawing and keeps the paragraph (a minimal document (inserted mark after anchor): rejected, "Social and emo" | "tional development" in both versions; without the drawing, (inserted mark after anchor control), joined); ECMA-376 Part 1 §17.13.5.16 ins, §20.4.2.3 anchor'
	},
	{
		failure: /^L2 (final|original): .*"1899"/,
		office: /^lo-7\./,
		witness: "boundDateControls",
		reason: 'LibreOffice 7.5 shows a date control bound to custom XML as its bound value read as a date, and a value that is no date as day 0 of its date serials, "December 30, 1899" (a minimal document (bound date text), where the store holds the control\'s text; a minimal document (bound date iso) shows the stored date; 26.8 shows the text); ECMA-376 Part 1 §17.5.2.6 dataBinding, §17.5.2.38 storeMappedDataAs'
	},
	{
		failure: /^(L2 (final|original)|G7 text): /,
		office: /^lo-7\./,
		witness: "blockControlRevisions",
		reason: 'LibreOffice 7.5 reads a block-level content control as an input field that keeps no tracked change: a deletion inside stays as text and an inserted paragraph mark becomes a line break in the field (a minimal document (block control tracked), (placeholder block tracked): "[Degree]\\rCli" where the file deletes "Deg" and inserts the mark after it; 26.8 reads "[ree]" | "Cli"); ECMA-376 Part 1 §17.5.2.29 sdt, §17.13.5.14 del, §17.13.5.16 ins'
	},
	{
		failure: /^L1 txt: /,
		office: /^lo-26\./,
		witness: "bodyEndsWithTable",
		reason: "LibreOffice 26.8's plain-text export of a body whose last block is a table never ends, writing an unbounded temporary file (a minimal document (body ends with table): past 300 MB in 18 s; (body table then paragraph): 16 B in 3 s; 7.5 converts both). A body may end with a table: CT_Body is EG_BlockLevelElts then w:sectPr (ECMA-376 Part 1 §17.2.2)"
	},
	{
		failure: /^(L1 (pdf|odt|docx|txt): |G7 (back )?gate: no file$)/,
		witness: "noteFloatsUnderTallFooters",
		reason: "LibreOffice lays a document out forever when a note holds a floating drawing (wp:anchor) and the footer's drawings take most of the page (a minimal document with a floating picture in a footnote and an 8-inch footer picture: 7.5 past 300 s, with a short footer 3 s; an edited govuk__BP18_1026 hangs in both versions and converts once either its notes' floating drawings or its footer's drawings are removed); a note holds any block-level content, drawings included (ECMA-376 Part 1 §17.11.10, §20.4.2.3 anchor)"
	}
]

// Failures that are no difference the edit made: a format LibreOffice cannot convert the unedited original to
// either (the corpus's oxpt__Watermark-2.docx exports to an empty text in both versions), and a missing DOCX from
// LibreOffice's own ODT of the save (only LibreOffice reads and writes there: such an ODT writes nothing in both
// versions, and converts with the paragraph that breaks it and those after it left out).
function notTheEdits(entry: EntryResult, failure: string): string | undefined {
	const format = /^L1 (\w+): /.exec(failure)?.[1]

	if (format !== undefined && entry.l1Original.includes(format))
		return `LibreOffice cannot convert the unedited original to ${format} either`

	if (failure === "G7 back gate: no file" && !entry.l1.some(item => item.startsWith("odt:")))
		return "LibreOffice wrote no DOCX from its own ODT of the save, which only LibreOffice reads and writes"

	return undefined
}

export function acceptedReason(entry: EntryResult, failure: string, office: string): string | undefined {
	const own = notTheEdits(entry, failure)

	if (own !== undefined) return own

	return ACCEPTED.find(
		item =>
			item.failure.test(failure) &&
			(item.source === undefined || item.source.test(entry.source)) &&
			(item.office === undefined || item.office.test(office)) &&
			(item.witness === undefined || (entry.witness.before[item.witness] ?? 0) + (entry.witness.after[item.witness] ?? 0) > 0)
	)?.reason
}

// Counts LibreOffice reads its own way on a construct our reading also counts (fuzz/saves.ts: the witness): in
// each file, LibreOffice's count may differ from ours by up to the number of instances, in the direction `per`
// (each instance may add one, or remove one), so the residual of the deltas is accepted within what the
// instances of the original and the edited file allow. Each is shown on
// a minimal document converted by LibreOffice 7.5 and 26.8.
export interface AcceptedCount {
	readonly metric: string
	readonly witness: string
	readonly per: 1 | -1
	readonly office?: RegExp
	readonly reason: string
}

export const ACCEPTED_COUNTS: readonly AcceptedCount[] = [
	{
		metric: "equations",
		witness: "separatorEquations",
		per: -1,
		reason: "LibreOffice does not import the continuation separators (w:footnote/w:endnote w:type continuationSeparator, continuationNotice; ECMA-376 Part 1 §17.11.10, §17.18.33) and moves a separator's content into the first note (a minimal document (equation in continuation separator): 1 equation in, 0 out)"
	},
	{
		metric: "equations",
		witness: "coveredEquations",
		per: -1,
		reason: "LibreOffice keeps no content in a cell that continues a vertical merge (w:vMerge, ECMA-376 Part 1 §17.4.84; an ODF covered cell): its text and equations are gone (a minimal document (vmerge continuation content): 6 paragraphs in, 5 out, the continuation cell's text dropped; cells and paragraphs are counted without them on our side, fuzz/saves.ts)"
	},
	{
		metric: "equations",
		witness: "headerEquations",
		per: -1,
		reason: "LibreOffice imports only the headers and footers a page style uses: an even-page one without w:evenAndOddHeaders, a first-page one without w:titlePg are not shown (ECMA-376 Part 1 §17.10.1, §17.10.6) and not imported (a minimal document (equation in even footer): 1 equation in, 0 out)"
	},
	{
		metric: "bodyParagraphs",
		witness: "emptySectionParagraphs",
		per: -1,
		reason: "LibreOffice drops an empty paragraph that ends a section (a minimal document (empty section break paragraph): 3 paragraphs in, 2 out); Word keeps it, ECMA-376 Part 1 §17.6.17: the section's properties are stored on its last paragraph, which stays a paragraph"
	},
	{
		metric: "bodyParagraphs",
		witness: "emptyLastSection",
		per: 1,
		reason: "LibreOffice gives a last section that holds no paragraph an empty one (a minimal document (empty last section): 2 paragraphs in, 3 out)"
	},
	{
		metric: "bodyParagraphs",
		witness: "deletedSectionMarks",
		per: 1,
		reason: "LibreOffice cannot track the deletion of a paragraph mark that ends a section (its section becomes a text:section or page style) and keeps the paragraph (a minimal document (deleted section mark): 2 paragraphs with the change accepted, 3 out); ECMA-376 Part 1 §17.13.5.15: the deleted mark joins the paragraph to the next"
	},
	{
		metric: "bodyParagraphs",
		witness: "framedParagraphs",
		per: 1,
		reason: "LibreOffice holds a framed paragraph (w:framePr) in a text frame and may add an empty paragraph to anchor it (a minimal document (framed after page break): 3 paragraphs in, 4 out)"
	},
	{
		metric: "bodyParagraphs",
		witness: "movedMarksInserted",
		per: 1,
		reason: "LibreOffice loses a moved-away paragraph mark when the paragraph also holds an insertion: it keeps the mark with changes accepted and drops another one with them rejected (a minimal document (moved mark with insertion): final 3 paragraphs, original 2, where both are 2 and 3); ECMA-376 Part 1 §17.13.5.21 moveFrom (Move Source Paragraph)"
	},
	{
		metric: "bodyParagraphs",
		witness: "startTableAnnotated",
		per: 1,
		office: /^lo-7\./,
		reason: "LibreOffice 7.5 puts an empty paragraph before a table that starts the body once the body holds a note reference or a comment (a minimal document (table start footnote), (table start comment later), (floating table comment range): 2 paragraphs in, 3 out; 26.8 reads 2); ECMA-376 Part 1 §17.2.2: a body may start with a table"
	},
	{
		metric: "bodyParagraphs",
		witness: "breakAnchors",
		per: -1,
		office: /^lo-7\./,
		reason: "LibreOffice 7.5 drops the paragraph start of a page or column break that is followed by a floating drawing (wp:anchor), where it keeps it without the drawing and 26.8 keeps it with (a minimal document (section break then anchored picture): 4 paragraphs out of 26.8, 3 out of 7.5; (section then page break): 4 out of both); ECMA-376 Part 1 §17.3.3.1 br"
	},
	{
		metric: "bodyParagraphs",
		witness: "floatingTableBeforeTable",
		per: 1,
		office: /^lo-26\./,
		reason: "LibreOffice 26.8 gives a floating table (w:tblpPr) directly followed by a table an empty paragraph to anchor its frame to (a minimal document (floating table then table): 3 paragraphs in, 4 out; 7.5 anchors it to the paragraph after the table, 3 out); ECMA-376 Part 1 §17.4.57 tblpPr"
	},
	{
		metric: "bodyParagraphs",
		witness: "customMarkBreaks",
		per: 1,
		office: /^lo-26\./,
		reason: 'LibreOffice 26.8 moves a page break that starts a paragraph holding a note reference to that reference and splits the paragraph there, once the body has a note with a custom mark (w:customMarkFollows) before it (a minimal document (custom mark then page break note): 2 paragraphs in, 3 out, "colu" | "mn"; 7.5 reads 2; without the note in the paragraph, (custom mark then page break), 2); ECMA-376 Part 1 §17.11 (footnoteReference/endnoteReference w:customMarkFollows), §17.3.3.1 br'
	},
	{
		metric: "bodyParagraphs",
		witness: "tocSdtLeadingText",
		per: 1,
		reason: "LibreOffice imports a TOC field in a block content control as an index of its own, so text before the field's begin in the same paragraph keeps a paragraph of its own (a minimal document (toc gallery space begin), (toc plain sdt space begin): 6 paragraphs in, 7 out of both versions; with nothing before the begin, (toc gallery sdt), 6 and 6); ECMA-376 Part 1 §17.16.5 (TOC field), §17.5.2 (block-level w:sdt)"
	},
	{
		metric: "bodyParagraphs",
		witness: "indexTailDeletedMarks",
		per: 1,
		reason: "LibreOffice keeps an index (text:table-of-content) apart from the paragraph after it: when the paragraph mark holding the TOC field's end is deleted as a tracked change, the change accepted joins it to the next paragraph in Word (ECMA-376 Part 1 §17.13.5.15) but not in LibreOffice (a minimal document (toc tail deleted): 3 paragraphs with the changes accepted, 4 out of both versions; (toc tail kept): 5 and 5)"
	},
	{
		metric: "bodyParagraphs",
		witness: "floatingTrackedRows",
		per: -1,
		reason: "LibreOffice holds a floating table (w:tblpPr) in a text frame, where its rows' tracked insertions and deletions (w:trPr w:ins / w:del, ECMA-376 Part 1 §17.13.5) become text changes (7.5) or a deletion of the whole frame (26.8), so the rows' paragraphs are not kept as our ODF reading keeps an in-flow table's (a minimal document (floating table deleted rows): 7 paragraphs in our reading, 3 out of both versions)"
	},
	{
		metric: "bodyParagraphs",
		witness: "floatingTrackedRows",
		per: 1,
		reason: "As the entry before: LibreOffice's reading of floating tables with tracked rows differs either way (a minimal document (floating table deleted rows), (floating table inserted rows); oxpt__RA001-Tracked-Revisions-01 unedited: 191 paragraphs ours, 190 in 7.5, 162 in 26.8)"
	},
	{
		metric: "equations",
		witness: "commentEquations",
		per: -1,
		reason: "LibreOffice imports a comment's text only, without its equations (a minimal document (equation in comment): one equation in the body and two in the comment, one math object out of both versions); ECMA-376 Part 1 §17.13.4.2 comment holds block-level content, m:oMathPara and m:oMath included (§22.1.2.78, §22.1.2.77)"
	},
	{
		metric: "comments",
		witness: "commentsAfterShapeRange",
		per: -1,
		office: /^lo-26\./,
		reason: "LibreOffice 26.8 drops a comment with no text in its range (or no range) that comes after the end of another comment's range holding a floating shape and before that comment's reference (a minimal document (comment in group range empty): 2 comments in, 1 out of 26.8, 2 out of 7.5; with text in place of the shape, (comment in group range empty text), 2; with text in the later comment's range, (comment in group range two) keeps it); ECMA-376 Part 1 §17.13.4.3 commentRangeEnd, §17.13.4.5 commentReference"
	},
	{
		metric: "bodyParagraphs",
		witness: "blockControlInsertedMarks",
		per: -1,
		office: /^lo-7\./,
		reason: "LibreOffice 7.5 reads a block-level content control as an input field: a paragraph mark inserted as a tracked change inside becomes a line break in it (a minimal document (block control tracked): 5 paragraphs in, 4 out of 7.5, 5 out of 26.8); ECMA-376 Part 1 §17.5.2.29 sdt, §17.13.5.16 ins"
	},
	{
		metric: "tables",
		witness: "drawingTextboxTables",
		per: -1,
		reason: "LibreOffice imports a DrawingML text box (wps:txbx) as a custom shape whose text holds paragraphs only (ODF 1.3 Part 3 §10.6.1 draw:custom-shape), so a table in it becomes its cells' paragraphs, where Word keeps it (w:txbxContent holds tables, ECMA-376 Part 1 §17.17.1.1) (a minimal document (textbox table): 2 tables in our reading, 1 out of both versions, the cells' text kept; a VML text box keeps it, a minimal document (textbox table vml): 2 and 2)"
	},
	{
		metric: "rows",
		witness: "drawingTextboxRows",
		per: -1,
		reason: "As the entry before, for the rows of a table in a DrawingML text box (a minimal document (textbox table): 4 rows in our reading, 2 out of both versions)"
	}
]

// Why a count residual is LibreOffice's, or undefined. `before`, `after`: our reading's witness counts of the
// original and the edited file.
export function acceptedCount(
	metric: string,
	theirs: number,
	ours: number,
	before: Readonly<Record<string, number>>,
	after: Readonly<Record<string, number>>,
	office: string
): string | undefined {
	const residual = theirs - ours
	const items = ACCEPTED_COUNTS.filter(item => item.metric === metric && (item.office === undefined || item.office.test(office)))
	let low = 0
	let high = 0

	for (const item of items) {
		const was = before[item.witness] ?? 0
		const is = after[item.witness] ?? 0

		// LibreOffice's delta is (theirs after - theirs before); each file's own error lies between 0 and per x count.
		low -= item.per > 0 ? was : is
		high += item.per > 0 ? is : was
	}

	if (residual === 0 || residual < low || residual > high) return undefined

	return items
		.filter(item => (before[item.witness] ?? 0) + (after[item.witness] ?? 0) > 0)
		.map(item => item.reason)
		.join("; ")
}

// Witness counts the accepted differences name, kept per entry by interop.ts.
export const WITNESSES: readonly string[] = [
	...new Set([
		...ACCEPTED.flatMap(item => (item.witness === undefined ? [] : [item.witness])),
		...ACCEPTED_COUNTS.map(item => item.witness)
	])
]

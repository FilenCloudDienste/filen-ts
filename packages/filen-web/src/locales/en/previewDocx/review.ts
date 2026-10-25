// "preview" namespace, Word document editor — comments and tracked changes while editing: the review menu, balloons, the author prompt. Spread into preview.ts; same catalog rules.
export const previewDocxReview = {
	/** Docx editor — Review menu switch recording every edit as a tracked change with the author's name (Word's "Track Changes") */
	previewDocxTrackChanges: "Track changes",
	/** Docx editor — Review menu item accepting the tracked change at the cursor */
	previewDocxAcceptChange: "Accept change",
	/** Docx editor — Review menu item rejecting the tracked change at the cursor */
	previewDocxRejectChange: "Reject change",
	/** Docx editor — Review menu item accepting every tracked change in the document */
	previewDocxAcceptAll: "Accept all changes",
	/** Docx editor — Review menu item rejecting every tracked change in the document */
	previewDocxRejectAll: "Reject all changes",
	/** Docx editor — Review menu item moving the cursor to the next tracked change */
	previewDocxNextChange: "Next change",
	/** Docx editor — Review menu item moving the cursor to the previous tracked change */
	previewDocxPreviousChange: "Previous change",
	/** Docx editor — Review menu and context menu item starting a new comment on the selected text */
	previewDocxNewComment: "New comment",
	/** Docx editor — Review menu item selecting the next comment's text */
	previewDocxNextComment: "Next comment",
	/** Docx editor — Review menu item selecting the previous comment's text */
	previewDocxPreviousComment: "Previous comment",
	/** Docx editor — button under a comment thread posting the reply typed in the field above it */
	previewDocxCommentReply: "Reply",
	/** Docx editor — comment menu item turning the comment's text into a field to change it */
	previewDocxCommentEdit: "Edit",
	/** Docx editor — comment menu item marking the thread done (Word's "Resolve thread") */
	previewDocxCommentResolve: "Resolve",
	/** Docx editor — comment menu item marking a resolved thread open again */
	previewDocxCommentReopen: "Reopen",
	/** Docx editor — comment menu item deleting the comment (a thread's first comment takes its replies with it) */
	previewDocxCommentDelete: "Delete",
	/** Docx editor — accessible name of a comment's ⋯ menu button */
	previewDocxCommentActions: "Comment actions",
	/** Docx editor — placeholder and accessible name of the field a new comment is typed in */
	previewDocxCommentPlaceholder: "Add a comment",
	/** Docx editor — placeholder and accessible name of the reply field under a comment thread */
	previewDocxReplyPlaceholder: "Reply",
	/** Docx editor — button posting a new comment typed in its field */
	previewDocxCommentPost: "Comment",
	/** Docx editor — button keeping a comment's changed text */
	previewDocxCommentSave: "Save",
	/** Docx editor — button dropping what was typed in a comment field */
	previewDocxCommentCancel: "Cancel",
	/** Docx editor — accessible name of the popover or balloon showing one comment thread; {{author}} = who started it */
	previewDocxCommentThread: "Comments by {{author}}",
	/** Docx editor — tracked change card: text inserted; the text follows in quotes */
	previewDocxChangeInserted: "Inserted",
	/** Docx editor — tracked change card: text deleted; the text follows in quotes */
	previewDocxChangeDeleted: "Deleted",
	/** Docx editor — tracked change card: text moved away from here (Word's "Moved (deletion)") */
	previewDocxChangeMovedFrom: "Moved from here",
	/** Docx editor — tracked change card: text moved to here (Word's "Moved (insertion)") */
	previewDocxChangeMovedTo: "Moved here",
	/** Docx editor — tracked change card: a paragraph break inserted */
	previewDocxChangeParagraphInserted: "Inserted paragraph",
	/** Docx editor — tracked change card: a paragraph break deleted (two paragraphs joined) */
	previewDocxChangeParagraphDeleted: "Deleted paragraph",
	/** Docx editor — tracked change card: table rows or cells inserted */
	previewDocxChangeTableInserted: "Inserted table cells",
	/** Docx editor — tracked change card: table rows or cells deleted */
	previewDocxChangeTableDeleted: "Deleted table cells",
	/** Docx editor — accessible name of the card about one tracked change; {{author}} = who made it */
	previewDocxChangeCard: "Change by {{author}}",
	/** Docx editor — button in a change card or balloon keeping the tracked change in the document */
	previewDocxAccept: "Accept",
	/** Docx editor — button in a change card or balloon undoing the tracked change */
	previewDocxReject: "Reject",
	/** Docx editor — tracked change balloon of a table's, row's or cell's changed properties (Word's wording) */
	previewDocxFormattedTable: "Formatted Table",
	/** Docx editor — what a formatting change changed: the font's changes, comma-separated, as Word's balloons list them ({{items}} e.g. "Bold, Italic") */
	previewDocxFormatFont: "Font: {{items}}",
	/** Docx editor — formatting change: the font for Latin text, before its name (Word's "Font: (Default) Arial") */
	previewDocxFormatDefault: "(Default)",
	/** Docx editor — formatting change: the font for East Asian text, before its name */
	previewDocxFormatAsian: "(Asian)",
	/** Docx editor — formatting change: the font for complex scripts (Arabic, Hebrew...), before its name */
	previewDocxFormatComplex: "(Complex)",
	/** Docx editor — formatting change: a script's font or size; {{script}} e.g. "(Default)", {{value}} the font or size */
	previewDocxFormatScriptValue: "{{script}} {{value}}",
	/** Docx editor — formatting change: a theme font and the typeface it is ({{theme}} "+Body"/"+Headings", {{name}} e.g. "Calibri") */
	previewDocxFormatThemeFont: "{{theme}} ({{name}})",
	/** Docx editor — formatting change: hidden text */
	previewDocxFormatHidden: "Hidden",
	/** Docx editor — formatting change: hidden text shown again */
	previewDocxFormatNotHidden: "Not Hidden",
	/** Docx editor — formatting change: the underline's colour ({{color}} a colour's name) */
	previewDocxFormatUnderlineColor: "Underline color: {{color}}",
	/** Docx editor — formatting change: the theme's body font */
	previewDocxFormatThemeBody: "+Body",
	/** Docx editor — formatting change: the theme's body font for East Asian text (Word's "+Body Asian") */
	previewDocxFormatThemeBodyAsian: "+Body Asian",
	/** Docx editor — formatting change: the theme's headings font for East Asian text */
	previewDocxFormatThemeHeadingsAsian: "+Headings Asian",
	/** Docx editor — formatting change: the theme's body font for complex scripts (Word's "+Body CS") */
	previewDocxFormatThemeBodyComplex: "+Body CS",
	/** Docx editor — formatting change: the theme's headings font for complex scripts */
	previewDocxFormatThemeHeadingsComplex: "+Headings CS",
	/** Docx editor — formatting change: the theme's headings font */
	previewDocxFormatThemeHeadings: "+Headings",
	/** Docx editor — formatting change: a size in points */
	previewDocxFormatPoints: "{{points}} pt",
	/** Docx editor — formatting change: text made bold */
	previewDocxFormatBold: "Bold",
	/** Docx editor — formatting change: bold removed (Word's wording) */
	previewDocxFormatNotBold: "Not Bold",
	/** Docx editor — formatting change: text made italic */
	previewDocxFormatItalic: "Italic",
	/** Docx editor — formatting change: italic removed */
	previewDocxFormatNotItalic: "Not Italic",
	/** Docx editor — formatting change: struck through */
	previewDocxFormatStrike: "Strikethrough",
	/** Docx editor — formatting change: strikethrough removed */
	previewDocxFormatNotStrike: "Not Strikethrough",
	/** Docx editor — formatting change: double strikethrough */
	previewDocxFormatDoubleStrike: "Double strikethrough",
	/** Docx editor — formatting change: double strikethrough removed */
	previewDocxFormatNotDoubleStrike: "Not Double strikethrough",
	/** Docx editor — formatting change: small capitals */
	previewDocxFormatSmallCaps: "Small caps",
	/** Docx editor — formatting change: small capitals removed */
	previewDocxFormatNotSmallCaps: "Not Small caps",
	/** Docx editor — formatting change: all capitals */
	previewDocxFormatCaps: "All caps",
	/** Docx editor — formatting change: all capitals removed */
	previewDocxFormatNotCaps: "Not All caps",
	/** Docx editor — formatting change: underlined */
	previewDocxFormatUnderline: "Underline",
	/** Docx editor — formatting change: double underline */
	previewDocxFormatDoubleUnderline: "Double underline",
	/** Docx editor — formatting change: thick underline */
	previewDocxFormatThickUnderline: "Thick underline",
	/** Docx editor — formatting change: dotted underline */
	previewDocxFormatDottedUnderline: "Dotted underline",
	/** Docx editor — formatting change: wavy underline */
	previewDocxFormatWaveUnderline: "Wave underline",
	/** Docx editor — formatting change: underline removed */
	previewDocxFormatNoUnderline: "No underline",
	/** Docx editor — formatting change: raised as superscript */
	previewDocxFormatSuperscript: "Superscript",
	/** Docx editor — formatting change: lowered as subscript */
	previewDocxFormatSubscript: "Subscript",
	/** Docx editor — formatting change: back on the baseline (Word's wording, space after the slash included) */
	previewDocxFormatBaseline: "Not Superscript/ Subscript",
	/** Docx editor — formatting change: character spacing widened */
	previewDocxFormatExpanded: "Expanded by {{points}} pt",
	/** Docx editor — formatting change: character spacing narrowed */
	previewDocxFormatCondensed: "Condensed by {{points}} pt",
	/** Docx editor — formatting change: character spacing back to normal (Word's wording) */
	previewDocxFormatNormalSpacing: "Not Expanded by / Condensed by",
	/** Docx editor — formatting change: the text colour ({{color}} a colour's name) */
	previewDocxFormatFontColor: "Font color: {{color}}",
	/** Docx editor — formatting change: the automatic colour or spacing */
	previewDocxFormatAuto: "Auto",
	/** Docx editor — formatting change: a colour with no name, as Word writes it */
	previewDocxFormatCustomColor: "Custom Color(RGB({{red}},{{green}},{{blue}}))",
	/** Docx editor — formatting change: the theme's hyperlink colour */
	previewDocxFormatHyperlink: "Hyperlink",
	/** Docx editor — formatting change: the theme's visited-link colour */
	previewDocxFormatFollowedHyperlink: "Followed Hyperlink",
	/** Docx editor — formatting change: highlighted */
	previewDocxFormatHighlight: "Highlight",
	/** Docx editor — formatting change: highlight removed */
	previewDocxFormatNotHighlight: "Not Highlight",
	/** Docx editor — formatting change: shading behind the text ({{color}} its colour) */
	previewDocxFormatPattern: "Pattern: Clear ({{color}})",
	/** Docx editor — formatting change: shading removed */
	previewDocxFormatNoPattern: "Pattern: Clear",
	/** Docx editor — formatting change: a character style removed (Word's name for none) */
	previewDocxFormatDefaultCharacterStyle: "Default Paragraph Font",
	/** Docx editor — formatting change: a paragraph style removed (Normal applies) */
	previewDocxFormatNormalStyle: "Normal",
	/** Docx editor — formatting change: paragraph aligned left */
	previewDocxFormatLeft: "Left",
	/** Docx editor — formatting change: paragraph centred */
	previewDocxFormatCentered: "Centered",
	/** Docx editor — formatting change: paragraph aligned right */
	previewDocxFormatRight: "Right",
	/** Docx editor — formatting change: paragraph justified */
	previewDocxFormatJustified: "Justified",
	/** Docx editor — formatting change: paragraph distributed */
	previewDocxFormatDistributed: "Distributed",
	/** Docx editor — formatting change: the paragraph's indents ({{items}} e.g. "Left: 1 cm, Hanging: 0.5 cm") */
	previewDocxFormatIndent: "Indent: {{items}}",
	/** Docx editor — formatting change: left indent */
	previewDocxFormatIndentLeft: "Left: {{length}}",
	/** Docx editor — formatting change: right indent */
	previewDocxFormatIndentRight: "Right: {{length}}",
	/** Docx editor — formatting change: first line indent */
	previewDocxFormatIndentFirstLine: "First line: {{length}}",
	/** Docx editor — formatting change: hanging indent */
	previewDocxFormatIndentHanging: "Hanging: {{length}}",
	/** Docx editor — formatting change: a length in centimetres */
	previewDocxFormatCentimetres: "{{value}} cm",
	/** Docx editor — formatting change: a length in inches (Word writes the inch mark) */
	previewDocxFormatInches: '{{value}}"',
	/** Docx editor — formatting change: space above the paragraph */
	previewDocxFormatSpaceBefore: "Space Before: {{value}}",
	/** Docx editor — formatting change: space below the paragraph */
	previewDocxFormatSpaceAfter: "Space After: {{value}}",
	/** Docx editor — formatting change: space below, right after "Space Before" */
	previewDocxFormatAfter: "After: {{value}}",
	/** Docx editor — formatting change: line spacing */
	previewDocxFormatLineSpacing: "Line spacing: {{value}}",
	/** Docx editor — formatting change: single line spacing (lower case, as Word writes it) */
	previewDocxFormatSingle: "single",
	/** Docx editor — formatting change: one and a half line spacing */
	previewDocxFormatOneAndHalf: "1.5 lines",
	/** Docx editor — formatting change: double line spacing */
	previewDocxFormatDouble: "double",
	/** Docx editor — formatting change: line spacing as a multiple of lines */
	previewDocxFormatMultiple: "Multiple {{lines}} li",
	/** Docx editor — formatting change: exact line spacing */
	previewDocxFormatExactly: "Exactly {{points}} pt",
	/** Docx editor — formatting change: minimum line spacing */
	previewDocxFormatAtLeast: "At least {{points}} pt",
	/** Docx editor — formatting change: made a bulleted list item at a level */
	previewDocxFormatBulleted: "Bulleted + Level: {{level}}",
	/** Docx editor — formatting change: made a numbered list item at a level */
	previewDocxFormatNumbered: "Numbered + Level: {{level}}",
	/** Docx editor — formatting change: taken out of a list */
	previewDocxFormatNoList: "No bullets or numbering",
	/** Docx editor — formatting change: the paragraph's borders */
	previewDocxFormatBorder: "Border",
	/** Docx editor — formatting change: kept on the page of the next paragraph */
	previewDocxFormatKeepNext: "Keep with next",
	/** Docx editor — formatting change: no longer kept with the next paragraph */
	previewDocxFormatNotKeepNext: "Don't keep with next",
	/** Docx editor — formatting change: its lines kept on one page */
	previewDocxFormatKeepLines: "Keep lines together",
	/** Docx editor — formatting change: its lines may break across pages */
	previewDocxFormatNotKeepLines: "Don't keep lines together",
	/** Docx editor — formatting change: starts on a new page */
	previewDocxFormatPageBreakBefore: "Page break before",
	/** Docx editor — formatting change: no longer starts on a new page */
	previewDocxFormatNoPageBreakBefore: "No page break before",
	/** Docx editor — formatting change: outline level */
	previewDocxFormatLevel: "Level {{level}}",
	/** Docx editor — formatting change: no outline level */
	previewDocxFormatBodyText: "Body Text",
	/** Docx editor — toast: an edit refused because what it changes can't be saved as a tracked change */
	previewDocxEditUnsupported: "This edit can't be made here",
	/** Docx editor — toast body: why the edit was refused */
	previewDocxEditUnsupportedBody: "Part of what it changes can't be saved as a tracked change."
} as const

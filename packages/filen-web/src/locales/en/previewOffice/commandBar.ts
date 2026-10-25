// "preview" namespace — the document viewers' command bar (PDF, text and code, markdown, the Word document viewer):
// one row of the ribbon's groups with the File menu first and the status at its end. Spread into preview.ts; same
// catalog rules.
export const previewCommandBar = {
	/** Document viewers — command bar group: moving between pages */
	previewCommandBarPages: "Pages",
	/** Document viewers — command bar button: go to the first page */
	previewCommandBarFirstPage: "First page",
	/** Document viewers — command bar button: go to the last page */
	previewCommandBarLastPage: "Last page",
	/** Document viewers — accessible name of the command bar's page number field (type a page and press Enter) */
	previewCommandBarPageNumber: "Page number",
	/** Document viewers — shown after the page number field: the number of pages ({{total}}) */
	previewCommandBarPageTotal: "of {{total, number}}",
	/** Document viewers — command bar menu button choosing a zoom level ({{percent}}, the current one) */
	previewCommandBarZoomLevel: "Zoom level, {{percent}}%",
	/** Document viewers — zoom menu item: the page in view fits the window, all of it */
	previewCommandBarFitPage: "Fit page",
	/** Document viewers — command bar group: turning the pages */
	previewCommandBarRotate: "Rotate",
	/** Document viewers — command bar button: turn every page a quarter turn to the left */
	previewCommandBarRotateLeft: "Rotate counterclockwise",
	/** Document viewers — command bar button: turn every page a quarter turn to the right */
	previewCommandBarRotateRight: "Rotate clockwise",
	/** PDF viewer — command bar menu of the document's bookmarks (its table of contents) */
	previewCommandBarOutline: "Outline",
	/** Document viewers — command bar button: show the document on the whole screen */
	previewCommandBarFullScreen: "Full screen",
	/** Document viewers — command bar button: leave full screen */
	previewCommandBarExitFullScreen: "Exit full screen",
	/** PDF viewer — File menu item and dialog title: what the document says about itself */
	previewCommandBarProperties: "Document properties",
	/** PDF viewer — document properties row */
	previewCommandBarPropertyTitle: "Title",
	/** PDF viewer — document properties row */
	previewCommandBarPropertyAuthor: "Author",
	/** PDF viewer — document properties row */
	previewCommandBarPropertySubject: "Subject",
	/** PDF viewer — document properties row */
	previewCommandBarPropertyKeywords: "Keywords",
	/** PDF viewer — document properties row: the application the document was made in */
	previewCommandBarPropertyCreator: "Application",
	/** PDF viewer — document properties row: the software that wrote the PDF */
	previewCommandBarPropertyProducer: "PDF producer",
	/** PDF viewer — document properties row */
	previewCommandBarPropertyCreated: "Created",
	/** PDF viewer — document properties row */
	previewCommandBarPropertyModified: "Modified",
	/** PDF viewer — document properties row: the number of pages */
	previewCommandBarPropertyPages: "Pages",
	/** PDF viewer — document properties row */
	previewCommandBarPropertySize: "File size",
	/** PDF viewer — document properties row: the PDF version the file declares */
	previewCommandBarPropertyVersion: "PDF version",
	/** PDF viewer — document properties: a property the document does not give */
	previewCommandBarPropertyNone: "—",
	/** Text editor — command bar button: undo the last edit */
	previewCommandBarUndo: "Undo",
	/** Text editor — command bar button: redo the last undone edit */
	previewCommandBarRedo: "Redo",
	/** Text editor — command bar button and dialog title: move the cursor to a line */
	previewCommandBarGoToLine: "Go to line",
	/** Text editor — go to line dialog: the field's label ({{total}}, the number of lines) */
	previewCommandBarGoToLineLabel: "Line number (1–{{total, number}})",
	/** Text editor — go to line dialog: its button */
	previewCommandBarGoToLineSubmit: "Go",
	/** Text editor — command bar group: commenting and folding code */
	previewCommandBarCode: "Code",
	/** Text editor — command bar button: comment or uncomment the selected lines */
	previewCommandBarToggleComment: "Toggle comment",
	/** Text editor — command bar button: fold every foldable block */
	previewCommandBarFoldAll: "Fold all",
	/** Text editor — command bar button: unfold every folded block */
	previewCommandBarUnfoldAll: "Unfold all",
	/** Text editor — command bar button and dialog title: compare the unsaved edits with the file as it was opened */
	previewCommandBarViewChanges: "View changes",
	/** Text editor — view changes: the file as it was opened */
	previewCommandBarChangesOpened: "As opened",
	/** Text editor — view changes: the edits not saved yet */
	previewCommandBarChangesEdited: "Your edits",
	/** Text editor — view changes, one column: how the differences are coloured */
	previewCommandBarChangesLegend: "Red lines were removed, green lines added since the file was opened.",
	/** Markdown editor — command bar group: markdown formatting */
	previewCommandBarFormatting: "Formatting",
	/** Markdown editor — command bar button */
	previewCommandBarBold: "Bold",
	/** Markdown editor — command bar button */
	previewCommandBarItalic: "Italic",
	/** Markdown editor — command bar button */
	previewCommandBarStrikethrough: "Strikethrough",
	/** Markdown editor — command bar button */
	previewCommandBarInlineCode: "Inline code",
	/** Markdown editor — command bar button */
	previewCommandBarLink: "Link",
	/** Markdown viewer — command bar group and switch: the rendered page or its markdown source */
	previewCommandBarMarkdownView: "Markdown view",
	/** Markdown viewer — switch option: the rendered page */
	previewCommandBarRendered: "Rendered",
	/** Markdown viewer — switch option: the markdown source */
	previewCommandBarSource: "Source",
	/** Text editor — command bar toggle: wrap long lines at the window's edge */
	previewCommandBarWrap: "Wrap lines",
	/** Text editor — command bar toggle: show line numbers */
	previewCommandBarLineNumbers: "Line numbers",
	/** Text editor — command bar menu: the editor's text size ({{size}} in pixels) */
	previewCommandBarFontSize: "Font size, {{size}} px",
	/** Text editor — font size menu item ({{size}} in pixels) */
	previewCommandBarFontSizeOption: "{{size}} px",
	/** Text editor — command bar menu: the language the text is highlighted as */
	previewCommandBarLanguage: "Language",
	/** Text editor — language menu item and status: no highlighting */
	previewCommandBarPlainText: "Plain text",
	/** Text editor — command bar menu: what the Tab key inserts and how wide a tab shows */
	previewCommandBarIndent: "Indentation",
	/** Text editor — indentation option and status: indent with tab characters */
	previewCommandBarIndentTabs: "Tabs",
	/** Text editor — indentation option and status: indent with {{width}} spaces */
	previewCommandBarIndentSpaces: "Spaces: {{width}}",
	/** Text editor — status: the cursor's line and column */
	previewCommandBarPosition: "Ln {{line, number}}, Col {{column, number}}",
	/** Text editor — status, after the position: how many characters are selected */
	previewCommandBarSelected: "({{count, number}} selected)",
	/** Text editor — status: the file's line endings, Unix style */
	previewCommandBarEolLf: "LF",
	/** Text editor — status: the file's line endings, Windows style */
	previewCommandBarEolCrlf: "CRLF",
	/** Text editor — status: the file's line endings, classic Mac style */
	previewCommandBarEolCr: "CR",
	/** Text editor — status, accessible name of the line endings ({{ending}}: LF, CRLF or CR), kept when saving */
	previewCommandBarEol: "Line endings: {{ending}}",
	/** Text editor — status: the file's encoding */
	previewCommandBarEncoding: "UTF-8",
	/** Text editor — status: the file's encoding, with a byte order mark (kept when saving) */
	previewCommandBarEncodingBom: "UTF-8 with BOM",
	/** Text editor — status badge: the file is shown but cannot be edited here */
	previewCommandBarReadOnly: "Read-only"
}

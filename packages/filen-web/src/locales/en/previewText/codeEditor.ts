// "preview" namespace, text family — the code editor's own labels and screen-reader announcements (CodeMirror's: its
// fold gutter, search panel, comparison and lint panel), for the file editor and the remote-change comparison. Spread
// into preview.ts; same catalog rules.
export const previewTextCodeEditor = {
	/** Code editor — tooltip on an invisible control character, followed by its name (e.g. "NUL") */
	previewCodeControlCharacter: "Control character",
	/** Code editor — a panel's close button (search, diagnostics) */
	previewCodeClose: "close",
	/** Code editor — accessible name of the placeholder shown where code is folded away */
	previewCodeFoldedCode: "folded code",
	/** Code editor — tooltip of the placeholder shown where code is folded away */
	previewCodeUnfold: "unfold",
	/** Code editor — fold gutter tooltip: fold the block starting on this line */
	previewCodeFoldLine: "Fold line",
	/** Code editor — fold gutter tooltip: unfold the block starting on this line */
	previewCodeUnfoldLine: "Unfold line",
	/** Code editor — screen-reader announcement, followed by "<first line> to <last line>." */
	previewCodeFoldedLines: "Folded lines",
	/** Code editor — screen-reader announcement, followed by "<first line> to <last line>." */
	previewCodeUnfoldedLines: "Unfolded lines",
	/** Code editor — the word between two line numbers in the fold announcements ("Folded lines 3 to 7.") */
	previewCodeLineRangeTo: "to",
	/** Code editor — search panel: the find field */
	previewCodeFind: "Find",
	/** Code editor — search panel: the replace field */
	previewCodeReplaceField: "Replace",
	/** Code editor — search panel button: go to the next match */
	previewCodeNext: "next",
	/** Code editor — search panel button: go to the previous match */
	previewCodePrevious: "previous",
	/** Code editor — search panel button: select every match */
	previewCodeAll: "all",
	/** Code editor — search panel option */
	previewCodeMatchCase: "match case",
	/** Code editor — search panel option: the search is a regular expression */
	previewCodeRegexp: "regexp",
	/** Code editor — search panel option: match whole words only */
	previewCodeByWord: "by word",
	/** Code editor — search panel button: replace the current match */
	previewCodeReplace: "replace",
	/** Code editor — search panel button: replace every match */
	previewCodeReplaceAll: "replace all",
	/** Code editor — screen-reader announcement, followed by the match's line text */
	previewCodeCurrentMatch: "current match",
	/** Code editor — screen-reader announcement: followed by the match's line number */
	previewCodeOnLine: "on line",
	/** Code editor — screen-reader announcement after replacing one match; {{line}} is a line number */
	previewCodeReplacedOnLine: "replaced match on line {{line}}",
	/** Code editor — screen-reader announcement after replacing all; {{matches}} is a number of any size (1 included): word it so it reads for every number, as one form serves them all (e.g. "Replaced: {{matches}}") */
	previewCodeReplacedMatches: "replaced {{matches}} matches",
	/** Code editor — go-to-line field's label */
	previewCodeGoToLine: "Go to line",
	/** Code editor — go-to-line field's submit button */
	previewCodeGo: "go",
	/** Code comparison — a collapsed stretch of identical lines; {{lines}} is a number, 4 or more: word it so it reads for every such number, as one form serves them all (e.g. "Unchanged lines: {{lines}}") */
	previewCodeUnchangedLines: "{{lines}} unchanged lines",
	/** Code comparison — button: take this change */
	previewCodeAccept: "Accept",
	/** Code comparison — button: drop this change */
	previewCodeReject: "Reject",
	/** Code comparison — tooltip of the button that copies a change back to the other side */
	previewCodeRevertChunk: "Revert this chunk",
	/** Code editor — accessible name of the autocompletion list */
	previewCodeCompletions: "Completions",
	/** Code editor — screen-reader announcement after deleting a selection */
	previewCodeSelectionDeleted: "Selection deleted",
	/** Code editor — accessible name of the diagnostics panel */
	previewCodeDiagnostics: "Diagnostics",
	/** Code editor — the diagnostics panel when there are none */
	previewCodeNoDiagnostics: "No diagnostics"
}

// "preview" namespace, text family — the read-only viewer for text files too large to load whole. Spread into
// preview.ts; same catalog rules.
export const previewTextLargeText = {
	/** Large text viewer — status: how far into the file the view is; {{percent}} is 0–100 */
	previewLargeTextPosition: "{{percent}}%",
	/** Large text viewer — View group button: count every line of the file (reads all of it); line numbers show for what is counted */
	previewLargeTextCountLines: "Count lines",
	/** Large text viewer — status while lines are counted; {{done}} and {{total}} are sizes (e.g. "412 MB", "1.2 GB") */
	previewLargeTextCounting: "Counting lines… {{done}} of {{total}}",
	/** Large text viewer — status once every line is counted */
	previewLargeTextLines_one: "{{count, number}} line",
	/** Large text viewer — status once every line is counted */
	previewLargeTextLines_other: "{{count, number}} lines",
	/** Large text viewer — beside the find field while the file is searched; {{done}} and {{total}} are sizes */
	previewLargeTextSearching: "Searching {{done}} of {{total}}",
	/** Large text viewer — button stopping a search or a line count in progress */
	previewLargeTextStop: "Stop",
	/** Large text viewer — Go to line dialog: the field's description; lines are counted from the start up to the line */
	previewLargeTextGoToLineLabel: "Line number. Lines are counted from the start of the file up to it.",
	/** Large text viewer — accessible name of the gutter mark on a row that continues the line above (a long line split into rows) */
	previewLargeTextContinuation: "Continued",
	/** Large text viewer — accessible name of the scrollbar: the position in the file */
	previewLargeTextScrollbar: "Position in file"
} as const

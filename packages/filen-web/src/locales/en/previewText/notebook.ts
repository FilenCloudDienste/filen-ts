// The notebook (.ipynb) preview.
export const previewTextNotebook = {
	/** Notebook preview — the view switch's name (Rendered | Source) */
	previewNotebookView: "Notebook view",
	/** Notebook preview — the rendered view's name in the switch */
	previewNotebookRendered: "Notebook",
	/** Notebook preview — a code cell's gutter label; {{count}} is its execution count */
	previewNotebookIn: "In [{{count}}]:",
	/** Notebook preview — a code cell's gutter label when it was never run */
	previewNotebookInNotRun: "In [ ]:",
	/** Notebook preview — after a cell's source, an output or a traceback cut at the size limit */
	previewNotebookTruncated: "Cut short here: the rest is too long to show.",
	/** Notebook preview — in place of an image, HTML or SVG output past what the preview shows */
	previewNotebookOutputTooLarge: "This output is too large to show here.",
	/** Notebook preview — under a cell whose outputs pass the limit */
	previewNotebookOutputsOmitted_one: "{{count}} more output is not shown.",
	previewNotebookOutputsOmitted_other: "{{count}} more outputs are not shown.",
	/** Notebook preview — at the top when cells of an unknown kind were left out */
	previewNotebookCellsSkipped_one: "{{count}} cell of an unknown kind is not shown.",
	previewNotebookCellsSkipped_other: "{{count}} cells of an unknown kind are not shown.",
	/** Notebook preview — the iframe title of an HTML output */
	previewNotebookHtmlOutput: "HTML output",
	/** Notebook preview — the notebook is not JSON, or not of a format the preview reads */
	previewNotebookInvalid: "This notebook could not be read. Its source is shown instead.",
	/** Notebook preview — more cells than the preview shows */
	previewNotebookTooLarge: "This notebook has too many cells to show here.",
	/** Notebook preview — reading the notebook failed */
	previewNotebookFailed: "The notebook could not be read."
}

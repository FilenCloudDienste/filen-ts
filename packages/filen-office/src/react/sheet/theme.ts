// The grid's own colours and fonts, from --fo-sheet-* custom properties on its root (css/sheet.css lists them
// with neutral defaults). A canvas cannot read CSS variables, so they are resolved once and again when the
// app says the theme changed.

// The grid's own colours, the defaults for what a file leaves unformatted: the cell area's background, automatic text
// and borders, gridlines, headers, the selection and the resize guide. A cell's own fill, text colour and font are
// the file's.
export interface SheetGridTheme {
	readonly background: string
	readonly text: string
	readonly gridLine: string
	// Automatic (black) borders.
	readonly border: string
	readonly headerBackground: string
	readonly headerText: string
	readonly headerLine: string
	readonly headerActiveBackground: string
	readonly headerActiveText: string
	// The headers of whole rows or columns selected: stronger than a cell selection's.
	readonly headerSelectedBackground: string
	readonly headerSelectedText: string
	readonly selectionFill: string
	readonly selectionLine: string
	// A ring inside the selection's outline. With a contrast of 9:1 or more against the line, one of the two has 3:1
	// on any fill (WCAG 2.2 technique C40), so the selection never disappears into a file's colours.
	readonly selectionHalo: string
	readonly frozenLine: string
	readonly resizeLine: string
	// Font stacks: a cell's own family goes first, this after it.
	readonly font: string
	readonly headerFont: string
}

export const DEFAULT_THEME: SheetGridTheme = {
	background: "#ffffff",
	text: "#000000",
	gridLine: "#e1e1e1",
	border: "#000000",
	headerBackground: "#f3f3f3",
	headerText: "#555555",
	headerLine: "#c8c8c8",
	headerActiveBackground: "#dde6f3",
	headerActiveText: "#1f3d6b",
	headerSelectedBackground: "#b6c9e6",
	headerSelectedText: "#0f2547",
	selectionFill: "rgba(37, 99, 235, 0.12)",
	selectionLine: "#1e3a8a",
	selectionHalo: "#ffffff",
	frozenLine: "#b0b0b0",
	resizeLine: "#2563eb",
	font: "Calibri, Carlito, Arial, sans-serif",
	headerFont: "12px system-ui, sans-serif"
}

import { DEFAULT_THEME, type SheetGridTheme } from "./theme"

// The theme from the --fo-sheet-* custom properties on the grid's root; a property not set keeps the default.

const VARIABLES: Record<keyof SheetGridTheme, string> = {
	background: "--fo-sheet-bg",
	text: "--fo-sheet-text",
	gridLine: "--fo-sheet-grid",
	border: "--fo-sheet-border",
	headerBackground: "--fo-sheet-header-bg",
	headerText: "--fo-sheet-header-text",
	headerLine: "--fo-sheet-header-line",
	headerActiveBackground: "--fo-sheet-header-active-bg",
	headerActiveText: "--fo-sheet-header-active-text",
	headerSelectedBackground: "--fo-sheet-header-selected-bg",
	headerSelectedText: "--fo-sheet-header-selected-text",
	selectionFill: "--fo-sheet-selection-fill",
	selectionLine: "--fo-sheet-selection-line",
	selectionHalo: "--fo-sheet-selection-halo",
	frozenLine: "--fo-sheet-frozen-line",
	resizeLine: "--fo-sheet-resize-line",
	font: "--fo-sheet-font",
	headerFont: "--fo-sheet-header-font"
}

export function readTheme(element: Element): SheetGridTheme {
	const computed = getComputedStyle(element)
	const theme: Record<string, string> = { ...DEFAULT_THEME }

	for (const [name, variable] of Object.entries(VARIABLES)) {
		const value = computed.getPropertyValue(variable).trim()

		if (value !== "") theme[name] = value
	}

	return theme as unknown as SheetGridTheme
}

// "preview" namespace, presentation editor: find and replace across slides, notes, tables and SmartArt. The find
// field itself is the document viewers' (previewDocxFind* keys). Spread into preview.ts; same catalog rules.
export const previewPptxFind = {
	/** Presentation editor — Home ribbon, Editing group: the Find menu and its first entry */
	previewPptxFindAction: "Find",
	/** Presentation editor — Home ribbon, Editing group: the Find menu's entry for find and replace */
	previewPptxFindReplaceAction: "Replace",
	/** Presentation editor — notice after Replace all, e.g. "Replaced 4 matches" */
	previewPptxFindReplaced_one: "Replaced {{count}} match",
	/** Presentation editor — notice after Replace all, e.g. "Replaced 4 matches" */
	previewPptxFindReplaced_other: "Replaced {{count}} matches"
}

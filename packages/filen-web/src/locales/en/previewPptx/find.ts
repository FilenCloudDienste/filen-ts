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
	previewPptxFindReplaced_other: "Replaced {{count}} matches",
	/** Presentation editor — notice after Replace all when some matches are in shapes that cannot be edited, e.g. "2 matches in locked shapes were not replaced" */
	previewPptxFindSkippedLocked_one: "{{count}} match in a locked shape was not replaced",
	/** Presentation editor — notice after Replace all when some matches are in shapes that cannot be edited, e.g. "2 matches in locked shapes were not replaced" */
	previewPptxFindSkippedLocked_other: "{{count}} matches in locked shapes were not replaced",
	/** Presentation editor — notice when Replace is used on a match in a shape that cannot be edited */
	previewPptxFindLocked: "This match is in a locked shape and cannot be replaced",
	/** Presentation editor — notice when Replace all is used with more matches than find lists, e.g. "More than 10000 matches…" */
	previewPptxFindReplaceCapped: "More than {{count}} matches. Narrow the search to replace them all"
}

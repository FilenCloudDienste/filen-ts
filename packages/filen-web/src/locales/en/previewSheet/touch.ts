// "preview" namespace, spreadsheet viewer — touch and screen readers (the touch menu over the
// selection, what the grid's live region says). Spread into preview.ts; same catalog rules.
export const previewSheetTouch = {
	/** Touch menu over the selected cells — opens the active cell for typing (the on-screen keyboard comes up) */
	previewSheetTouchEdit: "Edit",
	/** Touch menu — cuts the selected cells */
	previewSheetTouchCut: "Cut",
	/** Touch menu — copies the selected cells */
	previewSheetTouchCopy: "Copy",
	/** Touch menu — pastes into the selected cells */
	previewSheetTouchPaste: "Paste",
	/** Touch menu — its last item, "⋯", named for screen readers: opens the full menu of the cells (insert, hide, sort…) */
	previewSheetTouchMore: "More actions",
	/** Touch menu — selects the whole sheet */
	previewSheetTouchSelectAll: "Select all",
	/** Toast — the browser refused the clipboard to the touch menu; {{shortcut}} is the key that still works, e.g. Ctrl+V */
	previewSheetClipboardBlocked: "Access to the clipboard was blocked. Use {{shortcut}} instead.",
	/** Screen reader — the active cell and what it shows; {{cell}} is its name, e.g. B4 */
	previewSheetActiveCell: "{{cell}}, {{text}}",
	/** Screen reader — said after the active cell when more than one cell is selected; {{range}} is e.g. A1:C3 */
	previewSheetRangeSelected: "{{range}} selected",
	/** Screen reader — the name of the menu a right click opens on the cells */
	previewSheetGridMenu: "Cell actions"
}

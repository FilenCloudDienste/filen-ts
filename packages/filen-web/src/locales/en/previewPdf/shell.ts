// "preview" namespace, PDF editor: its frame (undo, save, discard, the ribbon tabs), the reasons a tool is not offered,
// saving a copy and its keys. Spread into preview.ts; same catalog rules as preview.ts.
export const previewPdfShell = {
	/** PDF editor — command bar button and tooltip: take back the last change */
	previewPdfUndo: "Undo",
	/** PDF editor — command bar button and tooltip: make the change taken back again */
	previewPdfRedo: "Redo",
	/** PDF editor — command bar button: save the changes as a new version of the file */
	previewPdfSave: "Save",
	/** PDF editor — save menu item: save the changes to a new file beside the original, which stays as it was */
	previewPdfSaveAsCopy: "Save as copy",
	/** PDF editor — accessible label of the arrow button next to Save that opens the other save choices */
	previewPdfSaveOptions: "More save options",
	/** PDF editor — save menu item: drop every change made since the last save */
	previewPdfDiscard: "Discard changes",
	/** PDF editor — title of the confirmation before dropping the unsaved changes */
	previewPdfDiscardTitle: "Discard your changes?",
	/** PDF editor — body of the confirmation before dropping the unsaved changes */
	previewPdfDiscardBody: "Changes since the last save are lost. The file stays as it was saved.",
	/** PDF editor — confirmation button: drop the unsaved changes */
	previewPdfDiscardConfirm: "Discard",
	/** PDF editor — ribbon tab: the everyday commands */
	previewPdfTabHome: "Home",
	/** PDF editor — ribbon tab: filling in forms and signing */
	previewPdfTabFillSign: "Fill & Sign",
	/** PDF editor — ribbon tab: organising the pages (rotate, move, delete, insert) */
	previewPdfTabPages: "Pages",
	/** PDF editor — ribbon tab: passwords, permissions and removing content */
	previewPdfTabProtect: "Protect",
	/** PDF editor — ribbon tab: the remaining tools */
	previewPdfTabTools: "Tools",
	/** PDF editor — accessible label of the ribbon's row of tabs */
	previewPdfRibbonLabel: "PDF ribbon tabs",
	/** PDF editor — accessible label of the ribbon's toolbar holding the selected tab's commands */
	previewPdfRibbonCommands: "PDF commands",
	/** PDF editor — ribbon group on the Fill & Sign tab: the form's commands */
	previewPdfRibbonGroupForm: "Form",
	/** PDF editor — ribbon button: set every form field back to its default value */
	previewPdfClearForm: "Clear form",
	/** PDF editor — status while the editor loads, after the first change was made in the viewer */
	previewPdfEditorStarting: "Opening the editor…",
	/** PDF editor — accessible label of a form field on the page that has no name of its own */
	previewPdfFieldLabel: "Form field",
	/** PDF editor — tooltip on a tool that is not offered: this file cannot be edited in the app (shared read-only, unsupported) */
	previewPdfToolNotEditable: "This PDF can't be edited here.",
	/** PDF editor — tooltip on a tool that is not offered while the device has no connection */
	previewPdfToolOffline: "You're offline.",
	/** PDF editor — tooltip on a tool that is not offered because the change would break the PDF's digital signature */
	previewPdfToolSigned: "Not available on a signed PDF.",
	/** PDF editor — added to the file name of a copy saved beside the original, e.g. "Contract edited.pdf" */
	previewPdfSaveCopySuffix: "edited",
	/** PDF editor — added to the file name of a copy when the name with the plain suffix is taken; {{number}} counts up from 2, e.g. "Contract edited 2.pdf" */
	previewPdfSaveCopySuffixNumbered: "edited {{number}}",
	/** PDF editor — notice after saving a copy; {{name}} is the new file's name */
	previewPdfSavedAsCopy: "Saved as {{name}}",
	/** PDF editor — button in the notice after saving a copy: open the new file */
	previewPdfOpenCopy: "Open",
	/** PDF editor — error when the saved file was read back and did not open correctly, so the original was kept */
	previewPdfSaveVerifyFailed: "The edited file didn't pass the check, so it wasn't saved.",
	/** PDF editor — error when saving failed for any other reason */
	previewPdfSaveFailed: "The PDF couldn't be saved.",
	/** PDF editor — error when a change (a form field's value, a tool's edit) could not be applied to the document */
	previewPdfChangeFailed: "This change couldn't be made.",
	/** PDF editor — button in the dialog shown when the file changed elsewhere since it was opened: save the changes to a new file instead */
	previewPdfRemoteSaveCopy: "Save as copy",
	/** PDF editor — button in the same dialog: save over the other change as a new version (the other change stays in the file's versions) */
	previewPdfRemoteSaveAnyway: "Save as new version anyway",
	/** PDF editor — button in the same dialog: do not save */
	previewPdfRemoteCancel: "Cancel",
	/** PDF editor — the position and size of the selected item, read out while moving it with the keyboard; {{left}}, {{top}} = distance from the page's left and top edge, {{width}} × {{height}} = its size, all in points */
	previewPdfPlacementPosition: "{{left}}, {{top}} pt, {{width}} × {{height}} pt",
	/** PDF editor — notice after a save that restarts the editor: undo can no longer go back past this save */
	previewPdfHistoryReset: "Undo starts again from this save.",
	/** Shortcuts list — the PDF editor's undo key */
	previewPdfKeyUndo: "Undo (PDF)",
	/** Shortcuts list — the PDF editor's redo key */
	previewPdfKeyRedo: "Redo (PDF)",
	/** Shortcuts list — the PDF editor's key deleting what is selected on the page (an annotation, a text box) or the selected pages */
	previewPdfKeyDelete: "Delete the selection (PDF)",
	/** Shortcuts list — the PDF editor's key clearing the selection and going back to the Select tool */
	previewPdfKeyEscape: "Deselect (PDF)",
	/** Shortcuts list — the PDF editor's key turning the selected pages 90° clockwise in the file (not only on screen) */
	previewPdfKeyRotatePagesCw: "Rotate pages clockwise (PDF)",
	/** Shortcuts list — the PDF editor's key turning the selected pages 90° counterclockwise in the file (not only on screen) */
	previewPdfKeyRotatePagesCcw: "Rotate pages counterclockwise (PDF)"
} as const

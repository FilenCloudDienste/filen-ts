// "preview" namespace, image viewer — entering and leaving the editing mode, and saving an edited image.
// Spread into preview.ts; same catalog rules.
export const previewImageSave = {
	/** Image preview header — button that opens the image in editing mode */
	previewImageSaveEditAction: "Edit",
	/** Keyboard shortcuts list — the shortcut that opens the image on screen in editing mode */
	previewImageSaveEditShortcut: "Edit image",
	/** Image editing header — button that leaves editing mode (asks first when there are unsaved edits) */
	previewImageSaveCancelAction: "Cancel",
	/** Image editing header — button that undoes every edit, back to the image as it was opened */
	previewImageSaveRevertAction: "Revert",
	/** Image editing header — button that saves the edited image as a new version of the same file */
	previewImageSaveSaveAction: "Save",
	/** Image editing header — accessible label of the arrow next to Save that opens more ways to save */
	previewImageSaveMoreAction: "More ways to save",
	/** Image editing header — saves the edited image as a new file beside the original, which stays as it was */
	previewImageSaveAsCopyAction: "Save as copy",
	/** Image editing header — the only save for a format the editor cannot write: a new JPEG file beside the original */
	previewImageSaveAsJpegCopyAction: "Save as JPEG copy",
	/** Image editing header — the only save for a format the editor cannot write: a new PNG file beside the original */
	previewImageSaveAsPngCopyAction: "Save as PNG copy",
	/** Toast after saving an edited copy; {{name}} is the new file's name */
	previewImageSaveSavedAsCopy: "Saved as {{name}}",
	/** Toast action after saving an edited copy — shows the new file in the preview */
	previewImageSaveOpenCopyAction: "Open",
	/** Name of an edited copy, inside the parentheses after the original name: "photo (edited).jpg" */
	previewImageSaveCopySuffix: "edited",
	/** Name of a further edited copy while the first is taken: "photo (edited 2).jpg"; {{number}} is 2, 3… */
	previewImageSaveCopySuffixNumbered: "edited {{number}}",
	/** Toast when editing cannot start: the file is not an image the editor reads (or its contents do not match its name) */
	previewImageSaveRefusedUnsupported: "This image can't be edited.",
	/** Toast when editing cannot start: the image is animated (an animated GIF, WebP or PNG) */
	previewImageSaveRefusedAnimated: "Animated images can't be edited.",
	/** Toast when editing cannot start: the image has more pixels than this device can edit */
	previewImageSaveRefusedTooLarge: "This image is too large to edit on this device.",
	/** Toast when editing cannot start: the browser offers no WebGL 2, which the editor draws with */
	previewImageSaveRefusedNoGraphics: "Editing images needs WebGL 2, which this browser doesn't provide.",
	/** Toast when editing cannot start for any other reason (the image could not be read) */
	previewImageSaveOpenFailed: "The image couldn't be opened for editing."
} as const

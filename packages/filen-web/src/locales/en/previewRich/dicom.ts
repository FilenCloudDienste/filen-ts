// "preview" namespace, rich viewers — the DICOM viewer (dcm, dicom). Spread into preview.ts; same catalog rules.
export const previewRichDicom = {
	/** DICOM viewer — accessible name of the canvas the image is drawn on */
	previewDicomCanvasLabel: "DICOM image",
	/** DICOM viewer — the summary line's image size, columns by rows */
	previewDicomSize: "{{columns, number}}×{{rows, number}}",
	/** DICOM viewer — the summary line's frame count */
	previewDicomFrames_one: "{{count, number}} frame",
	previewDicomFrames_other: "{{count, number}} frames",
	/** DICOM viewer — the window in effect, over the image: its width and level (the centre), as radiologists write them */
	previewDicomWindowReadout: "W {{width}} L {{center}}",
	/** DICOM viewer — the window presets menu's button, its preset or "Custom" after it */
	previewDicomPreset: "Window: {{preset}}",
	/** DICOM viewer — window preset: the window the file names first, else the image's full range */
	previewDicomPresetDefault: "Default",
	/** DICOM viewer — window preset: one the file names without saying what it is for; number is its place in the file */
	previewDicomPresetFile: "File window {{number}}",
	/** DICOM viewer — the window after a drag, matching no preset */
	previewDicomPresetCustom: "Custom",
	/** DICOM viewer — window preset for CT, soft tissue */
	previewDicomPresetSoftTissue: "Soft tissue",
	/** DICOM viewer — window preset for CT, lungs */
	previewDicomPresetLung: "Lung",
	/** DICOM viewer — window preset for CT, bone */
	previewDicomPresetBone: "Bone",
	/** DICOM viewer — window preset for CT, brain */
	previewDicomPresetBrain: "Brain",
	/** DICOM viewer — window preset for CT, liver */
	previewDicomPresetLiver: "Liver",
	/** DICOM viewer — window preset for CT, the mediastinum */
	previewDicomPresetMediastinum: "Mediastinum",
	/** DICOM viewer — toggle button showing the image's grey levels reversed */
	previewDicomInvert: "Invert",
	/** DICOM viewer — button going back to the file's window, no Invert, the image fitted */
	previewDicomReset: "Reset",
	/** DICOM viewer — toggle button opening the panel of the file's tags (its data elements) */
	previewDicomTags: "Tags",
	/** DICOM viewer — button going back from the tags to the image's card */
	previewDicomShowImage: "Image",
	/** DICOM viewer — playback: play the frames in turn */
	previewDicomPlay: "Play",
	/** DICOM viewer — playback: pause */
	previewDicomPause: "Pause",
	/** DICOM viewer — button showing the previous frame */
	previewDicomPreviousFrame: "Previous frame",
	/** DICOM viewer — button showing the next frame */
	previewDicomNextFrame: "Next frame",
	/** DICOM viewer — the frame on screen and how many there are */
	previewDicomFrame: "{{frame, number}} / {{count, number}}",
	/** DICOM viewer — accessible name of the slider that picks a frame */
	previewDicomFrameSlider: "Frame",
	/** DICOM viewer — the file is not DICOM (no "DICM" marker and no data set) */
	previewDicomNotDicom: "This file couldn't be read as DICOM.",
	/** DICOM viewer — the file's header is malformed */
	previewDicomDamaged: "This DICOM file is damaged.",
	/** DICOM viewer — the file, its header or an image frame is larger than the viewer reads on this device */
	previewDicomTooLarge: "This file is too large to preview.",
	/** DICOM viewer — reading the file failed (a download stalled or was refused); shown with Try again */
	previewDicomUnreadable: "This file couldn't be read.",
	/** DICOM viewer — the file holds tags only, no image (a report, a document); shown with Tags */
	previewDicomNoImage: "This DICOM file has no image.",
	/** DICOM viewer — the image's encoding (transfer syntax, colour model) is not one the viewer decodes; shown with Tags */
	previewDicomUnsupported: "This image's encoding can't be shown here.",
	/** DICOM viewer — a compressed frame's own header disagrees with the file's tags (size, samples or bit depth) */
	previewDicomFrameMismatch: "Pixel data doesn't match its header.",
	/** DICOM viewer — one frame could not be decoded; the others may still show */
	previewDicomFrameFailed: "This frame couldn't be shown.",
	/** DICOM viewer — one frame is larger than the viewer decodes on this device */
	previewDicomFrameTooLarge: "This frame is too large to show on this device.",
	/** DICOM viewer — a JPEG 2000 frame too large for this device is shown at a lower resolution */
	previewDicomReduced: "Shown at reduced resolution.",
	/** DICOM tags panel — the element's name when it is a private one (odd group) */
	previewDicomTagPrivate: "Private",
	/** DICOM tags panel — the element's name when the dictionary does not list it */
	previewDicomTagUnknown: "Unknown element",
	/** DICOM tags panel — a sequence's item, numbered from 1 */
	previewDicomTagItem: "Item {{number, number}}",
	/** DICOM tags panel — a value that is binary data, with its size */
	previewDicomTagBinary: "Binary, {{size}}",
	/** DICOM tags panel — a value the viewer has not read (the image data, read frame by frame) */
	previewDicomTagNotRead: "Not read",
	/** DICOM tags panel — the number of items or elements under a row */
	previewDicomTagChildren_one: "{{count, number}} item",
	previewDicomTagChildren_other: "{{count, number}} items",
	/** DICOM tags panel — the number of elements in a sequence's item */
	previewDicomTagElements_one: "{{count, number}} element",
	previewDicomTagElements_other: "{{count, number}} elements",
	/** DICOM tags panel — rows past what the panel lists */
	previewDicomTagsMore_one: "{{count, number}} more not shown",
	previewDicomTagsMore_other: "{{count, number}} more not shown",
	/** DICOM tags panel — button copying one element's value */
	previewDicomTagCopy: "Copy value",
	/** DICOM tags panel — toast after a value was copied */
	previewDicomTagCopied: "Value copied",
	/** DICOM tags panel — accessible name of the list of the file's tags */
	previewDicomTagsLabel: "DICOM tags",
	/** Keyboard shortcut description — the DICOM viewer's next frame */
	previewKeyDicomNextFrame: "Next frame (DICOM)",
	/** Keyboard shortcut description — the DICOM viewer's previous frame */
	previewKeyDicomPreviousFrame: "Previous frame (DICOM)"
} as const

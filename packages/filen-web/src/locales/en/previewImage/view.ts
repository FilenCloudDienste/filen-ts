// "preview" namespace, image viewer — images decoded by our own code: the reduced view and the states it can end in.
// Spread into preview.ts; same catalog rules.
export const previewImageView = {
	/** Image preview — chip over an image shown below its own resolution; {{width}}×{{height}} is its real size in pixels */
	previewImageReduced: "Reduced · {{width}}×{{height}}",
	/** Image preview — button in that chip that shows the image at its own resolution */
	previewImageShowFull: "Full res ▸",
	/** Image preview — toast when drawing the image at full resolution failed; the reduced view stays */
	previewImageFullFailed: "The image couldn't be shown at full resolution.",
	/** Image preview — an image with more pixels than this device can decode */
	previewImageTooLarge: "This image is too large to display on this device.",
	/** Image preview — button beside "This image is too large to display on this device." on a phone: shows it anyway */
	previewImageOpenAnyway: "Open anyway",
	/** Image preview — an image whose data could not be decoded (damaged or not what its name says) */
	previewImageDecodeFailed: "This image couldn't be read.",
	/** Image preview — a compressed SVG (.svgz) that inflates to more than the preview holds */
	previewSvgzTooLarge: "This image is too large to show once uncompressed.",
	/** Image preview — a TIFF in the BigTIFF format (for files over 4 GB), which the preview doesn't read */
	previewBigTiffUnsupported: "BigTIFF images can't be previewed.",
	/** Image preview — a Photoshop Large Document Format file (.psb), which the preview doesn't read */
	previewPsbUnsupported: "Large Document Format (.psb) files can't be previewed.",
	/** Image preview — a Photoshop file saved without the flattened image the preview shows */
	previewPsdNoComposite: "This Photoshop file has no flattened image to show.",
	/** Image preview — an EPS file without an embedded preview picture (PostScript is never run to draw one) */
	previewEpsNoPreview: "This EPS file has no preview to show.",
	/** Image editing header — beside the save button when the image has several pages: the copy holds the page shown */
	previewImageSaveCopyPage: "Current page only",
	/** Animated image player (GIF, animated WebP/PNG/AVIF) — button showing the previous frame; it pauses playback */
	previewAnimationPreviousFrame: "Previous frame",
	/** Animated image player — button showing the next frame; it pauses playback */
	previewAnimationNextFrame: "Next frame",
	/** Animated image player — accessible name of the slider that picks a frame */
	previewAnimationFrameSlider: "Frame",
	/** Animated image player — the frame on screen and how many there are, shown beside the slider, e.g. 12/48 */
	previewAnimationFrameCounter: "{{frame, number}}/{{count, number}}",
	/** Animated image player — the frame slider's spoken position, e.g. "Frame 12 of 48" */
	previewAnimationFrameOf: "Frame {{frame, number}} of {{count, number}}"
} as const

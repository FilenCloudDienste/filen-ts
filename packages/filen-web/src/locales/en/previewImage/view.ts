// "preview" namespace, image viewer — images decoded by our own code: the reduced view and the states it can end in.
// Spread into preview.ts; same catalog rules.
export const previewImageView = {
	/** Image preview — chip over an image shown below its own resolution; {{width}}×{{height}} is its real size in pixels */
	previewImageReduced: "Reduced · {{width}}×{{height}}",
	/** Image preview — button in that chip that shows the image at its own resolution */
	previewImageShowFull: "Full res ▸",
	/** Image preview — an image with more pixels than this device can decode */
	previewImageTooLarge: "This image is too large to display on this device.",
	/** Image preview — an image whose data could not be decoded (damaged or not what its name says) */
	previewImageDecodeFailed: "This image couldn't be read.",
	/** Image preview — a compressed SVG (.svgz) that inflates to more than the preview holds */
	previewSvgzTooLarge: "This image is too large to show once uncompressed.",
	/** Image preview — a TIFF in the BigTIFF format (for files over 4 GB), which the preview doesn't read */
	previewBigTiffUnsupported: "BigTIFF images can't be previewed.",
	/** Image editing header — beside the save button when the image has several pages: the copy holds the page shown */
	previewImageSaveCopyPage: "Current page only"
} as const

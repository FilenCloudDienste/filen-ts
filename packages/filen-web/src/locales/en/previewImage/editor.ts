// "preview" namespace, image viewer — the editing mode's own surface (adjust, crop, filters, markup).
// Spread into preview.ts; same catalog rules.
export const previewImageEditor = {
	/** Image editor — accessible name of the edited picture (the canvas showing the result) */
	previewImageEditCanvas: "Edited image",
	/** Image editor — accessible name of the area around the edited picture (holds the crop frame and markup) */
	previewImageEditStageArea: "Image editing area",
	/** Image editor — the image could not be prepared for editing (decoding or the graphics setup failed) */
	previewImageEditLoadFailed: "This image couldn't be opened for editing.",
	/** Image editor — accessible name of the panel holding the editing tools (tabs Adjust, Crop, Filters, Markup) */
	previewImageEditTools: "Editing tools",
	/** Image editor — side panel tab with the light and colour sliders */
	previewImageEditTabAdjust: "Adjust",
	/** Image editor — side panel tab with cropping, rotating, straightening and flipping */
	previewImageEditTabCrop: "Crop",
	/** Image editor — side panel tab with the one-tap looks (filter presets) */
	previewImageEditTabFilters: "Filters",
	/** Image editor — side panel tab for drawing on the image (pen, highlighter, arrows, text) */
	previewImageEditTabMarkup: "Markup",

	/** Image editor — button undoing the last edit; also its shortcut's description */
	previewImageEditUndo: "Undo",
	/** Image editor — button redoing the edit last undone; also its shortcut's description */
	previewImageEditRedo: "Redo",
	/** Shortcuts list — undoing the last edit in the image editor */
	previewImageEditKeyUndo: "Undo the last image edit",
	/** Shortcuts list — redoing the image edit last undone */
	previewImageEditKeyRedo: "Redo the image edit last undone",
	/** Image editor — button showing the original image while it is held down */
	previewImageEditCompare: "Hold to compare with the original",
	/** Image editor — hint under the sliders: a double click puts one back to its starting value */
	previewImageEditSliderResetHint: "Double-click a slider to reset it",
	/** Adjust tab — heading of the collapsible group of sliders for exposure, brightness, contrast, highlights and shadows */
	previewImageEditSectionLight: "Light",
	/** Adjust tab — heading of the collapsible group of sliders for warmth, tint, saturation and vibrance */
	previewImageEditSectionColour: "Colour",
	/** Adjust tab — heading of the collapsible group of sliders for sharpness and vignette */
	previewImageEditSectionDetail: "Detail",
	/** Adjust tab — button putting every slider of one group back to zero; {{section}} is the group's heading (Light, Colour, Detail) */
	previewImageEditResetSection: "Reset {{section}}",

	/** Adjust tab — slider: overall exposure of the image */
	previewImageEditExposure: "Exposure",
	/** Adjust tab — slider: brightness */
	previewImageEditBrightness: "Brightness",
	/** Adjust tab — slider: contrast */
	previewImageEditContrast: "Contrast",
	/** Adjust tab — slider: the brightness of the bright parts of the image */
	previewImageEditHighlights: "Highlights",
	/** Adjust tab — slider: the brightness of the dark parts of the image */
	previewImageEditShadows: "Shadows",
	/** Adjust tab — slider: colour temperature (towards warm orange or cool blue) */
	previewImageEditWarmth: "Warmth",
	/** Adjust tab — slider: colour tint (towards green or magenta) */
	previewImageEditTint: "Tint",
	/** Adjust tab — slider: colour saturation */
	previewImageEditSaturation: "Saturation",
	/** Adjust tab — slider: boosts muted colours more than already vivid ones */
	previewImageEditVibrance: "Vibrance",
	/** Adjust tab — slider: sharpening */
	previewImageEditSharpness: "Sharpness",
	/** Adjust tab — slider: darkening of the image's corners */
	previewImageEditVignette: "Vignette",

	/** Crop tab — label of the group of crop shapes (free, original, square, 4:3…) */
	previewImageEditAspect: "Aspect ratio",
	/** Crop tab — crop shape: any size */
	previewImageEditAspectFree: "Free",
	/** Crop tab — crop shape: the image's own width-to-height ratio */
	previewImageEditAspectOriginal: "Original",
	/** Crop tab — crop shape: as wide as tall */
	previewImageEditAspectSquare: "Square",
	/** Crop tab — slider tilting the image by a few degrees to level a horizon */
	previewImageEditStraighten: "Straighten",
	/** Crop tab — the straighten angle read out; {{degrees}} is a number, may be negative */
	previewImageEditDegrees: "{{degrees}}°",
	/** Crop tab — button turning the image a quarter turn counter-clockwise */
	previewImageEditRotateLeft: "Rotate left",
	/** Crop tab — button mirroring the image left to right */
	previewImageEditFlipHorizontal: "Flip horizontally",
	/** Crop tab — button mirroring the image top to bottom */
	previewImageEditFlipVertical: "Flip vertically",
	/** Crop tab — button undoing the crop, turns, flips and straightening (the colours and markup stay) */
	previewImageEditResetCrop: "Reset",
	/** Crop tab — accessible name of the crop frame drawn over the image (dragged to move it) */
	previewImageEditCropArea: "Crop area",
	/** Crop frame — accessible name of the handle at the top left corner */
	previewImageEditHandleTopLeft: "Top left corner",
	/** Crop frame — accessible name of the handle at the top right corner */
	previewImageEditHandleTopRight: "Top right corner",
	/** Crop frame — accessible name of the handle at the bottom left corner */
	previewImageEditHandleBottomLeft: "Bottom left corner",
	/** Crop frame — accessible name of the handle at the bottom right corner */
	previewImageEditHandleBottomRight: "Bottom right corner",
	/** Crop frame — accessible name of the handle on the top edge */
	previewImageEditHandleTop: "Top edge",
	/** Crop frame — accessible name of the handle on the bottom edge */
	previewImageEditHandleBottom: "Bottom edge",
	/** Crop frame — accessible name of the handle on the left edge */
	previewImageEditHandleLeft: "Left edge",
	/** Crop frame — accessible name of the handle on the right edge */
	previewImageEditHandleRight: "Right edge",

	/** Filters tab — the choice with no filter applied */
	previewImageEditFilterNone: "Original",
	/** Filters tab — filter preset: stronger, richer colours */
	previewImageEditFilterVivid: "Vivid",
	/** Filters tab — filter preset: warmer, golden tones */
	previewImageEditFilterWarm: "Warm",
	/** Filters tab — filter preset: cooler, bluish tones */
	previewImageEditFilterCool: "Cool",
	/** Filters tab — filter preset: black and white */
	previewImageEditFilterMono: "Mono",
	/** Filters tab — filter preset: high-contrast black and white */
	previewImageEditFilterNoir: "Noir",
	/** Filters tab — filter preset: washed-out, faded colours */
	previewImageEditFilterFade: "Fade",
	/** Filters tab — filter preset: crisp, slightly metallic colours */
	previewImageEditFilterChrome: "Chrome",
	/** Filters tab — filter preset: deep contrast and darker shadows */
	previewImageEditFilterDramatic: "Dramatic",

	/** Markup tab — label of the group of drawing tools */
	previewImageEditMarkupTool: "Tool",
	/** Markup tab — tool: freehand drawing */
	previewImageEditPen: "Pen",
	/** Markup tab — tool: translucent freehand marker */
	previewImageEditHighlighter: "Highlighter",
	/** Markup tab — tool: a straight arrow, dragged from its tail to its tip */
	previewImageEditArrow: "Arrow",
	/** Markup tab — tool: a line of text placed with a click; clicking existing text edits it */
	previewImageEditText: "Text",
	/** Markup tab — tool: clicking a drawing or text removes it */
	previewImageEditEraser: "Eraser",
	/** Markup tab — label of the group of colours */
	previewImageEditColor: "Colour",
	/** Markup tab — label of the group of stroke widths (thin, medium, thick) */
	previewImageEditWidth: "Size",
	/** Markup tab — stroke width or text size: small */
	previewImageEditWidthThin: "Small",
	/** Markup tab — stroke width or text size: medium */
	previewImageEditWidthMedium: "Medium",
	/** Markup tab — stroke width or text size: large */
	previewImageEditWidthThick: "Large",
	/** Markup tab — colour swatch */
	previewImageEditColorRed: "Red",
	/** Markup tab — colour swatch */
	previewImageEditColorOrange: "Orange",
	/** Markup tab — colour swatch */
	previewImageEditColorYellow: "Yellow",
	/** Markup tab — colour swatch */
	previewImageEditColorGreen: "Green",
	/** Markup tab — colour swatch */
	previewImageEditColorBlue: "Blue",
	/** Markup tab — colour swatch */
	previewImageEditColorPurple: "Purple",
	/** Markup tab — colour swatch */
	previewImageEditColorBlack: "Black",
	/** Markup tab — colour swatch */
	previewImageEditColorWhite: "White",
	/** Markup — accessible name of the field where text placed on the image is typed */
	previewImageEditTextField: "Text on the image",
	/** Markup — accessible name of the drawing surface over the image */
	previewImageEditMarkupSurface: "Drawing surface"
} as const

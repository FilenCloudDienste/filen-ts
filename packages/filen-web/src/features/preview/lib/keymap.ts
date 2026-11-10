import type { ActionDef, PlatformDefault } from "@/lib/keymap/registry"

// The PDF viewer's zoom, fit and rotate keys, as in Edge's and Acrobat's PDF viewers: Mod with the US "=" / "+" key
// (Shift or not) or the numpad's + to zoom in, Mod with "-" or the numpad's - to zoom out, Mod+0 for 100 %, Mod+\
// between fit to width and fit to page, Mod+] and Mod+[ to rotate (keys are physical, @filen/shared/keymap). Its page
// keys are Acrobat's (Mod+Page Down/Up, Mod+Home/End, N and P), Go to Page VS Code's go to line. The viewer matches
// them on its own keydown (pdfKeys.logic.ts), so they keep the browser's page zoom out while it has focus.
export type PdfViewerAction =
	| "preview.pdfZoomIn"
	| "preview.pdfZoomOut"
	| "preview.pdfZoomReset"
	| "preview.pdfToggleFit"
	| "preview.pdfRotateCw"
	| "preview.pdfRotateCcw"
	| "preview.pdfNextPage"
	| "preview.pdfPreviousPage"
	| "preview.pdfFirstPage"
	| "preview.pdfLastPage"
	| "preview.pdfGoToPage"
	| "preview.pdfFitWidth"
	| "preview.pdfFitPage"
	| "preview.pdfFullScreen"
	| "preview.pdfProperties"

type Def<Id extends string> = ActionDef & { readonly id: Id }

function withPlatforms(platformDefaults: readonly PlatformDefault[] | undefined): Pick<ActionDef, "platformDefaults"> {
	return platformDefaults === undefined ? {} : { platformDefaults }
}

function pdfAction(
	id: PdfViewerAction,
	defaultCombo: string,
	descriptionKey: ActionDef["descriptionKey"],
	platformDefaults?: readonly PlatformDefault[]
): Def<PdfViewerAction> {
	return {
		id,
		defaultCombo,
		...withPlatforms(platformDefaults),
		scope: "editor",
		section: "viewer",
		descriptionKey,
		hintKey: "settings:keyboardHintPdf"
	}
}

// Off a Mac a browser keeps Ctrl+Page Up/Down for its tabs, so there the page keys are N and P alone.
const BROWSER_OFF_MAC = { mac: false, desktop: false } as const

export const PDF_VIEWER_ACTIONS: readonly Def<PdfViewerAction>[] = [
	pdfAction("preview.pdfZoomIn", "mod+equal,mod+shift+equal,mod+add", "preview:previewPdfKeyZoomIn"),
	pdfAction("preview.pdfZoomOut", "mod+minus,mod+subtract", "preview:previewPdfKeyZoomOut"),
	pdfAction("preview.pdfZoomReset", "mod+0", "preview:previewPdfKeyZoomReset"),
	pdfAction("preview.pdfToggleFit", "mod+backslash", "preview:previewPdfKeyToggleFit"),
	pdfAction("preview.pdfRotateCw", "mod+bracketright", "preview:previewPdfKeyRotateCw"),
	pdfAction("preview.pdfRotateCcw", "mod+bracketleft", "preview:previewPdfKeyRotateCcw"),
	pdfAction("preview.pdfNextPage", "mod+pagedown,n", "preview:previewKeyPdfNextPage", [{ on: BROWSER_OFF_MAC, combo: "n" }]),
	pdfAction("preview.pdfPreviousPage", "mod+pageup,p", "preview:previewKeyPdfPreviousPage", [{ on: BROWSER_OFF_MAC, combo: "p" }]),
	pdfAction("preview.pdfFirstPage", "mod+home", "preview:previewKeyPdfFirstPage"),
	pdfAction("preview.pdfLastPage", "mod+end", "preview:previewKeyPdfLastPage"),
	pdfAction("preview.pdfGoToPage", "mod+alt+g", "preview:previewKeyPdfGoToPage"),
	pdfAction("preview.pdfFitWidth", "", "preview:previewKeyPdfFitWidth"),
	pdfAction("preview.pdfFitPage", "", "preview:previewKeyPdfFitPage"),
	pdfAction("preview.pdfFullScreen", "f", "preview:previewKeyPdfFullScreen"),
	pdfAction("preview.pdfProperties", "", "preview:previewKeyPdfProperties")
]

// The preview overlay's own keys, for the file on screen (previewOverlay.tsx): paging between the files, closing, and
// the header's download and item menu, with Finder's and Explorer's keys for those: F2 renames, Delete (Cmd+Backspace
// on a Mac) trashes, Alt+Enter (Cmd+I on a Mac) shows the info, Shift+F10 opens the menu. Mod+S downloads a file that
// cannot be edited, as in the listings; one that can is saved (preview.save). Off a Mac the desktop app also closes the
// preview on Ctrl+W, which no window menu takes there.
export type PreviewOverlayAction =
	| "preview.prev"
	| "preview.next"
	| "preview.first"
	| "preview.last"
	| "preview.close"
	| "preview.download"
	| "preview.rename"
	| "preview.move"
	| "preview.versions"
	| "preview.info"
	| "preview.share"
	| "preview.trash"
	| "preview.openMenu"

function overlayAction(
	id: PreviewOverlayAction,
	defaultCombo: string,
	descriptionKey: ActionDef["descriptionKey"],
	platformDefaults?: readonly PlatformDefault[]
): Def<PreviewOverlayAction> {
	return {
		id,
		defaultCombo,
		...withPlatforms(platformDefaults),
		scope: "editor",
		section: "viewer",
		descriptionKey,
		hintKey: "settings:keyboardHintPreview"
	}
}

export const PREVIEW_OVERLAY_ACTIONS: readonly Def<PreviewOverlayAction>[] = [
	overlayAction("preview.prev", "arrowleft", "preview:previewKeyPrevious"),
	overlayAction("preview.next", "arrowright", "preview:previewKeyNext"),
	overlayAction("preview.first", "home", "preview:previewKeyFirst"),
	overlayAction("preview.last", "end", "preview:previewKeyLast"),
	overlayAction("preview.close", "escape", "preview:previewKeyClose", [{ on: { mac: false, desktop: true }, combo: "escape,mod+w" }]),
	overlayAction("preview.download", "mod+s", "preview:previewKeyDownload"),
	overlayAction("preview.rename", "f2", "preview:previewKeyRename"),
	overlayAction("preview.move", "", "preview:previewKeyMove"),
	overlayAction("preview.versions", "", "preview:previewKeyVersions"),
	overlayAction("preview.info", "alt+enter", "preview:previewKeyInfo", [{ on: { mac: true }, combo: "mod+i" }]),
	overlayAction("preview.share", "", "preview:previewKeyShare"),
	overlayAction("preview.trash", "delete", "preview:previewKeyTrash", [{ on: { mac: true }, combo: "mod+backspace" }]),
	overlayAction("preview.openMenu", "shift+f10", "preview:previewKeyOpenMenu")
]

// The image viewer's zoom, as the PDF viewer's (the browser's zoom keys by character first, browserZoom.ts), 1 for the
// image's actual size, and the arrows to move a zoomed-in image (only while zoomed in: otherwise they page the files).
export type ImageViewerAction =
	| "preview.imageZoomIn"
	| "preview.imageZoomOut"
	| "preview.imageZoomFit"
	| "preview.imageActualSize"
	| "preview.imagePanLeft"
	| "preview.imagePanRight"
	| "preview.imagePanUp"
	| "preview.imagePanDown"

function imageViewerAction(
	id: ImageViewerAction,
	defaultCombo: string,
	descriptionKey: ActionDef["descriptionKey"],
	hintKey: ActionDef["descriptionKey"]
): Def<ImageViewerAction> {
	return { id, defaultCombo, scope: "editor", section: "viewer", descriptionKey, hintKey }
}

const IMAGE = "settings:keyboardHintImage"
const IMAGE_ZOOMED = "settings:keyboardHintImageZoomed"

export const IMAGE_VIEWER_ACTIONS: readonly Def<ImageViewerAction>[] = [
	imageViewerAction("preview.imageZoomIn", "mod+equal,mod+shift+equal,mod+add", "preview:previewKeyImageZoomIn", IMAGE),
	imageViewerAction("preview.imageZoomOut", "mod+minus,mod+subtract", "preview:previewKeyImageZoomOut", IMAGE),
	imageViewerAction("preview.imageZoomFit", "mod+0", "preview:previewKeyImageZoomFit", IMAGE),
	imageViewerAction("preview.imageActualSize", "1", "preview:previewKeyImageActualSize", IMAGE),
	imageViewerAction("preview.imagePanLeft", "arrowleft", "preview:previewKeyImagePanLeft", IMAGE_ZOOMED),
	imageViewerAction("preview.imagePanRight", "arrowright", "preview:previewKeyImagePanRight", IMAGE_ZOOMED),
	imageViewerAction("preview.imagePanUp", "arrowup", "preview:previewKeyImagePanUp", IMAGE_ZOOMED),
	imageViewerAction("preview.imagePanDown", "arrowdown", "preview:previewKeyImagePanDown", IMAGE_ZOOMED)
]

// The image editor's keys, matched on its own keydown and in its layer (imageEditor.tsx): the tabs by digit, Photoshop's
// rotate keys, hold Backslash to see the original (Lightroom's), Escape to leave without saving, Mod+Shift+S to save a
// copy.
export type ImageEditorAction =
	| "preview.imageUndo"
	| "preview.imageRedo"
	| "preview.imageSaveCopy"
	| "preview.imageCancel"
	| "preview.imageRevert"
	| "preview.imageCompare"
	| "preview.imageTabAdjust"
	| "preview.imageTabCrop"
	| "preview.imageTabFilters"
	| "preview.imageTabMarkup"
	| "preview.imageRotateLeft"
	| "preview.imageRotateRight"
	| "preview.imageFlipHorizontal"
	| "preview.imageFlipVertical"
	| "preview.imageResetAdjustments"
	| "preview.imageResetGeometry"
	| "preview.imageToolPen"
	| "preview.imageToolHighlighter"
	| "preview.imageToolArrow"
	| "preview.imageToolText"
	| "preview.imageToolEraser"

function imageEditorAction(
	id: ImageEditorAction,
	defaultCombo: string,
	descriptionKey: ActionDef["descriptionKey"]
): Def<ImageEditorAction> {
	return { id, defaultCombo, scope: "editor", section: "imageEditor", descriptionKey }
}

export const IMAGE_EDITOR_ACTIONS: readonly Def<ImageEditorAction>[] = [
	imageEditorAction("preview.imageUndo", "mod+z", "preview:previewImageEditKeyUndo"),
	imageEditorAction("preview.imageRedo", "mod+y,mod+shift+z", "preview:previewImageEditKeyRedo"),
	imageEditorAction("preview.imageSaveCopy", "mod+shift+s", "preview:previewKeyImageSaveCopy"),
	imageEditorAction("preview.imageCancel", "escape", "preview:previewKeyImageCancel"),
	imageEditorAction("preview.imageRevert", "", "preview:previewKeyImageRevert"),
	imageEditorAction("preview.imageCompare", "backslash", "preview:previewKeyImageCompare"),
	imageEditorAction("preview.imageTabAdjust", "1", "preview:previewKeyImageTabAdjust"),
	imageEditorAction("preview.imageTabCrop", "2", "preview:previewKeyImageTabCrop"),
	imageEditorAction("preview.imageTabFilters", "3", "preview:previewKeyImageTabFilters"),
	imageEditorAction("preview.imageTabMarkup", "4", "preview:previewKeyImageTabMarkup"),
	imageEditorAction("preview.imageRotateLeft", "mod+bracketleft", "preview:previewKeyImageRotateLeft"),
	imageEditorAction("preview.imageRotateRight", "mod+bracketright", "preview:previewKeyImageRotateRight"),
	imageEditorAction("preview.imageFlipHorizontal", "", "preview:previewKeyImageFlipHorizontal"),
	imageEditorAction("preview.imageFlipVertical", "", "preview:previewKeyImageFlipVertical"),
	imageEditorAction("preview.imageResetAdjustments", "", "preview:previewKeyImageResetAdjustments"),
	imageEditorAction("preview.imageResetGeometry", "", "preview:previewKeyImageResetGeometry"),
	imageEditorAction("preview.imageToolPen", "", "preview:previewKeyImageToolPen"),
	imageEditorAction("preview.imageToolHighlighter", "", "preview:previewKeyImageToolHighlighter"),
	imageEditorAction("preview.imageToolArrow", "", "preview:previewKeyImageToolArrow"),
	imageEditorAction("preview.imageToolText", "", "preview:previewKeyImageToolText"),
	imageEditorAction("preview.imageToolEraser", "", "preview:previewKeyImageToolEraser")
]

function codeAction(id: string, defaultCombo: string, descriptionKey: ActionDef["descriptionKey"], extra?: Partial<ActionDef>): ActionDef {
	return { id, defaultCombo, scope: "editor", section: "code", descriptionKey, ...extra }
}

const FIND_FIELD = "settings:keyboardHintFindField"

// The code and text editors' commands past find and replace, as VS Code binds them (bound inside CodeMirror by
// codeMirrorShared.ts's useEditorKeymap; the view settings on the command bar's surface, codeSurface.tsx): undo and
// redo, the next and previous match (also in a find field), go to line, comment, CodeMirror's fold keys, Alt+Z word
// wrap, Mod+= / Mod+- / Mod+0 font size; and the find field's toggles (Alt+C, Alt+W; Cmd+Option+C/W on a Mac, where
// Option types a character) and Replace all.
export const CODE_EDITOR_ACTIONS: readonly ActionDef[] = [
	codeAction("editor.undo", "mod+z", "preview:previewKeyEditorUndo"),
	codeAction("editor.redo", "mod+y,mod+shift+z", "preview:previewKeyEditorRedo", {
		platformDefaults: [{ on: { mac: true }, combo: "mod+shift+z,mod+y" }]
	}),
	codeAction("editor.findNext", "f3,mod+g", "preview:previewKeyFindNext"),
	codeAction("editor.findPrevious", "shift+f3,mod+shift+g", "preview:previewKeyFindPrevious"),
	codeAction("editor.findMatchCase", "alt+c", "preview:previewKeyFindMatchCase", {
		platformDefaults: [{ on: { mac: true }, combo: "mod+alt+c" }],
		hintKey: FIND_FIELD
	}),
	codeAction("editor.findWholeWord", "alt+w", "preview:previewKeyFindWholeWord", {
		platformDefaults: [{ on: { mac: true }, combo: "mod+alt+w" }],
		hintKey: FIND_FIELD
	}),
	codeAction("editor.replaceAll", "mod+alt+enter", "preview:previewKeyReplaceAll", { hintKey: FIND_FIELD }),
	codeAction("editor.goToLine", "mod+alt+g", "preview:previewKeyGoToLine"),
	codeAction("editor.toggleComment", "mod+slash", "preview:previewKeyToggleComment"),
	codeAction("editor.fold", "ctrl+shift+bracketleft", "preview:previewKeyFold", {
		platformDefaults: [{ on: { mac: true }, combo: "mod+alt+bracketleft" }]
	}),
	codeAction("editor.unfold", "ctrl+shift+bracketright", "preview:previewKeyUnfold", {
		platformDefaults: [{ on: { mac: true }, combo: "mod+alt+bracketright" }]
	}),
	codeAction("editor.foldAll", "ctrl+alt+bracketleft", "preview:previewKeyFoldAll"),
	codeAction("editor.unfoldAll", "ctrl+alt+bracketright", "preview:previewKeyUnfoldAll"),
	codeAction("editor.toggleWordWrap", "alt+z", "preview:previewKeyToggleWordWrap"),
	codeAction("editor.toggleLineNumbers", "", "preview:previewKeyToggleLineNumbers"),
	codeAction("editor.fontSizeIncrease", "mod+equal,mod+shift+equal,mod+add", "preview:previewKeyFontSizeIncrease"),
	codeAction("editor.fontSizeDecrease", "mod+minus,mod+subtract", "preview:previewKeyFontSizeDecrease"),
	codeAction("editor.fontSizeReset", "mod+0", "preview:previewKeyFontSizeReset"),
	codeAction("editor.viewChanges", "", "preview:previewKeyViewChanges")
]

// The text editors' commands — the file editor in the preview overlay and the note editors share them
// (codeMirrorShared.ts's useEditorKeymap binds them inside CodeMirror). Scope "editor" because the
// overlay is hosted by the drive and photos dialog hosts and the chat embeds — it CO-MOUNTS with those
// surfaces rather than replacing them, which is why save shares mod+s with `drive.download` and find
// mod+f with the listings' search: those handlers ignore editable content, where these live.
// `preview.save` passes `enableOnContentEditable`: CodeMirror's content DOM sets contenteditable while
// editable, and the library's default ignore-list would otherwise drop Cmd/Ctrl+S exactly when the
// cursor is inside the editor. The Word document viewer opens its find field on `editor.find` too, outside
// CodeMirror, for the layer it is shown in only. The markdown commands act in markdown editors only (.md files, markdown
// notes). The preview toggle is mod+shift+v, as in VS Code: mod+shift+p is audio's play/pause, and
// Firefox keeps Ctrl+Shift+P for a private window.
export const PREVIEW_ACTIONS: readonly ActionDef[] = [
	{ id: "preview.save", defaultCombo: "mod+s", scope: "editor", descriptionKey: "preview:previewSaveAction" },
	{ id: "editor.find", defaultCombo: "mod+f", scope: "editor", descriptionKey: "preview:previewEditorFind" },
	{ id: "editor.replace", defaultCombo: "mod+alt+f", scope: "editor", descriptionKey: "preview:previewEditorReplace" },
	{ id: "editor.bold", defaultCombo: "mod+b", scope: "editor", descriptionKey: "preview:previewEditorBold" },
	{ id: "editor.italic", defaultCombo: "mod+i", scope: "editor", descriptionKey: "preview:previewEditorItalic" },
	{ id: "editor.link", defaultCombo: "mod+k", scope: "editor", descriptionKey: "preview:previewEditorLink" },
	{
		id: "editor.strikethrough",
		defaultCombo: "mod+shift+x",
		scope: "editor",
		section: "code",
		descriptionKey: "preview:previewEditorStrikethrough",
		hintKey: "settings:keyboardHintMarkdown"
	},
	{
		id: "editor.code",
		defaultCombo: "mod+e",
		scope: "editor",
		section: "code",
		descriptionKey: "preview:previewEditorCode",
		hintKey: "settings:keyboardHintMarkdown"
	},
	{
		id: "editor.togglePreview",
		defaultCombo: "mod+shift+v",
		scope: "editor",
		section: "code",
		descriptionKey: "preview:previewEditorTogglePreview",
		hintKey: "settings:keyboardHintMarkdown"
	},
	// The image on screen into editing mode; outside a text field, as a bare letter.
	{
		id: "preview.editImage",
		defaultCombo: "e",
		scope: "editor",
		section: "viewer",
		descriptionKey: "preview:previewImageSaveEditShortcut",
		hintKey: "settings:keyboardHintImage"
	},
	...PDF_VIEWER_ACTIONS,
	...IMAGE_EDITOR_ACTIONS,
	...PREVIEW_OVERLAY_ACTIONS,
	...IMAGE_VIEWER_ACTIONS,
	...CODE_EDITOR_ACTIONS
]

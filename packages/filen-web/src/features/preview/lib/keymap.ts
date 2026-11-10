import type { ActionDef } from "@/lib/keymap/registry"

// The PDF viewer's zoom, fit and rotate keys, as in Edge's and Acrobat's PDF viewers: Mod with the US "=" / "+" key
// (Shift or not) or the numpad's + to zoom in, Mod with "-" or the numpad's - to zoom out, Mod+0 for 100 %, Mod+\
// between fit to width and fit to page, Mod+] and Mod+[ to rotate (keys are physical, @filen/shared/keymap). The
// viewer matches them on its own keydown (pdfKeys.logic.ts), so they keep the browser's page zoom out while it has
// focus.
export type PdfViewerAction =
	| "preview.pdfZoomIn"
	| "preview.pdfZoomOut"
	| "preview.pdfZoomReset"
	| "preview.pdfToggleFit"
	| "preview.pdfRotateCw"
	| "preview.pdfRotateCcw"

export const PDF_VIEWER_ACTIONS: readonly (ActionDef & { readonly id: PdfViewerAction })[] = [
	{
		id: "preview.pdfZoomIn",
		defaultCombo: "mod+equal,mod+shift+equal,mod+add",
		scope: "editor",
		descriptionKey: "preview:previewPdfKeyZoomIn"
	},
	{ id: "preview.pdfZoomOut", defaultCombo: "mod+minus,mod+subtract", scope: "editor", descriptionKey: "preview:previewPdfKeyZoomOut" },
	{ id: "preview.pdfZoomReset", defaultCombo: "mod+0", scope: "editor", descriptionKey: "preview:previewPdfKeyZoomReset" },
	{ id: "preview.pdfToggleFit", defaultCombo: "mod+backslash", scope: "editor", descriptionKey: "preview:previewPdfKeyToggleFit" },
	{ id: "preview.pdfRotateCw", defaultCombo: "mod+bracketright", scope: "editor", descriptionKey: "preview:previewPdfKeyRotateCw" },
	{ id: "preview.pdfRotateCcw", defaultCombo: "mod+bracketleft", scope: "editor", descriptionKey: "preview:previewPdfKeyRotateCcw" }
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
	// The image on screen into editing mode; outside a text field, as a bare letter.
	{ id: "preview.editImage", defaultCombo: "e", scope: "editor", descriptionKey: "preview:previewImageSaveEditShortcut" },
	{ id: "editor.find", defaultCombo: "mod+f", scope: "editor", descriptionKey: "preview:previewEditorFind" },
	{ id: "editor.replace", defaultCombo: "mod+alt+f", scope: "editor", descriptionKey: "preview:previewEditorReplace" },
	{ id: "editor.bold", defaultCombo: "mod+b", scope: "editor", descriptionKey: "preview:previewEditorBold" },
	{ id: "editor.italic", defaultCombo: "mod+i", scope: "editor", descriptionKey: "preview:previewEditorItalic" },
	{ id: "editor.strikethrough", defaultCombo: "mod+shift+x", scope: "editor", descriptionKey: "preview:previewEditorStrikethrough" },
	{ id: "editor.code", defaultCombo: "mod+e", scope: "editor", descriptionKey: "preview:previewEditorCode" },
	{ id: "editor.link", defaultCombo: "mod+k", scope: "editor", descriptionKey: "preview:previewEditorLink" },
	{ id: "editor.togglePreview", defaultCombo: "mod+shift+v", scope: "editor", descriptionKey: "preview:previewEditorTogglePreview" },
	// The image editor matches these on its own keydown and in its layer (imageEditor.tsx).
	{ id: "preview.imageUndo", defaultCombo: "mod+z", scope: "editor", descriptionKey: "preview:previewImageEditKeyUndo" },
	{ id: "preview.imageRedo", defaultCombo: "mod+y,mod+shift+z", scope: "editor", descriptionKey: "preview:previewImageEditKeyRedo" },
	...PDF_VIEWER_ACTIONS
]

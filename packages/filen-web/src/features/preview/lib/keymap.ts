import type { ActionDef } from "@/lib/keymap/registry"

// The text editors' commands — the file editor in the preview overlay and the note editors share them
// (codeMirrorShared.ts's useEditorKeymap binds them inside CodeMirror). Scope "editor" because the
// overlay is hosted by the drive and photos dialog hosts and the chat embeds — it CO-MOUNTS with those
// surfaces rather than replacing them, which is why save shares mod+s with `drive.download` and find
// mod+f with the listings' search: those handlers ignore editable content, where these live.
// `preview.save` passes `enableOnContentEditable`: CodeMirror's content DOM sets contenteditable while
// editable, and the library's default ignore-list would otherwise drop Cmd/Ctrl+S exactly when the
// cursor is inside the editor. The markdown commands act in markdown editors only (.md files, markdown
// notes). The preview toggle is mod+shift+v, as in VS Code: mod+shift+p is audio's play/pause, and
// Firefox keeps Ctrl+Shift+P for a private window.
export const PREVIEW_ACTIONS: readonly ActionDef[] = [
	{ id: "preview.save", defaultCombo: "mod+s", scope: "editor", descriptionKey: "preview:previewSaveAction" },
	{ id: "editor.find", defaultCombo: "mod+f", scope: "editor", descriptionKey: "preview:previewEditorFind" },
	{ id: "editor.replace", defaultCombo: "mod+alt+f", scope: "editor", descriptionKey: "preview:previewEditorReplace" },
	{ id: "editor.bold", defaultCombo: "mod+b", scope: "editor", descriptionKey: "preview:previewEditorBold" },
	{ id: "editor.italic", defaultCombo: "mod+i", scope: "editor", descriptionKey: "preview:previewEditorItalic" },
	{ id: "editor.strikethrough", defaultCombo: "mod+shift+x", scope: "editor", descriptionKey: "preview:previewEditorStrikethrough" },
	{ id: "editor.code", defaultCombo: "mod+e", scope: "editor", descriptionKey: "preview:previewEditorCode" },
	{ id: "editor.link", defaultCombo: "mod+k", scope: "editor", descriptionKey: "preview:previewEditorLink" },
	{ id: "editor.togglePreview", defaultCombo: "mod+shift+v", scope: "editor", descriptionKey: "preview:previewEditorTogglePreview" }
]

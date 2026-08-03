import type { ActionDef } from "@/lib/keymap/registry"

// The preview overlay's save command. Scope "editor" because the overlay is hosted by the drive and
// photos dialog hosts and the chat embeds — it CO-MOUNTS with those surfaces rather than replacing
// them, which is why it shares mod+s with `drive.download` and the listing's own handler no-ops
// while a dialog is open. The handler passes `enableOnContentEditable`: CodeMirror's content DOM
// sets contenteditable while editable, and the library's default ignore-list would otherwise drop
// Cmd/Ctrl+S exactly when the cursor is inside the editor.
export const PREVIEW_ACTIONS: readonly ActionDef[] = [
	{ id: "preview.save", defaultCombo: "mod+s", scope: "editor", descriptionKey: "preview:previewSaveAction" }
]

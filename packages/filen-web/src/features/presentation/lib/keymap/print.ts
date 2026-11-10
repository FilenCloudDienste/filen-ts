import type { ActionDef } from "@/lib/keymap/registry"

// Print (Mod+P) over an open deck, in the editor and the viewer alike. It is taken wherever the deck is shown, so the
// browser's own print (the app's chrome, or a copy where downloads are disallowed) never runs from the keyboard; the
// running show takes Mod+P for its pen first and stops it there.
export const PRESENTATION_PRINT_ACTIONS: readonly ActionDef[] = [
	{
		id: "presentation.print",
		defaultCombo: "mod+p",
		scope: "editor",
		section: "presentation",
		descriptionKey: "preview:previewPptxKeyPrint"
	}
]

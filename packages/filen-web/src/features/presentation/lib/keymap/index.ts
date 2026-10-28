import type { ActionDef } from "@/lib/keymap/registry"
import { PRESENTATION_EDITOR_ACTIONS } from "@/features/presentation/lib/keymap/editor"
import { PRESENTATION_OBJECT_ACTIONS } from "@/features/presentation/lib/keymap/objects"
import { PRESENTATION_PRINT_ACTIONS } from "@/features/presentation/lib/keymap/print"
import { PRESENTATION_SHOW_ACTIONS } from "@/features/presentation/lib/keymap/show"
import { PRESENTATION_TEXT_ACTIONS } from "@/features/presentation/lib/keymap/text"

// The presentation editor's keyboard actions, from one data-only file per owner (lib/keymap/actions.ts registers
// this list with the app's).
export const PRESENTATION_ACTIONS: readonly ActionDef[] = [
	...PRESENTATION_EDITOR_ACTIONS,
	...PRESENTATION_OBJECT_ACTIONS,
	...PRESENTATION_TEXT_ACTIONS,
	...PRESENTATION_SHOW_ACTIONS,
	...PRESENTATION_PRINT_ACTIONS
]

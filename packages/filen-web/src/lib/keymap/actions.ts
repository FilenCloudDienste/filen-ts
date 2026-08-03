import { registerAction, useOverrides, type ActionDef, type ResolvedAction } from "@/lib/keymap/registry"
import { APP_ACTIONS } from "@/features/shell/lib/keymap"
import { DRIVE_ACTIONS } from "@/features/drive/lib/keymap"
import { NOTES_ACTIONS } from "@/features/notes/lib/keymap"
import { CHATS_ACTIONS } from "@/features/chats/lib/keymap"
import { CONTACTS_ACTIONS } from "@/features/contacts/lib/keymap"
import { PHOTOS_ACTIONS } from "@/features/photos/lib/keymap"
import { PREVIEW_ACTIONS } from "@/features/preview/lib/keymap"
import { AUDIO_ACTIONS } from "@/features/audio/lib/keymap"

// The app's complete action set, assembled eagerly from each feature's data-only keymap module.
// Registration used to sit at module scope next to each handler, which meant half the actions only
// existed once their lazily-imported route chunk had loaded (autoCodeSplitting, vite.config.ts) — a
// shortcuts catalog opened from /settings would then be missing Cloud Drive and Photos entirely.
// The defs are plain objects whose only import is an erased type, so nothing heavy joins the entry
// chunk; the handlers stay exactly where they were, in their own components.
export const ALL_ACTIONS: readonly ActionDef[] = [
	...APP_ACTIONS,
	...DRIVE_ACTIONS,
	...NOTES_ACTIONS,
	...CHATS_ACTIONS,
	...CONTACTS_ACTIONS,
	...PHOTOS_ACTIONS,
	...PREVIEW_ACTIONS,
	...AUDIO_ACTIONS
]

let registered = false

// Called once from main.tsx before the first render, so `comboFor` is correct for every action from
// the very first paint — including on the pre-auth surface. Idempotent: one guarded entry point
// replaces the per-module registrations whose Fast-Refresh re-evaluation used to throw on the
// duplicate-id check.
export function registerAllActions(): void {
	if (registered) {
		return
	}

	registered = true

	for (const def of ALL_ACTIONS) {
		registerAction(def)
	}
}

// Every registered action with its live combo. Resolved from ALL_ACTIONS — a module const that is
// fully populated at module-evaluation time and never mutated — and from the hook's own subscribed
// `overrides`, so memoizing on `overrides` (which the React Compiler will do) is exactly correct.
// This is the shape useComboFor's browser-verified staleness note demands: no plain function reading
// a mutable Map behind the compiler's back.
export function useActionCatalog(): readonly ResolvedAction[] {
	const overrides = useOverrides()

	return ALL_ACTIONS.map(def => ({ ...def, combo: overrides[def.id] ?? def.defaultCombo }))
}

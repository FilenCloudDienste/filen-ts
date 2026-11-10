import { matchesCombo } from "@filen/shared/keymap"

// The app's shortcut combos as a CodeMirror binding's test of the keydown, so the editor binds the same,
// user-rebindable shortcuts the shortcuts list shows and matches them as every other surface does: by physical key
// (@filen/shared/keymap), where CodeMirror's own key names match by character. Undefined for an unbound combo.
export function editorKeyMatcher(combo: string, mac: boolean): ((event: KeyboardEvent) => boolean) | undefined {
	return combo.length === 0 ? undefined : event => matchesCombo(event, combo, mac)
}

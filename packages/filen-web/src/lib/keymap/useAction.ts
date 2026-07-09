import type { DependencyList } from "react"
import { useHotkeys, type HotkeyCallback, type Options } from "react-hotkeys-hook"
import { useComboFor } from "@/lib/keymap/registry"

// Holding a key down re-fires the native `keydown` event with `repeat: true` on every OS-level
// autorepeat tick — without this, a held combo would spam the action's handler instead of firing
// once. This matches the hand-rolled listener it replaces (themeProvider.tsx's old
// `if (event.repeat) return`) and is a sane default for keyboard *shortcuts* generally; a caller
// that genuinely wants repeat-fire can override it via `options`.
//
// `enableOnFormTags: ["option"]`: verified against the installed package's own compiled source
// (node_modules/react-hotkeys-hook — the default ignore-list a keydown's target is matched against,
// by tagName OR role, includes the ARIA role "option" alongside real form tags) plus a live browser
// repro (real click, then a real keypress) — react-hotkeys-hook silently drops every hotkey whose
// event target has `role="option"`, treating it exactly like a stray keypress inside an `<input>`.
// Drive's roving-tabindex rows/tiles are real DOM focus targets with `role="option"` (see
// directoryListing.tsx's moveActive/registerRef) — without this override every drive.* command
// would silently never fire while a row actually has focus, which is the normal, expected state
// during keyboard-driven listbox use, not an edge case.
const DEFAULT_OPTIONS: Options = {
	ignoreEventWhen: event => event.repeat,
	enableOnFormTags: ["option"]
}

// Thin wrapper around react-hotkeys-hook's `useHotkeys` (v5.3.3 — verified against the installed
// package's own compiled source and README) that resolves the combo through the registry instead
// of a literal string, so every keyboard-controllable action goes through one path and stays
// live-remappable without the calling component doing anything extra.
//
// `scopes` is deliberately never passed to `useHotkeys` here. Verified against the installed
// package's compiled source (node_modules/react-hotkeys-hook — useHotkeys.ts's `D()` scope-match
// helper): an *omitted* `scopes` option always matches, but a *present* one requires the combo's
// scope to be in `activeScopes`, which comes from `<HotkeysProvider>` context and defaults to an
// EMPTY array with no provider mounted — so a scoped hotkey would silently never fire today.
// There is no `<HotkeysProvider>` yet and only one implicit global scope is in use; every action
// fires unconditionally regardless of `ActionDef.scope`, which is carried for later UI/filtering
// only. Root wiring should mount `<HotkeysProvider>` before any action needs real scope isolation,
// at which point this wrapper can start forwarding `scope` as `options.scopes`.
export function useAction(id: string, handler: HotkeyCallback, options?: Options, deps: DependencyList = []): void {
	const combo = useComboFor(id)

	useHotkeys<HTMLElement>(combo, handler, { ...DEFAULT_OPTIONS, ...options }, [combo, ...deps])
}

import type { DependencyList } from "react"
import { useHotkeys, type HotkeyCallback, type Options } from "react-hotkeys-hook"
import { isRecordingCombo, useComboFor } from "@/lib/keymap/registry"

// The single predicate every registered action's key handling is gated on. Exported so it can be
// unit-tested directly; the narrow parameter type is all `event.repeat` needs and keeps it
// assignable to react-hotkeys-hook's `(e: KeyboardEvent) => boolean` by contravariance.
export function shouldIgnoreEvent(event: Pick<KeyboardEvent, "repeat">): boolean {
	return event.repeat || isRecordingCombo()
}

// Holding a key down re-fires the native `keydown` event with `repeat: true` on every OS-level
// autorepeat tick — without this, a held combo would spam the action's handler instead of firing
// once. This matches the hand-rolled listener it replaces (themeProvider.tsx's old
// `if (event.repeat) return`) and is a sane default for keyboard *shortcuts* generally. The second
// half suppresses EVERY action while a combo recording is in flight (registry.ts's owned session),
// so the keys a user presses to rebind a shortcut are captured as data instead of running commands.
// `ignoreEventWhen` is consulted before the handler AND before preventDefault, so the browser
// default survives too — the recorder's own preventDefault is what swallows it. A caller passing its
// own `ignoreEventWhen` via `options` opts out of BOTH guards and must re-`||` them.
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
	ignoreEventWhen: shouldIgnoreEvent,
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
// There is no `<HotkeysProvider>` and none is planned: `ActionDef.scope` is carried for the
// shortcuts catalog's grouping and its conflict check (lib/keymap/conflicts.ts), not for runtime
// isolation. Isolation is each handler's own `isDialogOpen`/`isAnyDialogOpen` guard, and a provider
// plus an active-scope stack could only land atomically with removing every one of those guards —
// forwarding `scopes` on its own would silently kill every scoped hotkey.
export function useAction(id: string, handler: HotkeyCallback, options?: Options, deps: DependencyList = []): void {
	const combo = useComboFor(id)

	useHotkeys<HTMLElement>(combo, handler, { ...DEFAULT_OPTIONS, ...options }, [combo, ...deps])
}

import type { DependencyList, RefCallback } from "react"
import { useHotkeys, type HotkeyCallback, type Options } from "react-hotkeys-hook"
import { isRecordingCombo, useComboFor } from "@/lib/keymap/registry"
import { isImeKeydown, typedWithAltGraph, type ChordEvent } from "@filen/shared/keymap"
import { useMenuAction } from "@/lib/keymap/desktopMenu"
import { isAnyOverlayOpen } from "@/lib/keymap/dialogGuard"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"

const IS_MAC = isMacPlatform()

// The single predicate every registered action's key handling is gated on. Exported so it can be
// unit-tested directly; the narrow parameter type is all it reads and keeps it assignable to
// react-hotkeys-hook's `(e: KeyboardEvent) => boolean` by contravariance. A character typed with AltGr
// is text: the library rejects AltGr only for chords without Ctrl, Alt or Mod, so a Ctrl+Alt chord would
// otherwise fire while typing "@" or "ó" on Windows (@filen/shared/keymap applies the same rule to every
// other matcher). A key an input method is composing with is the composition's, in an editor too.
export function shouldIgnoreEvent(
	event: Pick<KeyboardEvent, "repeat"> & Parameters<typeof isImeKeydown>[0] & Pick<ChordEvent, "key" | "getModifierState">
): boolean {
	return event.repeat || isImeKeydown(event) || isRecordingCombo() || typedWithAltGraph(event, IS_MAC)
}

// shouldIgnoreEvent, and any open dialog or menu: that layer owns the keyboard.
export function ignoredUnderOverlays(event: Parameters<typeof shouldIgnoreEvent>[0]): boolean {
	return shouldIgnoreEvent(event) || isAnyOverlayOpen()
}

// For an action of the page under every dialog and menu (a listing, the shell): it stands down while one is open, and
// the key keeps its default for that layer, as ignoreEventWhen runs before preventDefault. Not for an editor's actions,
// which run in the preview dialog: those check their own layer (dialogGuard.ts keyForEditor).
export const OUTSIDE_OVERLAYS: Options = { ignoreEventWhen: ignoredUnderOverlays }

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
// A matched bare printable key (N for New directory, or any action a user rebinds to a letter) would
// otherwise type itself: a handler that opens an autofocused field commits in React's sync lane, still
// inside this keydown, so the browser's default text input lands in the new field. Only consulted for a
// matched, non-ignored combo whose target is not a text field, so it never swallows real typing.
export function producesTextInput(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
	return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
}

const DEFAULT_OPTIONS: Options = {
	ignoreEventWhen: shouldIgnoreEvent,
	enableOnFormTags: ["option"],
	preventDefault: producesTextInput
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
//
// The returned ref scopes the action to one element: attached, the listener moves off the document onto
// that element and only fires while focus is inside it. Unattached (every caller ignoring it), the action
// stays document-wide.
// For a shortcut that must also fire with the cursor in an editor. CodeMirror's content is
// contenteditable AND carries role="textbox", which react-hotkeys-hook counts as a form field and drops
// unless it is listed; Quill's editor is contenteditable too.
export const IN_EDITORS: Options = { enableOnContentEditable: true, enableOnFormTags: ["option", "textbox"] }

// IN_EDITORS plus plain <input>/<textarea> fields, whose role is null, so "textbox" never matches them
// (a spreadsheet's cell editor and formula bar). Only for a save, whose combo means nothing to a text
// field but opens the browser's "Save page as": a text-editing shortcut (editor.togglePreview's
// Ctrl+Shift+V pastes as plain text) must stay the field's own, including in a dialog's input.
export const IN_EDITORS_AND_FIELDS: Options = {
	enableOnContentEditable: true,
	enableOnFormTags: ["option", "textbox", "input", "textarea"]
}

export function useAction(
	id: string,
	handler: HotkeyCallback,
	options?: Options,
	deps: DependencyList = []
): RefCallback<HTMLElement | null> {
	const combo = useComboFor(id)
	const merged: Options = { ...DEFAULT_OPTIONS, ...options }

	// The macOS desktop menu runs the same handler, behind the same guard. A key the page runs is cancelled, or macOS
	// would hand it to the menu as well (desktopMenu.ts cancelMenuRepeat).
	if (useMenuAction(id, handler, merged.ignoreEventWhen)) {
		merged.preventDefault = true
	}

	return useHotkeys<HTMLElement>(combo, handler, merged, [combo, ...deps])
}

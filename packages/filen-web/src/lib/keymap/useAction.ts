import type { DependencyList } from "react"
import { useHotkeys, type HotkeyCallback, type Options } from "react-hotkeys-hook"
import { useComboFor } from "@/lib/keymap/registry"

// Holding a key down re-fires the native `keydown` event with `repeat: true` on every OS-level
// autorepeat tick — without this, a held combo would spam the action's handler instead of firing
// once. This matches the hand-rolled listener it replaces (theme-provider.tsx's old
// `if (event.repeat) return`) and is a sane default for keyboard *shortcuts* generally; a caller
// that genuinely wants repeat-fire can override it via `options`.
const DEFAULT_OPTIONS: Options = {
	ignoreEventWhen: event => event.repeat
}

// Thin wrapper around react-hotkeys-hook's `useHotkeys` (v5.3.3 — verified against the installed
// package's own compiled source and README) that resolves the combo through the registry instead
// of a literal string, so every keyboard-controllable action goes through one path (D12) and
// stays live-remappable without the calling component doing anything extra.
//
// `scopes` is deliberately never passed to `useHotkeys` here. Verified against the installed
// package's compiled source (node_modules/react-hotkeys-hook — useHotkeys.ts's `D()` scope-match
// helper): an *omitted* `scopes` option always matches, but a *present* one requires the combo's
// scope to be in `activeScopes`, which comes from `<HotkeysProvider>` context and defaults to an
// EMPTY array with no provider mounted — so a scoped hotkey would silently never fire today.
// Slice-0 has no `<HotkeysProvider>` yet and uses exactly one implicit global scope; every action
// fires unconditionally regardless of `ActionDef.scope`, which is carried for later UI/filtering
// only. T9 (root wiring) should mount `<HotkeysProvider>` before any action needs real scope
// isolation, at which point this wrapper can start forwarding `scope` as `options.scopes`.
export function useAction(id: string, handler: HotkeyCallback, options?: Options, deps: DependencyList = []): void {
	const combo = useComboFor(id)

	useHotkeys<HTMLElement>(combo, handler, { ...DEFAULT_OPTIONS, ...options }, [combo, ...deps])
}

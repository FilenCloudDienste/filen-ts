import { type } from "arktype"
import { create } from "zustand"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { log } from "@/lib/log"
import type { CommonKey, DriveKey, PreviewKey, NotesKey, ChatsKey, AudioKey, PhotosKey } from "@/lib/i18n"

// Keyboard-first from day one — every keyboard-controllable action in the app registers
// here instead of wiring its own `window.addEventListener("keydown", …)`. A Map-backed registry
// of ActionDefs (defaults) plus a small persisted-override layer (kv key below) gives every
// consumer three things for free: one source of truth for "what does this shortcut do" (a future
// settings UI reads `actions`' defs), a user-remappable combo (`setUserCombo`), and a live
// indicator (`<Kbd action>`) that always reflects the combo actually in effect.
export type ActionScope = "global" | "drive" | "editor" | "notes" | "chats" | "audio" | "photos"

export interface ActionDef {
	id: string
	defaultCombo: string
	scope: ActionScope
	descriptionKey: CommonKey | DriveKey | PreviewKey | NotesKey | ChatsKey | AudioKey | PhotosKey
}

const OVERRIDES_KV_KEY = "keymap.v1.overrides"

// Every persisted value must be a non-empty combo string. "string > 0" is arktype's LENGTH
// constraint on a length-boundable operand, not a numeric comparison on `string` itself —
// verified against the installed 2.2.2 package's own parser (arktype/out/parser/shift/operator/
// bounds.js: `getBoundKinds` routes a `string`/`array` root to minLength/maxLength/exactLength;
// only a bare `number` root takes the numeric min/max branch). The record's key side is left
// unconstrained (`"[string]"`, the documented index-signature form — arktype's own docs don't
// show a constrained-key variant) since object keys are always strings anyway; a malformed VALUE
// at any key fails validation for the whole object, so `kvGetJson` drops the entire blob and
// every action's default wins — corrupt data can never partially-brick the keymap.
export const keymapOverridesSchema = type({ "[string]": "string > 0" })

const actions = new Map<string, ActionDef>()

interface KeymapState {
	overrides: Record<string, string>
	setOverrides: (overrides: Record<string, string>) => void
	setOverride: (id: string, combo: string) => void
}

// Internal reactivity primitive only — nothing outside this file touches the store directly (see
// `useComboFor` below), so swapping the mechanism later never ripples to `useAction`/`<Kbd>`.
// zustand is already a project dependency and convention (@/stores/boot.ts); it gives every
// consumer of `useComboFor` a free re-render the moment an override loads from kv or is set at
// runtime, without each of them hand-rolling a subscribe/listener.
const useKeymapStore = create<KeymapState>(set => ({
	overrides: {},
	setOverrides: overrides => {
		set({ overrides })
	},
	setOverride: (id, combo) => {
		set(state => ({ overrides: { ...state.overrides, [id]: combo } }))
	}
}))

// Memoized like `storage()` in @/lib/storage/adapter.ts — the kv read fires at most once per
// module lifetime, kicked off by the first `registerAction` call (import order between this
// module and its first feature consumer is otherwise unspecified). A rejected read is swallowed
// here too: a storage-layer failure must never take keyboard shortcuts down with it, so defaults
// keep working either way — only a successfully-loaded, schema-valid record ever overrides them.
let overridesLoad: Promise<void> | null = null

function ensureOverridesLoaded(): Promise<void> {
	overridesLoad ??= kvGetJson(OVERRIDES_KV_KEY, keymapOverridesSchema)
		.then(loaded => {
			if (loaded !== null) {
				useKeymapStore.getState().setOverrides(loaded)
			}
		})
		.catch((error: unknown) => {
			log.warn("keymap", "failed to load persisted keymap overrides", error)
		})

	return overridesLoad
}

// Test-only synchronization point today (also handy for a future boot gate that wants to know
// the keymap has settled). Production callers never need to await this — `comboFor`/`useComboFor`
// are correct from the very first render (defaults) and update live once this resolves.
export function keymapOverridesLoaded(): Promise<void> {
	return ensureOverridesLoaded()
}

export function registerAction(def: ActionDef): void {
	if (actions.has(def.id)) {
		throw new Error(`keymap: action "${def.id}" is already registered`)
	}

	actions.set(def.id, def)
	void ensureOverridesLoaded()
}

// Shared by the plain snapshot read (`comboFor`) and the reactive hook (`useComboFor`) below —
// kept as a private helper closed over `actions` rather than duplicated, since the two callers
// only differ in HOW they read `overrides` (a `.getState()` snapshot vs. a subscribed selector),
// never in the precedence rule itself.
function resolveCombo(overrides: Record<string, string>, id: string): string {
	const override = overrides[id]
	if (override !== undefined) {
		return override
	}

	const def = actions.get(id)
	if (!def) {
		throw new Error(`keymap: comboFor: unknown action "${id}"`)
	}

	return def.defaultCombo
}

export function comboFor(id: string): string {
	return resolveCombo(useKeymapStore.getState().overrides, id)
}

export async function setUserCombo(id: string, combo: string): Promise<void> {
	// Await the persisted-overrides load FIRST: without it, an early remap merges onto an empty store
	// and persists a one-entry record that clobbers any stored overrides — which the late load then
	// reverts in the UI. Loading first means we merge onto (and re-persist) the full existing set.
	await ensureOverridesLoaded()
	useKeymapStore.getState().setOverride(id, combo)
	await kvSetJson(OVERRIDES_KV_KEY, useKeymapStore.getState().overrides)
}

// Reactive read for `useAction`/`<Kbd>`. The combo is computed INSIDE the zustand selector (not
// via a separate call out to the plain `comboFor` after subscribing to a narrower slice) so the
// value this hook returns IS the subscribed hook's own return value — React Compiler treats hook
// return values as always-fresh, but it doesn't know a plain, non-"use"-prefixed function like
// `comboFor` secretly reads mutable module state. An earlier version of this hook subscribed via
// `useKeymapStore(state => state.overrides[id])` and then called the plain `comboFor(id)`
// separately — browser-verified (live override, Chrome DevTools) that the compiler memoized that
// second call keyed on `id` alone and never re-ran it once a runtime override landed, silently
// serving the pre-override combo. Folding the resolution into the selector itself, so its return
// value IS what the hook returns, sidesteps that hazard.
export function useComboFor(id: string): string {
	return useKeymapStore(state => resolveCombo(state.overrides, id))
}

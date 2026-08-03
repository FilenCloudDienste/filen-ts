import { type } from "arktype"
import { create } from "zustand"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { log } from "@/lib/log"
import type { CommonKey, DriveKey, PreviewKey, NotesKey, ChatsKey, AudioKey, PhotosKey, ContactsKey } from "@/lib/i18n"

// Keyboard-first from day one — every keyboard-controllable action in the app registers
// here instead of wiring its own `window.addEventListener("keydown", …)`. A Map-backed registry
// of ActionDefs (defaults) plus a small persisted-override layer (kv key below) gives every
// consumer three things for free: one source of truth for "what does this shortcut do" (read by
// the shortcuts catalog — lib/keymap/actions.ts, rendered by lib/keymap/shortcutsList.tsx on both
// the `?` dialog and Settings → Keyboard), a user-remappable combo (`setUserCombo` /
// `clearUserCombo`), and a live indicator (`<Kbd action>`) that always reflects the combo actually
// in effect. This file stays feature-agnostic: it holds no concrete action, only the mechanism.
export type ActionScope = "global" | "drive" | "editor" | "notes" | "chats" | "audio" | "photos" | "contacts"

// The namespace has to travel with the key: the shortcuts UI resolves these against several
// catalogs at once, and an unprefixed key would only ever resolve in the first one. Both halves are
// compile-checked — the namespace exists, and the key exists IN that namespace.
export type ShortcutDescriptionKey =
	| `common:${CommonKey}`
	| `drive:${DriveKey}`
	| `notes:${NotesKey}`
	| `chats:${ChatsKey}`
	| `photos:${PhotosKey}`
	| `audio:${AudioKey}`
	| `preview:${PreviewKey}`
	| `contacts:${ContactsKey}`

export interface ActionDef {
	id: string
	defaultCombo: string
	scope: ActionScope
	descriptionKey: ShortcutDescriptionKey
}

// An ActionDef plus the combo actually in effect for it (default or user override).
export interface ResolvedAction extends ActionDef {
	combo: string
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

// The in-flight combo recording: which surface instance owns it and which action it is rebinding.
// See beginRecording below for why the session carries an owner rather than being a bare boolean.
export interface RecordingSession {
	owner: string
	actionId: string
}

// Why the last recording attempt was refused. Outlives the session (the recorder stops the moment a
// full chord lands) so the surface can say which action already holds the combo.
export interface RecordingRejection {
	actionId: string
	conflictKey: ShortcutDescriptionKey
}

interface KeymapState {
	overrides: Record<string, string>
	recordingSession: RecordingSession | null
	recordingRejection: RecordingRejection | null
	setOverrides: (overrides: Record<string, string>) => void
	setOverride: (id: string, combo: string) => void
	clearOverride: (id: string) => void
	setRecordingSession: (session: RecordingSession | null) => void
	setRecordingRejection: (rejection: RecordingRejection | null) => void
}

// A rejection is only true of the binding it was computed against, so any change to that binding
// retires it.
function withoutRejectionFor(state: KeymapState, id: string): RecordingRejection | null {
	return state.recordingRejection?.actionId === id ? null : state.recordingRejection
}

// Internal reactivity primitive only — nothing outside this file touches the store directly (see
// `useComboFor` below), so swapping the mechanism later never ripples to `useAction`/`<Kbd>`.
// zustand is already a project dependency and convention (@/stores/boot.ts); it gives every
// consumer of `useComboFor` a free re-render the moment an override loads from kv or is set at
// runtime, without each of them hand-rolling a subscribe/listener.
const useKeymapStore = create<KeymapState>(set => ({
	overrides: {},
	recordingSession: null,
	recordingRejection: null,
	setOverrides: overrides => {
		set({ overrides })
	},
	setOverride: (id, combo) => {
		set(state => ({ overrides: { ...state.overrides, [id]: combo }, recordingRejection: withoutRejectionFor(state, id) }))
	},
	clearOverride: id => {
		// Rebuilt rather than deleted-from: keymapOverridesSchema rejects "", so an override can only
		// be REMOVED (back to the default), never blanked.
		set(state => ({
			overrides: Object.fromEntries(Object.entries(state.overrides).filter(([key]) => key !== id)),
			recordingRejection: withoutRejectionFor(state, id)
		}))
	},
	setRecordingSession: session => {
		set({ recordingSession: session })
	},
	setRecordingRejection: rejection => {
		set({ recordingRejection: rejection })
	}
}))

// Narrow subscribed read of the override layer, for consumers that resolve many actions at once
// (lib/keymap/actions.ts's useActionCatalog). Keeps the store itself module-private.
export function useOverrides(): Record<string, string> {
	return useKeymapStore(state => state.overrides)
}

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

// Every override lives in ONE persisted record, but a write only ever owns a single action's entry.
// Re-reading that record and merging just this entry onto it is what keeps a second tab's rebind (made
// after this tab's one-shot load) alive — persisting this tab's own snapshot wholesale would silently
// drop it. Falls back to the in-memory record when nothing readable is stored, so a dropped/corrupt blob
// still gets rewritten from what the app is actually using.
async function persistOverride(id: string, combo: string | null): Promise<void> {
	const persisted = await kvGetJson(OVERRIDES_KV_KEY, keymapOverridesSchema)
	const merged = Object.fromEntries(Object.entries(persisted ?? useKeymapStore.getState().overrides).filter(([key]) => key !== id))

	if (combo !== null) {
		merged[id] = combo
	}

	await kvSetJson(OVERRIDES_KV_KEY, merged)
}

// Drops a user override so the action resolves to its default again ("reset to default" in the
// shortcuts UI). Loads first for the same reason setUserCombo does.
export async function clearUserCombo(id: string): Promise<void> {
	await ensureOverridesLoaded()
	useKeymapStore.getState().clearOverride(id)
	await persistOverride(id, null)
}

export async function setUserCombo(id: string, combo: string): Promise<void> {
	// Await the persisted-overrides load FIRST: without it a late load would land on top of the override
	// just set here and revert it in the UI.
	await ensureOverridesLoaded()
	useKeymapStore.getState().setOverride(id, combo)
	await persistOverride(id, combo)
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

// A combo recording is a single app-wide session: while one is in flight every keypress is data, not
// a command. The recorder (react-hotkeys-hook's useRecordHotkeys) and useHotkeys both listen on
// `document`, and useHotkeys' listeners are registered first, so the recorder cannot out-order or
// out-propagate them — suppression has to happen inside useHotkeys' own opt-out, which reads
// `isRecordingCombo()` synchronously at event time (see useAction.ts).
//
// The session lives here, not in the surface that renders it, for two reasons: only its owner can end
// it, so a second shortcuts list (the dialog can open on top of the settings page) can never clear a
// session it did not start nor strand one it did; and the whole lifecycle — including why an attempt
// was refused — is then one piece of state with one owner, testable without a DOM.
export function beginRecording(owner: string, actionId: string): void {
	useKeymapStore.getState().setRecordingSession({ owner, actionId })
	useKeymapStore.getState().setRecordingRejection(null)
}

// No-op unless `owner` currently holds the session — a displaced list's unmount cleanup must not end
// a session it never started (that would leave a live recorder AND live hotkeys).
export function endRecording(owner: string): void {
	if (useKeymapStore.getState().recordingSession?.owner !== owner) {
		return
	}

	useKeymapStore.getState().setRecordingSession(null)
}

// Ends the owner's session and records why the combo was refused, so the surface can name the action
// already holding it. Same owner check as endRecording.
export function rejectRecording(owner: string, conflictKey: ShortcutDescriptionKey): void {
	const session = useKeymapStore.getState().recordingSession

	if (session?.owner !== owner) {
		return
	}

	useKeymapStore.getState().setRecordingRejection({ actionId: session.actionId, conflictKey })
	useKeymapStore.getState().setRecordingSession(null)
}

// Unconditional; a newly mounted shortcuts list calls this so it can never inherit someone else's
// in-flight recording — nor a rejection from an attempt made before it existed, which would otherwise
// render as a live "already used by" error under a row the user has not touched this time around.
export function clearRecording(): void {
	useKeymapStore.getState().setRecordingSession(null)
	useKeymapStore.getState().setRecordingRejection(null)
}

// Plain snapshot reads, the same split `comboFor`/`useComboFor` already draws. The predicate is what
// useAction consults inside a DOM event handler: no subscription, so it re-renders nothing and has
// none of the React-Compiler staleness hazard `useComboFor` above documents.
export function currentRecording(): RecordingSession | null {
	return useKeymapStore.getState().recordingSession
}

export function currentRecordingRejection(): RecordingRejection | null {
	return useKeymapStore.getState().recordingRejection
}

export function isRecordingCombo(): boolean {
	return currentRecording() !== null
}

// Subscribed counterparts, for the surface that has to re-render when it gains or loses the session.
export function useRecordingSession(): RecordingSession | null {
	return useKeymapStore(state => state.recordingSession)
}

export function useRecordingRejection(): RecordingRejection | null {
	return useKeymapStore(state => state.recordingRejection)
}

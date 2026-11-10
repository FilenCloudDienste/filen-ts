import { normalizeCombo, UNBOUND_COMBO, withoutCharacterChords } from "@filen/shared/keymap"
import { create } from "zustand"
import { desktopBridge } from "@/lib/desktop"
import { log } from "@/lib/log"
import type { NamespaceKey } from "@/lib/i18n"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import type { ReservedOwner } from "@/lib/keymap/reserved"
import type { SHORTCUT_NAMESPACES } from "@/lib/keymap/shortcutsCatalog"
import {
	DEFAULT_RECORD,
	deleteRecord,
	keymapAccountKey,
	KEYMAP_UNCLAIMED_KEY,
	LEGACY_OVERRIDES_KEY,
	onRecordPosted,
	postRecord,
	readLegacyOverrides,
	readRecord,
	writeRecord,
	type KeymapRecord
} from "@/lib/keymap/storage"

export { keymapOverridesSchema, keymapRecordSchema, type KeymapRecord } from "@/lib/keymap/storage"

// Keyboard-first from day one — every keyboard-controllable action in the app registers here instead of wiring its
// own keydown listener. A Map of ActionDefs (defaults) plus one persisted record (the user's combos and the single-key
// switch) gives every consumer one source of truth for what a shortcut does (the shortcuts list on both the `?`
// dialog and Settings → Keyboard), a user-remappable combo, and a live indicator (`<Kbd action>`) that always shows
// the combo actually in effect. This file stays feature-agnostic: it holds no concrete action, only the mechanism.
export type ActionScope =
	| "global"
	| "drive"
	| "editor"
	| "notes"
	| "chats"
	| "audio"
	| "photos"
	| "contacts"
	| "videos"
	| "playlists"
	| "transfers"
	| "sync"
	| "mounts"
	| "publicLinks"
	| "settings"
	| "media"

// A finer group inside a scope, for the shortcuts list only (conflicts read the scope): the editor's surfaces.
export type ShortcutSection =
	| "viewer"
	| "imageEditor"
	| "code"
	| "presentation"
	| "presentationObjects"
	| "presentationText"
	| "slideshow"
	| "word"
	| "sheet"
	| "archive"

type ShortcutNamespace = (typeof SHORTCUT_NAMESPACES)[number]

// The namespace has to travel with the key: the shortcuts UI resolves these against several catalogs at once. Both
// halves are compile-checked — the namespace exists, and the key exists IN that namespace.
export type ShortcutDescriptionKey = { [N in ShortcutNamespace]: `${N}:${NamespaceKey<N>}` }[ShortcutNamespace]

export interface KeymapPlatform {
	// Mod is Cmd.
	readonly mac: boolean
	// The desktop app, where the browser's own keys are free.
	readonly desktop: boolean
}

// A default for some platforms only; the first whose every given field matches wins over `defaultCombo`.
export interface PlatformDefault {
	readonly on: Partial<KeymapPlatform>
	readonly combo: string
}

export interface ActionDef {
	id: string
	defaultCombo: string
	platformDefaults?: readonly PlatformDefault[]
	scope: ActionScope
	section?: ShortcutSection
	descriptionKey: ShortcutDescriptionKey
	// Where the action works, when its name does not say ("While a slideshow runs").
	hintKey?: ShortcutDescriptionKey
	// Its character keys stay on with single-key shortcuts off: a running slideshow's keys are a clicker's.
	keepsCharacterKeys?: boolean
	// Where the action exists at all (the desktop app's window keys): elsewhere the shortcuts list leaves it out.
	only?: Partial<KeymapPlatform>
}

// An ActionDef plus its binding on this platform, for the shortcuts list and the conflict check.
export interface ResolvedAction extends ActionDef {
	// The combo the user configured or the default, character keys included; "" when unbound.
	combo: string
	// The platform's default.
	platformDefault: string
	overridden: boolean
}

const desktop = desktopBridge()

export const CURRENT_PLATFORM: KeymapPlatform = { mac: isMacPlatform(), desktop: desktop !== undefined }

export function defaultComboOn(def: ActionDef, platform: KeymapPlatform): string {
	const variant = def.platformDefaults?.find(
		({ on }) => (on.mac === undefined || on.mac === platform.mac) && (on.desktop === undefined || on.desktop === platform.desktop)
	)

	return variant?.combo ?? def.defaultCombo
}

export function availableOn(def: ActionDef, platform: KeymapPlatform): boolean {
	const only = def.only

	return (
		only === undefined ||
		((only.mac === undefined || only.mac === platform.mac) && (only.desktop === undefined || only.desktop === platform.desktop))
	)
}

// The combo the user set (unbound as ""), or the platform's default.
export function configuredCombo(def: ActionDef, overrides: Readonly<Record<string, string>>, platform: KeymapPlatform): string {
	const override = overrides[def.id]

	if (override === undefined) {
		return defaultComboOn(def, platform)
	}

	return override === UNBOUND_COMBO ? "" : override
}

// The combo that fires: the configured one, less its character keys while those are switched off.
export function effectiveCombo(def: ActionDef, record: KeymapRecord, platform: KeymapPlatform): string {
	const combo = configuredCombo(def, record.overrides, platform)

	return record.characterKeys || def.keepsCharacterKeys === true ? combo : withoutCharacterChords(combo)
}

export function resolveAction(def: ActionDef, overrides: Readonly<Record<string, string>>, platform: KeymapPlatform): ResolvedAction {
	return {
		...def,
		combo: configuredCombo(def, overrides, platform),
		platformDefault: defaultComboOn(def, platform),
		overridden: overrides[def.id] !== undefined
	}
}

const actions = new Map<string, ActionDef>()
// Bumped on each registration, so a bindings map computed before one is never served after it.
let registrations = 0

// The in-flight recording: which surface instance owns it, which action it rebinds (null: the list's key search), and
// which of its combo's chords it replaces (null: it adds one).
export interface RecordingSession {
	owner: string
	actionId: string | null
	slot: number | null
}

// What stopped or followed the last recording, shown under its row until that action's binding changes.
export type RecordingProblem =
	| {
			kind: "conflict"
			actionId: string
			// The action's whole combo with the recorded chord in place.
			combo: string
			chord: string
			// The chord it replaced, for a swap.
			replaced: string | null
			conflictIds: readonly string[]
	  }
	| { kind: "reserved"; actionId: string; chord: string; owner: ReservedOwner; blocked: boolean }

interface KeymapState {
	record: KeymapRecord
	recordingSession: RecordingSession | null
	recordingProblem: RecordingProblem | null
}

// Internal reactivity primitive only: nothing outside this file touches the store, so swapping the mechanism never
// ripples to `useAction`/`<Kbd>`.
const useKeymapStore = create<KeymapState>(() => ({ record: DEFAULT_RECORD, recordingSession: null, recordingProblem: null }))

function applyRecord(record: KeymapRecord): void {
	const state = useKeymapStore.getState()
	const problem = state.recordingProblem
	// A problem is only true of the binding it was computed against.
	const retired = problem !== null && state.record.overrides[problem.actionId] !== record.overrides[problem.actionId]

	useKeymapStore.setState({ record, recordingProblem: retired ? null : problem })
}

// Stored combos in the canonical token spelling (@filen/shared/keymap): older records may spell a key by its
// character ("mod+=", "mod+shift+,"). Rewritten on load rather than in storage: the next write persists the canonical
// form. A combo that holds no chord at all matches nothing, so it is dropped and the action falls back to its default;
// the unbound marker is kept.
export function migrateOverrides(overrides: Readonly<Record<string, string>>): Record<string, string> {
	const migrated: Record<string, string> = {}

	for (const [id, combo] of Object.entries(overrides)) {
		const canonical = combo === UNBOUND_COMBO ? combo : normalizeCombo(combo)

		if (canonical.length > 0) {
			migrated[id] = canonical
		}
	}

	return migrated
}

function migrateRecord(record: KeymapRecord): KeymapRecord {
	return { overrides: migrateOverrides(record.overrides), characterKeys: record.characterKeys }
}

// The record this tab reads and writes: the signed-in account's, or the unclaimed one before an account is known.
let activeKey = KEYMAP_UNCLAIMED_KEY
let account: string | null = null

// Every load, account switch and write runs in order on this chain, so a slow read can never land on top of a newer
// write, and each write merges onto the freshest stored record.
let chain: Promise<void> = Promise.resolve()

function enqueue(step: () => Promise<void>): Promise<void> {
	const run = chain.then(step)

	chain = run.catch((error: unknown) => {
		log.warn("keymap", "keymap update failed", error)
	})

	return run
}

// A storage failure must never take keyboard shortcuts down: the read is best effort and the defaults keep working.
async function readQuiet(key: string): Promise<KeymapRecord | null> {
	try {
		const record = await readRecord(key)

		return record === null ? null : migrateRecord(record)
	} catch (error) {
		log.warn("keymap", "failed to read the keymap", error)

		return null
	}
}

let loadStarted = false

// The first load, kicked off by the first registration, and the other tabs' changes from then on.
function ensureLoaded(): void {
	if (loadStarted) {
		return
	}

	loadStarted = true

	onRecordPosted((key, record) => {
		if (key === activeKey) {
			applyRecord(migrateRecord(record))
		}
	})

	void enqueue(async () => {
		const record = await readQuiet(activeKey)

		if (record !== null) {
			applyRecord(record)
		}
	})
}

// Resolves once every load and write queued so far has landed. Production callers never need to await this —
// `comboFor`/`useComboFor` are correct from the first render (defaults) and update live.
export function keymapOverridesLoaded(): Promise<void> {
	ensureLoaded()

	return chain
}

// The signed-in account (its user id), whose record this tab uses from now on. Its first sign-in on this device adopts
// the unclaimed record, or the previous format's, if there is one.
export function bindKeymapAccount(userId: string): Promise<void> {
	if (account === userId) {
		return chain
	}

	account = userId
	ensureLoaded()

	return enqueue(async () => {
		const key = keymapAccountKey(userId)

		activeKey = key

		let record = await readQuiet(key)

		if (record === null) {
			const unclaimed = await readQuiet(KEYMAP_UNCLAIMED_KEY)
			const legacy = unclaimed === null ? await readLegacyQuiet() : null
			const adopted = unclaimed ?? (legacy === null ? null : { overrides: legacy, characterKeys: true })

			if (adopted !== null) {
				record = adopted
				await writeRecord(key, adopted)
				await Promise.allSettled([deleteRecord(KEYMAP_UNCLAIMED_KEY), deleteRecord(LEGACY_OVERRIDES_KEY)])
			}
		}

		applyRecord(record ?? DEFAULT_RECORD)
	})
}

async function readLegacyQuiet(): Promise<Record<string, string> | null> {
	try {
		const legacy = await readLegacyOverrides()

		return legacy === null ? null : migrateOverrides(legacy)
	} catch {
		return null
	}
}

// One write: the change applied to the freshest stored record (another tab's change included), then stored, applied
// here and posted to the other tabs.
function mutate(update: (record: KeymapRecord) => KeymapRecord): Promise<void> {
	ensureLoaded()

	return enqueue(async () => {
		const key = activeKey
		const stored = await readQuiet(key)
		const next = update(stored ?? useKeymapStore.getState().record)

		applyRecord(next)
		postRecord(key, next)

		try {
			await writeRecord(key, next)
		} catch (error) {
			log.warn("keymap", "failed to persist the keymap", error)
		}
	})
}

export function registerAction(def: ActionDef): void {
	if (actions.has(def.id)) {
		throw new Error(`keymap: action "${def.id}" is already registered`)
	}

	actions.set(def.id, def)
	registrations++
	ensureLoaded()
}

function definition(id: string): ActionDef {
	const def = actions.get(id)

	if (def === undefined) {
		throw new Error(`keymap: comboFor: unknown action "${id}"`)
	}

	return def
}

export function registeredAction(id: string): ActionDef | undefined {
	return actions.get(id)
}

export function comboFor(id: string): string {
	return effectiveCombo(definition(id), useKeymapStore.getState().record, CURRENT_PLATFORM)
}

// Reactive read for `useAction`/`<Kbd>`. The combo is computed INSIDE the zustand selector, so the value this hook
// returns IS the subscribed hook's own return value: the React Compiler treats hook returns as always fresh, but would
// memoize a plain function reading module state (browser-verified once: an override never reached such a read).
export function useComboFor(id: string): string {
	return useKeymapStore(state => effectiveCombo(definition(id), state.record, CURRENT_PLATFORM))
}

const bindingsCache = new WeakMap<KeymapRecord, { registrations: number; bindings: Readonly<Record<string, string>> }>()

// The combo in effect for every registered action, one object per record: a matcher handed it keeps its parse cache
// hits between renders, and it is rebuilt only when the user changes a binding.
export function bindingsOf(record: KeymapRecord): Readonly<Record<string, string>> {
	const cached = bindingsCache.get(record)

	if (cached?.registrations === registrations) {
		return cached.bindings
	}

	const bindings: Record<string, string> = {}

	for (const def of actions.values()) {
		bindings[def.id] = effectiveCombo(def, record, CURRENT_PLATFORM)
	}

	bindingsCache.set(record, { registrations, bindings })

	return bindings
}

// Subscribed: every action's combo in effect, for a surface that matches many at once (the presentation editor, the
// PDF viewer).
export function useBindings(): Readonly<Record<string, string>> {
	return useKeymapStore(state => bindingsOf(state.record))
}

export function useKeymapRecord(): KeymapRecord {
	return useKeymapStore(state => state.record)
}

export function currentKeymapRecord(): KeymapRecord {
	return useKeymapStore.getState().record
}

export function useOverrides(): Readonly<Record<string, string>> {
	return useKeymapStore(state => state.record.overrides)
}

export function useCharacterKeys(): boolean {
	return useKeymapStore(state => state.record.characterKeys)
}

// Plain change feed of the bindings, for a non-React consumer (the desktop menu's combos).
export function subscribeBindings(listener: () => void): () => void {
	return useKeymapStore.subscribe((state, previous) => {
		if (state.record !== previous.record) {
			listener()
		}
	})
}

// An override as stored: the canonical spelling, or nothing when it equals the platform's default (the action then
// counts as unchanged and follows its default if that ever moves).
function storedOverride(id: string, combo: string): string | null {
	const def = actions.get(id)
	const platformDefault = def === undefined ? undefined : defaultComboOn(def, CURRENT_PLATFORM)

	if (combo === UNBOUND_COMBO) {
		return platformDefault === "" ? null : UNBOUND_COMBO
	}

	const canonical = normalizeCombo(combo)

	if (canonical.length === 0) {
		throw new Error(`keymap: "${combo}" is no combo`)
	}

	return canonical === platformDefault ? null : canonical
}

// Several bindings in one write: a combo (UNBOUND_COMBO turns the action off) or null for the default; and the
// single-key switch, when given (an import). Rejects, writing nothing, when a combo holds no chord.
export async function updateOverrides(changes: Readonly<Record<string, string | null>>, characterKeys?: boolean): Promise<void> {
	const resolved = Object.entries(changes).map(([id, combo]) => [id, combo === null ? null : storedOverride(id, combo)] as const)

	await mutate(record => {
		const overrides = new Map(Object.entries(record.overrides))

		for (const [id, combo] of resolved) {
			if (combo === null) {
				overrides.delete(id)
			} else {
				overrides.set(id, combo)
			}
		}

		return { overrides: Object.fromEntries(overrides), characterKeys: characterKeys ?? record.characterKeys }
	})
}

export function setUserCombo(id: string, combo: string): Promise<void> {
	return updateOverrides({ [id]: combo })
}

// Drops a user override, so the action resolves to its default again.
export function clearUserCombo(id: string): Promise<void> {
	return updateOverrides({ [id]: null })
}

// "Turn off": stored as a marker every matcher reads as no key at all.
export function unbindAction(id: string): Promise<void> {
	return updateOverrides({ [id]: UNBOUND_COMBO })
}

// Every override back to its default, or only those of `ids` (one group). One write either way.
export function resetOverrides(ids?: readonly string[]): Promise<void> {
	const only = ids === undefined ? null : new Set(ids)

	return mutate(record => ({
		...record,
		overrides: only === null ? {} : Object.fromEntries(Object.entries(record.overrides).filter(([id]) => !only.has(id)))
	}))
}

export function setCharacterKeys(enabled: boolean): Promise<void> {
	return mutate(record => ({ ...record, characterKeys: enabled }))
}

// A combo recording is a single app-wide session: while one is in flight every keypress is data, not a command. The
// recorder and useHotkeys both listen on `document`, and useHotkeys' listeners are registered first, so suppression
// has to happen inside useHotkeys' own opt-out, which reads `isRecordingCombo()` at event time (useAction.ts).
//
// The session lives here, not in the surface that renders it: only its owner can end it, so a second shortcuts list
// (the dialog can open on top of the settings page) can never clear a session it did not start nor strand one it did.
export function beginRecording(owner: string, actionId: string | null, slot: number | null = null): void {
	useKeymapStore.setState({ recordingSession: { owner, actionId, slot }, recordingProblem: null })
}

// No-op unless `owner` currently holds the session — a displaced list's unmount cleanup must not end a session it
// never started (that would leave a live recorder AND live hotkeys).
export function endRecording(owner: string): void {
	if (useKeymapStore.getState().recordingSession?.owner === owner) {
		useKeymapStore.setState({ recordingSession: null })
	}
}

// Ends the owner's session and keeps why its chord was not simply saved, for the row to show.
export function reportRecordingProblem(owner: string, problem: RecordingProblem): void {
	if (useKeymapStore.getState().recordingSession?.owner !== owner) {
		return
	}

	useKeymapStore.setState({ recordingSession: null, recordingProblem: problem })
}

// A note after a save (a key the browser may keep), shown until the binding changes again.
export function noteRecordingProblem(problem: RecordingProblem): void {
	useKeymapStore.setState({ recordingProblem: problem })
}

export function dismissRecordingProblem(): void {
	useKeymapStore.setState({ recordingProblem: null })
}

// Unconditional; a newly mounted shortcuts list calls this so it can never inherit someone else's in-flight recording,
// nor a problem from an attempt made before it existed.
export function clearRecording(): void {
	useKeymapStore.setState({ recordingSession: null, recordingProblem: null })
}

// Plain snapshot reads; the predicate is what useAction consults inside a DOM event handler.
export function currentRecording(): RecordingSession | null {
	return useKeymapStore.getState().recordingSession
}

export function currentRecordingProblem(): RecordingProblem | null {
	return useKeymapStore.getState().recordingProblem
}

export function isRecordingCombo(): boolean {
	return currentRecording() !== null
}

export function useRecordingSession(): RecordingSession | null {
	return useKeymapStore(state => state.recordingSession)
}

export function useRecordingProblem(): RecordingProblem | null {
	return useKeymapStore(state => state.recordingProblem)
}

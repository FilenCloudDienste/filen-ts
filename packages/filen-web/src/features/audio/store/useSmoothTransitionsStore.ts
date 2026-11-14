import { type } from "arktype"
import { create } from "zustand"
import { kvPreference } from "@/lib/storage/preference"
import { log } from "@/lib/log"
import {
	DEFAULT_SMOOTH_TRANSITIONS_PREFS,
	FADE_SECONDS_MAX,
	FADE_SECONDS_MIN,
	MANUAL_TRANSITIONS,
	SMOOTH_TRANSITIONS_PREFS_KEY,
	type ManualTransition,
	type SmoothTransitionsPrefs,
	type SmoothTransitionsUnavailable
} from "@/features/audio/lib/smoothTransitions.types"

// Smooth-transition prefs (persisted, in a kv row of their own so the shuffle/loop blob stays untouched) and why the
// feature is unavailable right now (in memory: the engine sets it, the UI reads it).

// Every field optional and loosely typed, so one bad field never discards the others.
const storedPrefsSchema = type({
	"enabled?": "boolean",
	"fadeSeconds?": "number",
	"manualTransition?": "string",
	"matchLoudness?": "boolean"
})

type StoredPrefs = typeof storedPrefsSchema.infer

function isManualTransition(value: string | undefined): value is ManualTransition {
	return MANUAL_TRANSITIONS.some(mode => mode === value)
}

export function clampFadeSeconds(seconds: number | undefined): number {
	if (seconds === undefined || !Number.isFinite(seconds)) {
		return DEFAULT_SMOOTH_TRANSITIONS_PREFS.fadeSeconds
	}

	return Math.min(FADE_SECONDS_MAX, Math.max(FADE_SECONDS_MIN, Math.round(seconds)))
}

export function normalizeSmoothTransitionsPrefs(stored: StoredPrefs): SmoothTransitionsPrefs {
	return {
		enabled: stored.enabled ?? DEFAULT_SMOOTH_TRANSITIONS_PREFS.enabled,
		fadeSeconds: clampFadeSeconds(stored.fadeSeconds),
		manualTransition: isManualTransition(stored.manualTransition)
			? stored.manualTransition
			: DEFAULT_SMOOTH_TRANSITIONS_PREFS.manualTransition,
		matchLoudness: stored.matchLoudness ?? DEFAULT_SMOOTH_TRANSITIONS_PREFS.matchLoudness
	}
}

const preference = kvPreference<StoredPrefs>({
	key: SMOOTH_TRANSITIONS_PREFS_KEY,
	schema: storedPrefsSchema,
	fallback: DEFAULT_SMOOTH_TRANSITIONS_PREFS,
	normalize: normalizeSmoothTransitionsPrefs
})

interface SmoothTransitionsState {
	prefs: SmoothTransitionsPrefs
	unavailable: SmoothTransitionsUnavailable | null
}

export const useSmoothTransitionsStore = create<SmoothTransitionsState>(() => ({
	prefs: DEFAULT_SMOOTH_TRANSITIONS_PREFS,
	unavailable: null
}))

let hydrate: Promise<void> | null = null
// A change made before the stored value arrived wins over it.
let userChanged = false

// Loads the stored prefs once per tab; every later call returns the same promise. Never rejects.
export function hydrateSmoothTransitionsPrefs(): Promise<void> {
	hydrate ??= preference.get().then(
		stored => {
			if (!userChanged) {
				useSmoothTransitionsStore.setState({ prefs: normalizeSmoothTransitionsPrefs(stored) })
			}
		},
		(error: unknown) => {
			log.warn("audio", "failed to load smooth transition prefs", error)
		}
	)

	return hydrate
}

// Applies at once (subscribers run synchronously, so a toggle in a click handler starts audio inside that gesture)
// and persists in the background.
export function setSmoothTransitionsPrefs(patch: Partial<SmoothTransitionsPrefs>): void {
	const next = normalizeSmoothTransitionsPrefs({ ...useSmoothTransitionsStore.getState().prefs, ...patch })

	userChanged = true
	useSmoothTransitionsStore.setState({ prefs: next })
	preference.set(next).catch((error: unknown) => {
		log.warn("audio", "failed to persist smooth transition prefs", error)
	})
}

export function toggleSmoothTransitions(): void {
	setSmoothTransitionsPrefs({ enabled: !useSmoothTransitionsStore.getState().prefs.enabled })
}

// Written by the engine.
export function setSmoothTransitionsUnavailable(cause: SmoothTransitionsUnavailable | null): void {
	if (useSmoothTransitionsStore.getState().unavailable === cause) {
		return
	}

	useSmoothTransitionsStore.setState({ unavailable: cause })
}

import { isImeKeydown, matchesCombo, type ChordEvent } from "@filen/shared/keymap"
import { MEDIA_ACTIONS, MEDIA_JUMP_ACTIONS, type MediaAction } from "@/lib/media/keymap"
import type { PlayerKeyTarget } from "@/lib/media/playerKeys.logic"

// Every player's seek: the keys, the scrubber's arrows, the on-screen and double-tap buttons, the OS media keys.
export const MEDIA_SEEK_STEP_SECONDS = 10
// The long seek (Shift with an arrow).
export const MEDIA_LONG_SEEK_STEP_SECONDS = 60
export const MEDIA_VOLUME_STEP = 0.05

const DEFAULTS: ReadonlyMap<string, string> = new Map(MEDIA_ACTIONS.map(def => [def.id, def.defaultCombo]))

// Held down, these step again on every repeat; the toggles fire once.
const REPEATING: ReadonlySet<MediaAction> = new Set([
	"media.seekBack",
	"media.seekForward",
	"media.seekBackLong",
	"media.seekForwardLong",
	"media.volumeUp",
	"media.volumeDown",
	"media.frameBack",
	"media.frameForward",
	"media.subtitleEarlier",
	"media.subtitleLater"
])

// A slider keeps these (seek, volume), a button its Space and Enter.
const SLIDER_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"])
const BUTTON_KEYS: ReadonlySet<string> = new Set([" ", "Enter"])

// How far through a number key's action jumps (0-0.9), or null for another action.
export function jumpFraction(action: MediaAction): number | null {
	const index = MEDIA_JUMP_ACTIONS.indexOf(action)

	return index < 0 ? null : index / 10
}

export function mediaKeyRepeats(id: MediaAction): boolean {
	return REPEATING.has(id)
}

export type MediaKeyEvent = ChordEvent & { readonly isComposing?: boolean; readonly keyCode?: number }

// Whether a key landed where the player owns it: a menu or a field keeps every key, a slider its own, a button its own
// activation keys.
export function playerOwnsKey(key: string, target: PlayerKeyTarget): boolean {
	if (target === "menu" || target === "field") {
		return false
	}

	if (target === "slider" && SLIDER_KEYS.has(key)) {
		return false
	}

	return !(target === "button" && BUTTON_KEYS.has(key))
}

// The media action a keydown is, among the ones the player takes (`actions`), under `combos` (the combos in effect by
// action id, useBindings), or null. Matched by physical key like every shortcut (@filen/shared/keymap). A held key's
// repeats match too, so the player keeps them from the page; only mediaKeyRepeats' actions act on them.
export function mediaKeyAction(
	event: MediaKeyEvent,
	target: PlayerKeyTarget,
	actions: readonly MediaAction[],
	combos: Readonly<Record<string, string>>,
	mac: boolean
): MediaAction | null {
	if (isImeKeydown(event) || !playerOwnsKey(event.key, target)) {
		return null
	}

	for (const id of actions) {
		if (matchesCombo(event, combos[id] ?? DEFAULTS.get(id) ?? "", mac)) {
			return id
		}
	}

	return null
}

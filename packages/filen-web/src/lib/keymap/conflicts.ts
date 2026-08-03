import { comboAlternatives } from "@/lib/keymap/kbd.logic"
import type { ActionScope, ResolvedAction } from "@/lib/keymap/registry"

// Which scopes can have handlers mounted at the same time, as CROSS-scope pairs (a scope always
// co-mounts with itself — see scopesCanCollide). `global` (themeProvider, above the auth gate) and
// `audio` (the player bar runs its useAction calls before its early return) are always mounted.
// drive/notes/chats/photos/contacts are mutually exclusive by route. `editor` co-mounts with drive,
// photos and chats because the preview overlay is hosted by the drive and photos dialog hosts and
// by the chat embeds — it opens ON TOP of those surfaces rather than replacing them.
export const CO_MOUNTABLE: readonly (readonly [ActionScope, ActionScope])[] = [
	["global", "drive"],
	["global", "editor"],
	["global", "notes"],
	["global", "chats"],
	["global", "audio"],
	["global", "photos"],
	["global", "contacts"],
	["audio", "drive"],
	["audio", "editor"],
	["audio", "notes"],
	["audio", "chats"],
	["audio", "photos"],
	["audio", "contacts"],
	["editor", "drive"],
	["editor", "photos"],
	["editor", "chats"]
]

// Collisions that already exist in the shipped defaults and are resolved by an explicit runtime
// guard, not by luck. `drive.download` and `preview.save` share mod+s; the listing's handler checks
// its dialog host's `isDialogOpen`, which is true exactly while the preview overlay is the open
// dialog, so only one of the two ever does real work.
//
// The ONLY consumer is the defaults-level invariant test. `conflictingActions` deliberately does not
// consult it: honoring it in the rebind UI would let a user create a SECOND, unguarded mod+s binding
// and have it silently accepted.
export const RESOLVED_COLLISIONS: readonly (readonly [string, string])[] = [["drive.download", "preview.save"]]

export function scopesCanCollide(a: ActionScope, b: ActionScope): boolean {
	// A scope always co-mounts with itself — binding drive.rename to mod+a while drive.selectAll holds
	// it is by far the commonest conflict, and CO_MOUNTABLE lists cross-scope pairs only.
	if (a === b) {
		return true
	}

	return CO_MOUNTABLE.some(([first, second]) => (first === a && second === b) || (first === b && second === a))
}

// Order-insensitive equality over two already-normalized token arrays: "shift+mod+a" and
// "mod+shift+a" are the same chord.
function sameChord(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every(key => b.includes(key))
}

function sharesAnAlternative(a: string, b: string): boolean {
	const left = comboAlternatives(a)
	const right = comboAlternatives(b)

	return left.some(chord => right.some(other => sameChord(chord, other)))
}

// Every action whose live combo would fire in the same context as `combo`, excluding `excludeId`
// (the action being rebound — re-recording a row with its own current combo is not a conflict).
//
// Matching is per ALTERNATIVE, not string equality: react-hotkeys-hook splits a combo on "," into
// alternatives, so drive.trash's "delete,backspace" fires on either key and a plain `===` would
// report no conflict when a user records bare Delete for a second drive action.
//
// An empty combo is unbound, not "bound to nothing in particular": it matches no key at all, so it
// never conflicts in either direction.
//
// The rebound action's scope comes from `actions` itself. When `excludeId` names no action in the
// list there is no scope to compare against, so every combo match is reported — a caller that cannot
// say where the binding lives gets the conservative answer, never a false all-clear.
export function conflictingActions(actions: readonly ResolvedAction[], combo: string, excludeId: string): readonly ResolvedAction[] {
	if (combo.length === 0) {
		return []
	}

	const subject = actions.find(action => action.id === excludeId)

	return actions.filter(
		action =>
			action.id !== excludeId &&
			action.combo.length > 0 &&
			(subject === undefined || scopesCanCollide(subject.scope, action.scope)) &&
			sharesAnAlternative(action.combo, combo)
	)
}

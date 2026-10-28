import { comboAlternatives } from "@/lib/keymap/kbd.logic"
import type { ActionScope, ResolvedAction } from "@/lib/keymap/registry"

// Which scopes can have handlers mounted at the same time, as CROSS-scope pairs (a scope always
// co-mounts with itself — see scopesCanCollide). `global` (themeProvider, above the auth gate) and
// `audio` (the player bar runs its useAction calls before its early return) are always mounted.
// drive/notes/chats/photos/contacts/videos are mutually exclusive by route. `editor` co-mounts with drive,
// photos and chats because the preview overlay is hosted by the drive and photos dialog hosts and
// by the chat embeds — it opens ON TOP of those surfaces rather than replacing them — and with notes,
// whose editors bind the editor.* actions.
export const CO_MOUNTABLE: readonly (readonly [ActionScope, ActionScope])[] = [
	["global", "drive"],
	["global", "editor"],
	["global", "notes"],
	["global", "chats"],
	["global", "audio"],
	["global", "photos"],
	["global", "contacts"],
	["global", "videos"],
	["audio", "drive"],
	["audio", "editor"],
	["audio", "notes"],
	["audio", "chats"],
	["audio", "photos"],
	["audio", "contacts"],
	["audio", "videos"],
	["editor", "drive"],
	["editor", "photos"],
	["editor", "chats"],
	["editor", "notes"]
]

// Collisions that already exist in the shipped defaults and are resolved by an explicit runtime
// guard, not by luck. `drive.download` and `preview.save` share mod+s; the listing's handler checks
// its dialog host's `isDialogOpen`, which is true exactly while the preview overlay is the open
// dialog, so only one of the two ever does real work. The listings' searches and `editor.find` share
// mod+f: the listing handlers ignore editable content and stand down while a dialog is open, the editor
// binds its find inside CodeMirror alone, and the Word document viewer only takes keys pressed in its own
// layer, so focus decides which one runs. `notes.saveNow` and `preview.save` share mod+s only at scope
// level: the preview overlay never mounts on the notes route, so the two never run together.
//
// The ONLY consumer is the defaults-level invariant test. `conflictingActions` deliberately does not
// consult it: honoring it in the rebind UI would let a user create a SECOND, unguarded mod+s binding
// and have it silently accepted.
export const RESOLVED_COLLISIONS: readonly (readonly [string, string])[] = [
	["drive.download", "preview.save"],
	["drive.search", "editor.find"],
	["photos.search", "editor.find"],
	["notes.saveNow", "preview.save"],
	// The presentation editor's keys act only where focus is: the slide rail (select all slides, delete slides), the
	// slide canvas (select all objects), a body being edited (align left/centre), the running show (its stage and the
	// presenter view stop every key they take), so the listings under the preview (drive, photos, chats), whose
	// handlers stand down while a dialog is open, and the notes route (which never mounts the preview) never see them.
	// Mod+E centres text in a slide body and is editor.code only in the code and Markdown editors, which never mount
	// inside a presentation.
	["presentation.deleteSlide", "drive.trash"],
	["presentation.deleteSlide", "photos.trash"],
	["presentation.deleteSlide", "notes.trash"],
	["presentation.selectAllSlides", "presentation.objects.selectAll"],
	["presentation.selectAllSlides", "drive.selectAll"],
	["presentation.selectAllSlides", "photos.selectAll"],
	["presentation.selectAllSlides", "chats.selectAll"],
	["presentation.selectAllSlides", "notes.selectAll"],
	["presentation.objects.selectAll", "drive.selectAll"],
	["presentation.objects.selectAll", "photos.selectAll"],
	["presentation.objects.selectAll", "chats.selectAll"],
	["presentation.objects.selectAll", "notes.selectAll"],
	["presentation.text.alignCenter", "editor.code"],
	["presentation.text.alignLeft", "presentation.show.laser"],
	// Print over an open deck; the running show takes Mod+P for its pen on its stage and stops it there.
	["presentation.print", "presentation.show.pen"],
	["presentation.show.arrow", "presentation.selectAllSlides"],
	["presentation.show.arrow", "presentation.objects.selectAll"],
	["presentation.show.arrow", "drive.selectAll"],
	["presentation.show.arrow", "photos.selectAll"],
	["presentation.show.arrow", "chats.selectAll"],
	["presentation.show.arrow", "notes.selectAll"],
	["presentation.show.next", "drive.newDirectory"],
	["presentation.show.next", "notes.newNote"],
	["presentation.show.end", "drive.clearSelection"],
	["presentation.show.end", "photos.clearSelection"],
	["presentation.show.end", "chats.clearSelection"],
	["presentation.show.end", "notes.clearSelection"]
]

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

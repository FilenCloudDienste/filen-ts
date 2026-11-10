import { chordIdentity, combosOverlap, formatChord, parseCombo, UNBOUND_COMBO } from "@filen/shared/keymap"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import type { ActionScope } from "@/lib/keymap/registry"

// What the conflict check reads of an action: where it lives and what it is bound to ("" when unbound).
export interface BoundAction {
	readonly id: string
	readonly scope: ActionScope
	readonly combo: string
	readonly overridden?: boolean
}

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
// `conflictingActions` deliberately does not consult it: honoring it in the rebind UI would let a user create a
// SECOND, unguarded mod+s binding and have it silently accepted. The list's conflict marker does, for pairs still on
// their defaults only (conflictsByAction).
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
	["presentation.show.end", "notes.clearSelection"],
	// The image editor and the presentation editor are both bodies of the preview overlay, which shows one file at a
	// time, so their undo and redo are never mounted together.
	["preview.imageUndo", "presentation.undo"],
	["preview.imageRedo", "presentation.redo"],
	// E opens the image on screen in the editor and does nothing over a deck; the running show takes it on its stage.
	["preview.editImage", "presentation.show.eraseAll"],
	// Backspace goes back a slide only in the running show, whose stage and presenter view stop every key they take.
	["presentation.show.previous", "drive.trash"],
	["presentation.show.previous", "photos.trash"],
	["presentation.show.previous", "notes.trash"],
	["presentation.show.previous", "presentation.deleteSlide"],
	// The running show takes Mod+E on its stage and stops it there; editor.code never mounts inside a presentation.
	["presentation.show.eraser", "presentation.text.alignCenter"],
	["presentation.show.eraser", "editor.code"],
	// Paste Formatting takes Mod+Shift+V on the slide and in a body being edited only; editor.togglePreview acts in the
	// Markdown viewer and editors alone, which never mount inside a presentation.
	["presentation.pasteFormat", "editor.togglePreview"],
	// The PDF viewer and the presentation editor are both bodies of the preview overlay, which shows one file at a time,
	// and each matches these keys on its own keydown only.
	["preview.pdfZoomIn", "presentation.zoomIn"],
	["preview.pdfZoomOut", "presentation.zoomOut"],
	["preview.pdfRotateCw", "presentation.objects.bringForward"],
	["preview.pdfRotateCcw", "presentation.objects.sendBackward"],
	// Off a Mac, subscript's Mod+Ctrl+= and superscript's Mod+Ctrl+Shift+= are Ctrl+= and Ctrl+Shift+=, zoom in's keys
	// (PowerPoint's, both). Subscript and superscript act in a body being edited and on shapes selected on the slide,
	// which take the key first and stop it; zoom acts only outside text, on the editor's own keydown. The PDF viewer
	// never shows with a presentation.
	["presentation.text.subscript", "presentation.zoomIn"],
	["presentation.text.superscript", "presentation.zoomIn"],
	["presentation.text.subscript", "preview.pdfZoomIn"],
	["presentation.text.superscript", "preview.pdfZoomIn"],
	// On a Mac, promote and demote are Cmd+[ and Cmd+] (PowerPoint for Mac's), the keys of the object order and the PDF
	// rotation. They act in a body being edited only, which takes the key first; the object order acts on shapes
	// selected on the slide, the rotation in the PDF viewer, which never shows with a presentation.
	["presentation.text.promote", "presentation.objects.sendBackward"],
	["presentation.text.demote", "presentation.objects.bringForward"],
	["presentation.text.promote", "preview.pdfRotateCcw"],
	["presentation.text.demote", "preview.pdfRotateCw"]
]

export function scopesCanCollide(a: ActionScope, b: ActionScope): boolean {
	// A scope always co-mounts with itself — binding drive.rename to mod+a while drive.selectAll holds
	// it is by far the commonest conflict, and CO_MOUNTABLE lists cross-scope pairs only.
	if (a === b) {
		return true
	}

	return CO_MOUNTABLE.some(([first, second]) => (first === a && second === b) || (first === b && second === a))
}

// Every action whose live combo would fire in the same context as `combo`, excluding `excludeId`
// (the action being rebound — re-recording a row with its own current combo is not a conflict).
//
// Matching is per ALTERNATIVE and per KEYSTROKE, not string equality (@filen/shared/keymap's combosOverlap):
// drive.trash's "delete,backspace" fires on either key, "mod+-" and "mod+minus" are one key, and off a Mac
// "mod+ctrl+equal" is the same Ctrl+= as "mod+equal". `mac` picks the platform whose keystrokes are compared.
//
// An empty combo is unbound, not "bound to nothing in particular": it matches no key at all, so it
// never conflicts in either direction.
//
// The rebound action's scope comes from `actions` itself. When `excludeId` names no action in the
// list there is no scope to compare against, so every combo match is reported — a caller that cannot
// say where the binding lives gets the conservative answer, never a false all-clear.
export function conflictingActions<T extends BoundAction>(
	actions: readonly T[],
	combo: string,
	excludeId: string,
	mac: boolean = isMacPlatform()
): readonly T[] {
	if (combo.length === 0) {
		return []
	}

	const subject = actions.find(action => action.id === excludeId)

	return actions.filter(
		action =>
			action.id !== excludeId &&
			action.combo.length > 0 &&
			(subject === undefined || scopesCanCollide(subject.scope, action.scope)) &&
			combosOverlap(action.combo, combo, mac)
	)
}

function isResolvedPair(a: BoundAction, b: BoundAction): boolean {
	return (
		a.overridden !== true &&
		b.overridden !== true &&
		RESOLVED_COLLISIONS.some(([first, second]) => (first === a.id && second === b.id) || (first === b.id && second === a.id))
	)
}

// Every action that shares a keystroke with another one that can be mounted with it, and those others, for the list's
// conflict marker and filter. A shipped pair whose runtime guard keeps them apart (RESOLVED_COLLISIONS) counts only
// once the user has rebound either side. Indexed by keystroke, so it is linear in the bindings, not quadratic.
export function conflictsByAction<T extends BoundAction>(actions: readonly T[], mac: boolean): ReadonlyMap<string, readonly T[]> {
	const byKeystroke = new Map<string, T[]>()

	for (const action of actions) {
		for (const identity of new Set(parseCombo(action.combo).map(chord => chordIdentity(chord, mac)))) {
			const holders = byKeystroke.get(identity)

			if (holders === undefined) {
				byKeystroke.set(identity, [action])
			} else {
				holders.push(action)
			}
		}
	}

	const conflicts = new Map<string, T[]>()

	for (const holders of byKeystroke.values()) {
		if (holders.length < 2) {
			continue
		}

		for (const action of holders) {
			for (const other of holders) {
				if (other === action || !scopesCanCollide(action.scope, other.scope) || isResolvedPair(action, other)) {
					continue
				}

				const list = conflicts.get(action.id)

				if (list === undefined) {
					conflicts.set(action.id, [other])
				} else if (!list.includes(other)) {
					list.push(other)
				}
			}
		}
	}

	return conflicts
}

// A combo without its chords that share a keystroke with `chord`; unbound when nothing is left.
export function comboWithout(combo: string, chord: string, mac: boolean): string {
	const kept = parseCombo(combo).filter(own => !combosOverlap(formatChord(own), chord, mac))

	return kept.length === 0 ? UNBOUND_COMBO : kept.map(formatChord).join(",")
}

// "Reassign": `id` takes `combo`, and every action that conflicts with its new chord gives that chord up.
export function reassignChanges(
	actions: readonly BoundAction[],
	id: string,
	combo: string,
	chord: string,
	mac: boolean
): Record<string, string> {
	const changes: Record<string, string> = { [id]: combo }

	for (const other of conflictingActions(actions, chord, id, mac)) {
		changes[other.id] = comboWithout(other.combo, chord, mac)
	}

	return changes
}

// "Swap": `id` takes `combo`, and the one conflicting action takes the chord `id` gave up in place of the shared one.
export function swapChanges(
	actions: readonly BoundAction[],
	id: string,
	combo: string,
	chord: string,
	replaced: string,
	otherId: string,
	mac: boolean
): Record<string, string> {
	const other = actions.find(action => action.id === otherId)

	if (other === undefined) {
		return { [id]: combo }
	}

	const chords = parseCombo(other.combo).map(own => (combosOverlap(formatChord(own), chord, mac) ? replaced : formatChord(own)))

	return { [id]: combo, [otherId]: [...new Set(chords)].join(",") }
}

import { registerAction, type ActionDef } from "@/lib/keymap/registry"

// The audio module's in-page transport shortcuts. Every combo is a mod+shift chord ON PURPOSE: the
// preview overlay owns BARE ArrowLeft/Right/Space (its own in-dialog paging + media scrubbers) and text
// editors own the bare caret keys, so a modifier chord can never collide with either — and useAction
// additionally doesn't fire inside form fields, so a note/chat editor is doubly safe. Exported as data
// so the combos/scope are unit-testable without mounting the player, and registered once via
// registerAudioActions (idempotent guard — registerAction itself throws on a duplicate id).
export const AUDIO_ACTIONS: readonly ActionDef[] = [
	{ id: "audio.playPause", defaultCombo: "mod+shift+p", scope: "audio", descriptionKey: "commandPlayPause" },
	{ id: "audio.next", defaultCombo: "mod+shift+right", scope: "audio", descriptionKey: "commandNext" },
	{ id: "audio.previous", defaultCombo: "mod+shift+left", scope: "audio", descriptionKey: "commandPrevious" }
]

let registered = false

export function registerAudioActions(): void {
	if (registered) {
		return
	}

	registered = true

	for (const def of AUDIO_ACTIONS) {
		registerAction(def)
	}
}

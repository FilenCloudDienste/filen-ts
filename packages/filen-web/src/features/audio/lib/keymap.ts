import type { ActionDef } from "@/lib/keymap/registry"

// The audio module's in-page transport shortcuts. Every combo is a mod+shift chord ON PURPOSE: the
// preview overlay owns BARE ArrowLeft/Right/Space (its own in-dialog paging + media scrubbers) and text
// editors own the bare caret keys, so a modifier chord can never collide with either — and useAction
// additionally doesn't fire inside form fields, so a note/chat editor is doubly safe.
export const AUDIO_ACTIONS: readonly ActionDef[] = [
	{ id: "audio.playPause", defaultCombo: "mod+shift+p", scope: "audio", descriptionKey: "audio:commandPlayPause" },
	{ id: "audio.next", defaultCombo: "mod+shift+right", scope: "audio", descriptionKey: "audio:commandNext" },
	{ id: "audio.previous", defaultCombo: "mod+shift+left", scope: "audio", descriptionKey: "audio:commandPrevious" }
]

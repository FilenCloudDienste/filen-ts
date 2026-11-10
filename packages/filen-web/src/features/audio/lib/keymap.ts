import type { ActionDef } from "@/lib/keymap/registry"

// The audio module's in-page transport shortcuts. Every combo is a modifier chord ON PURPOSE: the preview overlay owns
// BARE ArrowLeft/Right/Space (its own in-dialog paging + media scrubbers) and text editors own the bare caret keys, so
// a modifier chord can never collide with either — and useAction additionally doesn't fire inside form fields. Play
// and pause is Mod+Alt+P: Firefox keeps Mod+Shift+P for a private window.
export const AUDIO_ACTIONS: readonly ActionDef[] = [
	{
		id: "audio.playPause",
		defaultCombo: "mod+alt+p",
		scope: "audio",
		descriptionKey: "audio:commandPlayPause",
		hintKey: "settings:keyboardHintAudio"
	},
	{
		id: "audio.next",
		defaultCombo: "mod+shift+arrowright",
		scope: "audio",
		descriptionKey: "audio:commandNext",
		hintKey: "settings:keyboardHintAudio"
	},
	{
		id: "audio.previous",
		defaultCombo: "mod+shift+arrowleft",
		scope: "audio",
		descriptionKey: "audio:commandPrevious",
		hintKey: "settings:keyboardHintAudio"
	}
]

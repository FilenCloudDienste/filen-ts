import type { ActionDef } from "@/lib/keymap/registry"

// The audio player bar's app-wide transport. While focus is inside the bar, it also takes the players' media keys
// (lib/media/keymap.ts). Every combo here is a modifier chord ON PURPOSE: they work from anywhere (not in text
// fields), where the preview overlay owns bare ArrowLeft/Right/Space (its paging and its players) and text editors own
// the bare caret keys. Play and pause is Mod+Alt+P: Firefox keeps Mod+Shift+P for a
// private window. Seek is Alt+Shift with the arrows, beside next and previous's Mod+Shift.
const AUDIO_HINT = "settings:keyboardHintAudio"

function transport(id: string, defaultCombo: string, descriptionKey: ActionDef["descriptionKey"]): ActionDef {
	return { id, defaultCombo, scope: "audio", descriptionKey, hintKey: AUDIO_HINT }
}

export const AUDIO_ACTIONS: readonly ActionDef[] = [
	transport("audio.playPause", "mod+alt+p", "audio:commandPlayPause"),
	transport("audio.next", "mod+shift+arrowright", "audio:commandNext"),
	transport("audio.previous", "mod+shift+arrowleft", "audio:commandPrevious"),
	transport("audio.seekBack", "alt+shift+arrowleft", "audio:commandSeekBack"),
	transport("audio.seekForward", "alt+shift+arrowright", "audio:commandSeekForward"),
	// Unassigned: Alt+Shift+↑/↓ are the chats' next and previous unread (Slack's) and a playlist's track moves, and the
	// player bar's own volume keys work while focus is in it.
	transport("audio.volumeUp", "", "audio:commandVolumeUp"),
	transport("audio.volumeDown", "", "audio:commandVolumeDown"),
	transport("audio.mute", "alt+shift+m", "audio:commandMute"),
	transport("audio.shuffle", "alt+shift+s", "audio:commandShuffle"),
	transport("audio.loop", "alt+shift+r", "audio:commandLoop"),
	// Unassigned: Alt+Shift+D is the document editor's date field.
	transport("audio.smoothTransitions", "", "audio:commandSmoothTransitions"),
	// No free chord: unassigned, so it can be bound.
	transport("audio.toggleQueue", "", "audio:commandToggleQueue")
]

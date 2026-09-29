import { comboAlternatives } from "@/lib/keymap/kbd.logic"

// The app's shortcut combos ("mod+shift+x", alternatives comma-separated, as react-hotkeys-hook reads
// them) in CodeMirror's key notation ("Mod-Shift-x"), so the editor binds the same, user-rebindable
// shortcuts the shortcuts list shows.
const MODIFIERS: Readonly<Record<string, string>> = {
	mod: "Mod",
	shift: "Shift",
	alt: "Alt",
	option: "Alt",
	ctrl: "Ctrl",
	control: "Ctrl",
	meta: "Meta",
	cmd: "Meta",
	command: "Meta"
}

// react-hotkeys-hook's alias-resolved tokens (and the recorder's lowercased event.code with "key",
// "digit" and "numpad" stripped) as KeyboardEvent.key names, which CodeMirror matches on. Letters,
// digits and names that only need a capital ("escape", "enter", "f5") fall through to codeMirrorKey.
const KEYS: Readonly<Record<string, string>> = {
	arrowup: "ArrowUp",
	arrowdown: "ArrowDown",
	arrowleft: "ArrowLeft",
	arrowright: "ArrowRight",
	pageup: "PageUp",
	pagedown: "PageDown",
	space: "Space",
	slash: "/",
	backslash: "\\",
	comma: ",",
	period: ".",
	semicolon: ";",
	quote: "'",
	backquote: "`",
	bracketleft: "[",
	bracketright: "]",
	minus: "-",
	equal: "=",
	add: "+",
	subtract: "-",
	multiply: "*",
	divide: "/",
	decimal: "."
}

function codeMirrorKey(key: string): string {
	const named = KEYS[key]

	if (named !== undefined) {
		return named
	}

	return key.length === 1 ? key : key.charAt(0).toUpperCase() + key.slice(1)
}

export function codeMirrorKeys(combo: string): string[] {
	return comboAlternatives(combo).map(keys => keys.map(key => MODIFIERS[key] ?? codeMirrorKey(key)).join("-"))
}

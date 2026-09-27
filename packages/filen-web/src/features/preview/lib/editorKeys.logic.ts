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

const KEYS: Readonly<Record<string, string>> = {
	slash: "/",
	comma: ",",
	period: ".",
	space: "Space",
	esc: "Escape",
	up: "ArrowUp",
	down: "ArrowDown",
	left: "ArrowLeft",
	right: "ArrowRight"
}

function codeMirrorKey(key: string): string {
	const named = KEYS[key]

	if (named !== undefined) {
		return named
	}

	return key.length === 1 ? key : key.charAt(0).toUpperCase() + key.slice(1)
}

export function codeMirrorKeys(combo: string): string[] {
	return combo
		.split(",")
		.map(chord => chord.trim().toLowerCase())
		.filter(chord => chord.length > 0)
		.map(chord =>
			chord
				.split("+")
				.map(part => MODIFIERS[part] ?? codeMirrorKey(part))
				.join("-")
		)
}

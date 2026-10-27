import { matchesCombo, parseCombo, type KeyLike } from "../keyboard"

// The keys of a body being edited that a user may rebind, as combos in the app keymap's syntax ("mod+shift+."), so
// the body and the shortcuts list agree. The keys PowerPoint fixes (Enter, Backspace, Delete, arrows, Home, End,
// Escape, Mod+A, Mod+Z, Mod+Y) are the editor's own. `link` asks the host for the link dialog.

export type TextKeyCommand =
	| "bold"
	| "italic"
	| "underline"
	| "growFont"
	| "shrinkFont"
	| "alignLeft"
	| "alignCenter"
	| "alignRight"
	| "justify"
	| "lineBreak"
	| "levelDown"
	| "levelUp"
	| "link"

export type TextKeyBindings = Readonly<Record<TextKeyCommand, string>>

// PowerPoint's own keys: what a body takes when the host passes no bindings.
export const DEFAULT_TEXT_BINDINGS: TextKeyBindings = {
	bold: "mod+b",
	italic: "mod+i",
	underline: "mod+u",
	growFont: "mod+shift+.",
	shrinkFont: "mod+shift+,",
	alignLeft: "mod+l",
	alignCenter: "mod+e",
	alignRight: "mod+r",
	justify: "mod+j",
	lineBreak: "shift+enter",
	levelDown: "tab",
	levelUp: "shift+tab",
	link: "mod+k"
}

type Parsed = readonly (readonly [TextKeyCommand, NonNullable<ReturnType<typeof parseCombo>>])[]

// Parsed once per bindings object.
const parsed = new WeakMap<TextKeyBindings, Parsed>()

function combosOf(bindings: TextKeyBindings): Parsed {
	let out = parsed.get(bindings)

	if (out === undefined) {
		const list: (readonly [TextKeyCommand, NonNullable<ReturnType<typeof parseCombo>>])[] = []

		for (const command of Object.keys(bindings) as TextKeyCommand[]) {
			const combo = parseCombo(bindings[command])

			if (combo !== undefined) list.push([command, combo])
		}

		out = list
		parsed.set(bindings, out)
	}

	return out
}

// The rebindable command `event` is, if any; `apple`: Mod is Cmd (else Ctrl).
export function textKeyCommand(event: KeyLike, bindings: TextKeyBindings, apple: boolean): TextKeyCommand | undefined {
	for (const [command, combo] of combosOf(bindings)) if (matchesCombo(event, combo, apple)) return command

	return undefined
}

import {
	clearFormatting,
	setParaProps,
	stepFontSize,
	toggleBaseline,
	toggleRunFlag,
	toggleUnderline,
	type TextCommand,
	type TextDefaults
} from "../../../../core/presentation/edit/commands/text"
import { matchesChord, parseCombo, type Chord } from "@filen/shared/keymap"
import type { KeyLike } from "../keyboard"

// The keys of a body being edited that a user may rebind, as combos in the app keymap's syntax
// (@filen/shared/keymap: "mod+shift+period", alternatives comma-separated, keys matched by physical key), so the body
// and the shortcuts list agree. The keys PowerPoint fixes (Enter, Backspace, Delete, arrows, Home, End,
// Escape, Mod+A) are the editor's own. `link` asks the host for the link dialog; `nextPlaceholder` asks it to open the
// next placeholder (or a new slide); `undo` and `redo` step the body's history (the editor's undo and redo keys, so one
// binding serves the slide and the text). An empty combo is unbound.

export type TextKeyCommand =
	| "bold"
	| "italic"
	| "underline"
	| "subscript"
	| "superscript"
	| "clearFormatting"
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
	| "promote"
	| "demote"
	| "moveParagraphUp"
	| "moveParagraphDown"
	| "nextPlaceholder"
	| "undo"
	| "redo"

export type TextKeyBindings = Readonly<Record<TextKeyCommand, string>>

// PowerPoint's own keys: what a body takes when the host passes no bindings. Subscript and superscript are Ctrl+= and
// Ctrl+Shift+= on Windows, Cmd+Control+= and Cmd+Control+Shift+= on a Mac (Cmd+= is the browser's zoom); clearing the
// character formatting is Ctrl+Space on Windows.
export const DEFAULT_TEXT_BINDINGS: TextKeyBindings = {
	bold: "mod+b",
	italic: "mod+i",
	underline: "mod+u",
	subscript: "mod+ctrl+equal",
	superscript: "mod+ctrl+shift+equal",
	clearFormatting: "ctrl+space",
	growFont: "mod+shift+period",
	shrinkFont: "mod+shift+comma",
	alignLeft: "mod+l",
	alignCenter: "mod+e",
	alignRight: "mod+r",
	justify: "mod+j",
	lineBreak: "shift+enter",
	levelDown: "tab",
	levelUp: "shift+tab",
	link: "mod+k",
	promote: "alt+shift+arrowleft",
	demote: "alt+shift+arrowright",
	moveParagraphUp: "alt+shift+arrowup",
	moveParagraphDown: "alt+shift+arrowdown",
	nextPlaceholder: "mod+enter",
	undo: "mod+z",
	redo: "mod+y,mod+shift+z"
}

// PowerPoint for Mac's: Cmd+[ and Cmd+] promote and demote; moving paragraphs and the next placeholder have no key
// (Option+Shift+arrows select by word there). Clearing the character formatting is Cmd+Shift+Space: Control+Space
// switches the input source and Cmd+Space is Spotlight.
export const APPLE_TEXT_BINDINGS: TextKeyBindings = {
	...DEFAULT_TEXT_BINDINGS,
	clearFormatting: "mod+shift+space",
	promote: "mod+bracketleft",
	demote: "mod+bracketright",
	moveParagraphUp: "",
	moveParagraphDown: "",
	nextPlaceholder: ""
}

export function defaultTextBindings(apple: boolean): TextKeyBindings {
	return apple ? APPLE_TEXT_BINDINGS : DEFAULT_TEXT_BINDINGS
}

type Parsed = readonly (readonly [TextKeyCommand, Chord])[]

// Parsed once per bindings object, every alternative of a combo.
const parsed = new WeakMap<TextKeyBindings, Parsed>()

function combosOf(bindings: TextKeyBindings): Parsed {
	let out = parsed.get(bindings)

	if (out === undefined) {
		const list: (readonly [TextKeyCommand, Chord])[] = []

		for (const command of Object.keys(bindings) as TextKeyCommand[])
			for (const chord of parseCombo(bindings[command])) list.push([command, chord])

		out = list
		parsed.set(bindings, out)
	}

	return out
}

// The rebindable command `event` is, if any; `apple`: Mod is Cmd (else Ctrl).
export function textKeyCommand(event: KeyLike, bindings: TextKeyBindings, apple: boolean): TextKeyCommand | undefined {
	for (const [command, chord] of combosOf(bindings)) if (matchesChord(event, chord, apple)) return command

	return undefined
}

const ALIGN_OF = { alignLeft: "l", alignCenter: "ctr", alignRight: "r", justify: "just" } as const

// What a formatting key does to the text it acts on (an open body's selection, or the whole body of a shape selected
// as an object), given the body's defaults; undefined for a key that is not formatting (breaks, levels, the link
// dialog).
export function formatKey(command: TextKeyCommand): ((defaults: TextDefaults) => TextCommand) | undefined {
	switch (command) {
		case "bold":
		case "italic":
			return defaults => toggleRunFlag(command === "bold" ? "b" : "i", defaults)
		case "underline":
			return defaults => toggleUnderline(defaults)
		case "subscript":
		case "superscript":
			return defaults => toggleBaseline(command === "subscript" ? "sub" : "super", defaults)
		case "clearFormatting":
			return defaults => clearFormatting(defaults)
		case "growFont":
		case "shrinkFont":
			return defaults => stepFontSize(command === "growFont" ? 1 : -1, defaults)
		case "alignLeft":
		case "alignCenter":
		case "alignRight":
		case "justify":
			return defaults => setParaProps({ algn: ALIGN_OF[command] }, defaults)
		default:
			return undefined
	}
}

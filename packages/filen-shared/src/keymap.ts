// Keyboard shortcut combos: the one token model every matcher and display reads (the web app's keymap and its
// recorder, the office editors, the desktop menu).
//
// Syntax is react-hotkeys-hook's: alternatives joined by ",", a chord's modifiers and its one key joined by "+".
// A key is a PHYSICAL key token: KeyboardEvent.code lowercased with "key", "digit" or "numpad" removed ("a", "1",
// "bracketleft", "equal", "space", "add"), exactly what react-hotkeys-hook matches and its recorder stores. Every
// matcher compares an event's code, so a binding fires on the same key wherever it is matched, whatever the layout,
// and AltGr never fires a chord off a Mac. Labels name the character the user's layout prints on that key where the
// browser can say (Keyboard.getLayoutMap), the US one otherwise.
//
// Characters and react-hotkeys-hook's aliases ("=", "[", "esc", "left", "plus") parse as the token of the US key
// that types them, so older combos and stored overrides keep working; normalizeCombo rewrites them. A "," or "+"
// written where a key belongs is that key ("mod+shift+,", "a,="), never a separator.

export type ModifierToken = "mod" | "meta" | "ctrl" | "alt" | "shift"

export interface Chord {
	// The platform's primary modifier: Cmd on a Mac, Ctrl elsewhere.
	readonly mod: boolean
	readonly meta: boolean
	readonly ctrl: boolean
	readonly alt: boolean
	readonly shift: boolean
	readonly key: string
}

// A keydown as the matchers read it. getModifierState is optional so a plain object can stand in for an event.
export interface ChordEvent {
	readonly code: string
	readonly key: string
	readonly ctrlKey: boolean
	readonly metaKey: boolean
	readonly shiftKey: boolean
	readonly altKey: boolean
	getModifierState?(key: string): boolean
}

// A keyboard layout as Keyboard.getLayoutMap() returns it: the character on the key with a given code.
export interface KeyboardLayout {
	get(code: string): string | undefined
}

// Storage and display order of a chord's modifiers.
export const MODIFIER_ORDER: readonly ModifierToken[] = ["mod", "meta", "ctrl", "alt", "shift"]

const MODIFIER_ALIASES: ReadonlyMap<string, ModifierToken> = new Map([
	["mod", "mod"],
	["meta", "meta"],
	["cmd", "meta"],
	["command", "meta"],
	["os", "meta"],
	["ctrl", "ctrl"],
	["control", "ctrl"],
	["alt", "alt"],
	["option", "alt"],
	["shift", "shift"]
])

// The writing-system keys whose token is not their US character: token, KeyboardEvent.code, US character.
const PUNCTUATION: readonly (readonly [token: string, code: string, character: string])[] = [
	["minus", "Minus", "-"],
	["equal", "Equal", "="],
	["bracketleft", "BracketLeft", "["],
	["bracketright", "BracketRight", "]"],
	["backslash", "Backslash", "\\"],
	["semicolon", "Semicolon", ";"],
	["quote", "Quote", "'"],
	["backquote", "Backquote", "`"],
	["comma", "Comma", ","],
	["period", "Period", "."],
	["slash", "Slash", "/"],
	// The ISO key beside the left Shift; a US keyboard has none, most European ones print "<" on it.
	["intlbackslash", "IntlBackslash", "<"]
]

const CODE_OF_PUNCTUATION: ReadonlyMap<string, string> = new Map(PUNCTUATION.map(([token, code]) => [token, code]))
const CHARACTER_OF_PUNCTUATION: ReadonlyMap<string, string> = new Map(PUNCTUATION.map(([token, , character]) => [token, character]))
// The US keys' characters, back to their tokens (the ISO key types nothing on a US layout).
const PUNCTUATION_OF_CHARACTER: ReadonlyMap<string, string> = new Map(
	PUNCTUATION.filter(([token]) => token !== "intlbackslash").map(([token, , character]) => [character, token])
)

// Characters and names a combo may spell a key with, as the token react-hotkeys-hook matches. "+" (and its name
// "plus") is the US key that types it, Equal; Shift is the chord's own.
const KEY_ALIASES: ReadonlyMap<string, string> = new Map([
	["esc", "escape"],
	["return", "enter"],
	["left", "arrowleft"],
	["right", "arrowright"],
	["up", "arrowup"],
	["down", "arrowdown"],
	["spacebar", "space"],
	["plus", "equal"],
	["+", "equal"],
	...PUNCTUATION_OF_CHARACTER
])

// The labels of keys that are not characters, [Mac, elsewhere].
const NAMED_LABELS: ReadonlyMap<string, readonly [mac: string, other: string]> = new Map([
	["mod", ["⌘", "Ctrl"]],
	["meta", ["⌘", "Win"]],
	["ctrl", ["⌃", "Ctrl"]],
	["alt", ["⌥", "Alt"]],
	["shift", ["⇧", "Shift"]],
	["escape", ["Esc", "Esc"]],
	["enter", ["↵", "↵"]],
	["backspace", ["⌫", "⌫"]],
	["delete", ["⌦", "Del"]],
	["tab", ["Tab", "Tab"]],
	["space", ["Space", "Space"]],
	["arrowup", ["↑", "↑"]],
	["arrowdown", ["↓", "↓"]],
	["arrowleft", ["←", "←"]],
	["arrowright", ["→", "→"]],
	["pageup", ["PgUp", "PgUp"]],
	["pagedown", ["PgDn", "PgDn"]],
	["home", ["Home", "Home"]],
	["end", ["End", "End"]],
	["insert", ["Ins", "Ins"]],
	["contextmenu", ["Menu", "Menu"]],
	["add", ["Num +", "Num +"]],
	["subtract", ["Num −", "Num −"]],
	["multiply", ["Num *", "Num *"]],
	["divide", ["Num /", "Num /"]],
	["decimal", ["Num .", "Num ."]]
])

// react-hotkeys-hook's own code normalization (its parseHotkeys mapKey): modifier codes to their modifier, then the
// code lowercased with the first "key", "digit" or "numpad" removed. Numpad digits are therefore the digits'
// tokens, NumpadEnter is "enter". Cached per code: a keydown allocates nothing once its code has been seen.
const CODE_MODIFIERS: ReadonlyMap<string, string> = new Map([
	["ShiftLeft", "shift"],
	["ShiftRight", "shift"],
	["AltLeft", "alt"],
	["AltRight", "alt"],
	["MetaLeft", "meta"],
	["MetaRight", "meta"],
	["OSLeft", "meta"],
	["OSRight", "meta"],
	["ControlLeft", "ctrl"],
	["ControlRight", "ctrl"]
])

const tokenByCode = new Map<string, string>()

export function tokenOfCode(code: string): string {
	let token = tokenByCode.get(code)

	if (token === undefined) {
		token = (CODE_MODIFIERS.get(code) ?? code).toLowerCase().replace(/key|digit|numpad/u, "")
		tokenByCode.set(code, token)
	}

	return token
}

// A key as a canonical token: lowercased, aliases resolved.
export function canonicalKey(key: string): string {
	const lower = key.toLowerCase()

	return KEY_ALIASES.get(lower) ?? lower
}

function chordOf(parts: readonly string[]): Chord | undefined {
	let mod = false
	let meta = false
	let ctrl = false
	let alt = false
	let shift = false
	let key: string | undefined

	for (const [index, part] of parts.entries()) {
		// The last part is the key, so "shift" alone is the Shift key; any earlier one must be a modifier.
		const modifier = index < parts.length - 1 ? MODIFIER_ALIASES.get(part.toLowerCase()) : undefined

		if (index === parts.length - 1) key = canonicalKey(part)
		else if (modifier === "mod") mod = true
		else if (modifier === "meta") meta = true
		else if (modifier === "ctrl") ctrl = true
		else if (modifier === "alt") alt = true
		else if (modifier === "shift") shift = true
		// A chord of two keys ("a+b") or an unknown modifier: react-hotkeys-hook would hold both keys, nothing here can.
		else return undefined
	}

	return key === undefined || key === "" ? undefined : { mod, meta, ctrl, alt, shift, key }
}

// Splits a combo into its alternatives' parts. A "," or "+" where a key starts is that key; whitespace is ignored.
function splitCombo(combo: string): string[][] {
	const alternatives: string[][] = []
	let parts: string[] = []
	let part = ""

	for (const character of combo) {
		if (character.trim() === "") continue

		if ((character === "," || character === "+") && part === "") {
			part = character
		} else if (character === "+") {
			parts.push(part)
			part = ""
		} else if (character === ",") {
			parts.push(part)
			alternatives.push(parts)
			parts = []
			part = ""
		} else {
			part += character
		}
	}

	if (part !== "" || parts.length > 0) {
		parts.push(part)
		alternatives.push(parts)
	}

	return alternatives
}

// Parsed once per combo string: the matchers run on every keydown. Combos come from the shipped defaults and the
// user's overrides, a small set, so the cache stays small.
const parsedCombos = new Map<string, readonly Chord[]>()

// A combo's chords, in order, duplicates kept. A sequence ("g>d") and anything else that is not modifiers plus one
// key is no chord.
export function parseCombo(combo: string): readonly Chord[] {
	let chords = parsedCombos.get(combo)

	if (chords === undefined) {
		const out: Chord[] = []

		if (!combo.includes(">")) {
			for (const parts of splitCombo(combo)) {
				const chord = chordOf(parts)

				if (chord !== undefined) out.push(chord)
			}
		}

		chords = out
		parsedCombos.set(combo, chords)
	}

	return chords
}

export function chordModifiers(chord: Chord): ModifierToken[] {
	return MODIFIER_ORDER.filter(modifier => chord[modifier])
}

export function formatChord(chord: Chord): string {
	return [...chordModifiers(chord), chord.key].join("+")
}

// The canonical spelling of a combo: tokens only, modifiers in MODIFIER_ORDER, duplicates and non-chords dropped.
// "mod+shift+," is "mod+shift+comma", "a,=" is "a,equal".
export function normalizeCombo(combo: string): string {
	return [...new Set(parseCombo(combo).map(formatChord))].join(",")
}

// Whether a key was typed with AltGr: text, not a shortcut. Windows reports AltGr as Ctrl+Alt, so without this a
// Ctrl+Alt chord fires while typing "@" or "ó" on many European layouts. A Mac has no AltGr: Option is Alt, and the
// characters it types are its chords' own (Cmd+Option+O types "ø").
export function typedWithAltGraph(event: Pick<ChordEvent, "key" | "getModifierState">, mac: boolean): boolean {
	return !mac && event.getModifierState?.("AltGraph") === true && event.key.length === 1 && !/^[a-z0-9]$/iu.test(event.key)
}

// Whether `event` is `chord`: its key by code, the modifiers exactly (Mod is Cmd on a Mac, Ctrl elsewhere).
export function matchesChord(event: ChordEvent, chord: Chord, mac: boolean): boolean {
	return (
		tokenOfCode(event.code) === chord.key &&
		event.ctrlKey === (chord.ctrl || (chord.mod && !mac)) &&
		event.metaKey === (chord.meta || (chord.mod && mac)) &&
		event.shiftKey === chord.shift &&
		event.altKey === chord.alt &&
		!typedWithAltGraph(event, mac)
	)
}

// Whether `event` is any chord of `combo`.
export function matchesCombo(event: ChordEvent, combo: string, mac: boolean): boolean {
	for (const chord of parseCombo(combo)) if (matchesChord(event, chord, mac)) return true

	return false
}

// The keystroke a chord is on one platform: two chords with the same identity fire on the same keypress
// ("mod+equal" and "ctrl+=" off a Mac).
export function chordIdentity(chord: Chord, mac: boolean): string {
	const ctrl = chord.ctrl || (chord.mod && !mac)
	const meta = chord.meta || (chord.mod && mac)

	return `${ctrl ? "c" : ""}${meta ? "m" : ""}${chord.alt ? "a" : ""}${chord.shift ? "s" : ""}:${chord.key}`
}

// Whether two combos share a keystroke on one platform.
export function combosOverlap(a: string, b: string, mac: boolean): boolean {
	const left = parseCombo(a)

	if (left.length === 0) return false

	const identities = new Set(left.map(chord => chordIdentity(chord, mac)))

	return parseCombo(b).some(chord => identities.has(chordIdentity(chord, mac)))
}

// The KeyboardEvent.code of a writing-system key's token, for a layout lookup; undefined for the others.
export function codeOfToken(token: string): string | undefined {
	if (/^[a-z]$/u.test(token)) return `Key${token.toUpperCase()}`
	if (/^[0-9]$/u.test(token)) return `Digit${token}`

	return CODE_OF_PUNCTUATION.get(token)
}

// The character a US layout types with a writing-system key's token ("bracketleft" "["); undefined for the others.
export function usCharacterOf(token: string): string | undefined {
	return /^[a-z0-9]$/u.test(token) ? token : CHARACTER_OF_PUNCTUATION.get(token)
}

// The character `layout` puts on a writing-system key; undefined for other keys, and for a dead key's name.
function layoutCharacter(token: string, layout: KeyboardLayout | null | undefined): string | undefined {
	const code = codeOfToken(token)
	const character = code === undefined ? undefined : layout?.get(code)

	return character !== undefined && [...character].length === 1 ? character : undefined
}

// How a key is shown: a modifier's or named key's symbol, the character `layout` puts on a writing-system key (the
// US one without a layout), a function key's name ("F5").
export function keyLabel(token: string, mac: boolean, layout?: KeyboardLayout | null): string {
	const named = NAMED_LABELS.get(token)

	if (named !== undefined) return mac ? named[0] : named[1]

	const character = layoutCharacter(token, layout) ?? usCharacterOf(token)

	if (character !== undefined) {
		// Letters as keycaps print them; "ß" has no one-letter capital.
		const capital = character.toLocaleUpperCase()

		return [...capital].length === 1 ? capital : character
	}

	return token.charAt(0).toUpperCase() + token.slice(1)
}

// A chord as the keys a user presses, modifiers first.
export function chordLabels(chord: Chord, mac: boolean, layout?: KeyboardLayout | null): string[] {
	return [...chordModifiers(chord), chord.key].map(token => keyLabel(token, mac, layout))
}

// A combo with each key renamed to the US key that types the character `layout` puts on it, for a matcher that
// matches by character (a macOS menu's key equivalents): on a German layout "mod+y" (the key printed Z) becomes
// "mod+z". A chord whose character no US key types is dropped: no binding beats one on the wrong key.
export function comboForLayout(combo: string, layout: KeyboardLayout | null | undefined): string {
	if (layout === null || layout === undefined) return combo

	const chords: string[] = []

	for (const chord of parseCombo(combo)) {
		if (codeOfToken(chord.key) === undefined) {
			chords.push(formatChord(chord))
			continue
		}

		const character = layoutCharacter(chord.key, layout)?.toLowerCase()
		const key =
			character === undefined ? chord.key : /^[a-z0-9]$/u.test(character) ? character : PUNCTUATION_OF_CHARACTER.get(character)

		if (key !== undefined) chords.push(formatChord({ ...chord, key }))
	}

	return chords.join(",")
}

// Whether the page runs on a Mac, where Mod is Cmd: react-hotkeys-hook's own test (from the user agent; an iPhone or
// iPad is not one), so every matcher and label agrees with the library that dispatches the app's actions.
export function isMacPlatform(): boolean {
	const agent = (globalThis as { readonly navigator?: { readonly userAgent?: string } }).navigator?.userAgent ?? ""

	return /mac/i.test(agent) && !/iphone|ipad|ipod/i.test(agent)
}

// A keydown that belongs to an input method rather than to the page: during a composition, or (Safari) the one
// confirming it, which only its legacy keyCode 229 tells apart from a plain Enter.
export function isImeKeydown(event: { readonly key: string; readonly isComposing?: boolean; readonly keyCode?: number }): boolean {
	return event.isComposing === true || event.key === "Process" || event.keyCode === 229
}

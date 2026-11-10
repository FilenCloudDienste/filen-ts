import type { TFunction } from "i18next"
import {
	chordLabels,
	displayModifiers,
	isLinuxPlatform,
	keyLabel,
	parseCombo,
	usCharacterOf,
	type Chord,
	type KeyboardLayout
} from "@filen/shared/keymap"
import type { SettingsKey } from "@/lib/i18n"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import type { ReservedOwner } from "@/lib/keymap/reserved"

const IS_MAC = isMacPlatform()
const IS_LINUX = isLinuxPlatform()

// What a screen reader says for the keys shown as a glyph or an abbreviation; every other key reads as its label.
const SPOKEN_KEYS: ReadonlyMap<string, SettingsKey> = new Map<string, SettingsKey>([
	["mod", IS_MAC ? "keyboardKeyCommand" : "keyboardKeyControl"],
	["meta", IS_MAC ? "keyboardKeyCommand" : IS_LINUX ? "keyboardKeySuper" : "keyboardKeyWindows"],
	["ctrl", "keyboardKeyControl"],
	["alt", IS_MAC ? "keyboardKeyOption" : "keyboardKeyAlt"],
	["shift", "keyboardKeyShift"],
	["enter", "keyboardKeyEnter"],
	["backspace", "keyboardKeyBackspace"],
	["delete", "keyboardKeyDelete"],
	["escape", "keyboardKeyEscape"],
	["arrowup", "keyboardKeyArrowUp"],
	["arrowdown", "keyboardKeyArrowDown"],
	["arrowleft", "keyboardKeyArrowLeft"],
	["arrowright", "keyboardKeyArrowRight"],
	["pageup", "keyboardKeyPageUp"],
	["pagedown", "keyboardKeyPageDown"]
])

type Translate = (key: SettingsKey) => string

// A chord as words ("Command Shift Z"), for an accessible name.
export function spokenChord(chord: Chord, t: Translate, layout?: KeyboardLayout | null): string {
	return [...displayModifiers(chord, IS_MAC), chord.key]
		.map(token => {
			const spoken = SPOKEN_KEYS.get(token)

			return spoken === undefined ? keyLabel(token, IS_MAC, layout) : t(spoken)
		})
		.join(" ")
}

// A chord as glyphs ("⌘⇧Z"), for a short text.
export function chordText(chord: Chord, layout?: KeyboardLayout | null): string {
	return chordLabels(chord, IS_MAC, layout).join(IS_MAC ? "" : "+")
}

// The ARIA names of the keys whose token is not their name with a capital (aria-keyshortcuts takes KeyboardEvent.key
// values, US characters for the writing-system keys).
const ARIA_KEYS: ReadonlyMap<string, string> = new Map([
	["arrowup", "ArrowUp"],
	["arrowdown", "ArrowDown"],
	["arrowleft", "ArrowLeft"],
	["arrowright", "ArrowRight"],
	["pageup", "PageUp"],
	["pagedown", "PageDown"],
	["contextmenu", "ContextMenu"],
	["space", "Space"]
])

function ariaKey(token: string): string {
	return ARIA_KEYS.get(token) ?? usCharacterOf(token)?.toUpperCase() ?? token.charAt(0).toUpperCase() + token.slice(1)
}

// A combo as aria-keyshortcuts ("Control+H Meta+Shift+H"), for an item that shows its key as a hint hidden from screen
// readers.
export function ariaKeyShortcuts(combo: string, mac: boolean = IS_MAC): string {
	return parseCombo(combo)
		.map(chord =>
			[
				...(chord.ctrl || (chord.mod && !mac) ? ["Control"] : []),
				...(chord.alt ? ["Alt"] : []),
				...(chord.shift ? ["Shift"] : []),
				...(chord.meta || (chord.mod && mac) ? ["Meta"] : []),
				ariaKey(chord.key)
			].join("+")
		)
		.join(" ")
}

type SettingsT = TFunction<"settings">

// What to say about keys a browser or the system keeps.
export function reservedMessage(t: SettingsT, owner: ReservedOwner, keys: string): string {
	switch (owner) {
		case "browser":
			return t("keyboardReservedBrowser", { keys })
		case "firefox":
			return t("keyboardReservedFirefox", { keys })
		case "system":
			return t("keyboardReservedSystem", { keys })
		case "appMenu":
			return t("keyboardReservedAppMenu", { keys })
	}
}

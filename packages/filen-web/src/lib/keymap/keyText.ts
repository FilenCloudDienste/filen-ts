import type { TFunction } from "i18next"
import { chordLabels, displayModifiers, isLinuxPlatform, keyLabel, type Chord, type KeyboardLayout } from "@filen/shared/keymap"
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

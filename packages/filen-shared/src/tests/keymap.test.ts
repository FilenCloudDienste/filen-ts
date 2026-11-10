import { describe, expect, it, vi } from "vitest"
import {
	chordIdentity,
	chordLabels,
	comboForLayout,
	combosOverlap,
	isCharacterChord,
	isMacPlatform,
	keyLabel,
	matchesCombo,
	normalizeCombo,
	parseCombo,
	tokenOfCode,
	UNBOUND_COMBO,
	withoutCharacterChords,
	type ChordEvent,
	type KeyboardLayout
} from "@filen/shared/keymap"

function press(code: string, key: string, modifiers: Partial<ChordEvent> = {}, altGraph = false): ChordEvent {
	return {
		code,
		key,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		altKey: false,
		getModifierState: name => altGraph && name === "AltGraph",
		...modifiers
	}
}

function layout(entries: Record<string, string>): KeyboardLayout {
	return new Map(Object.entries(entries))
}

// A German (QWERTZ) layout's keys where they differ from a US one.
const GERMAN = layout({
	KeyY: "z",
	KeyZ: "y",
	Minus: "ß",
	Equal: "´",
	BracketLeft: "ü",
	BracketRight: "+",
	Slash: "-",
	Comma: ",",
	Period: "."
})
// A French (AZERTY) layout's.
const FRENCH = layout({ KeyQ: "a", KeyA: "q", KeyW: "z", KeyZ: "w", Digit1: "&", Comma: ";", KeyM: ",", Semicolon: "m" })

describe("tokenOfCode", () => {
	it("spells a code as react-hotkeys-hook matches it", () => {
		expect(tokenOfCode("KeyA")).toBe("a")
		expect(tokenOfCode("Digit1")).toBe("1")
		expect(tokenOfCode("Numpad1")).toBe("1")
		expect(tokenOfCode("NumpadAdd")).toBe("add")
		expect(tokenOfCode("NumpadEnter")).toBe("enter")
		expect(tokenOfCode("BracketLeft")).toBe("bracketleft")
		expect(tokenOfCode("Space")).toBe("space")
		expect(tokenOfCode("ShiftLeft")).toBe("shift")
		expect(tokenOfCode("ControlRight")).toBe("ctrl")
		expect(tokenOfCode("F5")).toBe("f5")
	})
})

describe("parseCombo", () => {
	it("splits alternatives and chords, aliases resolved", () => {
		expect(parseCombo("mod+shift+right,esc")).toEqual([
			{ mod: true, meta: false, ctrl: false, alt: false, shift: true, key: "arrowright" },
			{ mod: false, meta: false, ctrl: false, alt: false, shift: false, key: "escape" }
		])
	})

	it("reads a comma or plus where a key belongs as that key", () => {
		expect(normalizeCombo("mod+shift+,")).toBe("mod+shift+comma")
		expect(normalizeCombo("a,=")).toBe("a,equal")
		expect(normalizeCombo(",")).toBe("comma")
		expect(normalizeCombo(",,a")).toBe("comma,a")
		expect(normalizeCombo("mod++")).toBe("mod+equal")
		expect(normalizeCombo("mod+plus,mod+=,mod+shift+plus")).toBe("mod+equal,mod+shift+equal")
	})

	it("names characters by their US key", () => {
		expect(normalizeCombo("mod+-")).toBe("mod+minus")
		expect(normalizeCombo("mod+\\")).toBe("mod+backslash")
		expect(normalizeCombo("mod+[,mod+]")).toBe("mod+bracketleft,mod+bracketright")
		expect(normalizeCombo("mod+shift+.")).toBe("mod+shift+period")
		expect(normalizeCombo("mod+ctrl+shift+=")).toBe("mod+ctrl+shift+equal")
		expect(normalizeCombo("Shift+Mod+A")).toBe("mod+shift+a")
		expect(normalizeCombo("cmd+option+control+x")).toBe("meta+ctrl+alt+x")
	})

	it("drops what is no chord", () => {
		expect(parseCombo("")).toEqual([])
		expect(parseCombo("g>d")).toEqual([])
		expect(parseCombo("a+b")).toEqual([])
		expect(parseCombo("mod+")).toEqual([])
		expect(normalizeCombo("a+b,mod+s")).toBe("mod+s")
	})

	it("keeps canonical combos as they are", () => {
		for (const combo of [
			"mod+s",
			"delete,backspace",
			"shift+slash",
			"mod+alt+o",
			"arrowright,arrowdown,pagedown,space,enter,n",
			"f5"
		]) {
			expect(normalizeCombo(combo)).toBe(combo)
		}
	})
})

describe("matchesCombo", () => {
	it("matches by physical key, the modifiers exactly", () => {
		expect(matchesCombo(press("KeyS", "s", { ctrlKey: true }), "mod+s", false)).toBe(true)
		expect(matchesCombo(press("KeyS", "s", { metaKey: true }), "mod+s", true)).toBe(true)
		expect(matchesCombo(press("KeyS", "s", { metaKey: true }), "mod+s", false)).toBe(false)
		expect(matchesCombo(press("KeyS", "S", { ctrlKey: true, shiftKey: true }), "mod+s", false)).toBe(false)
		expect(matchesCombo(press("KeyH", "h", { ctrlKey: true }), "ctrl+h", true)).toBe(true)
	})

	it("matches punctuation, Space and the numpad by code, recorded or written as a character", () => {
		for (const combo of ["mod+equal", "mod+="]) expect(matchesCombo(press("Equal", "=", { ctrlKey: true }), combo, false)).toBe(true)
		expect(matchesCombo(press("Equal", "+", { ctrlKey: true, shiftKey: true }), "mod+shift+plus", false)).toBe(true)
		expect(matchesCombo(press("Comma", "<", { metaKey: true, shiftKey: true }), "mod+shift+,", true)).toBe(true)
		expect(matchesCombo(press("Comma", ",", {}), "w,comma", false)).toBe(true)
		expect(matchesCombo(press("Space", " "), "arrowright,space", false)).toBe(true)
		expect(matchesCombo(press("Space", " ", { ctrlKey: true }), "ctrl+space", true)).toBe(true)
		expect(matchesCombo(press("BracketRight", "]", { ctrlKey: true }), "mod+bracketright", false)).toBe(true)
		expect(matchesCombo(press("BracketRight", "]", { ctrlKey: true }), "mod+]", false)).toBe(true)
		expect(matchesCombo(press("NumpadAdd", "+", { ctrlKey: true }), "mod+add", false)).toBe(true)
		expect(matchesCombo(press("Numpad0", "0", { ctrlKey: true }), "mod+0", false)).toBe(true)
		expect(matchesCombo(press("NumpadEnter", "Enter"), "enter", false)).toBe(true)
	})

	it("fires on the same physical key on any layout", () => {
		// The German key printed Z is KeyY; a binding recorded on it is "mod+y" and fires there, not on the key printed Y.
		expect(matchesCombo(press("KeyY", "z", { ctrlKey: true }), "mod+y", false)).toBe(true)
		expect(matchesCombo(press("KeyZ", "y", { ctrlKey: true }), "mod+y", false)).toBe(false)
		// A Mac's Option turns letters into other characters; the code is still the key.
		expect(matchesCombo(press("KeyO", "ø", { metaKey: true, altKey: true }), "mod+alt+o", true)).toBe(true)
		// Another script's letters: the key is still the code.
		expect(matchesCombo(press("KeyZ", "я", { ctrlKey: true }), "mod+z", false)).toBe(true)
	})

	it("never takes a character typed with AltGr off a Mac", () => {
		// Polish AltGr+O types "ó", reported as Ctrl+Alt+O.
		const typed = press("KeyO", "ó", { ctrlKey: true, altKey: true }, true)

		expect(matchesCombo(typed, "mod+alt+o", false)).toBe(false)
		// The same chord without a character to type still works.
		expect(matchesCombo(press("KeyO", "o", { ctrlKey: true, altKey: true }, true), "mod+alt+o", false)).toBe(true)
		expect(matchesCombo(press("KeyO", "o", { ctrlKey: true, altKey: true }), "mod+alt+o", false)).toBe(true)
		expect(matchesCombo(press("KeyO", "ø", { metaKey: true, altKey: true }, true), "mod+alt+o", true)).toBe(true)
	})

	it("matches nothing for an empty or broken combo", () => {
		expect(matchesCombo(press("KeyA", "a"), "", false)).toBe(false)
		expect(matchesCombo(press("KeyA", "a"), "a>b", false)).toBe(false)
	})
})

describe("combosOverlap", () => {
	it("finds the same keystroke across spellings", () => {
		expect(combosOverlap("mod+-", "mod+minus", false)).toBe(true)
		expect(combosOverlap("mod+=", "mod+equal", false)).toBe(true)
		expect(combosOverlap("mod+\\", "mod+backslash", false)).toBe(true)
		expect(combosOverlap("mod+shift+,", "shift+mod+comma", false)).toBe(true)
		expect(combosOverlap("a,=", "equal", false)).toBe(true)
		expect(combosOverlap("mod+shift+right", "mod+shift+arrowright", false)).toBe(true)
	})

	it("resolves Mod per platform", () => {
		// Ctrl+= off a Mac; Cmd+Ctrl+= on one.
		expect(combosOverlap("mod+ctrl+=", "mod+equal", false)).toBe(true)
		expect(combosOverlap("mod+ctrl+=", "mod+equal", true)).toBe(false)
		expect(combosOverlap("mod+s", "ctrl+s", false)).toBe(true)
		expect(combosOverlap("mod+s", "ctrl+s", true)).toBe(false)
		expect(combosOverlap("mod+s", "meta+s", true)).toBe(true)
	})

	it("treats an empty combo as unbound", () => {
		expect(combosOverlap("", "", false)).toBe(false)
		expect(combosOverlap("", "mod+s", false)).toBe(false)
	})

	it("names a keystroke the same whichever way it is spelled", () => {
		const [first] = parseCombo("ctrl+shift+,")
		const [second] = parseCombo("shift+mod+comma")

		expect(first && chordIdentity(first, false)).toBe(second && chordIdentity(second, false))
	})
})

describe("keyLabel", () => {
	it("names keys by their US character without a layout", () => {
		expect(keyLabel("bracketleft", false)).toBe("[")
		expect(keyLabel("equal", false)).toBe("=")
		expect(keyLabel("comma", true)).toBe(",")
		expect(keyLabel("a", false)).toBe("A")
		expect(keyLabel("space", false)).toBe("Space")
		expect(keyLabel("f5", false)).toBe("F5")
		expect(keyLabel("mod", true)).toBe("⌘")
		expect(keyLabel("mod", false)).toBe("Ctrl")
		expect(keyLabel("delete", true)).toBe("⌦")
		expect(keyLabel("delete", false)).toBe("Del")
	})

	it("names keys by the layout's character where it is known", () => {
		expect(keyLabel("y", false, GERMAN)).toBe("Z")
		expect(keyLabel("bracketleft", false, GERMAN)).toBe("Ü")
		expect(keyLabel("equal", false, GERMAN)).toBe("´")
		expect(keyLabel("1", false, FRENCH)).toBe("&")
		// A key the layout does not list, and one that is no character.
		expect(keyLabel("period", false, FRENCH)).toBe(".")
		expect(keyLabel("enter", false, FRENCH)).toBe("↵")
		expect(keyLabel("q", false, layout({ KeyQ: "Dead" }))).toBe("Q")
	})

	it("labels a whole chord, modifiers first, in Apple's order on a Mac", () => {
		const [chord] = parseCombo("shift+mod+,")
		const [all] = parseCombo("mod+ctrl+alt+shift+k")

		expect(chord && chordLabels(chord, true)).toEqual(["⇧", "⌘", ","])
		expect(chord && chordLabels(chord, false, FRENCH, false)).toEqual(["Ctrl", "Shift", ";"])
		expect(all && chordLabels(all, true)).toEqual(["⌃", "⌥", "⇧", "⌘", "K"])
		expect(all && chordLabels(all, false, null, false)).toEqual(["Ctrl", "Ctrl", "Alt", "Shift", "K"])
	})

	it("names the Windows key Super on Linux", () => {
		expect(keyLabel("meta", false, null, true)).toBe("Super")
		expect(keyLabel("meta", false, null, false)).toBe("Win")
		expect(keyLabel("meta", true, null, true)).toBe("⌘")
	})
})

describe("comboForLayout", () => {
	it("renames keys to the US key typing the same character", () => {
		expect(comboForLayout("mod+y", GERMAN)).toBe("mod+z")
		expect(comboForLayout("mod+shift+slash", GERMAN)).toBe("mod+shift+minus")
		expect(comboForLayout("mod+comma", GERMAN)).toBe("mod+comma")
		expect(comboForLayout("mod+f2", GERMAN)).toBe("mod+f2")
	})

	it("drops a chord no US key can name, keeps the rest", () => {
		expect(comboForLayout("mod+bracketleft,mod+k", GERMAN)).toBe("mod+k")
		expect(comboForLayout("mod+equal", GERMAN)).toBe("")
	})

	it("leaves the combo alone without a layout", () => {
		expect(comboForLayout("mod+y", null)).toBe("mod+y")
	})
})

describe("isMacPlatform", () => {
	it("is a Mac but not an iPhone or iPad", () => {
		vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })
		expect(isMacPlatform()).toBe(true)
		vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)" })
		expect(isMacPlatform()).toBe(false)
		vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })
		expect(isMacPlatform()).toBe(false)
	})
})

describe("round trip", () => {
	// What the recorder stores is the event's token, so storing, matching and labelling a recorded key agree.
	const keys: readonly (readonly [code: string, key: string, usLabel: string, germanLabel: string])[] = [
		["Comma", ",", ",", ","],
		["Period", ".", ".", "."],
		["Slash", "/", "/", "-"],
		["Equal", "=", "=", "´"],
		["Minus", "-", "-", "ß"],
		["BracketLeft", "[", "[", "Ü"],
		["BracketRight", "]", "]", "+"],
		["Space", " ", "Space", "Space"],
		["KeyY", "y", "Y", "Z"]
	]

	it("records, stores, matches and labels punctuation, Space, plus and brackets", () => {
		for (const [code, key, usLabel, germanLabel] of keys) {
			const recorded = normalizeCombo(`mod+shift+${tokenOfCode(code)}`)
			const event = press(code, key, { ctrlKey: true, shiftKey: true })
			const [chord] = parseCombo(recorded)

			expect(matchesCombo(event, recorded, false), code).toBe(true)
			expect(chord && chordLabels(chord, false).at(-1), code).toBe(usLabel)
			expect(chord && chordLabels(chord, false, GERMAN).at(-1), code).toBe(germanLabel)
			expect(normalizeCombo(recorded), code).toBe(recorded)
		}
	})
})

describe("the unbound marker", () => {
	it("parses to no chord, so no matcher fires and normalizing drops it", () => {
		expect(parseCombo(UNBOUND_COMBO)).toEqual([])
		expect(normalizeCombo(UNBOUND_COMBO)).toBe("")
		expect(matchesCombo(press("KeyN", "n"), UNBOUND_COMBO, false)).toBe(false)
		expect(combosOverlap(UNBOUND_COMBO, "n", false)).toBe(false)
	})
})

describe("character key shortcuts", () => {
	it("are writing-system, space and numpad keys with no modifier but Shift", () => {
		const character = (combo: string): boolean => parseCombo(combo).every(isCharacterChord)

		expect(character("d")).toBe(true)
		expect(character("shift+slash")).toBe(true)
		expect(character("space")).toBe(true)
		expect(character("add")).toBe(true)
		expect(character("1")).toBe(true)
		expect(character("mod+d")).toBe(false)
		expect(character("alt+d")).toBe(false)
		expect(character("escape")).toBe(false)
		expect(character("delete")).toBe(false)
		expect(character("f2")).toBe(false)
		expect(character("arrowleft")).toBe(false)
	})

	it("withoutCharacterChords keeps the rest of a combo, and the combo itself when it has none", () => {
		expect(withoutCharacterChords("delete,backspace,t")).toBe("delete,backspace")
		expect(withoutCharacterChords("d")).toBe("")
		const combo = "mod+s"

		expect(withoutCharacterChords(combo)).toBe(combo)
	})
})

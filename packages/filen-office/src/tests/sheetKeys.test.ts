import { describe, expect, it } from "vitest"
import { cycleReference } from "../core/sheet/refs/formulaRefs"
import { SHEET_SHORTCUTS, dateEntry, shortcutOf, timeEntry, type KeyChord, type SheetShortcut } from "../react/sheet/keys"

// The shortcut table against Excel's "Keyboard shortcuts in Excel" (support.microsoft.com), Windows and Mac.

interface Press {
	readonly key: string
	readonly code?: string
	readonly ctrl?: boolean
	readonly meta?: boolean
	readonly shift?: boolean
	readonly alt?: boolean
}

function press(p: Press, mac: boolean): SheetShortcut | null {
	return shortcutOf(
		{
			key: p.key,
			code: p.code ?? "",
			ctrlKey: p.ctrl === true,
			metaKey: p.meta === true,
			shiftKey: p.shift === true,
			altKey: p.alt === true
		},
		mac
	)
}

// [the press on Windows, on a Mac, what it does], as the doc lists them.
const TABLE: readonly (readonly [Press, Press | null, SheetShortcut])[] = [
	[{ key: "d", ctrl: true }, { key: "d", meta: true }, "fillDown"],
	[{ key: "r", ctrl: true }, { key: "r", meta: true }, "fillRight"],
	[{ key: "F4" }, { key: "F4" }, "repeat"],
	[{ key: "y", ctrl: true }, { key: "y", meta: true }, "redoOrRepeat"],
	[{ key: ";", code: "Semicolon", ctrl: true }, { key: ";", code: "Semicolon", ctrl: true }, "insertDate"],
	[{ key: ":", code: "Semicolon", ctrl: true, shift: true }, { key: ";", code: "Semicolon", meta: true }, "insertTime"],
	[{ key: "'", code: "Quote", ctrl: true }, { key: "'", code: "Quote", ctrl: true }, "formulaFromAbove"],
	[{ key: '"', code: "Quote", ctrl: true, shift: true }, { key: '"', code: "Quote", ctrl: true, shift: true }, "valueFromAbove"],
	[{ key: "`", code: "Backquote", ctrl: true }, { key: "`", code: "Backquote", ctrl: true }, "showFormulas"],
	[{ key: "+", code: "Equal", ctrl: true, shift: true }, { key: "+", code: "Equal", meta: true, shift: true }, "insertCells"],
	[{ key: "-", code: "Minus", ctrl: true }, { key: "-", code: "Minus", meta: true }, "deleteCells"],
	[{ key: " ", code: "Space", ctrl: true }, { key: " ", code: "Space", ctrl: true }, "selectColumns"],
	[{ key: " ", code: "Space", shift: true }, { key: " ", code: "Space", shift: true }, "selectRows"],
	[{ key: "a", ctrl: true }, { key: "a", meta: true }, "selectAll"],
	[{ key: " ", code: "Space", ctrl: true, shift: true }, null, "selectAll"],
	[{ key: "*", code: "Digit8", ctrl: true, shift: true }, { key: "*", code: "Digit8", meta: true, shift: true }, "selectRegion"],
	[{ key: "Backspace", shift: true }, { key: "Backspace", shift: true }, "collapseSelection"],
	[{ key: ".", code: "Period", ctrl: true }, { key: ".", code: "Period", ctrl: true }, "nextCorner"],
	[{ key: "Backspace", ctrl: true }, { key: "Backspace", meta: true }, "revealActive"],
	[{ key: "PageDown", alt: true }, { key: "PageDown", alt: true }, "screenRight"],
	[{ key: "PageUp", alt: true }, { key: "PageUp", alt: true }, "screenLeft"],
	[{ key: "PageDown", ctrl: true }, { key: "PageDown", ctrl: true }, "nextSheet"],
	[{ key: "PageUp", ctrl: true }, { key: "PageUp", ctrl: true }, "previousSheet"],
	// Excel for the web in Chrome, which takes Ctrl+Page Down and Up for its tabs.
	[{ key: "PageDown", ctrl: true, alt: true }, { key: "PageDown", ctrl: true, alt: true }, "nextSheet"],
	[{ key: "PageUp", ctrl: true, alt: true }, { key: "PageUp", ctrl: true, alt: true }, "previousSheet"],
	[{ key: "PageDown", ctrl: true }, { key: "ArrowRight", alt: true }, "nextSheet"],
	[{ key: "PageUp", ctrl: true }, { key: "ArrowLeft", alt: true }, "previousSheet"],
	[{ key: "b", ctrl: true }, { key: "b", meta: true }, "bold"],
	[{ key: "2", code: "Digit2", ctrl: true }, null, "bold"],
	[{ key: "i", ctrl: true }, { key: "i", meta: true }, "italic"],
	[{ key: "u", ctrl: true }, { key: "u", meta: true }, "underline"],
	[{ key: "5", code: "Digit5", ctrl: true }, { key: "x", meta: true, shift: true }, "strikethrough"],
	[{ key: "~", code: "Backquote", ctrl: true, shift: true }, { key: "~", code: "Backquote", ctrl: true, shift: true }, "formatGeneral"],
	[{ key: "$", code: "Digit4", ctrl: true, shift: true }, { key: "$", code: "Digit4", ctrl: true, shift: true }, "formatCurrency"],
	[{ key: "%", code: "Digit5", ctrl: true, shift: true }, { key: "%", code: "Digit5", ctrl: true, shift: true }, "formatPercent"],
	[{ key: "^", code: "Digit6", ctrl: true, shift: true }, { key: "^", code: "Digit6", ctrl: true, shift: true }, "formatScientific"],
	[{ key: "#", code: "Digit3", ctrl: true, shift: true }, { key: "#", code: "Digit3", ctrl: true, shift: true }, "formatDate"],
	[{ key: "@", code: "Digit2", ctrl: true, shift: true }, { key: "@", code: "Digit2", ctrl: true, shift: true }, "formatTime"],
	[{ key: "!", code: "Digit1", ctrl: true, shift: true }, { key: "!", code: "Digit1", ctrl: true, shift: true }, "formatNumber"],
	[{ key: "1", code: "Digit1", ctrl: true }, { key: "1", code: "Digit1", meta: true }, "formatCells"],
	[{ key: "&", code: "Digit7", ctrl: true, shift: true }, { key: "0", code: "Digit0", meta: true, alt: true }, "borderOutline"],
	[{ key: "_", code: "Minus", ctrl: true, shift: true }, { key: "-", code: "Minus", meta: true, alt: true }, "borderNone"],
	[{ key: "9", code: "Digit9", ctrl: true }, { key: "9", code: "Digit9", ctrl: true }, "hideRows"],
	[{ key: "0", code: "Digit0", ctrl: true }, { key: "0", code: "Digit0", ctrl: true }, "hideColumns"],
	[{ key: "(", code: "Digit9", ctrl: true, shift: true }, { key: "(", code: "Digit9", ctrl: true, shift: true }, "unhideRows"],
	[{ key: ")", code: "Digit0", ctrl: true, shift: true }, { key: ")", code: "Digit0", ctrl: true, shift: true }, "unhideColumns"],
	[{ key: "f", ctrl: true }, { key: "f", meta: true }, "find"],
	[{ key: "F5", shift: true }, { key: "F5", shift: true }, "find"],
	[{ key: "f", ctrl: true }, { key: "f", ctrl: true }, "find"],
	[{ key: "F3", shift: true }, { key: "F3", shift: true }, "find"],
	[{ key: "g", ctrl: true }, { key: "g", ctrl: true }, "goTo"],
	[{ key: "F5" }, { key: "F5" }, "goTo"],
	[{ key: "F4", shift: true }, { key: "F4", shift: true }, "findNext"],
	[{ key: "F4", ctrl: true, shift: true }, { key: "F4", meta: true, shift: true }, "findPrevious"],
	[{ key: "h", ctrl: true }, { key: "h", ctrl: true }, "replace"],
	[{ key: "h", ctrl: true }, { key: "H", meta: true, shift: true }, "replace"],
	[{ key: "s", ctrl: true }, { key: "s", meta: true }, "save"],
	[{ key: "p", ctrl: true }, { key: "p", meta: true }, "print"],
	[{ key: "L", ctrl: true, shift: true }, { key: "f", meta: true, shift: true }, "filter"],
	[{ key: "ArrowDown", alt: true }, { key: "ArrowDown", alt: true }, "openDropdown"],
	[{ key: "=", code: "Equal", alt: true }, { key: "T", meta: true, shift: true }, "autoSum"],
	// Option+= types "≠"; browsers keep Command+Shift+T for reopening a tab.
	[{ key: "=", code: "Equal", alt: true }, { key: "≠", code: "Equal", alt: true }, "autoSum"],
	// Where "=" is Shift+0 (German): the character, Shift held.
	[{ key: "=", code: "Digit0", alt: true, shift: true }, null, "autoSum"],
	[{ key: "k", ctrl: true }, { key: "k", meta: true }, "hyperlink"],
	[{ key: "F2", shift: true }, { key: "F2", shift: true }, "note"],
	[{ key: "F11", shift: true }, { key: "F11", shift: true }, "newSheet"],
	[{ key: "5", code: "Digit5", ctrl: true, alt: true }, { key: "∞", code: "Digit5", ctrl: true, alt: true }, "selectObject"],
	[{ key: "F6" }, { key: "F6" }, "nextPane"],
	[{ key: "F6", shift: true }, { key: "F6", shift: true }, "previousPane"],
	[{ key: "F10", shift: true }, { key: "F10", shift: true }, "contextMenu"]
]

describe("the sheet shortcut table", () => {
	it.each(TABLE)("%o on Windows, %o on a Mac: %s", (windows, mac, action) => {
		expect(press(windows, false)).toBe(action)

		if (mac !== null) expect(press(mac, true)).toBe(action)
	})

	it("covers every entry it declares", () => {
		const tested = new Set(TABLE.map(row => row[2]))

		for (const entry of SHEET_SHORTCUTS) expect(tested.has(entry.action), entry.action).toBe(true)
	})

	it("gives each chord one action on each platform", () => {
		for (const mac of [false, true]) {
			const seen = new Map<string, SheetShortcut>()

			for (const entry of SHEET_SHORTCUTS) {
				for (const chord of mac ? entry.mac : entry.windows) {
					const name = JSON.stringify(chord satisfies KeyChord)

					expect(seen.get(name) ?? entry.action, name).toBe(entry.action)
					seen.set(name, entry.action)
				}
			}
		}
	})

	it("reads F5 and Ctrl+G as Go To, leaving Shift+F5 Find, Ctrl+F5 and the Mac's Command+G to the browser", () => {
		expect(press({ key: "F5", shift: true }, false)).toBe("find")
		expect(press({ key: "F5", ctrl: true }, false)).toBeNull()
		expect(press({ key: "g", meta: true }, true)).toBeNull()
		expect(press({ key: "G", ctrl: true, shift: true }, false)).toBeNull()
	})

	it('leaves AutoSum to the "=" a layout types, not to whatever sits where a US layout has it', () => {
		// The German layout's ´ sits on the Equal position.
		expect(press({ key: "´", code: "Equal", alt: true }, false)).toBeNull()
		expect(press({ key: "=", code: "Equal", ctrl: true, alt: true }, false)).toBeNull()
	})

	it("reads Ctrl+Alt+5 as reaching the sheet's objects, Control+Option+5 on a Mac, and leaves AltGr's characters typed", () => {
		expect(press({ key: "5", code: "Digit5", ctrl: true, alt: true }, false)).toBe("selectObject")
		expect(press({ key: "∞", code: "Digit5", ctrl: true, alt: true }, true)).toBe("selectObject")
		// AZERTY's AltGr+5 types "[" (Windows reports AltGr as Ctrl+Alt).
		expect(press({ key: "[", code: "Digit5", ctrl: true, alt: true }, false)).toBeNull()
		expect(press({ key: "5", code: "Digit5", ctrl: true }, false)).toBe("strikethrough")
	})

	it("keeps Ctrl and Command apart on a Mac", () => {
		// Control+D fills down there too; Command+Shift+; is nothing, Control+; the date and Command+; the time.
		expect(press({ key: "d", ctrl: true }, true)).toBe("fillDown")
		expect(press({ key: ";", code: "Semicolon", ctrl: true }, true)).toBe("insertDate")
		expect(press({ key: ";", code: "Semicolon", meta: true }, true)).toBe("insertTime")
		// Command+H hides the app on a Mac: replace is Control+H.
		expect(press({ key: "h", meta: true }, true)).toBeNull()
		// On Windows the Windows key is never a modifier of these.
		expect(press({ key: "d", meta: true }, false)).toBeNull()
	})

	it("reads a letter by what it types, whatever the layout", () => {
		// AZERTY: the key that types "d" sits where QWERTY has "d"; one that types "z" sits on QWERTY's "w".
		expect(press({ key: "d", code: "KeyD", ctrl: true }, false)).toBe("fillDown")
		expect(press({ key: "D", code: "KeyD", ctrl: true }, false)).toBe("fillDown")
		expect(press({ key: "r", code: "KeyR", ctrl: true, alt: true }, false)).toBeNull()
	})

	it("reads a letter by where it sits when the layout types no Latin letter there", () => {
		// Russian: the key that types "в" sits on QWERTY's "d", "ф" on "a" and "ж" on ";".
		expect(press({ key: "в", code: "KeyD", ctrl: true }, false)).toBe("fillDown")
		expect(press({ key: "Ф", code: "KeyA", ctrl: true, shift: true }, false)).toBeNull()
		expect(press({ key: "ф", code: "KeyA", meta: true }, true)).toBe("selectAll")
		expect(press({ key: "ж", code: "Semicolon", ctrl: true }, false)).toBe("insertDate")
		// A Latin letter on another key wins over the position (AZERTY's "a" on QWERTY's "q").
		expect(press({ key: "a", code: "KeyQ", ctrl: true }, false)).toBe("selectAll")
	})

	it("ignores keys that type a character or move", () => {
		expect(press({ key: "d" }, false)).toBeNull()
		expect(press({ key: "ArrowDown", ctrl: true }, false)).toBeNull()
		// AltGr arrives as Ctrl+Alt on Windows: it types, it is no shortcut.
		expect(press({ key: "@", code: "Digit2", ctrl: true, alt: true }, false)).toBeNull()
	})

	it("enters today and the time as an entry reads them", () => {
		const now = new Date(2026, 0, 5, 9, 7, 30)

		expect(dateEntry(now)).toBe("2026-01-05")
		expect(timeEntry(now)).toBe("9:07")
	})
})

describe("F4 in a formula being typed", () => {
	const cycle = (formula: string, caret: number): string | null => cycleReference(formula, caret)?.formula ?? null

	it("makes the reference at the caret absolute, then the row alone, then the column alone, then relative", () => {
		expect(cycle("A1+B2", 3)).toBe("A1+$B$2")
		expect(cycle("A1+B2", 1)).toBe("$A$1+B2")
		expect(cycle("$A$1+B2", 4)).toBe("A$1+B2")
		expect(cycle("A$1+B2", 3)).toBe("$A1+B2")
		expect(cycle("$A1+B2", 3)).toBe("A1+B2")
		// Just after a reference, as when it was typed.
		expect(cycle("SUM(A1", 6)).toBe("SUM($A$1")
		expect(cycleReference("SUM(A1", 6)?.end).toBe(8)
	})

	it("cycles both ends of a range together, with a sheet before it", () => {
		expect(cycle("SUM(A1:B$2)", 8)).toBe("SUM($A$1:$B$2)")
		expect(cycle("'My data'!A1:B2*2", 3)).toBe("'My data'!$A$1:$B$2*2")
		expect(cycle("SUM(C:D)", 5)).toBe("SUM($C:$D)")
		expect(cycle("SUM($C:$D)", 5)).toBe("SUM(C:D)")
		expect(cycle("SUM(2:3)", 5)).toBe("SUM($2:$3)")
	})

	it("leaves the formula when the caret is at no reference", () => {
		expect(cycle("LOG10(5)", 3)).toBeNull()
		expect(cycle('"A1"&B1', 2)).toBeNull()
		expect(cycle("1+2", 1)).toBeNull()
		expect(cycle("[1]Sheet1!A1", 11)).toBeNull()
	})
})

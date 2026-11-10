// The grid's keyboard shortcuts, from Excel's "Keyboard shortcuts in Excel" (support.microsoft.com), with the keys
// Excel for Mac uses. Moves within the grid (arrows, Home, End, Page Up and Down, Tab and Enter, with Shift and
// Ctrl) are navigation.ts's; this table holds the rest. A shortcut is an action: the grid performs its own (fills,
// selections, entries, formats it can apply), and hands the app the ones only the app can (Find, Save, dialogs),
// so each app wires what it offers.

export type SheetShortcut =
	// Done by the grid.
	| "fillDown"
	| "fillRight"
	| "repeat"
	| "redoOrRepeat"
	| "insertDate"
	| "insertTime"
	| "selectColumns"
	| "selectRows"
	| "selectAll"
	| "selectRegion"
	| "collapseSelection"
	| "nextCorner"
	| "revealActive"
	| "screenLeft"
	| "screenRight"
	| "nextSheet"
	| "previousSheet"
	| "formulaFromAbove"
	| "valueFromAbove"
	| "showFormulas"
	| "insertCells"
	| "deleteCells"
	| "bold"
	| "italic"
	| "underline"
	| "strikethrough"
	| "formatGeneral"
	| "formatCurrency"
	| "formatPercent"
	| "formatScientific"
	| "formatDate"
	| "formatTime"
	| "formatNumber"
	// The app's.
	| "find"
	| "findNext"
	| "findPrevious"
	| "replace"
	| "goTo"
	| "save"
	| "print"
	| "formatCells"
	| "filter"
	| "openDropdown"
	| "hyperlink"
	| "note"
	| "newSheet"
	| "autoSum"
	| "borderOutline"
	| "borderNone"
	| "hideRows"
	| "hideColumns"
	| "unhideRows"
	| "unhideColumns"
	| "selectObject"
	| "nextPane"
	| "previousPane"
	| "contextMenu"

// The shortcuts the grid cannot perform itself: without an app that takes them, they do nothing (and the browser's
// own use of the keys stays).
export const APP_SHORTCUTS: ReadonlySet<SheetShortcut> = new Set<SheetShortcut>([
	"find",
	"findNext",
	"findPrevious",
	"replace",
	"goTo",
	"save",
	"print",
	"formatCells",
	"filter",
	"openDropdown",
	"hyperlink",
	"note",
	"newSheet",
	"autoSum",
	"borderOutline",
	"borderNone",
	"hideRows",
	"hideColumns",
	"unhideRows",
	"unhideColumns",
	"selectObject",
	"nextPane",
	"previousPane",
	"contextMenu"
])

// A key with its modifiers. `primary` is Ctrl on Windows and Command on a Mac; `control` is the Control key itself
// (on Windows the same key as `primary`). A letter is matched by the character it types (whatever the layout), or by
// its position where the layout types no Latin letter there (Cyrillic, Greek), as Excel reads it; a digit or symbol
// key by its position (`code`), since Shift changes what it types.
export interface KeyChord {
	readonly key?: string
	readonly code?: string
	readonly primary?: boolean
	readonly control?: boolean
	readonly shift?: boolean
	readonly alt?: boolean
	// A character some layouts type with Shift ("=" is Shift+0 on a German one): Shift held or not.
	readonly anyShift?: boolean
}

export interface ShortcutEntry {
	readonly action: SheetShortcut
	readonly windows: readonly KeyChord[]
	readonly mac: readonly KeyChord[]
}

// Where the shortcut is used: on the grid, or also in the cell editor while an entry is typed.
export const EDITOR_SHORTCUTS: ReadonlySet<SheetShortcut> = new Set<SheetShortcut>(["insertDate", "insertTime"])

export const SHEET_SHORTCUTS: readonly ShortcutEntry[] = [
	// Editing and filling.
	{
		action: "fillDown",
		windows: [{ key: "d", primary: true }],
		mac: [
			{ key: "d", primary: true },
			{ key: "d", control: true }
		]
	},
	{
		action: "fillRight",
		windows: [{ key: "r", primary: true }],
		mac: [
			{ key: "r", primary: true },
			{ key: "r", control: true }
		]
	},
	{ action: "repeat", windows: [{ key: "F4" }], mac: [{ key: "F4" }] },
	{ action: "redoOrRepeat", windows: [{ key: "y", primary: true }], mac: [{ key: "y", primary: true }] },
	{ action: "insertDate", windows: [{ code: "Semicolon", primary: true }], mac: [{ code: "Semicolon", control: true }] },
	{
		action: "insertTime",
		windows: [{ code: "Semicolon", primary: true, shift: true }],
		mac: [{ code: "Semicolon", primary: true }]
	},
	{ action: "formulaFromAbove", windows: [{ code: "Quote", primary: true }], mac: [{ code: "Quote", control: true }] },
	{
		action: "valueFromAbove",
		windows: [{ code: "Quote", primary: true, shift: true }],
		mac: [{ code: "Quote", control: true, shift: true }]
	},
	{ action: "showFormulas", windows: [{ code: "Backquote", primary: true }], mac: [{ code: "Backquote", control: true }] },
	{
		action: "insertCells",
		windows: [
			{ code: "Equal", primary: true, shift: true },
			{ code: "NumpadAdd", primary: true }
		],
		mac: [
			{ code: "Equal", primary: true, shift: true },
			{ code: "Equal", control: true, shift: true }
		]
	},
	{
		action: "deleteCells",
		windows: [
			{ code: "Minus", primary: true },
			{ code: "NumpadSubtract", primary: true }
		],
		mac: [
			{ code: "Minus", primary: true },
			{ code: "Minus", control: true }
		]
	},
	// Selecting.
	{ action: "selectColumns", windows: [{ key: " ", primary: true }], mac: [{ key: " ", control: true }] },
	{ action: "selectRows", windows: [{ key: " ", shift: true }], mac: [{ key: " ", shift: true }] },
	{
		action: "selectAll",
		windows: [
			{ key: "a", primary: true },
			{ key: " ", primary: true, shift: true }
		],
		mac: [{ key: "a", primary: true }]
	},
	{
		action: "selectRegion",
		windows: [
			{ code: "Digit8", primary: true, shift: true },
			{ code: "NumpadMultiply", primary: true }
		],
		mac: [
			{ code: "Digit8", primary: true, shift: true },
			{ code: "Digit8", control: true, shift: true }
		]
	},
	{ action: "collapseSelection", windows: [{ key: "Backspace", shift: true }], mac: [{ key: "Backspace", shift: true }] },
	{ action: "nextCorner", windows: [{ code: "Period", primary: true }], mac: [{ code: "Period", control: true }] },
	{ action: "revealActive", windows: [{ key: "Backspace", primary: true }], mac: [{ key: "Backspace", primary: true }] },
	// Moving.
	{ action: "screenRight", windows: [{ key: "PageDown", alt: true }], mac: [{ key: "PageDown", alt: true }] },
	{ action: "screenLeft", windows: [{ key: "PageUp", alt: true }], mac: [{ key: "PageUp", alt: true }] },
	// Ctrl+Alt+Page Down and Up: Excel for the web's, as Chrome keeps Ctrl+Page Down and Up for its tabs.
	{
		action: "nextSheet",
		windows: [
			{ key: "PageDown", primary: true },
			{ key: "PageDown", primary: true, alt: true }
		],
		mac: [
			{ key: "PageDown", control: true },
			{ key: "PageDown", control: true, alt: true },
			{ key: "ArrowRight", alt: true }
		]
	},
	{
		action: "previousSheet",
		windows: [
			{ key: "PageUp", primary: true },
			{ key: "PageUp", primary: true, alt: true }
		],
		mac: [
			{ key: "PageUp", control: true },
			{ key: "PageUp", control: true, alt: true },
			{ key: "ArrowLeft", alt: true }
		]
	},
	// Formatting.
	{
		action: "bold",
		windows: [
			{ key: "b", primary: true },
			{ code: "Digit2", primary: true }
		],
		mac: [{ key: "b", primary: true }]
	},
	{
		action: "italic",
		windows: [
			{ key: "i", primary: true },
			{ code: "Digit3", primary: true }
		],
		mac: [{ key: "i", primary: true }]
	},
	{
		action: "underline",
		windows: [
			{ key: "u", primary: true },
			{ code: "Digit4", primary: true }
		],
		mac: [{ key: "u", primary: true }]
	},
	{ action: "strikethrough", windows: [{ code: "Digit5", primary: true }], mac: [{ key: "x", primary: true, shift: true }] },
	{
		action: "formatGeneral",
		windows: [{ code: "Backquote", primary: true, shift: true }],
		mac: [{ code: "Backquote", control: true, shift: true }]
	},
	{
		action: "formatCurrency",
		windows: [{ code: "Digit4", primary: true, shift: true }],
		mac: [{ code: "Digit4", control: true, shift: true }]
	},
	{
		action: "formatPercent",
		windows: [{ code: "Digit5", primary: true, shift: true }],
		mac: [{ code: "Digit5", control: true, shift: true }]
	},
	{
		action: "formatScientific",
		windows: [{ code: "Digit6", primary: true, shift: true }],
		mac: [{ code: "Digit6", control: true, shift: true }]
	},
	{
		action: "formatDate",
		windows: [{ code: "Digit3", primary: true, shift: true }],
		mac: [{ code: "Digit3", control: true, shift: true }]
	},
	{
		action: "formatTime",
		windows: [{ code: "Digit2", primary: true, shift: true }],
		mac: [{ code: "Digit2", control: true, shift: true }]
	},
	{
		action: "formatNumber",
		windows: [{ code: "Digit1", primary: true, shift: true }],
		mac: [{ code: "Digit1", control: true, shift: true }]
	},
	{ action: "formatCells", windows: [{ code: "Digit1", primary: true }], mac: [{ code: "Digit1", primary: true }] },
	{
		action: "borderOutline",
		windows: [{ code: "Digit7", primary: true, shift: true }],
		mac: [{ code: "Digit0", primary: true, alt: true }]
	},
	{
		action: "borderNone",
		windows: [{ code: "Minus", primary: true, shift: true }],
		mac: [{ code: "Minus", primary: true, alt: true }]
	},
	{ action: "hideRows", windows: [{ code: "Digit9", primary: true }], mac: [{ code: "Digit9", control: true }] },
	{ action: "hideColumns", windows: [{ code: "Digit0", primary: true }], mac: [{ code: "Digit0", control: true }] },
	{
		action: "unhideRows",
		windows: [{ code: "Digit9", primary: true, shift: true }],
		mac: [{ code: "Digit9", control: true, shift: true }]
	},
	{
		action: "unhideColumns",
		windows: [{ code: "Digit0", primary: true, shift: true }],
		mac: [{ code: "Digit0", control: true, shift: true }]
	},
	// The sheet's floating objects: the first in view, then Tab cycles them ("Keyboard shortcuts in Excel": Ctrl+Alt+5,
	// then Tab). By the "5" it types, not its position: where Ctrl+Alt is AltGr and types another character there
	// (AZERTY's "["), the key stays that character's. Excel for Mac documents none; Control+Option+5 types nothing.
	{ action: "selectObject", windows: [{ key: "5", primary: true, alt: true }], mac: [{ code: "Digit5", control: true, alt: true }] },
	// The panes beside the sheet (F6: "switches between the worksheet, ribbon, task pane"; Shift+F6 the other way) and
	// the context menu at the active cell (Shift+F10), on Windows and the Mac alike.
	{ action: "nextPane", windows: [{ key: "F6" }], mac: [{ key: "F6" }] },
	{ action: "previousPane", windows: [{ key: "F6", shift: true }], mac: [{ key: "F6", shift: true }] },
	{ action: "contextMenu", windows: [{ key: "F10", shift: true }], mac: [{ key: "F10", shift: true }] },
	// The app's.
	// Shift+F3, Shift+F4 and Ctrl+Shift+F4 are Excel for the web's.
	{
		action: "find",
		windows: [
			{ key: "f", primary: true },
			{ key: "F5", shift: true },
			{ key: "F3", shift: true }
		],
		mac: [
			{ key: "f", primary: true },
			{ key: "f", control: true },
			{ key: "F5", shift: true },
			{ key: "F3", shift: true }
		]
	},
	{ action: "findNext", windows: [{ key: "F4", shift: true }], mac: [{ key: "F4", shift: true }] },
	{ action: "findPrevious", windows: [{ key: "F4", primary: true, shift: true }], mac: [{ key: "F4", primary: true, shift: true }] },
	{
		action: "replace",
		windows: [{ key: "h", primary: true }],
		mac: [
			{ key: "h", control: true },
			{ key: "h", primary: true, shift: true }
		]
	},
	// "Ctrl+G: Displays the Go To dialog box. F5 also displays this dialog box"; Control+G on a Mac, whose Command+G
	// stays the browser's Find Next. Plain F5 only: Shift+F5 is Find, Ctrl+F5 the browser's.
	{
		action: "goTo",
		windows: [{ key: "g", primary: true }, { key: "F5" }],
		mac: [{ key: "g", control: true }, { key: "F5" }]
	},
	{ action: "save", windows: [{ key: "s", primary: true }], mac: [{ key: "s", primary: true }] },
	{ action: "print", windows: [{ key: "p", primary: true }], mac: [{ key: "p", primary: true }] },
	{
		action: "filter",
		windows: [{ key: "l", primary: true, shift: true }],
		mac: [{ key: "f", primary: true, shift: true }]
	},
	// Opens the selected drop-down: an autofilter's menu, a validation list (Option+Down on a Mac).
	{ action: "openDropdown", windows: [{ key: "ArrowDown", alt: true }], mac: [{ key: "ArrowDown", alt: true }] },
	{ action: "hyperlink", windows: [{ key: "k", primary: true }], mac: [{ key: "k", primary: true }] },
	{ action: "note", windows: [{ key: "F2", shift: true }], mac: [{ key: "F2", shift: true }] },
	{ action: "newSheet", windows: [{ key: "F11", shift: true }], mac: [{ key: "F11", shift: true }] },
	// "AutoSum formula: Alt+Equal sign": the "=" the layout types, wherever it sits. On a Mac "Insert the AutoSum
	// formula: Command+Shift+T", which browsers keep for reopening a tab: Option+= (the Windows keys; Option changes
	// the character there, so by the key's position) first.
	{
		action: "autoSum",
		windows: [{ key: "=", alt: true, anyShift: true }],
		mac: [
			{ code: "Equal", alt: true },
			{ key: "t", primary: true, shift: true }
		]
	}
]

export interface ShortcutKey {
	readonly key: string
	readonly code: string
	readonly ctrlKey: boolean
	readonly metaKey: boolean
	readonly shiftKey: boolean
	readonly altKey: boolean
}

const LETTER_CODE = /^Key([A-Z])$/

// The key a press names: its character, or the Latin letter of its position when it types another script's.
export function layoutKey(event: Pick<ShortcutKey, "key" | "code">): string {
	const letter = event.key.length === 1 && event.key.charCodeAt(0) > 0x7f ? LETTER_CODE.exec(event.code) : null

	return letter === null ? event.key : (letter[1] ?? "").toLowerCase()
}

function matches(chord: KeyChord, event: ShortcutKey, key: string, mac: boolean): boolean {
	if (chord.code !== undefined ? chord.code !== event.code : chord.key?.toLowerCase() !== key) return false
	if ((chord.anyShift !== true && (chord.shift === true) !== event.shiftKey) || (chord.alt === true) !== event.altKey) return false

	if (mac) return (chord.primary === true) === event.metaKey && (chord.control === true) === event.ctrlKey

	return (chord.primary === true || chord.control === true) === event.ctrlKey && !event.metaKey
}

// Built once per platform: chords by key and by code.
const lookups = new Map<boolean, { readonly byKey: Map<string, ShortcutEntry[]>; readonly byCode: Map<string, ShortcutEntry[]> }>()

function lookup(mac: boolean): { readonly byKey: Map<string, ShortcutEntry[]>; readonly byCode: Map<string, ShortcutEntry[]> } {
	let found = lookups.get(mac)

	if (found === undefined) {
		const byKey = new Map<string, ShortcutEntry[]>()
		const byCode = new Map<string, ShortcutEntry[]>()

		for (const entry of SHEET_SHORTCUTS) {
			for (const chord of mac ? entry.mac : entry.windows) {
				const map = chord.code !== undefined ? byCode : byKey
				const name = chord.code ?? chord.key?.toLowerCase() ?? ""
				const list = map.get(name) ?? []

				if (!list.includes(entry)) list.push(entry)

				map.set(name, list)
			}
		}

		found = { byKey, byCode }
		lookups.set(mac, found)
	}

	return found
}

// The shortcut a key press is, or null.
export function shortcutOf(event: ShortcutKey, mac: boolean): SheetShortcut | null {
	const { byKey, byCode } = lookup(mac)
	const key = layoutKey(event).toLowerCase()
	const candidates = [...(byCode.get(event.code) ?? []), ...(byKey.get(key) ?? [])]

	for (const entry of candidates)
		for (const chord of mac ? entry.mac : entry.windows) if (matches(chord, event, key, mac)) return entry.action

	return null
}

// Whether the page runs on a Mac (Command is the primary modifier): the app keymap's own test, so the grid and the app
// agree on which key is Mod.
export { isMacPlatform } from "@filen/shared/keymap"

// The number formats Excel's shortcuts apply ("Keyboard shortcuts in Excel", Format cells): General, Currency with
// two decimals and negatives in parentheses, Percentage without decimals, Scientific with two decimals, the date
// with day, month and year, the time with hour, minute and AM or PM, and Number with two decimals, a thousands
// separator and a minus sign for negatives.
export const SHORTCUT_FORMATS: Readonly<Partial<Record<SheetShortcut, string>>> = {
	formatGeneral: "General",
	formatCurrency: '"$"#,##0.00_);("$"#,##0.00)',
	formatPercent: "0%",
	formatScientific: "0.00E+00",
	formatDate: "d-mmm-yy",
	formatTime: "h:mm AM/PM",
	formatNumber: "#,##0.00"
}

function two(value: number): string {
	return value < 10 ? `0${String(value)}` : String(value)
}

// Today as an entry reads it (an ISO date, which every locale reads alike), and the time of day.
export function dateEntry(now: Date): string {
	return `${String(now.getFullYear())}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
}

export function timeEntry(now: Date): string {
	return `${String(now.getHours())}:${two(now.getMinutes())}`
}

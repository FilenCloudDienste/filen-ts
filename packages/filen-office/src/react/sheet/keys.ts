import { matchesChord, parseCombo, tokenOfCode, type Chord, type ChordEvent } from "@filen/shared/keymap"

// The grid's keyboard shortcuts, from Excel's "Keyboard shortcuts in Excel" (support.microsoft.com), with the keys
// Excel for Mac uses. Moves within the grid (arrows, Home, End, Page Up and Down, Tab and Enter, with Shift and
// Ctrl) are navigation.ts's; this table holds the rest. A shortcut is an action: the grid performs its own (fills,
// selections, entries, formats it can apply), and hands the app the ones only the app can (Find, Save, dialogs),
// so each app wires what it offers. Some ship without keys (the ribbon's commands): a user may bind them.

// Done by the grid.
type GridShortcut =
	| "undo"
	| "redo"
	| "fillDown"
	| "fillRight"
	| "fillUp"
	| "fillLeft"
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
const APP_ACTIONS = [
	"find",
	"findNext",
	"findPrevious",
	"replace",
	"goTo",
	"save",
	"saveAs",
	"print",
	"exportCsv",
	"exportPdf",
	"pasteValues",
	"formatCells",
	"fontGrow",
	"fontShrink",
	"wrap",
	"alignLeft",
	"alignCenter",
	"alignRight",
	"indentDecrease",
	"indentIncrease",
	"decimalsIncrease",
	"decimalsDecrease",
	"mergeCenter",
	"unmerge",
	"clearFormats",
	"clearAll",
	"autofitRows",
	"autofitColumns",
	"zoomIn",
	"zoomOut",
	"zoomReset",
	"freezePanes",
	"filter",
	"reapplyFilter",
	"clearFilters",
	"sortAscending",
	"sortDescending",
	"dataValidation",
	"openDropdown",
	"hyperlink",
	"note",
	"toggleNote",
	"deleteNote",
	"newComment",
	"insertChart",
	"insertPicture",
	"altText",
	"fillSeries",
	"newSheet",
	"renameSheet",
	"deleteSheet",
	"protectSheet",
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
] as const

export type SheetShortcut = GridShortcut | (typeof APP_ACTIONS)[number]

// The shortcuts the grid cannot perform itself: without an app that takes them, they do nothing (and the browser's
// own use of the keys stays).
export const APP_SHORTCUTS: ReadonlySet<SheetShortcut> = new Set<SheetShortcut>(APP_ACTIONS)

// A shortcut's keys: a combo of @filen/shared/keymap's token model (physical keys, alternatives joined by ","), off a
// Mac and on one; "" for one shipped without keys. `mod` is Ctrl on Windows and Command on a Mac; `ctrl` is the
// Control key itself (on Windows the same key as `mod`). Keys are matched by position, as every other matcher of the
// app's keymap matches them, so a binding a user records fires on the key they pressed, and a character typed with
// AltGr (Windows reports it as Ctrl+Alt) is never a shortcut.
export interface ShortcutEntry {
	readonly action: SheetShortcut
	readonly windows: string
	readonly mac: string
}

// The combos in effect, by action, over the table's (a user's bindings): an action left out keeps its default, ""
// turns one off. Hand in the same object while nothing changes: the lookup built from it is kept with it.
export type SheetKeyBindings = Readonly<Partial<Record<SheetShortcut, string>>>

function entry(action: SheetShortcut, windows: string, mac: string = windows): ShortcutEntry {
	return { action, windows, mac }
}

// In the order a key shared by two actions resolves: the first wins.
export const SHEET_SHORTCUTS: readonly ShortcutEntry[] = [
	// Editing and filling.
	entry("undo", "mod+z"),
	entry("redo", "mod+shift+z"),
	entry("fillDown", "mod+d", "mod+d,ctrl+d"),
	entry("fillRight", "mod+r", "mod+r,ctrl+r"),
	entry("fillUp", ""),
	entry("fillLeft", ""),
	entry("fillSeries", ""),
	entry("repeat", "f4"),
	entry("redoOrRepeat", "mod+y"),
	entry("insertDate", "mod+semicolon", "ctrl+semicolon"),
	entry("insertTime", "mod+shift+semicolon", "mod+semicolon"),
	entry("formulaFromAbove", "mod+quote", "ctrl+quote"),
	entry("valueFromAbove", "mod+shift+quote", "ctrl+shift+quote"),
	entry("showFormulas", "mod+backquote", "ctrl+backquote"),
	entry("insertCells", "mod+shift+equal,mod+add", "mod+shift+equal,ctrl+shift+equal"),
	entry("deleteCells", "mod+minus,mod+subtract", "mod+minus,ctrl+minus"),
	// Excel's Paste Values.
	entry("pasteValues", "mod+shift+v"),
	entry("clearFormats", ""),
	entry("clearAll", ""),
	// Selecting.
	entry("selectColumns", "mod+space", "ctrl+space"),
	entry("selectRows", "shift+space"),
	entry("selectAll", "mod+a,mod+shift+space", "mod+a"),
	entry("selectRegion", "mod+shift+8,mod+multiply", "mod+shift+8,ctrl+shift+8"),
	entry("collapseSelection", "shift+backspace"),
	entry("nextCorner", "mod+period", "ctrl+period"),
	entry("revealActive", "mod+backspace"),
	// Moving.
	entry("screenRight", "alt+pagedown"),
	entry("screenLeft", "alt+pageup"),
	// Ctrl+Alt+Page Down and Up: Excel for the web's, as Chrome keeps Ctrl+Page Down and Up for its tabs.
	entry("nextSheet", "mod+pagedown,mod+alt+pagedown", "ctrl+pagedown,ctrl+alt+pagedown,alt+arrowright"),
	entry("previousSheet", "mod+pageup,mod+alt+pageup", "ctrl+pageup,ctrl+alt+pageup,alt+arrowleft"),
	// Formatting.
	entry("bold", "mod+b,mod+2", "mod+b"),
	entry("italic", "mod+i,mod+3", "mod+i"),
	entry("underline", "mod+u,mod+4", "mod+u"),
	entry("strikethrough", "mod+5", "mod+shift+x"),
	// Excel's Increase and Decrease Font Size (Ctrl+Shift+> and Ctrl+Shift+<).
	entry("fontGrow", "mod+shift+period"),
	entry("fontShrink", "mod+shift+comma"),
	entry("formatGeneral", "mod+shift+backquote", "ctrl+shift+backquote"),
	entry("formatCurrency", "mod+shift+4", "ctrl+shift+4"),
	entry("formatPercent", "mod+shift+5", "ctrl+shift+5"),
	entry("formatScientific", "mod+shift+6", "ctrl+shift+6"),
	entry("formatDate", "mod+shift+3", "ctrl+shift+3"),
	entry("formatTime", "mod+shift+2", "ctrl+shift+2"),
	entry("formatNumber", "mod+shift+1", "ctrl+shift+1"),
	entry("formatCells", "mod+1"),
	entry("borderOutline", "mod+shift+7", "mod+alt+0"),
	entry("borderNone", "mod+shift+minus", "mod+alt+minus"),
	entry("wrap", ""),
	entry("alignLeft", ""),
	entry("alignCenter", ""),
	entry("alignRight", ""),
	entry("indentDecrease", ""),
	entry("indentIncrease", ""),
	entry("decimalsIncrease", ""),
	entry("decimalsDecrease", ""),
	entry("mergeCenter", ""),
	entry("unmerge", ""),
	// Rows and columns.
	entry("hideRows", "mod+9", "ctrl+9"),
	entry("hideColumns", "mod+0", "ctrl+0"),
	entry("unhideRows", "mod+shift+9", "ctrl+shift+9"),
	entry("unhideColumns", "mod+shift+0", "ctrl+shift+0"),
	entry("autofitRows", ""),
	entry("autofitColumns", ""),
	// The sheet's floating objects: the first in view, then Tab cycles them ("Keyboard shortcuts in Excel": Ctrl+Alt+5,
	// then Tab). Excel for Mac documents none; Control+Option+5 types nothing.
	entry("selectObject", "mod+alt+5", "ctrl+alt+5"),
	// The panes beside the sheet (F6: "switches between the worksheet, ribbon, task pane"; Shift+F6 the other way) and
	// the context menu at the active cell (Shift+F10), on Windows and the Mac alike.
	entry("nextPane", "f6"),
	entry("previousPane", "shift+f6"),
	entry("contextMenu", "shift+f10"),
	// Finding. Shift+F3, Shift+F4 and Ctrl+Shift+F4 are Excel for the web's.
	entry("find", "mod+f,shift+f5,shift+f3", "mod+f,ctrl+f,shift+f5,shift+f3"),
	entry("findNext", "shift+f4"),
	entry("findPrevious", "mod+shift+f4"),
	// Command+H hides the app on a Mac.
	entry("replace", "mod+h", "ctrl+h,mod+shift+h"),
	// "Ctrl+G: Displays the Go To dialog box. F5 also displays this dialog box"; Control+G on a Mac, whose Command+G
	// stays the browser's Find Next. Plain F5 only: Shift+F5 is Find, Ctrl+F5 the browser's.
	entry("goTo", "mod+g,f5", "ctrl+g,f5"),
	// The file.
	entry("save", "mod+s"),
	entry("saveAs", "mod+shift+s"),
	entry("print", "mod+p"),
	entry("exportCsv", ""),
	entry("exportPdf", ""),
	// The view: the app's zoom over the sheet's, Mod+Alt with the zoom keys; Control+Option on a Mac, whose
	// Command+Option+0 and Command+Option+Minus are the borders'.
	entry("zoomIn", "mod+alt+equal", "ctrl+alt+equal"),
	entry("zoomOut", "mod+alt+minus", "ctrl+alt+minus"),
	entry("zoomReset", "mod+alt+0", "ctrl+alt+0"),
	entry("freezePanes", ""),
	// Data.
	entry("filter", "mod+shift+l", "mod+shift+f"),
	entry("reapplyFilter", "mod+alt+l"),
	entry("clearFilters", ""),
	entry("sortAscending", ""),
	entry("sortDescending", ""),
	entry("dataValidation", ""),
	// Opens the selected drop-down: an autofilter's menu, a validation list (Option+Down on a Mac).
	entry("openDropdown", "alt+arrowdown"),
	// Inserting and reviewing.
	entry("hyperlink", "mod+k"),
	entry("note", "shift+f2"),
	entry("toggleNote", ""),
	entry("deleteNote", ""),
	// Excel's New Threaded Comment.
	entry("newComment", "mod+alt+m"),
	// Excel's chart of the selection on the sheet.
	entry("insertChart", "alt+f1"),
	entry("insertPicture", ""),
	entry("altText", ""),
	// "AutoSum formula: Alt+Equal sign". On a Mac "Insert the AutoSum formula: Command+Shift+T", which browsers keep
	// for reopening a tab: Option+= (the Windows keys) first.
	entry("autoSum", "alt+equal", "alt+equal,mod+shift+t"),
	// The workbook's sheets.
	entry("newSheet", "shift+f11"),
	entry("renameSheet", ""),
	entry("deleteSheet", ""),
	entry("protectSheet", "")
]

// A keydown as the shortcuts read it.
export type ShortcutKey = ChordEvent

// The actions bound to each key token, in table order, with their chords.
type Lookup = ReadonlyMap<string, readonly (readonly [SheetShortcut, Chord])[]>

function buildLookup(mac: boolean, bindings: SheetKeyBindings | undefined): Lookup {
	const byKey = new Map<string, (readonly [SheetShortcut, Chord])[]>()

	for (const { action, windows, mac: onMac } of SHEET_SHORTCUTS) {
		for (const chord of parseCombo(bindings?.[action] ?? (mac ? onMac : windows))) {
			const list = byKey.get(chord.key)

			if (list === undefined) byKey.set(chord.key, [[action, chord]])
			else list.push([action, chord])
		}
	}

	return byKey
}

// One lookup per platform for the table's own keys, and per bindings object for a user's: a keydown allocates nothing.
const defaultLookups = new Map<boolean, Lookup>()
const boundLookups = new WeakMap<SheetKeyBindings, Map<boolean, Lookup>>()

function lookup(mac: boolean, bindings: SheetKeyBindings | undefined): Lookup {
	let cache = defaultLookups

	if (bindings !== undefined) {
		const bound = boundLookups.get(bindings)

		if (bound === undefined) {
			cache = new Map()
			boundLookups.set(bindings, cache)
		} else cache = bound
	}

	let found = cache.get(mac)

	if (found === undefined) {
		found = buildLookup(mac, bindings)
		cache.set(mac, found)
	}

	return found
}

// The shortcut a key press is, or null: the first in the table whose keys it is.
export function shortcutOf(event: ShortcutKey, mac: boolean, bindings?: SheetKeyBindings): SheetShortcut | null {
	const candidates = lookup(mac, bindings).get(tokenOfCode(event.code))

	if (candidates === undefined) return null

	for (const [action, chord] of candidates) if (matchesChord(event, chord, mac)) return action

	return null
}

// Whether the page runs on a Mac (Command is the primary modifier): the app keymap's own test, so the grid and the app
// agree on which key is Mod.
export { isMacPlatform } from "@filen/shared/keymap"

// The number formats Excel's shortcuts apply ("Keyboard shortcuts in Excel", Format cells), as en-US has them: General,
// Currency with two decimals and negatives in parentheses, Percentage without decimals, Scientific with two decimals,
// the date with day, month and year, the time with hour, minute and AM or PM, and Number with two decimals, a
// thousands separator and a minus sign for negatives. An app hands the grid its locale's currency, date and time
// (SheetGrid's numberFormats), as Excel follows the system's.
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

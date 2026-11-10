import { formatChord, matchesChord, normalizeCombo, parseCombo, tokenOfCode, type Chord, type ChordEvent } from "@filen/shared/keymap"
import {
	DOCX_EDITOR_COMMANDS,
	DOCX_PARAGRAPH_STYLE_MENU,
	browserReservedShortcut,
	shortcutFor,
	type DocxEditorCommand,
	type DocxEditorCommandType,
	type DocxShortcutEntry
} from "./commands"
import { DATE_FIELD_CODE, TIME_FIELD_CODE } from "./commands/fields"

// The editor's keyboard shortcuts a host may rebind, Word's keys their defaults, and the matcher the input views run
// on each key press. Data and matching only, no engine: a host's keymap imports it to list the keys and their defaults.

// The parts of a key event shortcuts look at. Keys are @filen/shared/keymap's: matched by physical key, so a binding
// fires on the same key in the editor as everywhere else in the app, whatever the layout, and a character typed
// with AltGr is text.
export type KeyLike = ChordEvent

// What a Word key does besides running an editor command: the app's find, its replace row, Word's Go To, Word's
// Repeat.
export type DocxAppKey = "find" | "replace" | "goTo" | "repeat"

export type DocxKeyRun =
	| { readonly kind: "command"; readonly command: DocxEditorCommand }
	// A command the host runs (DocxCommandInfo.hostShortcut): it asks for the input or the author first.
	| { readonly kind: "host"; readonly type: DocxEditorCommandType }
	| { readonly kind: "app"; readonly key: DocxAppKey }

// One Word key a host may rebind: its id, what it runs, and Word's own key as the default.
export interface DocxKey extends DocxShortcutEntry {
	readonly id: string
	readonly run: DocxKeyRun
	// Further keys on every platform (Word's Mod+Shift+Z redo).
	readonly alsoShortcuts?: readonly string[]
	// Only in the desktop app, where the browser does not own the key (Ctrl/Cmd+digit switches tabs, Mod+T opens one).
	readonly desktop?: boolean
	// In a browser, in place of Word's key where the browser keeps that (browserReservedShortcut).
	readonly browserShortcut?: string
}

// A host's combos by key id (@filen/shared/keymap syntax, alternatives comma-separated); an id it leaves out, or binds
// to "", is unbound.
export type DocxKeyBindings = Readonly<Partial<Record<string, string>>>

function app(key: DocxAppKey): DocxKeyRun {
	return { kind: "app", key }
}

function command(command: DocxEditorCommand): DocxKeyRun {
	return { kind: "command", command }
}

const APP_KEYS: readonly DocxKey[] = [
	// Mod+F; Cmd+G finds too on a Mac.
	{ id: "find", shortcut: "mod+f", appleShortcut: "mod+f,mod+g", run: app("find") },
	// Find and Replace: Ctrl+H; on a Mac Control+H or Cmd+Shift+H (Cmd+H hides the app).
	{ id: "replace", shortcut: "mod+h", appleShortcut: "ctrl+h,mod+shift+h", run: app("replace") },
	// Word's Go To: Ctrl+G; Cmd+Option+G on a Mac, where Cmd+G finds.
	{ id: "goTo", shortcut: "mod+g", appleShortcut: "mod+alt+g", run: app("goTo") },
	// Word's Repeat (F4) off Apple platforms; F4 is not Repeat there.
	{ id: "repeat", shortcut: "f4", appleShortcut: "", run: app("repeat") }
]

// Commands without a key of Word's that a user may give one (Review's, the field updates, the Insert dialogs).
const UNBOUND_COMMANDS: ReadonlySet<DocxEditorCommandType> = new Set<DocxEditorCommandType>([
	"review.accept",
	"review.reject",
	"review.acceptAll",
	"review.rejectAll",
	"review.next",
	"review.prev",
	"comment.next",
	"comment.prev",
	"field.updateAll",
	"toc.update",
	"table.insert",
	"insert.symbol",
	"page.setup"
])

// Word's Copy and Paste Formatting (Ctrl+Shift+C and V) are a browser's inspector and plain paste: the desktop app's.
const DESKTOP_COMMANDS: ReadonlySet<DocxEditorCommandType> = new Set<DocxEditorCommandType>(["format.copy", "format.paste"])

// In a browser, where Word for Mac's Cmd+8 selects a tab: Word's Ctrl+Shift+8.
const BROWSER_SHORTCUTS: ReadonlyMap<string, string> = new Map([["view.formattingMarks", "mod+shift+8"]])

const COMMAND_KEYS: readonly DocxKey[] = DOCX_EDITOR_COMMANDS.filter(
	info => info.type !== "style.set" && (info.shortcut !== undefined || UNBOUND_COMMANDS.has(info.type))
).map(info => {
	const browserShortcut = BROWSER_SHORTCUTS.get(info.type)
	const run: DocxKeyRun =
		info.hostShortcut === true ? { kind: "host", type: info.type } : command({ type: info.type } as DocxEditorCommand)

	return {
		id: info.type,
		shortcut: info.shortcut ?? "",
		...(info.appleShortcut === undefined ? {} : { appleShortcut: info.appleShortcut }),
		...(info.alsoShortcuts === undefined ? {} : { alsoShortcuts: info.alsoShortcuts }),
		...(DESKTOP_COMMANDS.has(info.type) ? { desktop: true } : {}),
		...(browserShortcut === undefined ? {} : { browserShortcut }),
		run
	}
})

// Word's keys for commands with arguments.
const ARGUMENT_KEYS: readonly DocxKey[] = [
	{
		id: "paragraph.lineSpacing1",
		shortcut: "mod+1",
		desktop: true,
		run: command({ type: "paragraph.lineSpacing", rule: "auto", value: 240 })
	},
	{
		id: "paragraph.lineSpacing2",
		shortcut: "mod+2",
		desktop: true,
		run: command({ type: "paragraph.lineSpacing", rule: "auto", value: 480 })
	},
	{
		id: "paragraph.lineSpacing15",
		shortcut: "mod+5",
		desktop: true,
		run: command({ type: "paragraph.lineSpacing", rule: "auto", value: 360 })
	},
	// Hanging Indent and Unhang, Word for Mac's too (Mod+T opens a browser tab).
	{ id: "paragraph.hangingIndent", shortcut: "mod+t", desktop: true, run: command({ type: "paragraph.hangingIndent", direction: 1 }) },
	{ id: "paragraph.unhang", shortcut: "mod+shift+t", desktop: true, run: command({ type: "paragraph.hangingIndent", direction: -1 }) },
	// DATE and TIME fields: Alt+Shift+D and T, Word for Mac's Control+Shift+D and T (Option+Shift types a character).
	{
		id: "insert.dateField",
		shortcut: "alt+shift+d",
		appleShortcut: "ctrl+shift+d",
		run: command({ type: "insert.field", instruction: DATE_FIELD_CODE })
	},
	{
		id: "insert.timeField",
		shortcut: "alt+shift+t",
		appleShortcut: "ctrl+shift+t",
		run: command({ type: "insert.field", instruction: TIME_FIELD_CODE })
	},
	// Without a key of Word's: a section break starting on the next page, Layout's commonest.
	{ id: "insert.sectionBreak", shortcut: "", run: command({ type: "insert.sectionBreak", kind: "nextPage" }) }
]

// Normal is Word's Ctrl+Shift+N, a browser's new window: Ctrl+Alt+0 there, beside the headings' Ctrl+Alt+1 to 3.
const STYLE_KEYS: readonly DocxKey[] = DOCX_PARAGRAPH_STYLE_MENU.flatMap(entry =>
	entry.shortcut === undefined
		? []
		: [
				{
					id: `style.${entry.style}`,
					shortcut: entry.shortcut,
					...(entry.style === "normal" ? { browserShortcut: "mod+alt+0" } : {}),
					run: command({ type: "style.set", style: entry.style })
				}
			]
)

// Every rebindable key, in the order a key bound twice resolves (the first wins).
export const DOCX_KEYS: readonly DocxKey[] = [...APP_KEYS, ...COMMAND_KEYS, ...ARGUMENT_KEYS, ...STYLE_KEYS]

// A key's default on a platform, in the canonical token spelling: Word's (Word for Mac's on Apple platforms), and in a
// browser (`desktop` false) without the chords the browser keeps, `browserShortcut` in their place.
export function docxKeyDefault(key: DocxKey, apple: boolean, desktop: boolean): string {
	const word = [shortcutFor(key, apple) ?? "", ...(key.alsoShortcuts ?? [])].filter(combo => combo !== "").join(",")

	if (desktop) return normalizeCombo(word)
	if (key.desktop === true) return normalizeCombo(key.browserShortcut ?? "")

	const chords = parseCombo(word)
	const kept = chords.filter(chord => !browserReservedShortcut(formatChord(chord), apple)).map(formatChord)

	if (kept.length < chords.length && key.browserShortcut !== undefined) kept.push(key.browserShortcut)

	return normalizeCombo(kept.join(","))
}

const defaults = new Map<string, DocxKeyBindings>()

// Every key's default on a platform, for a host that keeps no keymap of its own.
export function docxKeyBindings(apple: boolean, desktop: boolean): DocxKeyBindings {
	const id = `${String(apple)}:${String(desktop)}`
	let bindings = defaults.get(id)

	if (bindings === undefined) {
		bindings = Object.fromEntries(DOCX_KEYS.map(key => [key.id, docxKeyDefault(key, apple, desktop)]))
		defaults.set(id, bindings)
	}

	return bindings
}

type IndexedChords = ReadonlyMap<string, readonly (readonly [Chord, DocxKeyRun])[]>

// The bindings' chords by key token, parsed once per bindings object: a keystroke compares its own key's only.
const indexed = new WeakMap<DocxKeyBindings, IndexedChords>()

function chordsOf(bindings: DocxKeyBindings): IndexedChords {
	const known = indexed.get(bindings)

	if (known !== undefined) return known

	const out = new Map<string, (readonly [Chord, DocxKeyRun])[]>()

	for (const key of DOCX_KEYS) {
		for (const chord of parseCombo(bindings[key.id] ?? "")) {
			const list = out.get(chord.key)

			if (list === undefined) out.set(chord.key, [[chord, key.run]])
			else list.push([chord, key.run])
		}
	}

	indexed.set(bindings, out)

	return out
}

// What `event` runs under `bindings`, if anything.
export function docxKeyFor(event: KeyLike, bindings: DocxKeyBindings, apple: boolean): DocxKeyRun | undefined {
	const candidates = chordsOf(bindings).get(tokenOfCode(event.code))

	if (candidates === undefined) return undefined

	for (const [chord, run] of candidates) if (matchesChord(event, chord, apple)) return run

	return undefined
}

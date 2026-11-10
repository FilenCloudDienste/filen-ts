// What every command file shares (the metadata shape and the checks bridge input goes through), and the
// base commands. Command files hold types, metadata and parsers only: an app imports them without the
// engine.

// Which object runs a command: the story being edited, or the paged editor (comments, review, notes,
// fields, sections, images, the undo order across stories).
export type DocxCommandScope = "story" | "document"

// The picker an app shows before sending a command with arguments.
export type DocxCommandInput =
	| "font"
	| "size"
	| "color"
	| "highlight"
	| "link"
	| "tableSize"
	| "text"
	| "choice"
	| "date"
	| "image"
	| "equation"
	| "pageSetup"
	| "sectionBreak"

// Where contextual menus offer a command.
export type DocxCommandContext = "table" | "drawing" | "control" | "comment" | "revision" | "header" | "note"

export type DocxEditorCommandGroup =
	| "format"
	| "style"
	| "align"
	| "list"
	| "history"
	| "font"
	| "color"
	| "paragraph"
	| "painter"
	| "insert"
	| "link"
	| "comment"
	| "review"
	| "table"
	| "section"
	| "header"
	| "note"
	| "field"
	| "control"
	| "drawing"
	| "equation"
	| "view"

export interface DocxCommandInfo<T extends string = string> {
	readonly type: T
	// A stable id an app maps to its own translation.
	readonly labelKey: string
	// A neutral icon id an app maps to its own icon set; absent for commands without one.
	readonly icon?: string
	// Word's platform-neutral shortcut, the default of the command's key (DOCX_KEYS; "mod" = Cmd on Apple platforms,
	// Ctrl elsewhere; "ctrl" = Control on every platform; keys are @filen/shared/keymap's physical key tokens); only on
	// commands without arguments unless `hostShortcut`. Read through shortcutFor.
	readonly shortcut?: string
	// The shortcut on Apple platforms where Word for Mac's differs from `shortcut`.
	readonly appleShortcut?: string
	// The host runs the command's key (it gives the arguments, asks for the author or the input first): docxKeyFor
	// reports it as the host's.
	readonly hostShortcut?: true
	// Further keys that run the command on every platform; never shown.
	readonly alsoShortcuts?: readonly string[]
	readonly group: DocxEditorCommandGroup
	// Changes the document (refused in read-only mode).
	readonly write: boolean
	readonly scope: DocxCommandScope
	// Records an author: the app has the user's author name before sending it (never filled in for them).
	readonly author?: true
	// Runs asynchronously: the editor's execute returns a promise.
	readonly async?: true
	readonly input?: DocxCommandInput
	readonly context?: DocxCommandContext
}

// Parses the arguments of one command type from untrusted input; undefined when they do not hold.
export type DocxCommandParser<C extends { readonly type: string }> = (type: C["type"], value: object) => C | undefined

// ---- argument checks --------------------------------------------------------------------------------------

export function field(value: object, key: string): unknown {
	return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined
}

export function stringArg(value: object, key: string, max: number, min = 0): string | undefined {
	const out = field(value, key)

	return typeof out === "string" && out.length >= min && out.length <= max ? out : undefined
}

export function intArg(value: object, key: string, min: number, max: number): number | undefined {
	const out = field(value, key)

	return typeof out === "number" && Number.isInteger(out) && out >= min && out <= max ? out : undefined
}

export function boolArg(value: object, key: string): boolean | undefined {
	const out = field(value, key)

	return typeof out === "boolean" ? out : undefined
}

export function choiceArg<T extends string>(value: object, key: string, choices: ReadonlySet<string>): T | undefined {
	const out = field(value, key)

	return typeof out === "string" && choices.has(out) ? (out as T) : undefined
}

// An optional argument: absent is fine, present must parse. `ok` false when present and invalid.
export function optional<T>(value: object, key: string, parse: (value: object, key: string) => T | undefined): { ok: boolean; value?: T } {
	if (field(value, key) === undefined) return { ok: true }

	const out = parse(value, key)

	return out === undefined ? { ok: false } : { ok: true, value: out }
}

const HEX_COLOR = /^[0-9A-Fa-f]{6}$/

// "RRGGBB" (no #).
export function hexArg(value: object, key: string): string | undefined {
	const out = field(value, key)

	return typeof out === "string" && HEX_COLOR.test(out) ? out.toUpperCase() : undefined
}

// A w:id (ST_DecimalNumber) as written.
export function idArg(value: object, key: string): string | undefined {
	const out = field(value, key)

	return typeof out === "string" && /^-?\d{1,10}$/.test(out) ? out : undefined
}

// Whether text holds C0 controls or DEL (never in a URL, a name or an id), or what XML cannot carry at all
// (U+FFFE, U+FFFF, lone surrogates).
export function hasControl(text: string): boolean {
	for (let k = 0; k < text.length; k++) {
		const code = text.charCodeAt(k)

		if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(k + 1) & 0xfc00) === 0xdc00) k++
		else if (code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) return true
	}

	return false
}

// Commands whose strings are written as they are (attribute values, field codes, marks), not cleaned as typed
// text is.
const VERBATIM_TEXT: ReadonlySet<string> = new Set([
	"link.set",
	"insert.field",
	"insert.date",
	"note.insertFootnote",
	"note.insertEndnote",
	"control.text",
	"control.items",
	"drawing.altText",
	"image.insert"
])

function carriesXmlText(value: unknown, depth: number): boolean {
	if (typeof value === "string") {
		for (let k = 0; k < value.length; k++) {
			const code = value.charCodeAt(k)

			if (code >= 0xd800 && code <= 0xdbff && (value.charCodeAt(k + 1) & 0xfc00) === 0xdc00) k++
			else if (
				(code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
				(code >= 0xd800 && code <= 0xdfff) ||
				code === 0xfffe ||
				code === 0xffff
			)
				return false
		}

		return true
	}

	if (typeof value !== "object" || value === null || depth > 4) return true

	for (const item of Array.isArray(value) ? value : Object.values(value)) if (!carriesXmlText(item, depth + 1)) return false

	return true
}

// Whether a command would write text XML cannot hold (tab and line ends aside): refused at the command, as a
// bridge message is, rather than by every save after it.
export function writesUnholdableText(command: { readonly type: string }): boolean {
	return VERBATIM_TEXT.has(command.type) && !carriesXmlText(command, 0)
}

// Twips, as far as Word's own limits go (22 inches).
export const MAX_TWIPS = 31680

// ---- shortcuts --------------------------------------------------------------------------------------------

export interface DocxShortcutEntry {
	readonly shortcut?: string
	readonly appleShortcut?: string
}

// The shortcut an entry runs with (and shows) on the platform.
export function shortcutFor(entry: DocxShortcutEntry, apple: boolean): string | undefined {
	return apple ? (entry.appleShortcut ?? entry.shortcut) : entry.shortcut
}

// Keys a browser keeps for itself (Chromium never delivers them to a page; on macOS the app menu takes the
// rest), as canonical chords: a key's default in a browser leaves them out (docxKeyDefault), a desktop shell
// delivers them.
const BROWSER_RESERVED: ReadonlySet<string> = new Set(["mod+n", "mod+shift+n", "mod+t", "mod+shift+t", "mod+w", "mod+shift+w"])
// Cmd+digit selects a browser tab (the Window menu's).
const APPLE_BROWSER_RESERVED: ReadonlySet<string> = new Set(["mod+q", "mod+h", "mod+m", "mod+8"])

export function browserReservedShortcut(shortcut: string, apple: boolean): boolean {
	const combo = shortcut.toLowerCase()

	return BROWSER_RESERVED.has(combo) || (apple && APPLE_BROWSER_RESERVED.has(combo))
}

// ---- base commands ---------------------------------------------------------------------------------------

export const DOCX_PARAGRAPH_STYLES = [
	"normal",
	"title",
	"subtitle",
	"heading1",
	"heading2",
	"heading3",
	"heading4",
	"heading5",
	"heading6",
	"heading7",
	"heading8",
	"heading9",
	"quote"
] as const

export type DocxParagraphStyle = (typeof DOCX_PARAGRAPH_STYLES)[number]

// The built-in name each style has in every document, whatever the UI language (style ids are localised).
export const PARAGRAPH_STYLE_NAMES: Readonly<Record<DocxParagraphStyle, string>> = {
	normal: "normal",
	title: "title",
	subtitle: "subtitle",
	heading1: "heading 1",
	heading2: "heading 2",
	heading3: "heading 3",
	heading4: "heading 4",
	heading5: "heading 5",
	heading6: "heading 6",
	heading7: "heading 7",
	heading8: "heading 8",
	heading9: "heading 9",
	quote: "quote"
}

export type DocxAlignment = "start" | "center" | "end" | "justify"

export type BaseCommand =
	| { readonly type: "format.bold" }
	| { readonly type: "format.italic" }
	| { readonly type: "format.underline" }
	| { readonly type: "format.strike" }
	| { readonly type: "format.clear" }
	| { readonly type: "style.set"; readonly style: DocxParagraphStyle }
	| { readonly type: "align.start" }
	| { readonly type: "align.center" }
	| { readonly type: "align.end" }
	| { readonly type: "align.justify" }
	| { readonly type: "list.bullet" }
	| { readonly type: "list.numbered" }
	| { readonly type: "list.indent" }
	| { readonly type: "list.outdent" }
	| { readonly type: "history.undo" }
	| { readonly type: "history.redo" }

const story = { write: true, scope: "story" } as const

export const BASE_COMMANDS: readonly DocxCommandInfo<BaseCommand["type"]>[] = [
	{ type: "format.bold", labelKey: "docx.format.bold", icon: "bold", shortcut: "mod+b", group: "format", ...story },
	{ type: "format.italic", labelKey: "docx.format.italic", icon: "italic", shortcut: "mod+i", group: "format", ...story },
	{ type: "format.underline", labelKey: "docx.format.underline", icon: "underline", shortcut: "mod+u", group: "format", ...story },
	// Not Word's (it has none): Google Docs' and the Markdown editors'.
	{
		type: "format.strike",
		labelKey: "docx.format.strike",
		icon: "strikethrough",
		shortcut: "mod+shift+x",
		group: "format",
		...story
	},
	// Ctrl+Space; on a Mac, where Cmd+Space is Spotlight's and Control+Space (Word for Mac's) switches the input
	// source, Cmd+Shift+Space, as the presentation editor's.
	{
		type: "format.clear",
		labelKey: "docx.format.clear",
		icon: "clear-formatting",
		shortcut: "mod+space",
		appleShortcut: "mod+shift+space",
		group: "format",
		...story
	},
	{ type: "style.set", labelKey: "docx.style.set", icon: "paragraph-style", group: "style", ...story },
	{ type: "align.start", labelKey: "docx.align.start", icon: "align-start", shortcut: "mod+l", group: "align", ...story },
	{ type: "align.center", labelKey: "docx.align.center", icon: "align-center", shortcut: "mod+e", group: "align", ...story },
	{ type: "align.end", labelKey: "docx.align.end", icon: "align-end", shortcut: "mod+r", group: "align", ...story },
	{ type: "align.justify", labelKey: "docx.align.justify", icon: "align-justify", shortcut: "mod+j", group: "align", ...story },
	// Word's List Bullet key (Mod+Shift+8 is its Show/Hide ¶).
	{ type: "list.bullet", labelKey: "docx.list.bullet", icon: "list-bullet", shortcut: "mod+shift+l", group: "list", ...story },
	// Not Word's (it has no numbered-list key): a free key kept for a numbered list.
	{ type: "list.numbered", labelKey: "docx.list.numbered", icon: "list-numbered", shortcut: "mod+shift+7", group: "list", ...story },
	// Word's indent keys; on a Mac Control+Shift+M indents (Cmd+M minimises the window).
	{
		type: "list.indent",
		labelKey: "docx.list.indent",
		icon: "indent",
		shortcut: "mod+m",
		appleShortcut: "ctrl+shift+m",
		group: "list",
		...story
	},
	{ type: "list.outdent", labelKey: "docx.list.outdent", icon: "outdent", shortcut: "mod+shift+m", group: "list", ...story },
	// One undo order across every story the editor edits (a session alone undoes its own edits).
	{
		type: "history.undo",
		labelKey: "docx.history.undo",
		icon: "undo",
		shortcut: "mod+z",
		group: "history",
		write: true,
		scope: "document"
	},
	{
		type: "history.redo",
		labelKey: "docx.history.redo",
		icon: "redo",
		// Word's Mod+Y; Mod+Shift+Z, the platform's redo, too.
		shortcut: "mod+y",
		alsoShortcuts: ["mod+shift+z"],
		group: "history",
		write: true,
		scope: "document"
	}
]

export interface DocxParagraphStyleInfo {
	readonly style: DocxParagraphStyle
	readonly labelKey: string
	readonly shortcut?: string
}

// The paragraph styles `style.set` offers, in menu order.
export const DOCX_PARAGRAPH_STYLE_MENU: readonly DocxParagraphStyleInfo[] = DOCX_PARAGRAPH_STYLES.map(style => {
	const level = /^heading([1-3])$/.exec(style)?.[1]

	return {
		style,
		labelKey: `docx.style.${style}`,
		...(level !== undefined ? { shortcut: `mod+alt+${level}` } : style === "normal" ? { shortcut: "mod+shift+n" } : {})
	}
})

const STYLES = new Set<string>(DOCX_PARAGRAPH_STYLES)

export const parseBaseCommand: DocxCommandParser<BaseCommand> = (type, value) => {
	if (type === "style.set") {
		const style = choiceArg<DocxParagraphStyle>(value, "style", STYLES)

		return style === undefined ? undefined : { type, style }
	}

	return { type } as BaseCommand
}

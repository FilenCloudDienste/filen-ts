import { choiceArg, field, hasControl, intArg, optional, stringArg, type DocxCommandInfo, type DocxCommandParser } from "./base"

// Footnotes and endnotes.

export type DocxNoteKind = "footnote" | "endnote"
// ST_NumberFormat values Word's Footnote and Endnote dialog offers.
export const DOCX_NOTE_NUMBER_FORMATS = [
	"decimal",
	"upperRoman",
	"lowerRoman",
	"upperLetter",
	"lowerLetter",
	"chicago",
	"decimalEnclosedCircle"
] as const

export type DocxNoteNumberFormat = (typeof DOCX_NOTE_NUMBER_FORMATS)[number]
// ST_RestartNumber; "eachPage" for footnotes only.
export type DocxNoteRestart = "continuous" | "eachSect" | "eachPage"
// ST_FtnPos for footnotes, ST_EdnPos for endnotes.
export type DocxNotePosition = "pageBottom" | "beneathText" | "sectEnd" | "docEnd"

// Word's custom marks: a few characters shown instead of the number.
export const MAX_NOTE_MARK = 10

// What Word's Footnote and Endnote dialog sets, for the caret's section or every section. Fields left out
// stay as they are.
export interface DocxNoteOptions {
	readonly kind: DocxNoteKind
	readonly format?: DocxNoteNumberFormat
	readonly start?: number
	readonly restart?: DocxNoteRestart
	readonly position?: DocxNotePosition
	readonly scope: "section" | "document"
}

export type NoteCommand =
	// A new note at the caret, numbered or (`mark`) with Word's custom mark.
	| { readonly type: "note.insertFootnote"; readonly mark?: string }
	| { readonly type: "note.insertEndnote"; readonly mark?: string }
	// Between a note reference and its note.
	| { readonly type: "note.goto" }
	// The note at the caret (its reference, or the note being edited) with its reference.
	| { readonly type: "note.delete" }
	// The note at the caret becomes one of the other kind.
	| { readonly type: "note.convert" }
	// Every note of the other kind becomes one of kind `to`.
	| { readonly type: "note.convertAll"; readonly to: DocxNoteKind }
	| ({ readonly type: "note.options" } & DocxNoteOptions)

const document = { scope: "document", group: "note", context: "note" } as const

export const NOTE_COMMANDS: readonly DocxCommandInfo<NoteCommand["type"]>[] = [
	// Word's Ctrl+Alt+F and Ctrl+Alt+D (Cmd+Option+F and D on a Mac).
	{
		type: "note.insertFootnote",
		labelKey: "docx.note.insertFootnote",
		icon: "footnote",
		shortcut: "mod+alt+f",
		write: true,
		...document
	},
	{
		type: "note.insertEndnote",
		labelKey: "docx.note.insertEndnote",
		icon: "endnote",
		shortcut: "mod+alt+d",
		write: true,
		...document
	},
	{ type: "note.goto", labelKey: "docx.note.goto", icon: "note-goto", write: false, ...document },
	{ type: "note.delete", labelKey: "docx.note.delete", icon: "note-delete", write: true, ...document },
	{ type: "note.convert", labelKey: "docx.note.convert", icon: "note-convert", write: true, ...document },
	{ type: "note.convertAll", labelKey: "docx.note.convertAll", icon: "note-convert", write: true, input: "choice", ...document },
	{ type: "note.options", labelKey: "docx.note.options", icon: "note-options", write: true, input: "choice", ...document }
]

const KINDS = new Set<string>(["footnote", "endnote"])
const FORMATS = new Set<string>(DOCX_NOTE_NUMBER_FORMATS)
const RESTARTS = new Set<string>(["continuous", "eachSect", "eachPage"])
const POSITIONS: Readonly<Record<DocxNoteKind, ReadonlySet<string>>> = {
	footnote: new Set(["pageBottom", "beneathText"]),
	endnote: new Set(["sectEnd", "docEnd"])
}
const SCOPES = new Set<string>(["section", "document"])

function customMark(value: object): { ok: boolean; value?: string } {
	if (field(value, "mark") === undefined) return { ok: true }

	const text = stringArg(value, "mark", MAX_NOTE_MARK, 1)

	return text === undefined || hasControl(text) || text.trim() === "" ? { ok: false } : { ok: true, value: text }
}

function noteOptions(value: object): DocxNoteOptions | undefined {
	const kind = choiceArg<DocxNoteKind>(value, "kind", KINDS)
	const scope = choiceArg<"section" | "document">(value, "scope", SCOPES)

	if (kind === undefined || scope === undefined) return undefined

	const format = optional(value, "format", (holder, key) => choiceArg<DocxNoteNumberFormat>(holder, key, FORMATS))
	const start = optional(value, "start", (holder, key) => intArg(holder, key, 1, 32767))
	const restart = optional(value, "restart", (holder, key) => choiceArg<DocxNoteRestart>(holder, key, RESTARTS))
	const position = optional(value, "position", (holder, key) => choiceArg<DocxNotePosition>(holder, key, POSITIONS[kind]))

	if (!format.ok || !start.ok || !restart.ok || !position.ok) return undefined
	// Endnotes never restart on each page (ST_RestartNumber in w:endnotePr).
	if (kind === "endnote" && restart.value === "eachPage") return undefined
	if (format.value === undefined && start.value === undefined && restart.value === undefined && position.value === undefined)
		return undefined

	return {
		kind,
		scope,
		...(format.value === undefined ? {} : { format: format.value }),
		...(start.value === undefined ? {} : { start: start.value }),
		...(restart.value === undefined ? {} : { restart: restart.value }),
		...(position.value === undefined ? {} : { position: position.value })
	}
}

export const parseNoteCommand: DocxCommandParser<NoteCommand> = (type, value) => {
	switch (type) {
		case "note.insertFootnote":
		case "note.insertEndnote": {
			const mark = customMark(value)

			if (!mark.ok) return undefined

			return mark.value === undefined ? { type } : { type, mark: mark.value }
		}
		case "note.convertAll": {
			const to = choiceArg<DocxNoteKind>(value, "to", KINDS)

			return to === undefined ? undefined : { type, to }
		}
		case "note.options": {
			const options = noteOptions(value)

			return options === undefined ? undefined : { type, ...options }
		}
		default:
			return { type }
	}
}

// The DOCX editor's commands as serialisable data, with their metadata: an app builds its own toolbar,
// menus and shortcuts from the table and the state snapshot, and sends commands back (directly on web,
// over a worker or the WebView bridge on mobile). Untrusted input goes through parseDocxEditorCommand.
// Each feature's commands live in commands/<feature>.ts (types, metadata, parser); this joins them.

import { BASE_COMMANDS, parseBaseCommand, type BaseCommand, type DocxCommandInfo, type DocxCommandParser } from "./commands/base"
import { COMMENT_COMMANDS, parseCommentCommand, type CommentCommand } from "./commands/comments"
import { DRAWING_COMMANDS, parseDrawingCommand, type DrawingCommand } from "./commands/drawings"
import { FIELD_COMMANDS, parseFieldCommand, type FieldCommand } from "./commands/fields"
import { FORM_COMMANDS, parseFormCommand, type FormCommand } from "./commands/forms"
import { FORMATTING_COMMANDS, parseFormattingCommand, type FormattingCommand } from "./commands/formatting"
import { INSERT_COMMANDS, parseInsertCommand, type InsertCommand } from "./commands/insert"
import { MATH_COMMANDS, parseMathCommand, type MathCommand } from "./commands/math"
import { NOTE_COMMANDS, parseNoteCommand, type NoteCommand } from "./commands/notes"
import { REVIEW_COMMANDS, parseReviewCommand, type ReviewCommand } from "./commands/review"
import { SECTION_COMMANDS, parseSectionCommand, type SectionCommand } from "./commands/sections"
import { TABLE_COMMANDS, parseTableCommand, type TableCommand } from "./commands/tables"
import { VIEW_COMMANDS, parseViewCommand, type ViewCommand } from "./commands/view"

export {
	DOCX_PARAGRAPH_STYLES,
	DOCX_PARAGRAPH_STYLE_MENU,
	PARAGRAPH_STYLE_NAMES,
	browserReservedShortcut,
	shortcutFor,
	type BaseCommand,
	type DocxAlignment,
	type DocxCommandContext,
	type DocxCommandInfo,
	type DocxCommandInput,
	type DocxCommandScope,
	type DocxEditorCommandGroup,
	type DocxParagraphStyle,
	type DocxParagraphStyleInfo,
	type DocxShortcutEntry
} from "./commands/base"

export type DocxEditorCommand =
	| BaseCommand
	| FormattingCommand
	| InsertCommand
	| CommentCommand
	| ReviewCommand
	| TableCommand
	| SectionCommand
	| NoteCommand
	| FieldCommand
	| FormCommand
	| DrawingCommand
	| MathCommand
	| ViewCommand

export type DocxEditorCommandType = DocxEditorCommand["type"]

// The command of one type.
export type DocxCommandOf<T extends DocxEditorCommandType> = Extract<DocxEditorCommand, { readonly type: T }>

export type DocxEditorCommandInfo = DocxCommandInfo<DocxEditorCommandType>

// The commands by feature: an app labels and places each feature's commands.
export const DOCX_COMMAND_FEATURES = {
	base: BASE_COMMANDS,
	formatting: FORMATTING_COMMANDS,
	insert: INSERT_COMMANDS,
	comments: COMMENT_COMMANDS,
	review: REVIEW_COMMANDS,
	tables: TABLE_COMMANDS,
	sections: SECTION_COMMANDS,
	notes: NOTE_COMMANDS,
	fields: FIELD_COMMANDS,
	forms: FORM_COMMANDS,
	drawings: DRAWING_COMMANDS,
	math: MATH_COMMANDS,
	view: VIEW_COMMANDS
} as const

export type DocxCommandFeature = keyof typeof DOCX_COMMAND_FEATURES

export const DOCX_EDITOR_COMMANDS: readonly DocxEditorCommandInfo[] = Object.values(DOCX_COMMAND_FEATURES).flat()

const INFOS = new Map<string, DocxEditorCommandInfo>()
const PARSERS = new Map<string, (type: string, value: object) => DocxEditorCommand | undefined>()

function register<C extends DocxEditorCommand>(infos: readonly DocxCommandInfo<C["type"]>[], parse: DocxCommandParser<C>): void {
	for (const info of infos) {
		INFOS.set(info.type, info)
		PARSERS.set(info.type, (type, value) => parse(type as C["type"], value))
	}
}

register(BASE_COMMANDS, parseBaseCommand)
register(FORMATTING_COMMANDS, parseFormattingCommand)
register(INSERT_COMMANDS, parseInsertCommand)
register(COMMENT_COMMANDS, parseCommentCommand)
register(REVIEW_COMMANDS, parseReviewCommand)
register(TABLE_COMMANDS, parseTableCommand)
register(SECTION_COMMANDS, parseSectionCommand)
register(NOTE_COMMANDS, parseNoteCommand)
register(FIELD_COMMANDS, parseFieldCommand)
register(FORM_COMMANDS, parseFormCommand)
register(DRAWING_COMMANDS, parseDrawingCommand)
register(MATH_COMMANDS, parseMathCommand)
register(VIEW_COMMANDS, parseViewCommand)

// Untrusted input (a bridge message) to a command, or undefined.
export function parseDocxEditorCommand(value: unknown): DocxEditorCommand | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined

	const type: unknown = Object.hasOwn(value, "type") ? Reflect.get(value, "type") : undefined
	const parse = typeof type === "string" ? PARSERS.get(type) : undefined

	return parse === undefined || typeof type !== "string" ? undefined : parse(type, value)
}

export function commandInfo(type: DocxEditorCommandType): DocxEditorCommandInfo | undefined {
	return INFOS.get(type)
}

export function isWriteCommand(type: DocxEditorCommandType): boolean {
	return INFOS.get(type)?.write ?? true
}

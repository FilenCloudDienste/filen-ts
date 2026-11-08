import { boolArg, hasControl, intArg, optional, stringArg, type DocxCommandInfo, type DocxCommandParser } from "./base"

// Fields, bookmarks and tables of contents. Updates are explicit, as in Word (Update Field, F9, Update Table):
// they wait for layout (page numbers), so they run asynchronously.

export type FieldCommand =
	| { readonly type: "field.update" }
	| { readonly type: "field.updateAll" }
	// Unlink Fields: the fields of the selection (or the one at the caret) become their results as text.
	| { readonly type: "field.unlink" }
	| { readonly type: "toc.insert"; readonly levels: number; readonly hyperlinks: boolean }
	| { readonly type: "toc.update"; readonly pagesOnly: boolean }
	| { readonly type: "insert.pageNumber" }
	| { readonly type: "insert.pageCount" }
	// A Word date picture ("d MMMM yyyy"): a DATE field, or with `field` false the date as text (Word's Date and
	// Time without Update automatically).
	| { readonly type: "insert.date"; readonly format: string; readonly field?: boolean }
	// A field of FIELD_CATALOGUE by its code (` SEQ Figure \* ARABIC `, ` PAGEREF _Ref1 \h `).
	| { readonly type: "insert.field"; readonly instruction: string }
	| { readonly type: "bookmark.add"; readonly name: string }
	| { readonly type: "bookmark.delete"; readonly name: string }
	| { readonly type: "bookmark.rename"; readonly name: string; readonly to: string }

const document = { write: true, scope: "document", group: "field" } as const

export const FIELD_COMMANDS: readonly DocxCommandInfo<FieldCommand["type"]>[] = [
	{ type: "field.update", labelKey: "docx.field.update", icon: "field-update", shortcut: "F9", async: true, ...document },
	{ type: "field.updateAll", labelKey: "docx.field.updateAll", icon: "field-update-all", async: true, ...document },
	{ type: "field.unlink", labelKey: "docx.field.unlink", icon: "field-unlink", shortcut: "mod+shift+F9", ...document },
	{ type: "toc.insert", labelKey: "docx.toc.insert", icon: "toc", async: true, ...document },
	{ type: "toc.update", labelKey: "docx.toc.update", icon: "toc-update", async: true, ...document },
	// Alt+Shift+P; Word for Mac's Control+Shift+P (Option+Shift types a character there).
	{
		type: "insert.pageNumber",
		labelKey: "docx.insert.pageNumber",
		icon: "page-number",
		shortcut: "alt+shift+p",
		appleShortcut: "ctrl+shift+p",
		...document
	},
	{ type: "insert.pageCount", labelKey: "docx.insert.pageCount", icon: "page-count", ...document },
	{ type: "insert.date", labelKey: "docx.insert.date", icon: "date", input: "date", ...document },
	{ type: "insert.field", labelKey: "docx.insert.field", icon: "field", input: "text", ...document },
	{ type: "bookmark.add", labelKey: "docx.bookmark.add", icon: "bookmark", input: "text", ...document },
	{ type: "bookmark.delete", labelKey: "docx.bookmark.delete", icon: "bookmark-delete", input: "choice", ...document },
	{ type: "bookmark.rename", labelKey: "docx.bookmark.rename", icon: "bookmark-rename", input: "text", ...document }
]

// The codes Word's Alt+Shift+D and Alt+Shift+T insert (Control+Shift+D and T on a Mac).
export const DATE_FIELD_CODE = ' DATE \\@ "M/d/yyyy" '
export const TIME_FIELD_CODE = ' TIME \\@ "h:mm am/pm" '

// The fields insert.field makes (those an update computes), with an example code each for a picker.
export const FIELD_CATALOGUE: readonly { readonly type: string; readonly example: string }[] = [
	{ type: "PAGE", example: " PAGE \\* MERGEFORMAT " },
	{ type: "NUMPAGES", example: " NUMPAGES \\* MERGEFORMAT " },
	{ type: "SECTIONPAGES", example: " SECTIONPAGES \\* MERGEFORMAT " },
	{ type: "SECTION", example: " SECTION " },
	{ type: "DATE", example: DATE_FIELD_CODE },
	{ type: "TIME", example: TIME_FIELD_CODE },
	{ type: "REF", example: " REF _Ref1 \\h " },
	{ type: "PAGEREF", example: " PAGEREF _Ref1 \\h " },
	{ type: "SEQ", example: " SEQ Figure \\* ARABIC " }
]

// Word's bookmark names: a letter, then letters, digits and underscores, 40 at most (hidden ones, starting
// with "_", are Word's own).
const BOOKMARK_NAME = /^\p{L}[\p{L}\p{N}_]{0,39}$/u
// An existing bookmark: Word's hidden ones included.
const ANY_BOOKMARK_NAME = /^[\p{L}_][\p{L}\p{N}_]{0,39}$/u
// A date picture: no quotes or backslashes (it is written inside a quoted switch argument).
const DATE_PICTURE = /^[\p{L}\p{N} .,:/\-']{1,64}$/u
// A field code: printable, at most what Word's field dialog takes.
const INSTRUCTION = /^\P{Cc}{1,255}$/u
const CATALOGUE_TYPES: ReadonlySet<string> = new Set(FIELD_CATALOGUE.map(entry => entry.type))

// The type of a field code (its first word, upper case).
export function fieldCodeType(instruction: string): string {
	return (/^\s*([^\s\\"]+)/.exec(instruction)?.[1] ?? "").toUpperCase()
}

export const parseFieldCommand: DocxCommandParser<FieldCommand> = (type, value) => {
	switch (type) {
		case "toc.insert": {
			const levels = intArg(value, "levels", 1, 9)
			const hyperlinks = boolArg(value, "hyperlinks")

			return levels === undefined || hyperlinks === undefined ? undefined : { type, levels, hyperlinks }
		}
		case "toc.update": {
			const pagesOnly = boolArg(value, "pagesOnly")

			return pagesOnly === undefined ? undefined : { type, pagesOnly }
		}
		case "insert.date": {
			const format = stringArg(value, "format", 64, 1)
			const field = optional(value, "field", boolArg)

			if (format === undefined || !DATE_PICTURE.test(format) || !field.ok) return undefined

			return field.value === undefined ? { type, format } : { type, format, field: field.value }
		}
		case "insert.field": {
			const instruction = stringArg(value, "instruction", 255, 1)

			return instruction === undefined ||
				!INSTRUCTION.test(instruction) ||
				hasControl(instruction) ||
				!CATALOGUE_TYPES.has(fieldCodeType(instruction))
				? undefined
				: { type, instruction }
		}
		case "bookmark.add":
		case "bookmark.delete": {
			const name = stringArg(value, "name", 40, 1)

			return name === undefined || !(type === "bookmark.add" ? BOOKMARK_NAME : ANY_BOOKMARK_NAME).test(name)
				? undefined
				: { type, name }
		}
		case "bookmark.rename": {
			const name = stringArg(value, "name", 40, 1)
			const to = stringArg(value, "to", 40, 1)

			return name === undefined || to === undefined || !ANY_BOOKMARK_NAME.test(name) || !BOOKMARK_NAME.test(to)
				? undefined
				: { type, name, to }
		}
		default:
			return { type }
	}
}

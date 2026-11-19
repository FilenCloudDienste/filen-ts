import { isNameChar, skipQuoted } from "../../sheet/refs/scan"

// Structured references (MS-XLSX §2.2.2 Formulas, structure-reference): Table1[Col], Table1[[#Headers],[A]:[C]],
// Table1[@Col], and inside a table's own formulas [@Col] with no table name. They name a table and its columns, so
// a structure edit changes one only when the table, or a column it names, is deleted: it then becomes #REF!.

export type TableEdit = { readonly deleted: true } | { readonly deleted: false; readonly columns: ReadonlySet<string> }

const QUOTE = 34
const APOSTROPHE = 39
const BRACKET_OPEN = 91
const BRACKET_CLOSE = 93

// Past a bracketed run (nested; "'" escapes the next character), or -1 when it never closes.
function bracketEnd(text: string, start: number): number {
	let depth = 0

	for (let index = start; index < text.length; index++) {
		const code = text.charCodeAt(index)

		if (code === APOSTROPHE) {
			index++

			continue
		}

		if (code === BRACKET_OPEN) depth++

		if (code === BRACKET_CLOSE && --depth === 0) return index + 1
	}

	return -1
}

function unescape(name: string): string {
	return name.replace(/'(.)/g, "$1")
}

// The column names a specifier (the text inside the outer brackets) names; special items (#Data, #This Row) name
// none.
export function specifierColumns(inner: string): string[] {
	const columns: string[] = []
	// A bracketed name keeps its spaces (they are part of it); an unbracketed one's ends are the brackets' spacing.
	const item = (name: string): void => {
		if (name !== "" && !name.startsWith("#")) columns.push(unescape(name))
	}

	if (inner.trimStart().startsWith("@")) {
		const rest = inner.trimStart().slice(1).trim()

		item(rest.startsWith("[") && rest.endsWith("]") ? rest.slice(1, -1) : rest)

		return columns
	}

	if (!inner.trimStart().startsWith("[")) {
		item(inner.trim())

		return columns
	}

	// [[#Headers],[A]:[C]] and [@[A]]: every bracketed part.
	for (let index = 0; index < inner.length; index++) {
		if (inner.charCodeAt(index) === APOSTROPHE) {
			index++

			continue
		}

		if (inner.charCodeAt(index) !== BRACKET_OPEN) continue

		const end = bracketEnd(inner, index)

		if (end < 0) break

		item(inner.slice(index + 1, end - 1))
		index = end - 1
	}

	return columns
}

function broken(table: string, columns: readonly string[], tables: ReadonlyMap<string, TableEdit>): boolean {
	const edit = tables.get(table.toUpperCase())

	if (edit === undefined) return false
	if (edit.deleted) return true

	return columns.some(column => edit.columns.has(column.toUpperCase()))
}

// The formula with every structured reference into a deleted table or column replaced by #REF!. `context`: the
// table whose own formula this is (its references may omit the table's name).
export function rewriteStructured(text: string, context: string | null, tables: ReadonlyMap<string, TableEdit>): string {
	let out = ""
	let pending = 0
	let index = 0

	while (index < text.length) {
		const code = text.charCodeAt(index)

		if (code === QUOTE || code === APOSTROPHE) {
			index = skipQuoted(text, index, code)

			continue
		}

		if (code === 35) {
			// An error literal (#REF!, #N/A): its letters are not a name.
			index++
			while (index < text.length && (isNameChar(text.charCodeAt(index)) || text.charCodeAt(index) === 47)) index++

			continue
		}

		const start = index
		let table: string | null = null

		if (isNameChar(code) && (code < 48 || code > 57)) {
			let end = index

			while (end < text.length && isNameChar(text.charCodeAt(end))) end++

			if (text.charCodeAt(end) !== BRACKET_OPEN) {
				index = end

				continue
			}

			table = text.slice(index, end)
			index = end
		} else if (code === BRACKET_OPEN) {
			table = context
		} else {
			index++

			continue
		}

		const end = bracketEnd(text, index)

		if (end < 0) break

		// [1]Sheet1!A1 is a reference into another workbook, not a table.
		let after = end

		while (after < text.length && isNameChar(text.charCodeAt(after))) after++

		const external = text.charCodeAt(after) === 33

		if (!external && table !== null && broken(table, specifierColumns(text.slice(index + 1, end - 1)), tables)) {
			out += `${text.slice(pending, start)}#REF!`
			pending = end
		}

		index = end
	}

	return pending === 0 ? text : out + text.slice(pending)
}

// The formula with every structured reference to a table in `names` (upper case -> new name) naming the new one.
export function renameTables(text: string, names: ReadonlyMap<string, string>): string {
	let out = ""
	let pending = 0
	let index = 0

	while (index < text.length) {
		const code = text.charCodeAt(index)

		if (code === QUOTE || code === APOSTROPHE) {
			index = skipQuoted(text, index, code)

			continue
		}

		if (!isNameChar(code) || (code >= 48 && code <= 57) || code === 35) {
			index++

			continue
		}

		let end = index

		while (end < text.length && isNameChar(text.charCodeAt(end))) end++

		const renamed = text.charCodeAt(end) === BRACKET_OPEN ? names.get(text.slice(index, end).toUpperCase()) : undefined

		if (renamed !== undefined) {
			out += `${text.slice(pending, index)}${renamed}`
			pending = end
		}

		index = end
	}

	return pending === 0 ? text : out + text.slice(pending)
}

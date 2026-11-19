// The lexical pieces every formula scanner shares (cell formulas, conditional-format formulas, structured
// references): what a word is, past a quoted run, and the shapes of a cell, a column and a row.

// A character of a word: a name, a function's name, a reference or a number.
export function isWordChar(code: number): boolean {
	return (
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		(code >= 48 && code <= 57) ||
		code === 95 || // _
		code === 46 || // .
		code === 36 || // $
		code === 92 || // \
		code === 63 || // ?
		code >= 128
	)
}

// A character of a table's or a column's name: a word's but "$", which ends the name before a structured reference.
export function isNameChar(code: number): boolean {
	return code !== 36 && isWordChar(code)
}

// Past the word starting at `start` (`start` itself when none does).
export function readWord(text: string, start: number): number {
	let end = start

	while (end < text.length && isWordChar(text.charCodeAt(end))) end++

	return end
}

// Past a quoted run ("…" or '…', the quote doubled inside), or the end of the text when it never closes.
export function skipQuoted(text: string, start: number, quote: number): number {
	let index = start + 1

	while (index < text.length) {
		if (text.charCodeAt(index) === quote) {
			if (text.charCodeAt(index + 1) === quote) {
				index += 2

				continue
			}

			return index + 1
		}

		index++
	}

	return text.length
}

export const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/
export const COLUMN = /^(\$?)([A-Za-z]{1,3})$/
export const ROW = /^(\$?)([0-9]{1,7})$/

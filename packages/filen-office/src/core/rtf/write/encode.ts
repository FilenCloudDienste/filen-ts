import { decodeCodepage } from "../codepage"

// Text as RTF writes it (Microsoft RTF Specification 1.9.1, "Unicode RTF"): ASCII as itself with \, { and }
// escaped; every other character as \uN (a signed 16-bit value; characters past U+FFFF as their UTF-16 pair)
// followed by one fallback byte for readers without Unicode: the character in the document's ANSI code page
// as \'hh where that code page has it, else "?". Nothing is lost: a reader that knows \uN skips the fallback.
// The writer puts \uc1 in front of every group whose text uses \uN.

const reverse = new Map<number, Map<number, number>>()

// The single-byte encoding of `codepage`: each character's byte (bytes a double-byte code page uses as lead
// bytes decode to nothing alone and are not in it).
function encoder(codepage: number): Map<number, number> {
	let table = reverse.get(codepage)

	if (table !== undefined) return table

	table = new Map()

	const byte = new Uint8Array(1)

	for (let value = 0x80; value <= 0xff; value++) {
		byte[0] = value

		const text = decodeCodepage(byte, 0, 1, codepage)

		if (text.length === 1 && text !== "�" && !table.has(text.charCodeAt(0))) table.set(text.charCodeAt(0), value)
	}

	reverse.set(codepage, table)

	return table
}

function hex(value: number): string {
	return value.toString(16).padStart(2, "0")
}

export interface EncodedText {
	readonly rtf: string
	// Whether it uses \uN (its group needs \uc1).
	readonly unicode: boolean
}

export function encodeText(text: string, codepage: number): EncodedText {
	let out = ""
	let unicode = false
	let table: Map<number, number> | undefined

	for (let k = 0; k < text.length; k++) {
		const code = text.charCodeAt(k)

		if (code >= 0x20 && code < 0x7f) {
			out += code === 0x5c ? "\\\\" : code === 0x7b ? "\\{" : code === 0x7d ? "\\}" : text[k]

			continue
		}

		if (code === 0x09) {
			out += "\\tab "

			continue
		}

		unicode = true
		table ??= encoder(codepage)

		const fallback = table.get(code)

		out += `\\u${code > 0x7fff ? code - 0x10000 : code}${fallback === undefined ? "?" : `\\'${hex(fallback)}`}`
	}

	return { rtf: out, unicode }
}

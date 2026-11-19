import { XmlError } from "./errors"
import { decodeUtf8 } from "./utf8"

const AMP = 38
const CR = 13
const LF = 10
const TAB = 9
const SEMICOLON = 59

// The XML Char production: a character reference outside it is a well-formedness error.
function isXmlChar(code: number): boolean {
	return (
		code === TAB ||
		code === LF ||
		code === CR ||
		(code >= 0x20 && code <= 0xd7ff) ||
		(code >= 0xe000 && code <= 0xfffd) ||
		(code >= 0x10000 && code <= 0x10ffff)
	)
}

function decodeReference(bytes: Uint8Array, start: number, end: number): string {
	const length = end - start

	if (bytes[start] === 35) {
		const hex = bytes[start + 1] === 120
		let code = 0
		let digits = 0

		for (let i = start + (hex ? 2 : 1); i < end; i++) {
			const b = bytes[i] ?? 0
			let digit: number

			if (b >= 48 && b <= 57) {
				digit = b - 48
			} else if (hex && b >= 97 && b <= 102) {
				digit = b - 87
			} else if (hex && b >= 65 && b <= 70) {
				digit = b - 55
			} else {
				throw new XmlError("invalidReference", "Invalid character reference", start - 1)
			}

			code = code * (hex ? 16 : 10) + digit
			digits++

			if (code > 0x10ffff) {
				throw new XmlError("invalidReference", "Character reference out of range", start - 1)
			}
		}

		if (digits === 0 || !isXmlChar(code)) {
			throw new XmlError("invalidReference", "Invalid character reference", start - 1)
		}

		return String.fromCodePoint(code)
	}

	// No DTD is ever read, so only the five predefined entities exist.
	if (length === 2 && bytes[start + 1] === 116) {
		if (bytes[start] === 108) return "<"
		if (bytes[start] === 103) return ">"
	} else if (length === 3 && bytes[start] === 97 && bytes[start + 1] === 109 && bytes[start + 2] === 112) {
		return "&"
	} else if (length === 4) {
		const a = bytes[start]
		const b = bytes[start + 1]
		const c = bytes[start + 2]
		const d = bytes[start + 3]

		if (a === 113 && b === 117 && c === 111 && d === 116) return '"'
		if (a === 97 && b === 112 && c === 111 && d === 115) return "'"
	}

	throw new XmlError("invalidReference", "Undefined entity reference", start - 1)
}

// Character data with references resolved and line ends normalised (CRLF and CR to LF). Attribute values
// additionally turn literal tabs and line ends into spaces; a reference such as &#10; survives as itself.
export function decodeCharacterData(bytes: Uint8Array, start: number, end: number, attribute: boolean): string {
	let plain = true

	for (let i = start; i < end; i++) {
		const b = bytes[i]

		if (b === AMP || b === CR || (attribute && (b === LF || b === TAB))) {
			plain = false

			break
		}
	}

	if (plain) {
		return decodeUtf8(bytes, start, end)
	}

	let out = ""
	let runStart = start
	let i = start

	while (i < end) {
		const b = bytes[i]

		if (b === AMP) {
			let semicolon = i + 1

			while (semicolon < end && bytes[semicolon] !== SEMICOLON) semicolon++

			if (semicolon >= end) {
				throw new XmlError("invalidReference", "Unterminated reference", i)
			}

			out += decodeUtf8(bytes, runStart, i) + decodeReference(bytes, i + 1, semicolon)
			i = semicolon + 1
			runStart = i
		} else if (b === CR) {
			out += decodeUtf8(bytes, runStart, i) + (attribute ? " " : "\n")
			i += bytes[i + 1] === LF ? 2 : 1
			runStart = i
		} else if (attribute && (b === LF || b === TAB)) {
			out += decodeUtf8(bytes, runStart, i) + " "
			i++
			runStart = i
		} else {
			i++
		}
	}

	return out + decodeUtf8(bytes, runStart, end)
}

// CDATA content: no references, but line ends are normalised like everywhere else.
export function decodeCData(bytes: Uint8Array, start: number, end: number): string {
	const text = decodeUtf8(bytes, start, end)

	return text.indexOf("\r") < 0 ? text : text.replace(/\r\n?/g, "\n")
}

const ESCAPES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&apos;",
	"\t": "&#9;",
	"\n": "&#10;",
	"\r": "&#13;"
}

// Escapes markup characters and replaces every code unit XML cannot carry (C0 controls other than tab and
// line ends, U+FFFE, U+FFFF, unpaired surrogates) with U+FFFD, so written text always re-parses.
// `attribute` also escapes quotes, and tabs and line ends, which attribute-value normalisation would eat.
function escape(text: string, attribute: boolean): string {
	let out = ""
	let runStart = 0

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		let replacement: string | undefined

		if (code < 0x20) {
			replacement = code === 9 || code === 10 ? (attribute ? ESCAPES[text.charAt(i)] : undefined) : code === 13 ? "&#13;" : "\ufffd"
		} else if (code === 38 || code === 60 || (code === 62 && !attribute) || (attribute && (code === 34 || code === 39))) {
			replacement = ESCAPES[text.charAt(i)]
		} else if (code >= 0xd800 && code <= 0xdfff) {
			const next = text.charCodeAt(i + 1)

			if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
				i++

				continue
			}

			replacement = "\ufffd"
		} else if (code === 0xfffe || code === 0xffff) {
			replacement = "\ufffd"
		}

		if (replacement === undefined) continue

		out += text.slice(runStart, i) + replacement
		runStart = i + 1
	}

	return runStart === 0 ? text : out + text.slice(runStart)
}

// A character `escape` changes, tested natively first (most text and values hold none): anything but what is written
// as it is. In u-mode a paired surrogate is one code point past U+FFFF; an unpaired one matches.
const TEXT_ESCAPES = /[^\t\n -%'-;=?-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u
const ATTRIBUTE_ESCAPES = /[^ !#-%(-;=-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u

// Text for new markup.
export function escapeText(text: string): string {
	return TEXT_ESCAPES.test(text) ? escape(text, false) : text
}

// An attribute value for new markup, safe inside either quote character.
export function escapeAttribute(value: string): string {
	return ATTRIBUTE_ESCAPES.test(value) ? escape(value, true) : value
}

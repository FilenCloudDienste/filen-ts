import type { Text } from "@codemirror/state"
import { decodeTextBytes, editableAsIs, encodeTextBytes, TEXT_ENCODINGS, type EncodedText } from "@filen/shared/textEncoding"

// A text file as the editor opens and saves it: its text, its encoding, whether it began with a byte order mark and
// the line ending it uses. A save writes the file in the encoding it was read with (encodeTextBytes). The editor splits lines on any ending (so text pasted or typed with another still breaks
// lines) and keeps none of them; a save joins the lines with the file's own ending and puts its mark back, so
// saving a CRLF or BOM file changes only what was edited. (CodeMirror's lineSeparator facet is not used: set to
// "\r\n" it would stop a pasted "\n" from breaking the line.)

export type LineEnding = "lf" | "crlf" | "cr"

export interface TextFileFormat {
	// WHATWG name of the encoding the file was read with.
	readonly encoding: string
	readonly bom: boolean
	readonly lineEnding: LineEnding
}

export interface TextFile extends TextFileFormat {
	// Without the mark.
	readonly text: string
	// A save (in this encoding, its mark kept) writes back the bytes it came from; otherwise the file opens read-only.
	readonly editableAsIs: boolean
}

// The editor's buffer, read on demand (never per keystroke).
export interface TextBuffer {
	// As a save writes it, before encoding: the file's line ending, its mark as a leading U+FEFF.
	text(): string
	// Encoded as a save writes it; null when the encoding cannot hold a character (the editor says where).
	bytes(): Uint8Array | null
}

const BOM = "﻿"
// Enough of a file to tell its line ending; the rest is not scanned.
const LINE_ENDING_PROBE = 1 << 20

// The most used ending in the probe; a file with none (one line) is LF.
export function detectLineEnding(text: string): LineEnding {
	let lf = 0
	let crlf = 0
	let cr = 0
	const end = Math.min(text.length, LINE_ENDING_PROBE)

	for (let index = 0; index < end; index++) {
		const code = text.charCodeAt(index)

		if (code === 13) {
			if (text.charCodeAt(index + 1) === 10) {
				crlf++
				index++
			} else {
				cr++
			}
		} else if (code === 10) {
			lf++
		}
	}

	if (crlf > lf && crlf >= cr) {
		return "crlf"
	}

	return cr > lf && cr > crlf ? "cr" : "lf"
}

// Never throws. Bytes that are not Unicode are read with the codepage of the browser's first language; `encoding`
// (a label of TEXT_ENCODINGS) reads them with that one instead.
export function readTextFile(bytes: Uint8Array, encoding?: string | null): TextFile {
	const decoded = decodeTextBytes(bytes, { languageHint: navigator.languages[0] ?? null, encoding: encoding ?? null })

	return {
		text: decoded.text,
		encoding: decoded.encoding,
		bom: decoded.bom,
		lineEnding: detectLineEnding(decoded.text),
		editableAsIs: editableAsIs(decoded)
	}
}

export function lineBreak(ending: LineEnding): string {
	return ending === "crlf" ? "\r\n" : ending === "cr" ? "\r" : "\n"
}

// What a save writes: the editor's lines joined with the file's ending, after its mark.
export function writeTextFile(doc: Text, format: TextFileFormat): string {
	const text = doc.sliceString(0, doc.length, lineBreak(format.lineEnding))

	return format.bom ? BOM + text : text
}

// What a save uploads: writeTextFile's text in the file's encoding.
export function encodeTextFile(doc: Text, format: TextFileFormat): EncodedText {
	return encodeTextBytes(writeTextFile(doc, format), format.encoding)
}

// The format a conversion to UTF-8 saves in: a UTF-8 file keeps its mark, any other encoding's is dropped.
export function utf8Format(format: TextFileFormat): TextFileFormat {
	return { encoding: "utf-8", bom: format.encoding === "utf-8" && format.bom, lineEnding: format.lineEnding }
}

const ENCODING_NAMES: ReadonlyMap<string, string> = new Map(
	TEXT_ENCODINGS.map(encoding => [encoding.label, /\(([^)]+)\)$/.exec(encoding.name)?.[1] ?? encoding.label.toUpperCase()])
)

// The encoding's short name ("Windows-1251", "UTF-16 LE"), as the status shows it.
export function encodingShortName(label: string): string {
	return ENCODING_NAMES.get(label) ?? label.toUpperCase()
}

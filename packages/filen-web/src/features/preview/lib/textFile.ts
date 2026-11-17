import type { Text } from "@codemirror/state"
import {
	decodeTextBytes,
	decodeUnicodeText,
	editableAsIs,
	encodeTextBytes,
	TEXT_ENCODINGS,
	type DecodedText,
	type EncodedText,
	type Unencodable
} from "@filen/shared/textEncoding"
import { joinLines, type LineBreaks } from "@/features/preview/lib/lineBreaks"

// A text file as the editor opens and saves it: its text, its encoding, whether it began with a byte order mark and
// the line ending most of its lines use. A save writes the file in the encoding it was read with (encodeTextBytes).
// The editor splits lines on any ending (so text pasted or typed with another still breaks lines) and keeps none of
// them; a save joins the lines with the file's own ending, keeps every other ending where it was (lineBreaks.ts) and
// puts its mark back, so saving a CRLF, mixed-ending or BOM file changes only what was edited. (CodeMirror's lineSeparator facet is not used: set to
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
	// Some bytes could not be read and show as U+FFFD: a conversion would write that in their place.
	readonly lossy: boolean
}

// The editor's buffer, read on demand (never per keystroke).
export interface TextBuffer {
	// As a save writes it, before encoding: the file's line endings, its mark as a leading U+FEFF.
	text(): string
	// Encoded as a save writes it, or where the encoding cannot hold a character.
	bytes(): EncodedText
	// Tells the user why bytes() refused (the editor's dialog, which offers the conversion).
	explain(at: Unencodable): void
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

function textFile(decoded: DecodedText): TextFile {
	return {
		text: decoded.text,
		encoding: decoded.encoding,
		bom: decoded.bom,
		lineEnding: detectLineEnding(decoded.text),
		editableAsIs: editableAsIs(decoded),
		lossy: decoded.lossy
	}
}

// Never throws. Bytes that are not Unicode are read with `guess` (the detector's label, guessLegacyEncoding), else the
// codepage of the browser's first language; `encoding` (a label of TEXT_ENCODINGS) reads them with that one instead.
export function readTextFile(bytes: Uint8Array, options?: { encoding?: string | null; guess?: string | null }): TextFile {
	return textFile(
		decodeTextBytes(bytes, {
			languageHint: navigator.languages[0] ?? null,
			encoding: options?.encoding ?? null,
			guess: options?.guess ?? null
		})
	)
}

// The bytes read as Unicode, or null when they are not (a codepage has to be picked: readTextFile with it). One decode.
export function readUnicodeTextFile(bytes: Uint8Array): TextFile | null {
	const decoded = decodeUnicodeText(bytes)

	return decoded === null ? null : textFile(decoded)
}

export function lineBreak(ending: LineEnding): string {
	return ending === "crlf" ? "\r\n" : ending === "cr" ? "\r" : "\n"
}

// What a save writes: the editor's lines joined with the file's ending (or the one `breaks` kept), after its mark.
export function writeTextFile(doc: Text, format: TextFileFormat, breaks?: LineBreaks): string {
	const separator = lineBreak(format.lineEnding)
	const text = breaks === undefined ? doc.sliceString(0, doc.length, separator) : joinLines(doc, separator, breaks)

	return format.bom ? BOM + text : text
}

// What a save uploads: writeTextFile's text in the file's encoding.
export function encodeTextFile(doc: Text, format: TextFileFormat, breaks?: LineBreaks): EncodedText {
	return encodeTextBytes(writeTextFile(doc, format, breaks), format.encoding)
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

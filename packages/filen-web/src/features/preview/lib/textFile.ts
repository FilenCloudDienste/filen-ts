import type { Text } from "@codemirror/state"

// A text file as the editor opens and saves it: its UTF-8 text, whether it began with a byte order mark and the
// line ending it uses. The editor splits lines on any ending (so text pasted or typed with another still breaks
// lines) and keeps none of them; a save joins the lines with the file's own ending and puts its mark back, so
// saving a CRLF or BOM file changes only what was edited. (CodeMirror's lineSeparator facet is not used: set to
// "\r\n" it would stop a pasted "\n" from breaking the line.)

export type LineEnding = "lf" | "crlf" | "cr"

export interface TextFileFormat {
	readonly bom: boolean
	readonly lineEnding: LineEnding
}

export interface TextFile extends TextFileFormat {
	// Without the mark.
	readonly text: string
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

// Never throws: an invalid sequence becomes U+FFFD (decodeUtf8's rule).
export function readTextFile(bytes: Uint8Array): TextFile {
	const decoded = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)
	const bom = decoded.startsWith(BOM)
	const text = bom ? decoded.slice(1) : decoded

	return { text, bom, lineEnding: detectLineEnding(text) }
}

export function lineBreak(ending: LineEnding): string {
	return ending === "crlf" ? "\r\n" : ending === "cr" ? "\r" : "\n"
}

// What a save writes: the editor's lines joined with the file's ending, after its mark.
export function writeTextFile(doc: Text, format: TextFileFormat): string {
	const text = doc.sliceString(0, doc.length, lineBreak(format.lineEnding))

	return format.bom ? BOM + text : text
}

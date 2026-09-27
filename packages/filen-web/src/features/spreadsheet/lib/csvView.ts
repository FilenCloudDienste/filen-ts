import { detectDelimiter, parseCsv, writeCsv, type CellValue } from "hucre"
import { cellKey, type CellView, type SpreadsheetDoc } from "@/features/spreadsheet/lib/model"

// How a CSV file was written, so a save writes it back the same way: its separator, its line ends, a byte
// order mark, a final line end, and the byte encoding it was read as. A legacy windows-1252 export is
// decoded and ALWAYS re-written as windows-1252, never re-encoded to another encoding behind the user's
// back: decode-then-encode is a bijection on every byte the table defines, so an untouched cell's characters
// come back as the same bytes even when the true source encoding was really 1250, 1251, GBK, or another
// single-byte encoding windows-1252 happened to decode without throwing. The rows are written anew, not
// copied: quotes a field did not need go, and line ends all become the first one read. An edit that types
// a character the table cannot hold is refused outright (see CsvDocument and canEncodeWindows1252), not
// silently reformatted.
// `writable` is false when the source bytes hold a byte windows-1252 leaves undefined, or when they read
// as confidently non-Western text — both cases where editing would show confusing mojibake.
export interface CsvFormat {
	delimiter: string
	lineSeparator: "\r\n" | "\n" | "\r"
	bom: boolean
	trailingNewline: boolean
	encoding: "utf-8" | "utf-16le" | "utf-16be" | "windows-1252"
	writable: boolean
}

const UTF8_BOM = [0xef, 0xbb, 0xbf]
const UTF16LE_BOM = [0xff, 0xfe]
const UTF16BE_BOM = [0xfe, 0xff]

function withBom(bom: readonly number[], body: Uint8Array): Uint8Array {
	const out = new Uint8Array(bom.length + body.length)

	out.set(bom)
	out.set(body, bom.length)

	return out
}

// The byte values windows-1252 leaves undefined (0x80-0x9F minus the specials below). A non-fatal
// windows-1252 decode still maps these to C1 control code points instead of throwing, so their presence
// is the only signal that the bytes are really some other single-byte encoding (Shift-JIS, GBK, ...) that
// happened to decode without error; such a file cannot be told apart or written back reliably.
const WIN1252_UNDEFINED = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d])

function hasWin1252UndefinedByte(bytes: Uint8Array): boolean {
	for (const byte of bytes) {
		if (WIN1252_UNDEFINED.has(byte)) {
			return true
		}
	}

	return false
}

// Excel's default CSV encoding in CJK and Cyrillic locales (GBK, EUC-KR, windows-1251, Shift-JIS) leaves
// none of the bytes above undefined, so it passes hasWin1252UndefinedByte and must be told apart another
// way. Real Western windows-1252 text keeps its non-ASCII letters mostly isolated inside ASCII words
// ("Größe", "café"): a short run of high bytes and a low overall share of them. Those other encodings
// decode as long runs of consecutive high bytes and a high overall share, since most or all of every
// multi-byte character's bytes are >=0x80. The ratio check is skipped on very short bodies, where a single
// accented word can cross it by chance; the run check has no such floor, since it takes 3 in a row.
const HIGH_BYTE_RUN_LIMIT = 3
const HIGH_BYTE_RATIO_LIMIT = 0.3
const HIGH_BYTE_RATIO_MIN_LENGTH = 16

function looksWesternWindows1252(bytes: Uint8Array): boolean {
	let high = 0
	let run = 0
	let maxRun = 0

	for (const byte of bytes) {
		if (byte >= 0x80) {
			high++
			run++
			maxRun = maxRun < run ? run : maxRun
		} else {
			run = 0
		}
	}

	if (maxRun >= HIGH_BYTE_RUN_LIMIT) {
		return false
	}

	return bytes.length < HIGH_BYTE_RATIO_MIN_LENGTH || high / bytes.length <= HIGH_BYTE_RATIO_LIMIT
}

export function decodeCsv(bytes: Uint8Array): { text: string; bom: boolean; encoding: CsvFormat["encoding"]; writable: boolean } {
	// Excel's "Save as Unicode Text" writes UTF-16LE with a BOM; decoded as UTF-8 it would come back as
	// NUL-interleaved garbage rather than throwing, so it must be checked before the UTF-8 BOM/fallback below.
	if (UTF16LE_BOM.every((byte, index) => bytes[index] === byte)) {
		return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), bom: true, encoding: "utf-16le", writable: true }
	}

	if (UTF16BE_BOM.every((byte, index) => bytes[index] === byte)) {
		return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), bom: true, encoding: "utf-16be", writable: true }
	}

	const bom = UTF8_BOM.every((byte, index) => bytes[index] === byte)
	const body = bom ? bytes.subarray(3) : bytes

	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), bom, encoding: "utf-8", writable: true }
	} catch {
		return {
			text: new TextDecoder("windows-1252").decode(body),
			bom,
			encoding: "windows-1252",
			writable: !hasWin1252UndefinedByte(body) && looksWesternWindows1252(body)
		}
	}
}

// The first line break outside a quoted field, whichever line ending it uses ("\r" alone included). A
// newline embedded in a quoted value (e.g. a multi-line header cell) is not the row separator.
function detectLineSeparator(text: string): CsvFormat["lineSeparator"] {
	let quoted = false

	for (let i = 0; i < text.length; i++) {
		const char = text[i]

		if (char === '"') {
			if (quoted && text[i + 1] === '"') {
				i++
			} else {
				quoted = !quoted
			}

			continue
		}

		if (quoted) {
			continue
		}

		if (char === "\n") {
			return "\n"
		}

		if (char === "\r") {
			return text[i + 1] === "\n" ? "\r\n" : "\r"
		}
	}

	return "\n"
}

export function parseCsvFile(bytes: Uint8Array, tabSeparated: boolean): { rows: string[][]; format: CsvFormat } {
	const { text, bom, encoding, writable } = decodeCsv(bytes)
	const delimiter = tabSeparated ? "\t" : text.length === 0 ? "," : detectDelimiter(text)
	const lineSeparator = detectLineSeparator(text)
	// Every value stays the text it was: a CSV's "007" or "1e5" is not a number until someone says so.
	const parsed = text.length === 0 ? [] : parseCsv(text, { delimiter, typeInference: false, skipBom: false })
	const rows = parsed.map(row => row.map(value => (value === null ? "" : String(value))))

	return {
		rows,
		format: { delimiter, lineSeparator, bom, trailingNewline: /[\r\n]$/.test(text), encoding, writable }
	}
}

// windows-1252's departures from Latin-1: the block at 0x80-0x9F. Byte values with no entry here (0x81,
// 0x8D, 0x8F, 0x90, 0x9D) are undefined in the encoding; decodeCsv can still hand back code points equal to
// those bytes (from some other single-byte encoding it mistook for windows-1252), but such a document is
// marked unwritable before it ever reaches serializeCsv, so no inverse mapping is needed for them here.
const WIN1252_SPECIALS: Record<number, number> = {
	0x20ac: 0x80,
	0x201a: 0x82,
	0x0192: 0x83,
	0x201e: 0x84,
	0x2026: 0x85,
	0x2020: 0x86,
	0x2021: 0x87,
	0x02c6: 0x88,
	0x2030: 0x89,
	0x0160: 0x8a,
	0x2039: 0x8b,
	0x0152: 0x8c,
	0x017d: 0x8e,
	0x2018: 0x91,
	0x2019: 0x92,
	0x201c: 0x93,
	0x201d: 0x94,
	0x2022: 0x95,
	0x2013: 0x96,
	0x2014: 0x97,
	0x02dc: 0x98,
	0x2122: 0x99,
	0x0161: 0x9a,
	0x203a: 0x9b,
	0x0153: 0x9c,
	0x017e: 0x9e,
	0x0178: 0x9f
}

// null when the text holds a character windows-1252 cannot represent; edits that would need one are refused.
// Loops by UTF-16 code unit rather than code point: every representable codepoint is in the BMP, so a
// surrogate half can only belong to a character outside it, which is unrepresentable anyway.
function encodeWindows1252(text: string): Uint8Array | null {
	const bytes = new Uint8Array(text.length)

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)

		if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) {
			bytes[i] = code

			continue
		}

		const mapped = WIN1252_SPECIALS[code]

		if (mapped === undefined) {
			return null
		}

		bytes[i] = mapped
	}

	return bytes
}

// Whether `text` can be written back as windows-1252 without loss — used by CsvDocument to refuse an edit
// before it ever reaches serializeCsv, rather than letting the file's saved encoding change silently.
export function canEncodeWindows1252(text: string): boolean {
	return encodeWindows1252(text) !== null
}

// A JS string is already UTF-16 code units; writing UTF-16 bytes is just splitting each one in the given
// byte order, surrogate pairs included (they are two code units, written as two units here too).
function encodeUtf16(text: string, littleEndian: boolean): Uint8Array {
	const bytes = new Uint8Array(text.length * 2)

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		const high = (code >> 8) & 0xff
		const low = code & 0xff

		if (littleEndian) {
			bytes[i * 2] = low
			bytes[i * 2 + 1] = high
		} else {
			bytes[i * 2] = high
			bytes[i * 2 + 1] = low
		}
	}

	return bytes
}

export function serializeCsv(rows: readonly (readonly string[])[], format: CsvFormat): Uint8Array {
	// Only what the separator, a quote or a line end requires is quoted; a user's own data is never
	// rewritten against formula injection (that is for exporting other people's data, not saving a file).
	let text = writeCsv(rows as CellValue[][], {
		delimiter: format.delimiter,
		lineSeparator: format.lineSeparator,
		quoteStyle: "required",
		escapeFormulae: false
	})

	if (format.trailingNewline && rows.length > 0) {
		text += format.lineSeparator
	}

	if (format.encoding === "utf-16le") {
		return withBom(UTF16LE_BOM, encodeUtf16(text, true))
	}

	if (format.encoding === "utf-16be") {
		return withBom(UTF16BE_BOM, encodeUtf16(text, false))
	}

	if (format.encoding === "windows-1252") {
		const encoded = encodeWindows1252(text)

		if (encoded === null) {
			// CsvDocument refuses any edit that would introduce a character this table cannot hold, so a
			// reachable document's text is always fully encodable here — this file never silently changes
			// encoding on save. Reaching this is a bug upstream, not a case to paper over with UTF-8.
			throw new Error("spreadsheet: windows-1252 CSV holds a character it cannot represent")
		}

		return encoded
	}

	const body = new TextEncoder().encode(text)

	if (!format.bom) {
		return body
	}

	return withBom(UTF8_BOM, body)
}

const NUMERIC = /^[-+]?(\d+([.,]\d+)?|\d{1,3}([.,]\d{3})+([.,]\d+)?)%?$/

// A CSV cell shows its text as is; one that reads as a number sits on the right, as a number does.
export function csvCellView(text: string): CellView | null {
	return text === "" ? null : NUMERIC.test(text.trim()) ? { text, numeric: true } : { text }
}

export function csvDoc(rows: readonly (readonly string[])[], writable: boolean): SpreadsheetDoc {
	const cells = new Map<number, CellView>()
	let colCount = 0

	rows.forEach((row, rowIndex) => {
		colCount = Math.max(colCount, row.length)
		row.forEach((value, colIndex) => {
			const view = csvCellView(value)

			if (view !== null) {
				cells.set(cellKey(rowIndex, colIndex), view)
			}
		})
	})

	return {
		kind: "csv",
		sheets: [
			{
				name: "",
				rowCount: rows.length,
				colCount,
				cells,
				merges: [],
				colWidths: new Map(),
				rowHeights: new Map(),
				hiddenCols: [],
				hiddenRows: [],
				frozenRows: 0,
				frozenCols: 0,
				structureLocked: false
			}
		],
		activeSheet: 0,
		styles: [],
		writable
	}
}

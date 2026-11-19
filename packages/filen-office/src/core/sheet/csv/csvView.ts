import { detectDelimiter, detectsStably, parseCsvRecords, utf8Length, writeCsv, type CsvLimits } from "./csvParse"
import {
	decodeUtf16,
	decodeUtf8Strict,
	decodeWindows1252,
	detectBom,
	encodeUtf16,
	encodeWindows1252,
	isWindows1252Undefined,
	type CsvEncoding
} from "./encoding"
import { MAX_COLUMNS, type CellView } from "../model/model"

// How a CSV file was written, so a save writes it back the same way: its separator, its line ends, a byte
// order mark, a final line end, and the byte encoding it was read as. A legacy windows-1252 export is
// decoded and ALWAYS re-written as windows-1252, never re-encoded to another encoding behind the user's
// back: decode-then-encode is a bijection on every byte the table defines, so an untouched cell's characters
// come back as the same bytes even when the true source encoding was really 1250, 1251, GBK, or another
// single-byte encoding windows-1252 happened to decode without throwing. The rows are written anew, not
// copied: quotes a field did not need go, and line ends all become the first one read. An edit that types
// a character the table cannot hold is refused outright (see the text session and canEncodeWindows1252), not
// silently reformatted.
// `writable` is false when the source bytes hold a byte windows-1252 leaves undefined, or when they read
// as confidently non-Western text — both cases where editing would show confusing mojibake.
// `stable`: the separator was detected (a CSV) and the file detects as it whatever the locale prefers, so a save that
// would detect as another one quotes every field holding a separator the detection weighs, and the file reopens as
// it was written. A file whose separator was a tie the session's locale settled keeps its rows' bytes instead: quoted
// for this reading, every row would write the misreading in for every reader.
export interface CsvFormat {
	delimiter: string
	stable: boolean
	lineSeparator: "\r\n" | "\n" | "\r"
	bom: boolean
	trailingNewline: boolean
	encoding: CsvEncoding
	writable: boolean
}

const UTF8_BOM = [0xef, 0xbb, 0xbf]
const UTF16LE_BOM = [0xff, 0xfe]
const UTF16BE_BOM = [0xfe, 0xff]

// `text` as UTF-8, after a byte order mark when `bom`: encoded straight into one buffer of the final size, so a large
// file's body is never copied to make room for the mark.
export function encodeUtf8(text: string, bom: boolean): Uint8Array {
	const encoder = new TextEncoder()

	if (!bom) return encoder.encode(text)

	const bytes = new Uint8Array(UTF8_BOM.length + utf8Length(text))

	bytes.set(UTF8_BOM)
	encoder.encodeInto(text, bytes.subarray(UTF8_BOM.length))

	return bytes
}

// A non-fatal windows-1252 decode maps the bytes the encoding leaves undefined to C1 control code points
// instead of throwing, so their presence is the only signal that the bytes are really some other single-byte
// encoding (Shift-JIS, GBK, ...) that happened to decode without error; such a file cannot be told apart or
// written back reliably.
function hasWin1252UndefinedByte(bytes: Uint8Array): boolean {
	for (const byte of bytes) {
		if (isWindows1252Undefined(byte)) {
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

function decodeCsv(bytes: Uint8Array): { text: string; bom: boolean; encoding: CsvFormat["encoding"]; writable: boolean } {
	const bomInfo = detectBom(bytes)

	// Excel's "Save as Unicode Text" writes UTF-16LE with a BOM; decoded as UTF-8 it would come back as
	// NUL-interleaved garbage rather than failing, so it must be handled before the UTF-8 fallback below.
	if (bomInfo !== null && bomInfo.encoding !== "utf-8") {
		return {
			text: decodeUtf16(bytes.subarray(bomInfo.length), bomInfo.encoding === "utf-16le"),
			bom: true,
			encoding: bomInfo.encoding,
			writable: true
		}
	}

	const bom = bomInfo !== null
	const body = bomInfo !== null ? bytes.subarray(bomInfo.length) : bytes
	const text = decodeUtf8Strict(body)

	if (text !== null) {
		return { text, bom, encoding: "utf-8", writable: true }
	}

	return {
		text: decodeWindows1252(body),
		bom,
		encoding: "windows-1252",
		writable: !hasWin1252UndefinedByte(body) && looksWesternWindows1252(body)
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

// `listSeparator`: the session locale's, which wins a tie between separators. Past `limits` (or the grid's last
// column) it throws, as soon as the parse reaches them; `complete` is false when limits.keepFirstRows ended it.
export function parseCsvFile(
	bytes: Uint8Array,
	tabSeparated: boolean,
	options: { readonly listSeparator?: string; readonly limits?: CsvLimits } = {}
): { rows: string[][]; complete: boolean; format: CsvFormat } {
	const { text, bom, encoding, writable } = decodeCsv(bytes)
	const delimiter = tabSeparated ? "\t" : text.length === 0 ? "," : detectDelimiter(text, options.listSeparator)
	const lineSeparator = detectLineSeparator(text)
	const limits = options.limits ?? {}
	// The last character alone, not a search of the whole text (NaN for an empty one).
	const lastCode = text.charCodeAt(text.length - 1)
	// Every value stays the text it was: a CSV's "007" or "1e5" is not a number until someone says so. Past the
	// grid's last column, cells would take the keys of the next row's (cellKey).
	const { rows, complete } = parseCsvRecords(text, delimiter, {
		...limits,
		maxColumns: Math.min(limits.maxColumns ?? MAX_COLUMNS, MAX_COLUMNS)
	})

	return {
		rows,
		complete,
		format: {
			delimiter,
			stable: !tabSeparated && detectsStably(text, delimiter),
			lineSeparator,
			bom,
			trailingNewline: lastCode === 0x0a || lastCode === 0x0d,
			encoding,
			writable
		}
	}
}

// Whether `text` can be written back as windows-1252 without loss — used by the text session to refuse an edit
// before it ever reaches serializeCsv, rather than letting the file's saved encoding change silently.
export function canEncodeWindows1252(text: string): boolean {
	return encodeWindows1252(text) !== null
}

export function serializeCsv(rows: readonly (readonly string[])[], format: CsvFormat): Uint8Array {
	// Only what the separator, a quote or a line end requires is quoted; a user's own data is never rewritten against
	// formula injection (that is for exporting other people's data, not saving a file). A CSV whose text would detect
	// as another separator, in some locale, also quotes every field holding one (writeCsv's stable).
	let text = writeCsv(rows, format.delimiter, format.lineSeparator)

	if (format.stable && !detectsStably(text, format.delimiter)) text = writeCsv(rows, format.delimiter, format.lineSeparator, true)

	if (format.trailingNewline && rows.length > 0) {
		text += format.lineSeparator
	}

	if (format.encoding === "utf-16le") {
		return encodeUtf16(text, true, UTF16LE_BOM)
	}

	if (format.encoding === "utf-16be") {
		return encodeUtf16(text, false, UTF16BE_BOM)
	}

	if (format.encoding === "windows-1252") {
		const encoded = encodeWindows1252(text)

		if (encoded === null) {
			// The text session refuses any edit that would introduce a character this table cannot hold, so a
			// reachable document's text is always fully encodable here — this file never silently changes
			// encoding on save. Reaching this is a bug upstream, not a case to paper over with UTF-8.
			throw new Error("spreadsheet: windows-1252 CSV holds a character it cannot represent")
		}

		return encoded
	}

	return encodeUtf8(text, format.bom)
}

const NUMERIC = /^[-+]?(\d+([.,]\d+)?|\d{1,3}([.,]\d{3})+([.,]\d+)?)%?$/

// A CSV cell shows its text as is; one that reads as a number sits on the right, as a number does.
export function csvCellView(text: string): CellView | null {
	return text === "" ? null : NUMERIC.test(text.trim()) ? { text, numeric: true } : { text }
}

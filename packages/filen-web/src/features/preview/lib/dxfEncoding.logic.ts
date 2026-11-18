import { textEncodingLabel } from "@filen/shared/textEncoding"

// The text encoding a DXF drawing is read with. From R2007 (AC1021) on, a DXF is UTF-8 whatever its header says; before,
// its text is in the codepage $DWGCODEPAGE names. A file that names none (or one no decoder here reads) is read as
// UTF-8 when its head is valid UTF-8, else as Windows-1252, AutoCAD's default.

// The head read for the header variables: they open a DXF.
export const DXF_HEADER_BYTES = 65_536

const UTF8_FROM_VERSION = 1021

export interface DxfHeaderFields {
	// $ACADVER's number ("AC1015" gives 1015), null when absent.
	readonly version: number | null
	// $DWGCODEPAGE as written ("ANSI_1252"), null when absent.
	readonly codepage: string | null
}

// The two header variables, with the lines paired as the parser pairs them (a group code line, then its value line);
// the first occurrence wins. Read as Latin-1: both values are ASCII.
export function dxfHeaderFields(head: Uint8Array): DxfHeaderFields {
	const lines = new TextDecoder("latin1").decode(head.subarray(0, DXF_HEADER_BYTES)).split(/\r\n|\r|\n/)
	let version: number | null = null
	let codepage: string | null = null

	for (let index = 0; index + 3 < lines.length && (version === null || codepage === null); index += 2) {
		if (Number.parseInt(lines[index] ?? "", 10) !== 9) continue

		const name = (lines[index + 1] ?? "").trim()
		const value = (lines[index + 3] ?? "").trim()

		if (name === "$ACADVER" && version === null) {
			const match = /^AC(\d+)$/i.exec(value)

			version = match === null ? null : Number(match[1])
		} else if (name === "$DWGCODEPAGE" && codepage === null) {
			codepage = value
		}
	}

	return { version, codepage }
}

const ANSI_CODEPAGES: ReadonlyMap<number, string> = new Map([
	[932, "shift_jis"],
	[936, "gbk"],
	[949, "euc-kr"],
	[950, "big5"]
])

function ansiLabel(number: number): string | null {
	return ANSI_CODEPAGES.get(number) ?? (number === 874 || (number >= 1250 && number <= 1258) ? `windows-${String(number)}` : null)
}

// The encoding label (filen-shared's TEXT_ENCODINGS) a $DWGCODEPAGE value names, or null when none reads it.
export function dwgCodepageLabel(codepage: string): string | null {
	const value = codepage.trim().toUpperCase()
	const ansi = /^ANSI_(\d+)$/.exec(value)
	const iso = /^ISO8859-(\d+)$/.exec(value)
	let label: string | null = null

	if (ansi !== null) {
		label = ansiLabel(Number(ansi[1]))
	} else if (iso !== null) {
		const part = Number(iso[1])

		// Latin-1 and Latin-5 are read as their Windows supersets, as the Encoding Standard does.
		label = part === 1 ? "windows-1252" : part === 9 ? "windows-1254" : `iso-8859-${String(part)}`
	} else if (value === "DOS866") {
		label = "ibm866"
	} else if (value === "MACINTOSH") {
		label = "macintosh"
	} else if (value === "UTF8" || value === "UTF-8") {
		label = "utf-8"
	}

	return label === null ? null : textEncodingLabel(label)
}

export function dxfFileEncoding(head: Uint8Array): string {
	const { version, codepage } = dxfHeaderFields(head)

	if (version !== null && version >= UTF8_FROM_VERSION) return "utf-8"

	const named = codepage === null ? null : dwgCodepageLabel(codepage)

	if (named !== null) return named

	try {
		// A head may end inside a character: streamed, so only a sequence that cannot go on is an error.
		new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, DXF_HEADER_BYTES), { stream: true })

		return "utf-8"
	} catch {
		return "windows-1252"
	}
}

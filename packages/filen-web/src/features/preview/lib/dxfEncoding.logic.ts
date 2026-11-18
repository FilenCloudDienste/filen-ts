import { textEncodingLabel } from "@filen/shared/textEncoding"

// The text encoding a DXF drawing is read with. From R2007 (AC1021) on, a DXF is UTF-8 whatever its header says; before,
// its text is in the codepage $DWGCODEPAGE names. A file that names none (or one no decoder here reads) is read as
// UTF-8 when the whole file is valid UTF-8, else as Windows-1252, AutoCAD's default (dxfText.logic).

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

// Codepages AutoCAD-family writers name, by the number after ANSI_ or DOS (or the bare name), that have a decoder here.
const NUMBERED_CODEPAGES: ReadonlyMap<number, string> = new Map([
	[866, "ibm866"],
	[932, "shift_jis"],
	[936, "gbk"],
	[949, "euc-kr"],
	[950, "big5"]
])

const NAMED_CODEPAGES: ReadonlyMap<string, string> = new Map([
	["GB2312", "gbk"],
	["BIG5", "big5"],
	["KSC5601", "euc-kr"],
	["MACINTOSH", "macintosh"],
	["UTF8", "utf-8"],
	["UTF-8", "utf-8"]
])

function numberedLabel(number: number): string | null {
	return NUMBERED_CODEPAGES.get(number) ?? (number === 874 || (number >= 1250 && number <= 1258) ? `windows-${String(number)}` : null)
}

function isoLabel(part: number): string {
	// Latin-1 and Latin-5 are read as their Windows supersets, as the Encoding Standard does; Thai as Windows-874.
	return part === 1 ? "windows-1252" : part === 9 ? "windows-1254" : part === 11 ? "windows-874" : `iso-8859-${String(part)}`
}

function decodable(label: string): boolean {
	try {
		new TextDecoder(label)

		return true
	} catch {
		return false
	}
}

// The encoding label a $DWGCODEPAGE value names (filen-shared's TEXT_ENCODINGS name where it lists one), or null when
// no decoder here reads it (the DOS Latin pages, Johab).
export function dwgCodepageLabel(codepage: string): string | null {
	const value = codepage.trim().toUpperCase()
	const numbered = /^(?:ANSI_|DOS)(\d+)$/.exec(value)
	const iso = /^ISO8859-(\d+)$/.exec(value)
	const label =
		numbered !== null
			? numberedLabel(Number(numbered[1]))
			: iso !== null
				? isoLabel(Number(iso[1]))
				: (NAMED_CODEPAGES.get(value) ?? null)

	if (label === null) return null

	return textEncodingLabel(label) ?? (decodable(label) ? label : null)
}

// The encoding the header declares: UTF-8 from R2007, else the codepage $DWGCODEPAGE names; null when it says nothing
// usable, and the read pass decides (dxfText.logic).
export function dxfDeclaredEncoding(head: Uint8Array): string | null {
	const { version, codepage } = dxfHeaderFields(head)

	if (version !== null && version >= UTF8_FROM_VERSION) return "utf-8"

	return codepage === null ? null : dwgCodepageLabel(codepage)
}

import type { Bytes } from "./bytes"

// [MS-DOC] §2.9.286 SttbfFfn: cData, cbExtra (0), then per font cchData (byte size) and an FFN (§2.9.82).

export interface DocFont {
	readonly name: string
	readonly altName: string | undefined
	// FFID (§2.9.85): prq (pitch), fTrueType, ff (family).
	readonly pitch: number
	readonly trueType: boolean
	readonly family: number
	readonly weight: number
	// Character set (chs).
	readonly charset: number
	readonly panose: Uint8Array
	// FontSignature, 24 bytes.
	readonly signature: Uint8Array
}

const FFN_HEADER = 39
const MAX_FONTS = 4096

// Empty name: every consumer treats it as absent; empty panose/signature: never written.
const UNREADABLE_FONT: DocFont = Object.freeze({
	name: "",
	altName: undefined,
	pitch: 0,
	trueType: false,
	family: 0,
	weight: 0,
	charset: 0,
	panose: new Uint8Array(0),
	signature: new Uint8Array(0)
})

function zeroTerminated(data: Uint8Array, at: number, end: number): readonly [string, number] {
	let text = ""
	let cursor = at

	for (; cursor + 2 <= end; cursor += 2) {
		const unit = (data[cursor] ?? 0) | ((data[cursor + 1] ?? 0) << 8)

		if (unit === 0) return [text, cursor + 2]

		text += String.fromCharCode(unit)
	}

	return [text, cursor]
}

export function readFonts(table: Bytes, fc: number, lcb: number): DocFont[] {
	if (lcb < 4 || !table.has(fc, lcb)) return []

	const end = fc + lcb
	const count = Math.min(MAX_FONTS, table.u16(fc))
	const fonts: DocFont[] = []
	let at = fc + 4

	for (let k = 0; k < count && at < end; k++) {
		const size = table.u8(at)
		const ffn = at + 1
		const ffnEnd = Math.min(end, ffn + size)

		at = ffn + size

		// ftc is an index into the entries, so an unreadable FFN keeps its slot.
		if (ffn + FFN_HEADER > ffnEnd) {
			fonts.push(UNREADABLE_FONT)

			continue
		}

		const ffid = table.u8(ffn)
		const ixchSzAlt = table.u8(ffn + 4)
		const [name, after] = zeroTerminated(table.data, ffn + FFN_HEADER, ffnEnd)
		const altName = ixchSzAlt !== 0 && after < ffnEnd ? zeroTerminated(table.data, after, ffnEnd)[0] : undefined

		fonts.push({
			name,
			altName: altName === "" ? undefined : altName,
			pitch: ffid & 3,
			trueType: (ffid & 4) !== 0,
			family: (ffid >> 4) & 7,
			weight: table.i16(ffn + 1),
			charset: table.u8(ffn + 3),
			panose: table.data.subarray(ffn + 5, ffn + 15),
			signature: table.data.subarray(ffn + 15, ffn + 39)
		})
	}

	return fonts
}

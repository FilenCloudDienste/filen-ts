import { type Bytes, utf16 } from "./bytes"

// [MS-DOC] §2.9.201 PlfLst (LSTF §2.9.147) + appended LVLs (§2.9.149, LVLF §2.9.150); §2.9.200 PlfLfo (LFO §2.9.131,
// LFOData §2.9.132, LFOLVL §2.9.133); §2.4.6.4 numbering.

export const NFC_DECIMAL = 0x00
export const NFC_BULLET = 0x17
export const NFC_NONE = 0xff

export interface DocLevel {
	readonly start: number
	// MSONFC ([MS-OSHARED] §2.2.1.3).
	readonly nfc: number
	// 0 left, 1 center, 2 right.
	readonly jc: number
	readonly legal: boolean
	readonly noRestart: boolean
	readonly restartLimit: number
	readonly tentative: boolean
	// The number text with placeholders: code units 0–8 at the offsets in `placeholders` stand for that level's number.
	readonly text: string
	// Zero-based offsets into `text` (from rgbxchNums).
	readonly placeholders: readonly number[]
	// 0 tab, 1 space, 2 nothing.
	readonly follow: number
	readonly indentSaved: number | undefined
	readonly papx: Uint8Array
	readonly chpx: Uint8Array
}

export interface DocListDef {
	readonly lsid: number
	readonly tplc: number
	readonly simple: boolean
	readonly hybrid: boolean
	readonly autoNumber: boolean
	// istd of the style linked to each level (0x0FFF = none).
	readonly styles: readonly number[]
	readonly levels: readonly DocLevel[]
}

export interface DocLevelOverride {
	readonly level: number
	readonly startAt: number | undefined
	readonly formatting: DocLevel | undefined
}

export interface DocListInstance {
	readonly lsid: number
	readonly overrides: readonly DocLevelOverride[]
}

export interface DocLists {
	readonly lists: readonly DocListDef[]
	// Indexed by iLfo - 1.
	readonly instances: readonly DocListInstance[]
}

const MAX_LISTS = 8192
// MS-DOC LVLF.iStartAt and LFOLVL.iStartAt: 0..0x7FFF; Word stops counting there too.
const MAX_NUMBER = 0x7fff

function clampNumber(value: number): number {
	return Math.min(MAX_NUMBER, Math.max(0, value))
}

function readLevel(table: Bytes, at: number): readonly [DocLevel, number] {
	table.check(at, 28, "LVLF")

	const flags = table.u8(at + 5)
	const nums: number[] = []

	for (let k = 0; k < 9; k++) {
		const offset = table.u8(at + 6 + k)

		if (offset === 0) break

		nums.push(offset - 1)
	}

	const cbChpx = table.u8(at + 24)
	const cbPapx = table.u8(at + 25)
	let cursor = at + 28
	const papx = table.slice(cursor, cbPapx, "LVL grpprlPapx")

	cursor += cbPapx

	const chpx = table.slice(cursor, cbChpx, "LVL grpprlChpx")

	cursor += cbChpx

	const cch = table.u16(cursor)

	table.check(cursor + 2, 2 * cch, "LVL xst")

	const text = utf16(table.data, cursor + 2, cch)

	cursor += 2 + 2 * cch

	return [
		{
			start: clampNumber(table.i32(at)),
			nfc: table.u8(at + 4),
			jc: flags & 3,
			legal: (flags & 0x04) !== 0,
			noRestart: (flags & 0x08) !== 0,
			tentative: (flags & 0x80) !== 0,
			indentSaved: (flags & 0x10) !== 0 ? table.i32(at + 16) : undefined,
			placeholders: nums.filter(offset => offset < text.length),
			follow: table.u8(at + 15),
			restartLimit: table.u8(at + 26),
			text,
			papx,
			chpx
		},
		cursor
	]
}

export function readLists(table: Bytes, lst: readonly [number, number], lfo: readonly [number, number]): DocLists {
	const lists: DocListDef[] = []
	const instances: DocListInstance[] = []
	const [fcLst, lcbLst] = lst

	if (lcbLst >= 2 && table.has(fcLst, lcbLst)) {
		const count = Math.min(MAX_LISTS, Math.max(0, table.i16(fcLst)), Math.floor((lcbLst - 2) / 28))
		let levelAt = fcLst + lcbLst

		for (let k = 0; k < count; k++) {
			const at = fcLst + 2 + 28 * k
			const flags = table.u8(at + 26)
			const simple = (flags & 1) !== 0
			const styles = Array.from({ length: 9 }, (_, n) => table.u16(at + 8 + 2 * n))
			const levels: DocLevel[] = []

			for (let n = 0; n < (simple ? 1 : 9); n++) {
				if (!table.has(levelAt, 28)) break

				const [level, next] = readLevel(table, levelAt)

				levels.push(level)
				levelAt = next
			}

			lists.push({
				lsid: table.i32(at),
				tplc: table.u32(at + 4),
				simple,
				autoNumber: (flags & 4) !== 0,
				hybrid: (flags & 0x10) !== 0,
				styles,
				levels
			})
		}
	}

	const [fcLfo, lcbLfo] = lfo

	if (lcbLfo >= 4 && table.has(fcLfo, lcbLfo)) {
		const end = fcLfo + lcbLfo
		const count = Math.min(MAX_LISTS, table.u32(fcLfo), Math.floor((lcbLfo - 4) / 16))
		let dataAt = fcLfo + 4 + 16 * count

		for (let k = 0; k < count; k++) {
			const at = fcLfo + 4 + 16 * k
			const levelCount = Math.min(9, table.u8(at + 12))
			const overrides: DocLevelOverride[] = []

			if (dataAt + 4 <= end) {
				let cursor = dataAt + 4

				for (let n = 0; n < levelCount && cursor + 8 <= end; n++) {
					const startAt = clampNumber(table.i32(cursor))
					const flags = table.u32(cursor + 4)
					let formatting: DocLevel | undefined

					cursor += 8

					if ((flags & 0x20) !== 0 && table.has(cursor, 28)) {
						const [level, next] = readLevel(table, cursor)

						formatting = level
						cursor = next
					}

					overrides.push({ level: flags & 0xf, startAt: (flags & 0x10) !== 0 ? startAt : undefined, formatting })
				}

				dataAt = cursor
			}

			instances.push({ lsid: table.i32(at), overrides })
		}
	}

	return { lists, instances }
}

const ROMAN: readonly (readonly [number, string])[] = [
	[1000, "m"],
	[900, "cm"],
	[500, "d"],
	[400, "cd"],
	[100, "c"],
	[90, "xc"],
	[50, "l"],
	[40, "xl"],
	[10, "x"],
	[9, "ix"],
	[5, "v"],
	[4, "iv"],
	[1, "i"]
]

// Beyond these, labels stop being readable and hostile values would build huge strings: decimal instead.
const MAX_ROMAN = 3999
const MAX_REPEATS = 30

function roman(value: number): string {
	if (value > MAX_ROMAN) return String(value)

	let out = ""
	let rest = value

	for (const [amount, digits] of ROMAN) {
		while (rest >= amount) {
			out += digits
			rest -= amount
		}
	}

	return out
}

// Word's alphabetic numbering repeats the letter: a … z, aa … zz, aaa ….
function letters(value: number): string {
	if (value <= 0) return ""

	const repeats = Math.floor((value - 1) / 26) + 1

	return repeats > MAX_REPEATS ? String(value) : String.fromCharCode(0x61 + ((value - 1) % 26)).repeat(repeats)
}

function ordinalSuffix(value: number): string {
	const tens = value % 100

	if (tens >= 11 && tens <= 13) return "th"

	return ["th", "st", "nd", "rd"][value % 10] ?? "th"
}

// A level number in MSONFC format. Formats without a Latin rendering here fall back to decimal.
export function formatNumber(value: number, nfc: number): string {
	switch (nfc) {
		case 0x01:
			return roman(value).toUpperCase()
		case 0x02:
			return roman(value)
		case 0x03:
			return letters(value).toUpperCase()
		case 0x04:
			return letters(value)
		case 0x05:
			return `${value}${ordinalSuffix(value)}`
		case 0x16:
			return value < 10 && value >= 0 ? `0${value}` : String(value)
		case NFC_BULLET:
		case NFC_NONE:
			return ""
		default:
			return String(value)
	}
}

export interface ListLabel {
	readonly lsid: number
	readonly level: DocLevel
	// The number text with placeholders filled, follow character excluded.
	readonly text: string
	// For bullet levels, the bullet as stored (0xF0xx: a symbol-font code point).
	readonly bullet: number | undefined
}

// Numbers paragraphs in reading order (§2.4.6.4 "Determining Level Number of a Paragraph"); one counter per lsid.
export class ListNumberer {
	private readonly lists: DocLists
	private readonly byLsid = new Map<number, DocListDef>()
	private readonly counters = new Map<number, (number | undefined)[]>()
	private readonly seenLfo = new Set<string>()

	constructor(lists: DocLists) {
		this.lists = lists

		for (const list of lists.lists) if (!this.byLsid.has(list.lsid)) this.byLsid.set(list.lsid, list)
	}

	level(
		ilfo: number,
		ilvl: number
	): { readonly list: DocListDef; readonly level: DocLevel; readonly override: DocLevelOverride | undefined } | undefined {
		const instance = this.lists.instances[ilfo - 1]

		if (instance === undefined) return undefined

		const list = this.byLsid.get(instance.lsid)

		if (list === undefined) return undefined

		const index = list.simple ? 0 : ilvl
		const override = instance.overrides.find(entry => entry.level === index)
		const level = override?.formatting ?? list.levels[index]

		return level === undefined ? undefined : { list, level, override }
	}

	next(ilfo: number, ilvl: number): ListLabel | undefined {
		if (ilfo <= 0) return undefined

		const found = this.level(ilfo, ilvl)

		if (found === undefined) return undefined

		const { list, level, override } = found
		const index = list.simple ? 0 : ilvl
		let counters = this.counters.get(list.lsid)

		if (counters === undefined) {
			counters = new Array<number | undefined>(9).fill(undefined)
			this.counters.set(list.lsid, counters)
		}

		// More significant levels restart deeper ones (unless their fNoRestart says otherwise).
		for (let deeper = index + 1; deeper < 9; deeper++) {
			const other = this.level(ilfo, deeper)?.level
			const limit = other?.noRestart === true ? other.restartLimit : deeper

			if (index < limit) counters[deeper] = undefined
		}

		const instanceKey = `${ilfo}:${index}`
		const firstUse = !this.seenLfo.has(instanceKey)

		this.seenLfo.add(instanceKey)

		const current = counters[index]

		if (firstUse && override?.startAt !== undefined) counters[index] = override.startAt
		else counters[index] = current === undefined ? level.start : Math.min(MAX_NUMBER, current + 1)

		const value = counters[index] ?? level.start

		if (level.nfc === NFC_BULLET) {
			const bullet = level.text.charCodeAt(0)

			// §2.4.6.4 part 2 step 3: a symbol-font bullet (0xF0xx) keeps its low byte.
			if (Number.isNaN(bullet)) return { lsid: list.lsid, level, text: "", bullet: undefined }

			return {
				lsid: list.lsid,
				level,
				text: String.fromCharCode((bullet & 0xff00) === 0xf000 ? bullet & 0x0fff : bullet) + level.text.slice(1),
				bullet
			}
		}

		let text = ""
		let previous = 0

		for (const offset of level.placeholders) {
			const placeholder = level.text.charCodeAt(offset)

			text += level.text.slice(previous, offset)
			previous = offset + 1

			if (placeholder > 8) {
				text += level.text.charAt(offset)
				continue
			}

			const other = placeholder === index ? level : this.level(ilfo, placeholder)?.level
			const number = placeholder === index ? value : (counters[placeholder] ?? other?.start ?? 0)
			const nfc = other === undefined ? NFC_DECIMAL : level.legal && other.nfc !== 0x16 ? NFC_DECIMAL : other.nfc

			text += formatNumber(number, nfc)
		}

		text += level.text.slice(previous)

		return { lsid: list.lsid, level, text, bullet: undefined }
	}
}

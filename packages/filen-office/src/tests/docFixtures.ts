import { cfbBytes, type CfbWriteEntry } from "@filen/office/core/cfb"
import { FC, type FcName } from "../core/doc/fib"

// Builds small Word 97 binary documents ([MS-DOC]) for reader tests: a Fib, text pieces, one CHPX and one PAPX
// FKP page, and any Table-stream structures given as raw bytes.

export interface PieceSpec {
	readonly text: string
	// 8-bit cp1252 storage; default true when every code unit fits a byte.
	readonly compressed?: boolean
	readonly prm?: number
	// Stored byte offset instead of where the text is written (to point outside the stream).
	readonly fc?: number
}

export interface RunSpec {
	// CP range [start, end).
	readonly start: number
	readonly end: number
	readonly grpprl: readonly number[]
}

export interface ParagraphSpec {
	// CP of the paragraph mark + 1.
	readonly end: number
	readonly istd?: number
	readonly grpprl?: readonly number[]
}

export interface DocSpec {
	readonly pieces: readonly PieceSpec[]
	readonly runs?: readonly RunSpec[]
	readonly paragraphs?: readonly ParagraphSpec[]
	// FibRgLw97 counts; text defaults to the whole text.
	readonly ccp?: Partial<Record<"text" | "ftn" | "hdd" | "atn" | "edn" | "txbx" | "hdrTxbx", number>>
	// Table-stream structures by Fib pair.
	readonly structures?: Partial<Record<FcName, Uint8Array>>
	// lcb for a structure shorter than its bytes (PlfLst does not count the LVLs after it).
	readonly lengths?: Partial<Record<FcName, number>>
	// Clx Prc grpprls (Prm1 igrpprl indexes these).
	readonly prcs?: readonly (readonly number[])[]
	readonly nFib?: number
	readonly wIdent?: number
	readonly flags?: number
	// FibBase.pnNext: the page of a template's AutoText document.
	readonly pnNext?: number
	// Bytes the Table stream starts with (an EncryptionHeader for encrypted files).
	readonly tablePrefix?: Uint8Array
	// Extra compound-file streams.
	readonly streams?: readonly CfbWriteEntry[]
	// Leave out the Table stream.
	readonly noTable?: boolean
}

class Writer {
	bytes: number[] = []

	u8(value: number): this {
		this.bytes.push(value & 0xff)
		return this
	}

	u16(value: number): this {
		return this.u8(value).u8(value >>> 8)
	}

	u32(value: number): this {
		return this.u16(value & 0xffff).u16(value >>> 16)
	}

	raw(values: ArrayLike<number>): this {
		for (let k = 0; k < values.length; k++) this.bytes.push((values[k] ?? 0) & 0xff)
		return this
	}

	pad(to: number): this {
		while (this.bytes.length < to) this.bytes.push(0)
		return this
	}

	get length(): number {
		return this.bytes.length
	}

	array(): Uint8Array {
		return Uint8Array.from(this.bytes)
	}
}

const FIB_PAIRS = 93
const TEXT_AT = 0x800

function fits8(text: string): boolean {
	for (let k = 0; k < text.length; k++) if (text.charCodeAt(k) > 0xff) return false

	return true
}

function chpxPage(runs: readonly { readonly fcStart: number; readonly fcEnd: number; readonly grpprl: readonly number[] }[]): Uint8Array {
	const page = new Uint8Array(512)
	const view = new DataView(page.buffer)
	const crun = runs.length
	let top = 511

	runs.forEach((run, k) => {
		view.setUint32(4 * k, run.fcStart, true)
		view.setUint32(4 * (k + 1), run.fcEnd, true)

		if (run.grpprl.length === 0) return

		top -= 1 + run.grpprl.length
		top &= ~1
		page[top] = run.grpprl.length
		page.set(run.grpprl, top + 1)
		page[4 * (crun + 1) + k] = top / 2
	})

	page[511] = crun

	return page
}

function papxPage(
	paragraphs: readonly { readonly fcStart: number; readonly fcEnd: number; readonly istd: number; readonly grpprl: readonly number[] }[]
): Uint8Array {
	const page = new Uint8Array(512)
	const view = new DataView(page.buffer)
	const cpara = paragraphs.length
	let top = 511

	paragraphs.forEach((paragraph, k) => {
		view.setUint32(4 * k, paragraph.fcStart, true)
		view.setUint32(4 * (k + 1), paragraph.fcEnd, true)

		const body = [paragraph.istd & 0xff, paragraph.istd >>> 8, ...paragraph.grpprl]
		const head = body.length % 2 === 1 ? [(body.length + 1) / 2] : [0, body.length / 2]

		top -= head.length + body.length
		top &= ~1
		page.set(head, top)
		page.set(body, top + head.length)
		page[4 * (cpara + 1) + 13 * k] = top / 2
	})

	page[511] = cpara

	return page
}

export async function buildDoc(spec: DocSpec): Promise<Uint8Array> {
	const word = new Writer()
	const table = new Writer()
	const text = spec.pieces.map(piece => piece.text).join("")

	if (spec.tablePrefix !== undefined) table.raw(spec.tablePrefix)

	// Text pieces, then their FcCompressed values.
	const texts = new Writer().pad(TEXT_AT)
	const pieceFcs: number[] = []
	const pieceStarts: number[] = []
	const compressedFlags: boolean[] = []
	let cp = 0

	for (const piece of spec.pieces) {
		const compressed = piece.compressed ?? fits8(piece.text)

		pieceFcs.push(texts.length)
		pieceStarts.push(cp)
		compressedFlags.push(compressed)

		for (let k = 0; k < piece.text.length; k++) {
			if (compressed) texts.u8(piece.text.charCodeAt(k))
			else texts.u16(piece.text.charCodeAt(k))
		}

		cp += piece.text.length
	}

	const pieceOf = (at: number): number => {
		let piece = 0

		while (piece + 1 < spec.pieces.length && (pieceStarts[piece + 1] ?? 0) <= at) piece++

		return piece
	}
	const widthAt = (at: number): number => (compressedFlags[pieceOf(at)] === true ? 1 : 2)
	const fcOf = (at: number): number => {
		const piece = pieceOf(at)

		return (pieceFcs[piece] ?? 0) + widthAt(at) * (at - (pieceStarts[piece] ?? 0))
	}

	const pagesAt = Math.ceil(texts.length / 512) * 512 + 512
	const runs = (spec.runs ?? []).map(run => ({
		fcStart: fcOf(run.start),
		fcEnd: fcOf(run.end - 1) + widthAt(run.end - 1),
		grpprl: run.grpprl
	}))
	let previous = 0
	const paragraphs = (spec.paragraphs ?? [{ end: text.length }]).map(paragraph => {
		const out = {
			fcStart: fcOf(previous),
			fcEnd: fcOf(paragraph.end - 1) + widthAt(paragraph.end - 1),
			istd: paragraph.istd ?? 0,
			grpprl: paragraph.grpprl ?? []
		}

		previous = paragraph.end

		return out
	})
	const chpx = chpxPage(
		runs.length > 0 ? runs : [{ fcStart: fcOf(0), fcEnd: fcOf(Math.max(0, text.length - 1)) + widthAt(text.length - 1), grpprl: [] }]
	)
	const papx = papxPage(paragraphs)
	const pairs = new Map<number, readonly [number, number]>()
	const place = (name: FcName, bytes: Uint8Array): void => {
		pairs.set(FC[name], [table.length, spec.lengths?.[name] ?? bytes.length])
		table.raw(bytes)
	}

	// Clx: Prcs, then the Pcdt.
	const clx = new Writer()

	for (const prc of spec.prcs ?? []) clx.u8(1).u16(prc.length).raw(prc)

	clx.u8(2).u32(4 * (spec.pieces.length + 1) + 8 * spec.pieces.length)

	for (const start of pieceStarts) clx.u32(start)

	clx.u32(text.length)

	spec.pieces.forEach((piece, k) => {
		const fc = piece.fc ?? pieceFcs[k] ?? 0

		clx.u16(0)
		clx.u32(compressedFlags[k] === true ? (fc * 2) | 0x40000000 : fc)
		clx.u16(piece.prm ?? 0)
	})

	place("clx", clx.array())
	place(
		"plcfBteChpx",
		new Writer()
			.u32(chpx.length > 0 ? fcOf(0) : 0)
			.u32(0x7fffffff)
			.u32(pagesAt / 512)
			.array()
	)
	place(
		"plcfBtePapx",
		new Writer()
			.u32(fcOf(0))
			.u32(0x7fffffff)
			.u32(pagesAt / 512 + 1)
			.array()
	)

	for (const [name, bytes] of Object.entries(spec.structures ?? {})) if (bytes !== undefined) place(name as FcName, bytes)

	const ccp = { text: text.length, ftn: 0, hdd: 0, atn: 0, edn: 0, txbx: 0, hdrTxbx: 0, ...spec.ccp }

	// Fib: FibBase, csw + FibRgW97, cslw + FibRgLw97, cbRgFcLcb + pairs, cswNew.
	word.u16(spec.wIdent ?? 0xa5ec)
		.u16(spec.nFib ?? 0xc1)
		.u16(0)
		.u16(0x0409)
		.u16(spec.pnNext ?? 0)
		.u16(spec.flags ?? 0x0200)
		.u16(0xbf)
		.u32(0)
		.u8(0)
		.u8(0)
	word.pad(32)
	word.u16(14).pad(32 + 2 + 28)
	word.u16(22)

	const lw = [0, 0, 0, ccp.text, ccp.ftn, ccp.hdd, 0, ccp.atn, ccp.edn, ccp.txbx, ccp.hdrTxbx]

	for (let k = 0; k < 22; k++) word.u32(lw[k] ?? 0)

	// FibRgFcLcb97 unless a structure needs a later Fib's pairs.
	const pairCount = Math.max(FIB_PAIRS, ...[...pairs.keys()].map(index => index + 1))

	word.u16(pairCount)

	for (let k = 0; k < pairCount; k++) {
		const [fc, lcb] = pairs.get(k) ?? [0, 0]

		word.u32(fc).u32(lcb)
	}

	word.u16(0)

	const fibBytes = word.array()
	const all = new Writer().raw(fibBytes).pad(TEXT_AT)

	all.raw(texts.array().subarray(TEXT_AT)).pad(pagesAt).raw(chpx).raw(papx)

	const entries: CfbWriteEntry[] = [{ path: ["WordDocument"], bytes: all.array() }, ...(spec.streams ?? [])]

	if (spec.noTable !== true) entries.push({ path: [(spec.flags ?? 0x0200) & 0x0200 ? "1Table" : "0Table"], bytes: table.array() })

	return cfbBytes(entries)
}

// Prl helpers.
export const prl = {
	toggle: (sprm: number, value: number): number[] => [sprm & 0xff, sprm >>> 8, value],
	u16: (sprm: number, value: number): number[] => [sprm & 0xff, sprm >>> 8, value & 0xff, (value >>> 8) & 0xff],
	u8: (sprm: number, value: number): number[] => [sprm & 0xff, sprm >>> 8, value & 0xff],
	u32: (sprm: number, value: number): number[] => [
		sprm & 0xff,
		sprm >>> 8,
		value & 0xff,
		(value >>> 8) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 24) & 0xff
	]
}

// A PLC: n + 1 CPs then n elements of `size` bytes.
export function plc(cps: readonly number[], elements: readonly (readonly number[])[] = []): Uint8Array {
	const out = new Writer()

	for (const cp of cps) out.u32(cp)

	for (const element of elements) out.raw(element)

	return out.array()
}

// An STSH with paragraph (stk 1) and character (stk 2) styles; each gets its grpprls.
export interface StyleSpec {
	readonly name: string
	readonly stk: 1 | 2
	readonly base?: number
	readonly papx?: readonly number[]
	readonly chpx?: readonly number[]
}

export function stsh(styles: readonly (StyleSpec | undefined)[], fonts: readonly [number, number, number] = [0, 0, 0]): Uint8Array {
	const out = new Writer()

	// LPStshi: cbStshi = 18 (Stshif only).
	out.u16(18).u16(styles.length).u16(10).u16(1).u16(0x5b).u16(15).u16(0).u16(fonts[0]).u16(fonts[1]).u16(fonts[2])

	styles.forEach((style, istd) => {
		if (style === undefined) {
			out.u16(0)
			return
		}

		const std = new Writer()
		const cupx = style.stk === 1 ? 2 : 1

		std.u16(istd === 0 ? 0 : 0xffe)
			.u16(style.stk | ((style.base ?? 0xfff) << 4))
			.u16(cupx | (istd << 4))
			.u16(0)
			.u16(0)
		std.u16(style.name.length)

		for (let k = 0; k < style.name.length; k++) std.u16(style.name.charCodeAt(k))

		std.u16(0)

		if (std.length % 2 === 1) std.u8(0)

		const upx = (bytes: readonly number[]): void => {
			std.u16(bytes.length).raw(bytes)

			if (bytes.length % 2 === 1) std.u8(0)
		}

		if (style.stk === 1) upx([istd & 0xff, istd >>> 8, ...(style.papx ?? [])])

		upx(style.chpx ?? [])

		out.u16(std.length).raw(std.bytes)

		if (std.length % 2 === 1) out.u8(0)
	})

	return out.array()
}

export interface LevelSpec {
	readonly nfc: number
	// Number text with placeholders as code units 0–8.
	readonly text: string
	readonly start?: number
	readonly follow?: number
}

// PlfLst with one nine-level list (lsid 1) whose levels are given (missing ones are decimal "n."), and PlfLfo
// with `instances` LFOs pointing at it.
export function lists(
	levels: readonly LevelSpec[],
	instances = 1
): { readonly plfLst: Uint8Array; readonly lstLength: number; readonly plfLfo: Uint8Array } {
	const lst = new Writer().u16(1).u32(1).u32(0)

	for (let k = 0; k < 9; k++) lst.u16(0xfff)

	lst.u8(0).u8(0)

	const lstLength = lst.length

	for (let k = 0; k < 9; k++) {
		const level = levels[k] ?? { nfc: 0, text: `${String.fromCharCode(k)}.` }
		const placeholders: number[] = []

		for (let n = 0; n < level.text.length; n++) if (level.text.charCodeAt(n) < 9) placeholders.push(n + 1)

		lst.u32(level.start ?? 1)
			.u8(level.nfc)
			.u8(0)

		for (let n = 0; n < 9; n++) lst.u8(placeholders[n] ?? 0)

		lst.u8(level.follow ?? 0)
			.u32(0)
			.u32(0)
			.u8(0)
			.u8(0)
			.u8(0)
			.u8(0)
		lst.u16(level.text.length)

		for (let n = 0; n < level.text.length; n++) lst.u16(level.text.charCodeAt(n))
	}

	const lfo = new Writer().u32(instances)

	for (let k = 0; k < instances; k++) lfo.u32(1).u32(0).u32(0).u8(0).u8(0).u8(0).u8(0)

	for (let k = 0; k < instances; k++) lfo.u32(0xffffffff)

	// The LVLs follow the PlfLst outside lcbPlfLst (pass lstLength as its length).
	return { plfLst: lst.array(), lstLength, plfLfo: lfo.array() }
}

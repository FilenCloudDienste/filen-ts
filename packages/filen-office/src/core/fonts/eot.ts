import { FontError } from "./errors"

// Embedded OpenType (W3C Member Submission "Embedded OpenType (EOT) File Format", 2008) and the MicroType
// Express compression it carries (W3C Member Submission "MicroType Express (MTX) Font Format", 2008): the
// .fntdata parts PowerPoint embeds. Decoding yields a plain TrueType font. Every size is checked before it is
// allocated, so a hostile file refuses (FontError) before it can exhaust memory.

export interface EotLimits {
	// Bytes of decoded font, and of each decompressed MTX block.
	readonly maxFontBytes: number
}

export const DEFAULT_EOT_LIMITS: EotLimits = { maxFontBytes: 32 * 1024 * 1024 }

export interface EotHeader {
	readonly version: number
	readonly flags: number
	readonly weight: number
	readonly italic: boolean
	readonly fsType: number
	readonly charset: number
	readonly familyName: string
	readonly styleName: string
	readonly fullName: string
	// Where FontData starts and how long it is.
	readonly fontOffset: number
	readonly fontLength: number
}

const EOT_MAGIC = 0x504c
const VERSIONS = new Set([0x00010000, 0x00020001, 0x00020002])
const TTEMBED_TTCOMPRESSED = 0x00000004
const TTEMBED_XORENCRYPTDATA = 0x10000000
const XOR_KEY = 0x50
const FIXED_HEADER = 82

const SFNT_TRUE = 0x00010000
const SFNT_APPLE = 0x74727565
const SFNT_CFF = 0x4f54544f

function u16le(bytes: Uint8Array, at: number): number {
	return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
}

function u32le(bytes: Uint8Array, at: number): number {
	return ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24)) >>> 0
}

function u32be(bytes: Uint8Array, at: number): number {
	return (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0
}

// Whether `bytes` start with a plain TrueType or OpenType font.
export function isSfnt(bytes: Uint8Array): boolean {
	if (bytes.length < 12) return false

	const signature = u32be(bytes, 0)

	return signature === SFNT_TRUE || signature === SFNT_APPLE || signature === SFNT_CFF
}

// Whether `bytes` look like an EOT structure (its magic number and a size that fits).
export function isEot(bytes: Uint8Array): boolean {
	return (
		bytes.length >= FIXED_HEADER && u16le(bytes, 34) === EOT_MAGIC && u32le(bytes, 0) <= bytes.length && VERSIONS.has(u32le(bytes, 8))
	)
}

function utf16le(bytes: Uint8Array, at: number, size: number): string {
	let out = ""

	for (let i = 0; i + 1 < size; i += 2) out += String.fromCharCode(u16le(bytes, at + i))

	return out
}

// The EMBEDDEDFONT header (§3): little-endian, its strings UTF-16LE. FontData is the structure's last member in
// every version, so it is located from EOTSize and FontDataSize.
export function readEotHeader(bytes: Uint8Array): EotHeader {
	if (bytes.length < FIXED_HEADER) throw new FontError("truncated", "Too short for an EOT header")
	if (u16le(bytes, 34) !== EOT_MAGIC) throw new FontError("notSfnt", "No EOT magic number")

	const size = u32le(bytes, 0)
	const fontLength = u32le(bytes, 4)
	const version = u32le(bytes, 8)

	if (!VERSIONS.has(version)) throw new FontError("unsupported", `EOT version 0x${version.toString(16)}`)
	if (size > bytes.length) throw new FontError("truncated", "The EOT structure is longer than its data")
	if (fontLength > size - FIXED_HEADER) throw new FontError("corrupt", "FontDataSize exceeds the EOT structure")

	let at = 82
	const strings: string[] = []

	// FamilyName, StyleName, VersionName and FullName, each after a 2-byte padding (the first padding is part of
	// the fixed header).
	for (let i = 0; i < 4; i++) {
		if (i > 0) at += 2

		const length = u16le(bytes, at)

		at += 2

		if (at + length > size - fontLength) throw new FontError("corrupt", "An EOT name runs into the font data")

		strings.push(utf16le(bytes, at, length))
		at += length
	}

	return {
		version,
		flags: u32le(bytes, 12),
		charset: bytes[26] ?? 0,
		italic: bytes[27] === 1,
		weight: u32le(bytes, 28),
		fsType: u16le(bytes, 32),
		familyName: strings[0] ?? "",
		styleName: strings[1] ?? "",
		fullName: strings[3] ?? "",
		fontOffset: size - fontLength,
		fontLength
	}
}

// The TrueType font an EOT carries: XOR-decrypted and MTX-decompressed as its flags say (§4.4: compression is
// applied first, so it is undone last).
export function decodeEot(bytes: Uint8Array, limits: EotLimits = DEFAULT_EOT_LIMITS): Uint8Array {
	const header = readEotHeader(bytes)
	let data = bytes.subarray(header.fontOffset, header.fontOffset + header.fontLength)

	if ((header.flags & TTEMBED_XORENCRYPTDATA) !== 0) {
		const plain = new Uint8Array(data.length)

		for (let i = 0; i < data.length; i++) plain[i] = (data[i] ?? 0) ^ XOR_KEY

		data = plain
	}

	if ((header.flags & TTEMBED_TTCOMPRESSED) !== 0) return decodeMtx(data, limits)
	if (!isSfnt(data)) throw new FontError("notSfnt", "The EOT font data is not a TrueType font")
	if (data.length > limits.maxFontBytes) throw new FontError("tooLarge", "The embedded font exceeds the size limit")

	const font = data.slice()

	if (clearCmapLanguages(font)) resum(font)

	return font
}

// Font bytes as a platform can load them: a plain sfnt as it is, an EOT decoded. Anything else refuses notSfnt.
export function embeddedFontData(bytes: Uint8Array, limits: EotLimits = DEFAULT_EOT_LIMITS): Uint8Array {
	if (isSfnt(bytes)) {
		if (bytes.length > limits.maxFontBytes) throw new FontError("tooLarge", "The embedded font exceeds the size limit")

		return bytes
	}

	if (isEot(bytes)) return decodeEot(bytes, limits)

	throw new FontError("notSfnt", "Neither a TrueType font nor an EOT")
}

// ---------------------------------------------------------------------------------------------------------------
// LZCOMP (MTX §3.3 and Appendix C): LZ77 copy items and literals as symbols of three adaptive Huffman trees.

const PRELOAD = 2 * 32 * 96 + 4 * 256
const MAX_2BYTE_DIST = 512
const DIST_WIDTH = 3
const LEN_WIDTH = 3

// The preloaded history every block starts from (InitializeModel).
let preloaded: Uint8Array | undefined

function preload(): Uint8Array {
	if (preloaded !== undefined) return preloaded

	const out = new Uint8Array(PRELOAD)
	let i = 0

	for (let k = 0; k < 32; k++) {
		for (let j = 0; j < 96; j++) {
			out[i++] = k
			out[i++] = j
		}
	}

	for (let j = 0; i < PRELOAD; j++) {
		out[i++] = j
		out[i++] = j
		out[i++] = j
		out[i++] = j
	}

	preloaded = out

	return out
}

class BitReader {
	private readonly bytes: Uint8Array
	private index = 0
	private count = 0
	private buffer = 0

	constructor(bytes: Uint8Array) {
		this.bytes = bytes
	}

	// Most significant bit first (MTX_BITIO_input_bit).
	bit(): number {
		if (this.count === 0) {
			if (this.index >= this.bytes.length) throw new FontError("truncated", "An MTX block ends early")

			this.buffer = this.bytes[this.index++] ?? 0
			this.count = 8
		}

		this.count--

		return (this.buffer >> this.count) & 1
	}

	value(bits: number): number {
		let value = 0

		for (let i = 0; i < bits; i++) value = value * 2 + this.bit()

		return value
	}
}

const ROOT = 1

// Adaptive Huffman coding over [0, range) (AHUFF.C): a sibling-ordered tree whose weights grow with each symbol.
class AdaptiveHuffman {
	private readonly up: Int32Array
	private readonly left: Int32Array
	private readonly right: Int32Array
	private readonly code: Int32Array
	private readonly weight: Int32Array
	private readonly symbolIndex: Int32Array
	private readonly bits: BitReader

	constructor(bits: BitReader, range: number) {
		const size = 2 * range

		this.bits = bits
		this.up = new Int32Array(size)
		this.left = new Int32Array(size)
		this.right = new Int32Array(size)
		this.code = new Int32Array(size)
		this.weight = new Int32Array(size)
		this.symbolIndex = new Int32Array(range)
		this.weight[0] = -1

		for (let i = 2; i < size; i++) {
			this.up[i] = i >> 1
			this.weight[i] = 1
		}

		for (let i = 1; i < range; i++) {
			this.left[i] = 2 * i
			this.right[i] = 2 * i + 1
		}

		for (let i = 0; i < range; i++) {
			this.code[i] = -1
			this.code[range + i] = i
			this.left[range + i] = -1
			this.right[range + i] = -1
			this.symbolIndex[i] = range + i
		}

		// init_weight: every internal node's children have larger indices.
		for (let i = range - 1; i >= ROOT; i--) this.weight[i] = (this.weight[2 * i] ?? 0) + (this.weight[2 * i + 1] ?? 0)

		if (range > 256 && range < 512) {
			this.update(this.symbolIndex[256] ?? 0)
			this.update(this.symbolIndex[257] ?? 0)

			for (let i = 0; i < 12; i++) this.update(this.symbolIndex[range - 3] ?? 0)
			for (let i = 0; i < 6; i++) this.update(this.symbolIndex[range - 2] ?? 0)
		} else {
			for (let pass = 0; pass < 2; pass++) {
				for (let i = 0; i < range; i++) this.update(this.symbolIndex[i] ?? 0)
			}
		}
	}

	read(): number {
		const left = this.left
		const right = this.right
		const code = this.code
		let a = ROOT
		let symbol: number

		do {
			a = this.bits.bit() === 1 ? (right[a] ?? 0) : (left[a] ?? 0)
			symbol = code[a] ?? 0
		} while (symbol < 0)

		this.update(a)

		return symbol
	}

	private swap(a: number, b: number): void {
		const up = this.up
		const left = this.left
		const right = this.right
		const code = this.code
		const weight = this.weight
		const upA = up[a] ?? 0
		const upB = up[b] ?? 0
		const leftA = left[a] ?? 0
		const rightA = right[a] ?? 0
		const codeA = code[a] ?? 0
		const weightA = weight[a] ?? 0

		left[a] = left[b] ?? 0
		right[a] = right[b] ?? 0
		code[a] = code[b] ?? 0
		weight[a] = weight[b] ?? 0
		left[b] = leftA
		right[b] = rightA
		code[b] = codeA
		weight[b] = weightA
		up[a] = upA
		up[b] = upB
		this.relink(a)
		this.relink(b)
	}

	private relink(node: number): void {
		const code = this.code[node] ?? 0

		if (code < 0) {
			this.up[this.left[node] ?? 0] = node
			this.up[this.right[node] ?? 0] = node
		} else {
			this.symbolIndex[code] = node
		}
	}

	// UpdateWeight: increments the node and its ancestors, swapping a node past the run of equal weights before it
	// so the sibling property holds.
	private update(start: number): void {
		const weight = this.weight
		const up = this.up
		let a = start

		while (a !== ROOT) {
			const w = weight[a] ?? 0
			let b = a - 1

			if (weight[b] === w) {
				do b--
				while (weight[b] === w)

				b++

				if (b > ROOT) {
					this.swap(a, b)
					a = b
				}
			}

			weight[a] = w + 1
			a = up[a] ?? ROOT
		}

		weight[ROOT] = (weight[ROOT] ?? 0) + 1
	}
}

// MTX_LZCOMP_UnPackMemory: one block decompressed. `version` is the MTX header's (1 has no run-length flag).
export function lzcompDecompress(block: Uint8Array, version: number, copyLimit: number, maxBytes: number): Uint8Array {
	if (block.length === 0) return new Uint8Array(0)

	const bits = new BitReader(block)
	const runLength = version === 1 ? false : bits.bit() === 1
	const dist = new AdaptiveHuffman(bits, 1 << DIST_WIDTH)
	const len = new AdaptiveHuffman(bits, 1 << LEN_WIDTH)
	const outLength = bits.value(24)

	if (outLength > maxBytes) throw new FontError("tooLarge", "An MTX block exceeds the size limit")

	// SetDistRange.
	let ranges = 1

	while (1 + (1 << (DIST_WIDTH * ranges)) - 1 < outLength) ranges++

	const dup2 = 256 + (1 << LEN_WIDTH) * ranges
	const dup4 = dup2 + 1
	const dup6 = dup2 + 2
	const sym = new AdaptiveHuffman(bits, dup6 + 1)
	// MTX_LZCOMP_Create2 never limits copies to less than the preload and a little more.
	const limit = Math.max(copyLimit, PRELOAD + 64)
	const history = new Uint8Array(PRELOAD + outLength)

	history.set(preload())

	let pos = PRELOAD
	const end = PRELOAD + outLength

	while (pos < end) {
		const symbol = sym.read()

		if (symbol < 256) {
			history[pos++] = symbol
		} else if (symbol === dup2) {
			history[pos] = history[pos - 2] ?? 0
			pos++
		} else if (symbol === dup4) {
			history[pos] = history[pos - 4] ?? 0
			pos++
		} else if (symbol === dup6) {
			history[pos] = history[pos - 6] ?? 0
			pos++
		} else {
			// DecodeLength: the first symbol carries the distance's symbol count and the first two length bits; a set
			// third bit means more length symbols follow.
			let bitsOf = symbol - 256
			const distRanges = Math.floor(bitsOf / (1 << LEN_WIDTH)) + 1

			if (distRanges > ranges) throw new FontError("corrupt", "An MTX copy has too many distance symbols")

			bitsOf %= 1 << LEN_WIDTH

			let length = 0

			for (;;) {
				length = length * 4 + (bitsOf & 3)

				if ((bitsOf & 4) === 0) break
				if (length > outLength) throw new FontError("corrupt", "An MTX copy is longer than its block")

				bitsOf = len.read()
			}

			length += 2

			let distance = 0

			for (let i = 0; i < distRanges; i++) distance = distance * 8 + dist.read()

			distance += 1

			if (distance >= MAX_2BYTE_DIST) length++

			const start = pos - distance - length + 1

			if (start < 0 || distance + length - 1 > limit || pos + length > end) {
				throw new FontError("corrupt", "An MTX copy reaches outside its history")
			}

			for (let j = 0; j < length; j++) history[pos + j] = history[start + j] ?? 0

			pos += length
		}
	}

	const data = history.subarray(PRELOAD)

	return runLength ? runLengthDecode(data, maxBytes) : data
}

// MTX_RUNLENGTHCOMP_SaveBytes: the first byte is the escape; escape, 0 is the escape byte itself; escape, n, b is
// n copies of b.
function runLengthDecode(data: Uint8Array, maxBytes: number): Uint8Array {
	if (data.length === 0) return data

	const escape = data[0] ?? 0
	let size = 0

	for (let i = 1; i < data.length;) {
		if (data[i] !== escape) {
			size++
			i++
		} else {
			const count = data[i + 1] ?? 0

			if (i + 1 >= data.length || (count !== 0 && i + 2 >= data.length)) throw new FontError("truncated", "An MTX run ends early")

			size += count === 0 ? 1 : count
			i += count === 0 ? 2 : 3
		}

		if (size > maxBytes) throw new FontError("tooLarge", "An MTX block exceeds the size limit")
	}

	const out = new Uint8Array(size)
	let at = 0

	for (let i = 1; i < data.length;) {
		const value = data[i] ?? 0

		if (value !== escape) {
			out[at++] = value
			i++
		} else {
			const count = data[i + 1] ?? 0

			if (count === 0) {
				out[at++] = escape
				i += 2
			} else {
				out.fill(data[i + 2] ?? 0, at, at + count)
				at += count
				i += 3
			}
		}
	}

	return out
}

// ---------------------------------------------------------------------------------------------------------------
// MTX container (§2) and the Compact Table Format (§4–§7).

const MTX_HEADER = 10

function u24(bytes: Uint8Array, at: number): number {
	return ((bytes[at] ?? 0) << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0)
}

export function decodeMtx(bytes: Uint8Array, limits: EotLimits = DEFAULT_EOT_LIMITS): Uint8Array {
	if (bytes.length < MTX_HEADER) throw new FontError("truncated", "Too short for an MTX font")

	const version = bytes[0] ?? 0
	const copyLimit = u24(bytes, 1)
	const offset2 = u24(bytes, 4)
	const offset3 = u24(bytes, 7)

	if (version < 1 || version > 3) throw new FontError("unsupported", `MTX version ${version}`)
	if (offset2 < MTX_HEADER || offset3 < offset2 || offset3 > bytes.length)
		throw new FontError("corrupt", "MTX block offsets are out of order")

	const max = limits.maxFontBytes
	const rest = lzcompDecompress(bytes.subarray(MTX_HEADER, offset2), version, copyLimit, max)
	const push = lzcompDecompress(bytes.subarray(offset2, offset3), version, copyLimit, max)
	const code = lzcompDecompress(bytes.subarray(offset3), version, copyLimit, max)

	return ctfToTtf(rest, push, code, max)
}

const TAG_GLYF = 0x676c7966
const TAG_LOCA = 0x6c6f6361
const TAG_CVT = 0x63767420
const TAG_HDMX = 0x68646d78
const TAG_VDMX = 0x56444d58
const TAG_HEAD = 0x68656164
const TAG_MAXP = 0x6d617870
const TAG_HHEA = 0x68686561
const TAG_HMTX = 0x686d7478
const TAG_CMAP = 0x636d6170
const MAC_PLATFORM = 1

interface CtfTable {
	readonly tag: number
	readonly offset: number
	readonly length: number
}

// A big-endian cursor that refuses reads past its end.
class Reader {
	readonly bytes: Uint8Array
	at: number
	readonly end: number

	constructor(bytes: Uint8Array, at: number = 0, end: number = bytes.length) {
		this.bytes = bytes
		this.at = at
		this.end = end
	}

	private need(count: number): void {
		if (this.at + count > this.end) throw new FontError("truncated", "Compact font data ends early")
	}

	u8(): number {
		this.need(1)

		return this.bytes[this.at++] ?? 0
	}

	u16(): number {
		this.need(2)

		const value = ((this.bytes[this.at] ?? 0) << 8) | (this.bytes[this.at + 1] ?? 0)

		this.at += 2

		return value
	}

	s16(): number {
		const value = this.u16()

		return value >= 0x8000 ? value - 0x10000 : value
	}

	u32(): number {
		const high = this.u16()

		return high * 0x10000 + this.u16()
	}

	take(count: number): Uint8Array {
		this.need(count)

		const out = this.bytes.subarray(this.at, this.at + count)

		this.at += count

		return out
	}

	// 255USHORT (§6.1.1).
	u255(): number {
		const code = this.u8()

		if (code === 253) return this.u16()
		if (code === 255) return 253 + this.u8()
		if (code === 254) return 506 + this.u8()

		return code
	}

	// 255SHORT (§6.1.2), as a signed 16-bit value.
	s255(): number {
		let code = this.u8()

		if (code === 253) {
			const value = this.u16()

			return value >= 0x8000 ? value - 0x10000 : value
		}

		let sign = 1

		if (code === 250) {
			sign = -1
			code = this.u8()
		}

		const value = code === 255 ? 250 + this.u8() : code === 254 ? 500 + this.u8() : code

		return sign * value
	}
}

// A growable big-endian byte sink, bounded by the font size limit.
class Writer {
	bytes: Uint8Array
	length = 0
	private readonly max: number

	constructor(initial: number, max: number) {
		this.bytes = new Uint8Array(Math.max(16, Math.min(initial, max)))
		this.max = max
	}

	reserve(count: number): void {
		const needed = this.length + count

		if (needed > this.max) throw new FontError("tooLarge", "The decoded font exceeds the size limit")
		if (needed <= this.bytes.length) return

		const grown = new Uint8Array(Math.min(this.max, Math.max(needed, this.bytes.length * 2)))

		grown.set(this.bytes.subarray(0, this.length))
		this.bytes = grown
	}

	u8(value: number): void {
		this.reserve(1)
		this.bytes[this.length++] = value & 0xff
	}

	u16(value: number): void {
		this.reserve(2)
		this.bytes[this.length++] = (value >> 8) & 0xff
		this.bytes[this.length++] = value & 0xff
	}

	u32(value: number): void {
		this.u16(Math.floor(value / 0x10000) & 0xffff)
		this.u16(value & 0xffff)
	}

	put(data: Uint8Array): void {
		this.reserve(data.length)
		this.bytes.set(data, this.length)
		this.length += data.length
	}

	pad4(): void {
		while ((this.length & 3) !== 0) this.u8(0)
	}

	result(): Uint8Array {
		return this.bytes.subarray(0, this.length)
	}
}

function readDirectory(rest: Uint8Array): CtfTable[] {
	const reader = new Reader(rest)

	reader.u32()

	const count = reader.u16()

	reader.at = 12

	const tables: CtfTable[] = []

	for (let i = 0; i < count; i++) {
		const tag = reader.u32()

		reader.u32()

		const offset = reader.u32()
		const length = reader.u32()

		if (tag !== TAG_LOCA && offset + length > rest.length) throw new FontError("corrupt", "A compact font table lies outside its block")

		tables.push({ tag, offset, length })
	}

	return tables
}

function find(tables: readonly CtfTable[], tag: number): CtfTable | undefined {
	return tables.find(table => table.tag === tag)
}

function view(rest: Uint8Array, table: CtfTable | undefined, minimum: number, name: string): Reader {
	if (table === undefined || table.length < minimum) throw new FontError("corrupt", `The compact font has no usable ${name} table`)

	return new Reader(rest, table.offset, table.offset + table.length)
}

interface FontFacts {
	readonly numGlyphs: number
	readonly unitsPerEm: number
	readonly longLoca: boolean
	readonly advances: Uint16Array
}

function factsOf(rest: Uint8Array, tables: readonly CtfTable[]): FontFacts {
	const head = view(rest, find(tables, TAG_HEAD), 54, "head")
	const maxp = view(rest, find(tables, TAG_MAXP), 6, "maxp")
	const hhea = view(rest, find(tables, TAG_HHEA), 36, "hhea")

	head.at += 18

	const unitsPerEm = head.u16()

	head.at += 30

	const longLoca = head.s16() === 1

	maxp.at += 4

	const numGlyphs = maxp.u16()

	hhea.at += 34

	const numberOfHMetrics = Math.min(hhea.u16(), numGlyphs)
	const advances = new Uint16Array(numGlyphs)
	const hmtx = find(tables, TAG_HMTX)

	if (hmtx !== undefined && numberOfHMetrics > 0 && hmtx.length >= numberOfHMetrics * 4) {
		const reader = new Reader(rest, hmtx.offset, hmtx.offset + hmtx.length)
		let last = 0

		for (let i = 0; i < numberOfHMetrics; i++) {
			last = reader.u16()
			advances[i] = last
			reader.u16()
		}

		advances.fill(last, numberOfHMetrics)
	}

	return { numGlyphs, unitsPerEm: Math.max(1, unitsPerEm), longLoca, advances }
}

// §5.2: n relative values, each coded in one to three bytes.
function decodeCvt(source: Reader, out: Writer): void {
	const count = source.u16()
	let value = 0

	out.reserve(count * 2)

	for (let i = 0; i < count; i++) {
		const code = source.u8()
		let delta: number

		if (code < 238) delta = code
		else if (code >= 248) delta = (code - 247) * 238 + source.u8()
		else if (code >= 239) delta = -((code - 239) * 238 + source.u8())
		else delta = source.s16()

		value = (value + delta) & 0xffff
		out.u16(value)
	}
}

// §5.3: magnitude-dependent values, bits least significant first.
class MagnitudeReader {
	private readonly source: Reader
	private bit = 8
	private byte = 0

	constructor(source: Reader) {
		this.source = source
	}

	private next(): number {
		if (this.bit === 8) {
			this.byte = this.source.u8()
			this.bit = 0
		}

		return (this.byte >> this.bit++) & 1
	}

	value(): number {
		let magnitude = 0

		while (this.next() === 1) {
			magnitude++

			if (magnitude > 0xffff) throw new FontError("corrupt", "A magnitude-coded value does not end")
		}

		if (magnitude === 0) return 0

		return this.next() === 1 ? -magnitude : magnitude
	}

	// The reader at the next whole byte.
	align(): void {
		this.bit = 8
	}
}

// §5.4: device widths as surprises over the hmtx prediction. A version of 0xFFFF minus the real one means the
// table is stored as it was.
function decodeHdmx(source: Reader, facts: FontFacts, out: Writer): void {
	const version = source.u16()

	if (version >= 0xff00) {
		out.u16(0xffff - version)
		out.put(source.take(source.end - source.at))

		return
	}

	const records = source.u16()
	const recordSize = source.u32()

	if (recordSize < facts.numGlyphs + 2 || recordSize > facts.numGlyphs + 2 + 3)
		throw new FontError("corrupt", "The hdmx record size does not fit the glyph count")

	const sizes: number[] = []
	const maxWidths: number[] = []

	for (let i = 0; i < records; i++) {
		sizes.push(source.u8())
		maxWidths.push(source.u8())
	}

	out.u16(version)
	out.u16(records)
	out.u32(recordSize)
	out.reserve(records * recordSize)

	const bits = new MagnitudeReader(source)
	const upem = facts.unitsPerEm

	for (let r = 0; r < records; r++) {
		const ppem = sizes[r] ?? 0

		out.u8(ppem)
		out.u8(maxWidths[r] ?? 0)

		for (let g = 0; g < facts.numGlyphs; g++) {
			const predicted = Math.floor((Math.floor((64 * ppem * (facts.advances[g] ?? 0) + Math.floor(upem / 2)) / upem) + 32) / 64)
			const width = predicted + bits.value()

			if (width < 0 || width > 255) throw new FontError("corrupt", "An hdmx width is out of range")

			out.u8(width)
		}

		for (let p = facts.numGlyphs + 2; p < recordSize; p++) out.u8(0)
	}
}

// §5.5: per group, pel heights and extremes as surprises over linear predictions.
function decodeVdmx(source: Reader, out: Writer): void {
	const start = source.at
	const version = source.u16()

	if (version >= 0xff00) {
		out.u16(0xffff - version)
		out.put(source.take(source.end - source.at))

		return
	}

	const groups = source.u16()
	const ratioCount = source.u16()
	const ratios = source.take(ratioCount * 4)
	const offsets: number[] = []

	for (let i = 0; i < ratioCount; i++) offsets.push(source.u16())

	if (groups > 0 && offsets.length === 0) throw new FontError("corrupt", "VDMX groups without ratios")

	// Written as decoded, through the size-bounded writer: the offsets are filled in once the groups' sizes are known.
	const table = out.length

	out.u16(version)
	out.u16(groups)
	out.u16(ratioCount)
	out.put(ratios)

	const offsetsAt = out.length

	for (let i = 0; i < ratioCount; i++) out.u16(0)

	const placed = new Map<number, number>()

	if (groups > 0) source.at = start + (offsets[0] ?? 0)

	for (let g = 0; g < groups; g++) {
		const ctf = source.at - start
		const recs = source.u16()
		const yMaxMult = source.s16()
		const yMinMult = source.s16()

		// Each record takes at least three bits of input, and its six bytes of output count against the limit first.
		if (recs * 3 > (source.end - source.at) * 8) throw new FontError("truncated", "VDMX records run past the table")

		out.reserve(4 + recs * 6)
		placed.set(ctf, out.length - table)
		out.u16(recs)

		const sizes = out.length

		out.u16(0)

		const bits = new MagnitudeReader(source)
		let predicted = 8
		let first = 0
		let last = 0

		for (let j = 0; j < recs; j++) {
			const ppem = predicted + bits.value()
			const yMax = Math.trunc((ppem * yMaxMult + 1024) / 2048) + bits.value()
			const yMin = -Math.trunc((ppem * yMinMult + 1024) / 2048) + bits.value()

			if (j === 0) first = ppem

			last = ppem
			out.u16(ppem & 0xffff)
			out.u16(yMax & 0xffff)
			out.u16(yMin & 0xffff)
			predicted = ppem + 1
		}

		out.bytes[sizes] = first & 0xff
		out.bytes[sizes + 1] = last & 0xff
		bits.align()
	}

	offsets.forEach((offset, i) => {
		const mapped = placed.get(offset)

		if (mapped === undefined) throw new FontError("corrupt", "A VDMX ratio names no group")

		out.bytes[offsetsAt + i * 2] = (mapped >> 8) & 0xff
		out.bytes[offsetsAt + i * 2 + 1] = mapped & 0xff
	})
}

// Glyph push data (§6.2): values with Hop3/Hop4 codes repeating the value two places back.
function readPushes(source: Reader, count: number, values: Int32Array): void {
	let i = 0

	while (i < count) {
		const code = source.bytes[source.at]

		if (code === 251 || code === 252) {
			if (i < 2) throw new FontError("corrupt", "A push hop code has no value to repeat")

			const repeat = values[i - 2] ?? 0
			const step = code === 251 ? 3 : 5

			if (i + step > count) throw new FontError("corrupt", "A push hop code overruns its glyph's pushes")

			source.at++
			values[i++] = repeat
			values[i++] = source.s255()
			values[i++] = repeat

			if (code === 252) {
				values[i++] = source.s255()
				values[i++] = repeat
			}
		} else {
			values[i++] = source.s255()
		}
	}
}

// TrueType PUSHB/NPUSHB and PUSHW/NPUSHW instructions that push `values` in order.
function writePushes(values: Int32Array, count: number, out: Writer): void {
	let i = 0

	while (i < count) {
		const bytes = (values[i] ?? 0) >= 0 && (values[i] ?? 0) <= 255
		let j = i

		while (j < count && j - i < 255 && ((values[j] ?? 0) >= 0 && (values[j] ?? 0) <= 255) === bytes) j++

		const run = j - i

		if (run <= 8) out.u8((bytes ? 0xb0 : 0xb8) + run - 1)
		else {
			out.u8(bytes ? 0x40 : 0x41)
			out.u8(run)
		}

		for (let k = i; k < j; k++) {
			if (bytes) out.u8(values[k] ?? 0)
			else out.u16((values[k] ?? 0) & 0xffff)
		}

		i = j
	}
}

// The length in bytes of the push instructions writePushes makes.
function pushesLength(values: Int32Array, count: number): number {
	let length = 0
	let i = 0

	while (i < count) {
		const bytes = (values[i] ?? 0) >= 0 && (values[i] ?? 0) <= 255
		let j = i

		while (j < count && j - i < 255 && ((values[j] ?? 0) >= 0 && (values[j] ?? 0) <= 255) === bytes) j++

		const run = j - i

		length += (run <= 8 ? 1 : 2) + run * (bytes ? 1 : 2)
		i = j
	}

	return length
}

const MORE_COMPONENTS = 0x0020
const ARG_1_AND_2_ARE_WORDS = 0x0001
const WE_HAVE_A_SCALE = 0x0008
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040
const WE_HAVE_A_TWO_BY_TWO = 0x0080
const WE_HAVE_INSTRUCTIONS = 0x0100
const MAX_POINTS = 0xffff

interface GlyphStreams {
	readonly glyf: Reader
	readonly push: Reader
	readonly code: Reader
	pushes: Int32Array
	xs: Int32Array
	ys: Int32Array
	flags: Uint8Array
}

function instructions(streams: GlyphStreams, out: Writer): void {
	const pushCount = streams.glyf.u255()
	const codeSize = streams.glyf.u255()

	if (streams.pushes.length < pushCount) streams.pushes = new Int32Array(Math.max(pushCount, streams.pushes.length * 2))

	readPushes(streams.push, pushCount, streams.pushes)

	const length = pushesLength(streams.pushes, pushCount) + codeSize

	if (length > 0xffff) throw new FontError("corrupt", "A glyph program is too long")

	out.u16(length)
	writePushes(streams.pushes, pushCount, out)
	out.put(streams.code.take(codeSize))
}

// One composite glyph (§5.10): the bounding box, the components as in TrueType, then the program if any.
function compositeGlyph(streams: GlyphStreams, contours: number, out: Writer): void {
	const glyf = streams.glyf
	const header = glyf.take(8)

	out.u16(contours & 0xffff)
	out.put(header)

	let flags: number

	do {
		flags = glyf.u16()

		const size =
			2 +
			((flags & ARG_1_AND_2_ARE_WORDS) !== 0 ? 4 : 2) +
			((flags & WE_HAVE_A_SCALE) !== 0
				? 2
				: (flags & WE_HAVE_AN_X_AND_Y_SCALE) !== 0
					? 4
					: (flags & WE_HAVE_A_TWO_BY_TWO) !== 0
						? 8
						: 0)

		out.u16(flags)
		out.put(glyf.take(size))
	} while ((flags & MORE_COMPONENTS) !== 0)

	if ((flags & WE_HAVE_INSTRUCTIONS) !== 0) instructions(streams, out)
}

// One simple glyph (§5.9, §5.11): contour sizes, triplet flags and deltas, then the program.
function simpleGlyph(streams: GlyphStreams, first: number, out: Writer): void {
	const glyf = streams.glyf
	let contours = first
	let box: [number, number, number, number] | undefined

	if (contours === 0x7fff) {
		contours = glyf.s16()
		box = [glyf.s16(), glyf.s16(), glyf.s16(), glyf.s16()]
	}

	if (contours < 0) throw new FontError("corrupt", "A glyph with a stored box has a negative contour count")

	const ends: number[] = []
	let points = 0

	// The first contour's end point, then each further contour's point count.
	for (let i = 0; i < contours; i++) {
		points += glyf.u255() + (i === 0 ? 1 : 0)

		if (points > MAX_POINTS) throw new FontError("corrupt", "A glyph has too many points")

		ends.push(points - 1)
	}

	if (streams.xs.length < points) {
		const size = Math.max(points, streams.xs.length * 2)

		streams.xs = new Int32Array(size)
		streams.ys = new Int32Array(size)
		streams.flags = new Uint8Array(size)
	}

	const xs = streams.xs
	const ys = streams.ys
	const flags = streams.flags
	const tripletFlags = glyf.take(points)
	let x = 0
	let y = 0
	let xMin = 0
	let yMin = 0
	let xMax = 0
	let yMax = 0

	for (let i = 0; i < points; i++) {
		const flag = tripletFlags[i] ?? 0
		const index = flag & 0x7f
		let dx: number
		let dy: number

		if (index < 10) {
			dx = 0
			dy = ((index & 14) << 7) + glyf.u8()
		} else if (index < 20) {
			dx = (((index - 10) & 14) << 7) + glyf.u8()
			dy = 0
		} else if (index < 84) {
			const b0 = index - 20
			const b1 = glyf.u8()

			dx = 1 + (b0 & 0x30) + (b1 >> 4)
			dy = 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f)
		} else if (index < 120) {
			const b0 = index - 84

			dx = 1 + (Math.floor(b0 / 12) << 8) + glyf.u8()
			dy = 1 + (((b0 % 12) >> 2) << 8) + glyf.u8()
		} else if (index < 124) {
			const b1 = glyf.u8()
			const b2 = glyf.u8()

			dx = (b1 << 4) + (b2 >> 4)
			dy = ((b2 & 0x0f) << 8) + glyf.u8()
		} else {
			dx = glyf.u16()
			dy = glyf.u16()
		}

		// A set sign bit means positive: the flag's lowest bit signs the only or the X delta, the next bit Y's.
		const ySign = index < 20 ? index & 1 : (index >> 1) & 1

		x += (index & 1) !== 0 ? dx : -dx
		y += ySign !== 0 ? dy : -dy
		xs[i] = x
		ys[i] = y
		flags[i] = (flag & 0x80) === 0 ? 1 : 0

		if (i === 0) {
			xMin = xMax = x
			yMin = yMax = y
		} else {
			if (x < xMin) xMin = x
			if (x > xMax) xMax = x
			if (y < yMin) yMin = y
			if (y > yMax) yMax = y
		}
	}

	const [bx0, by0, bx1, by1] = box ?? [xMin, yMin, xMax, yMax]

	out.u16(contours)
	out.u16(bx0 & 0xffff)
	out.u16(by0 & 0xffff)
	out.u16(bx1 & 0xffff)
	out.u16(by1 & 0xffff)

	for (const end of ends) out.u16(end)

	instructions(streams, out)
	writeOutline(xs, ys, flags, points, out)
}

const ON_CURVE = 0x01
const X_SHORT = 0x02
const Y_SHORT = 0x04
const REPEAT = 0x08
const X_SAME_OR_POSITIVE = 0x10
const Y_SAME_OR_POSITIVE = 0x20

// TrueType flags (repeat-compressed) and coordinate deltas for absolute points.
function writeOutline(xs: Int32Array, ys: Int32Array, onCurve: Uint8Array, points: number, out: Writer): void {
	const deltaFlags = new Uint8Array(points)
	let previousX = 0
	let previousY = 0
	let xBytes = 0
	let yBytes = 0

	for (let i = 0; i < points; i++) {
		const dx = (xs[i] ?? 0) - previousX
		const dy = (ys[i] ?? 0) - previousY
		let flag = onCurve[i] === 1 ? ON_CURVE : 0

		if (dx === 0) flag |= X_SAME_OR_POSITIVE
		else if (dx > -256 && dx < 256) {
			flag |= X_SHORT | (dx > 0 ? X_SAME_OR_POSITIVE : 0)
			xBytes += 1
		} else xBytes += 2

		if (dy === 0) flag |= Y_SAME_OR_POSITIVE
		else if (dy > -256 && dy < 256) {
			flag |= Y_SHORT | (dy > 0 ? Y_SAME_OR_POSITIVE : 0)
			yBytes += 1
		} else yBytes += 2

		deltaFlags[i] = flag
		previousX = xs[i] ?? 0
		previousY = ys[i] ?? 0
	}

	out.reserve(points * 2 + xBytes + yBytes)

	for (let i = 0; i < points;) {
		const flag = deltaFlags[i] ?? 0
		let run = 1

		while (i + run < points && deltaFlags[i + run] === flag && run < 256) run++

		if (run > 1) {
			out.u8(flag | REPEAT)
			out.u8(run - 1)
		} else out.u8(flag)

		i += run
	}

	for (const [values, short] of [
		[xs, X_SHORT],
		[ys, Y_SHORT]
	] as const) {
		let previous = 0

		for (let i = 0; i < points; i++) {
			const delta = (values[i] ?? 0) - previous
			const flag = deltaFlags[i] ?? 0

			previous = values[i] ?? 0

			if ((flag & short) !== 0) out.u8(Math.abs(delta))
			else if (delta !== 0) out.u16(delta & 0xffff)
		}
	}
}

function decodeGlyphs(
	rest: Uint8Array,
	glyf: CtfTable,
	push: Uint8Array,
	code: Uint8Array,
	numGlyphs: number,
	max: number
): { readonly glyf: Uint8Array; readonly offsets: Uint32Array } {
	const streams: GlyphStreams = {
		glyf: new Reader(rest, glyf.offset, glyf.offset + glyf.length),
		push: new Reader(push),
		code: new Reader(code),
		pushes: new Int32Array(64),
		xs: new Int32Array(256),
		ys: new Int32Array(256),
		flags: new Uint8Array(256)
	}
	const out = new Writer(glyf.length * 2 + code.length + push.length, max)
	const offsets = new Uint32Array(numGlyphs + 1)

	for (let g = 0; g < numGlyphs; g++) {
		offsets[g] = out.length

		const contours = streams.glyf.s16()
		if (contours < 0) compositeGlyph(streams, contours, out)
		else if (contours > 0) simpleGlyph(streams, contours, out)

		out.pad4()
	}

	offsets[numGlyphs] = out.length

	return { glyf: out.result(), offsets }
}

// Zeroes the language field of every cmap subtable outside the Macintosh platform (OpenType: it must be 0 there).
// PowerPoint's subsetter leaves garbage in it, which Windows ignores and Chromium's and Firefox's sanitisers refuse,
// the whole font with it. Whether anything changed.
function clearLanguages(data: DataView, offset: number, length: number): boolean {
	if (length < 4 || offset + length > data.byteLength) return false

	const end = offset + length
	const count = data.getUint16(offset + 2)
	let changed = false

	for (let k = 0; k < count && offset + 4 + k * 8 + 8 <= end; k++) {
		const record = offset + 4 + k * 8

		if (data.getUint16(record) === MAC_PLATFORM) continue

		const subtable = offset + data.getUint32(record + 4)

		if (subtable + 12 > end) continue

		const format = data.getUint16(subtable)

		if ((format === 0 || format === 2 || format === 4 || format === 6) && data.getUint16(subtable + 4) !== 0) {
			data.setUint16(subtable + 4, 0)
			changed = true
		} else if ((format === 8 || format === 10 || format === 12 || format === 13) && data.getUint32(subtable + 8) !== 0) {
			data.setUint32(subtable + 8, 0)
			changed = true
		}
	}

	return changed
}

// clearLanguages over a whole font's cmap.
function clearCmapLanguages(font: Uint8Array): boolean {
	const data = new DataView(font.buffer, font.byteOffset, font.byteLength)
	const count = data.getUint16(4)

	for (let k = 0; k < count && 12 + k * 16 + 16 <= font.length; k++) {
		if (data.getUint32(12 + k * 16) === TAG_CMAP)
			return clearLanguages(data, data.getUint32(12 + k * 16 + 8), data.getUint32(12 + k * 16 + 12))
	}

	return false
}

// A font's table checksums and head.checkSumAdjustment, written again.
function resum(font: Uint8Array): void {
	const data = new DataView(font.buffer, font.byteOffset, font.byteLength)
	const count = data.getUint16(4)
	let head = -1

	for (let k = 0; k < count && 12 + k * 16 + 16 <= font.length; k++) {
		const at = 12 + k * 16
		const offset = data.getUint32(at + 8)
		const length = data.getUint32(at + 12)

		if (offset + length > font.length) continue
		if (data.getUint32(at) === TAG_HEAD && length >= 12) {
			head = offset
			data.setUint32(offset + 8, 0)
		}

		data.setUint32(at + 4, checksum(font, offset, length))
	}

	if (head >= 0) data.setUint32(head + 8, (0xb1b0afba - checksum(font, 0, font.length)) >>> 0)
}

function checksum(bytes: Uint8Array, start: number, length: number): number {
	let sum = 0
	const end = start + length

	for (let i = start; i < end; i += 4) {
		sum = (sum + (((bytes[i] ?? 0) << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0))) >>> 0
	}

	return sum
}

// The TrueType font from the three decompressed blocks: tables copied, except glyf/loca rebuilt from the compact
// glyphs (with their push data and programs), and cvt, hdmx and VDMX expanded.
export function ctfToTtf(rest: Uint8Array, push: Uint8Array, code: Uint8Array, max: number = DEFAULT_EOT_LIMITS.maxFontBytes): Uint8Array {
	if (rest.length < 12) throw new FontError("truncated", "Too short for a compact font")

	const tables = readDirectory(rest)
	const facts = factsOf(rest, tables)
	const glyfTable = find(tables, TAG_GLYF)
	const glyphs = glyfTable === undefined ? undefined : decodeGlyphs(rest, glyfTable, push, code, facts.numGlyphs, max)
	const longLoca = glyphs !== undefined && (facts.longLoca || (glyphs.offsets[facts.numGlyphs] ?? 0) > 0x1fffe)
	const out = new Writer(rest.length * 2 + (glyphs?.glyf.length ?? 0), max)
	const count = tables.length

	out.put(rest.subarray(0, 12))
	out.reserve(count * 16)
	out.length += count * 16

	const records: { readonly tag: number; readonly offset: number; readonly length: number }[] = []
	let headOffset = -1

	for (const table of tables) {
		const offset = out.length

		if (table.tag === TAG_GLYF && glyphs !== undefined) out.put(glyphs.glyf)
		else if (table.tag === TAG_LOCA && glyphs !== undefined) {
			for (const value of glyphs.offsets) {
				if (longLoca) out.u32(value)
				else out.u16(value >> 1)
			}
		} else if (table.tag === TAG_CVT) decodeCvt(new Reader(rest, table.offset, table.offset + table.length), out)
		else if (table.tag === TAG_HDMX) decodeHdmx(new Reader(rest, table.offset, table.offset + table.length), facts, out)
		else if (table.tag === TAG_VDMX) decodeVdmx(new Reader(rest, table.offset, table.offset + table.length), out)
		else {
			if (table.tag === TAG_HEAD) headOffset = offset

			out.put(rest.subarray(table.offset, table.offset + table.length))
		}

		records.push({ tag: table.tag, offset, length: out.length - offset })
		out.pad4()
	}

	const font = out.result()
	const data = new DataView(font.buffer, font.byteOffset, font.byteLength)

	if (headOffset >= 0) {
		data.setInt16(headOffset + 50, longLoca ? 1 : 0)
		data.setUint32(headOffset + 8, 0)
	}

	const cmap = records.find(record => record.tag === TAG_CMAP)

	if (cmap !== undefined) clearLanguages(data, cmap.offset, cmap.length)

	records.forEach((record, i) => {
		const at = 12 + i * 16

		data.setUint32(at, record.tag)
		data.setUint32(at + 4, checksum(font, record.offset, record.length))
		data.setUint32(at + 8, record.offset)
		data.setUint32(at + 12, record.length)
	})

	if (headOffset >= 0) data.setUint32(headOffset + 8, (0xb1b0afba - checksum(font, 0, font.length)) >>> 0)

	return font
}

import { Unzlib } from "fflate"
import { decompress as brotliDecompress } from "brotli/decompress"
import { FontError } from "./errors"

// The tables of a WOFF or WOFF2 file, as the sfnt they wrap holds them, without rebuilding the sfnt. WOFF2's
// transformed tables (glyf, loca, a transformed hmtx) are only located, never reconstructed: outlines are the
// browser's to draw. Every length is checked against the file and every decompression is bounded by what the
// directory declares, so a hostile file fails with a FontError instead of growing without limit.

const WOFF = 0x774f4646 // "wOFF"
const WOFF2 = 0x774f4632 // "wOF2"
const COLLECTION = 0x74746366 // "ttcf"

const WOFF_HEADER = 44
const WOFF_ENTRY = 20
const WOFF2_HEADER = 48
const MAX_TABLES = 256
// Most a WOFF2 table stream may expand to. Real fonts stay far below; the stream is held whole while it is read.
export const WOFF2_MAX_STREAM_BYTES = 128 * 1024 * 1024
// fflate inflates all it is given before handing anything over, so a table goes in steps and stops at its length.
const INFLATE_STEP = 64 * 1024

// The 63 tags a WOFF2 table directory names by index, four characters each.
const KNOWN_TAGS =
	"cmapheadhheahmtxmaxpnameOS/2postcvt fpgmglyflocaprepCFF VORGEBDTEBLCgasphdmxkernLTSHPCLTVDMXvheavmtxBASEGDEFGPOSGSUBEBSCJSTF" +
	"MATHCBDTCBLCCOLRCPALSVG sbixacntavarbdatblocbslncvarfdscfeatfmtxfvargvarhstyjustlcarmortmorxopbdproptrakZapfSilfGlatGlocFeatSill"

export type FontContainer = "sfnt" | "woff" | "woff2"

// What a font file is by its first four bytes; null for none of these.
export function fontContainer(bytes: Uint8Array): FontContainer | null {
	if (bytes.length < 4) return null

	const signature = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0)

	if (signature === WOFF) return "woff"
	if (signature === WOFF2) return "woff2"
	if (signature === 0x00010000 || signature === 0x4f54544f || signature === 0x74727565) return "sfnt"

	return null
}

// The wrapped sfnt's version, every table's tag in directory order, and the wanted tables' bytes.
export interface FontTableSet {
	readonly container: FontContainer
	readonly flavor: number
	readonly tags: readonly string[]
	readonly tables: ReadonlyMap<string, Uint8Array>
}

function tagAt(data: DataView, offset: number): string {
	return String.fromCharCode(data.getUint8(offset), data.getUint8(offset + 1), data.getUint8(offset + 2), data.getUint8(offset + 3))
}

function checkFlavor(flavor: number): number {
	if (flavor === COLLECTION) throw new FontError("unsupported", "Font collections are not read here")

	return flavor
}

// Inflates a zlib stream into exactly `length` bytes, refusing one that holds more or less.
function inflateTable(compressed: Uint8Array, length: number, tag: string): Uint8Array {
	const out = new Uint8Array(length)
	let written = 0
	const unzlib = new Unzlib(chunk => {
		if (written + chunk.length > length) throw new FontError("corrupt", `Table ${tag} inflates past its length`)

		out.set(chunk, written)
		written += chunk.length
	})

	try {
		for (let at = 0; at < compressed.length; at += INFLATE_STEP) {
			unzlib.push(compressed.subarray(at, at + INFLATE_STEP), at + INFLATE_STEP >= compressed.length)
		}
	} catch (error) {
		if (error instanceof FontError) throw error

		throw new FontError("corrupt", `Table ${tag} does not inflate`)
	}

	if (written !== length) throw new FontError("corrupt", `Table ${tag} inflates short of its length`)

	return out
}

// A WOFF 1.0 file's tables; only those in `wanted` are inflated.
export function readWoffTables(bytes: Uint8Array, wanted: ReadonlySet<string>): FontTableSet {
	const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	if (bytes.length < WOFF_HEADER || data.getUint32(0) !== WOFF) throw new FontError("notSfnt", "Not a WOFF file")

	const flavor = checkFlavor(data.getUint32(4))
	const numTables = data.getUint16(12)

	if (numTables > MAX_TABLES) throw new FontError("corrupt", `${numTables} tables`)
	if (WOFF_HEADER + numTables * WOFF_ENTRY > bytes.length) throw new FontError("truncated", "Table directory is cut off")

	const tags: string[] = []
	const tables = new Map<string, Uint8Array>()

	for (let i = 0; i < numTables; i++) {
		const entry = WOFF_HEADER + i * WOFF_ENTRY
		const tag = tagAt(data, entry)
		const offset = data.getUint32(entry + 4)
		const compressedLength = data.getUint32(entry + 8)
		const length = data.getUint32(entry + 12)

		tags.push(tag)

		if (!wanted.has(tag) || tables.has(tag)) continue
		if (offset + compressedLength > bytes.length) throw new FontError("truncated", `Table ${tag} lies outside the file`)
		if (compressedLength > length) throw new FontError("corrupt", `Table ${tag} is longer compressed than whole`)

		const stored = bytes.subarray(offset, offset + compressedLength)

		tables.set(tag, compressedLength === length ? stored.slice() : inflateTable(stored, length, tag))
	}

	return { container: "woff", flavor, tags, tables }
}

interface Woff2Entry {
	readonly tag: string
	readonly transformed: boolean
	// Its length in the table stream: the transformed length for a transformed table.
	readonly length: number
}

// A WOFF2 file's table directory and where its compressed stream lies.
export interface Woff2Directory {
	readonly flavor: number
	readonly entries: readonly Woff2Entry[]
	readonly streamOffset: number
	readonly compressedLength: number
	// The decompressed stream's length: every table's, back to back.
	readonly streamLength: number
}

export function readWoff2Directory(bytes: Uint8Array): Woff2Directory {
	const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	if (bytes.length < WOFF2_HEADER || data.getUint32(0) !== WOFF2) throw new FontError("notSfnt", "Not a WOFF2 file")

	const flavor = checkFlavor(data.getUint32(4))
	const numTables = data.getUint16(12)
	const compressedLength = data.getUint32(20)

	if (numTables > MAX_TABLES) throw new FontError("corrupt", `${numTables} tables`)

	const entries: Woff2Entry[] = []
	let at = WOFF2_HEADER
	let streamLength = 0
	const byte = (): number => {
		if (at >= bytes.length) throw new FontError("truncated", "Table directory is cut off")

		return data.getUint8(at++)
	}
	const base128 = (): number => {
		let value = 0

		for (let i = 0; i < 5; i++) {
			const next = byte()

			if (i === 0 && next === 0x80) throw new FontError("corrupt", "UIntBase128 with a leading zero")

			value = value * 128 + (next & 0x7f)

			if (value > 0xffffffff) throw new FontError("corrupt", "UIntBase128 past 32 bits")
			if ((next & 0x80) === 0) return value
		}

		throw new FontError("corrupt", "UIntBase128 longer than 5 bytes")
	}

	for (let i = 0; i < numTables; i++) {
		const flags = byte()
		const index = flags & 0x3f
		let tag: string

		if (index === 63) {
			if (at + 4 > bytes.length) throw new FontError("truncated", "Table directory is cut off")

			tag = tagAt(data, at)
			at += 4
		} else {
			tag = KNOWN_TAGS.slice(index * 4, index * 4 + 4)
		}

		const version = flags >>> 6
		const origLength = base128()
		// glyf and loca use version 3 for "not transformed"; every other table uses 0.
		const transformed = tag === "glyf" || tag === "loca" ? version !== 3 : version !== 0
		const length = transformed ? base128() : origLength

		streamLength += length

		if (streamLength > WOFF2_MAX_STREAM_BYTES) throw new FontError("tooLarge", "The table stream is too large")

		entries.push({ tag, transformed, length })
	}

	if (at + compressedLength > bytes.length) throw new FontError("truncated", "The table stream lies outside the file")

	return { flavor, entries, streamOffset: at, compressedLength, streamLength }
}

// The wanted, untransformed tables out of a decompressed stream (views into it).
export function woff2Tables(directory: Woff2Directory, stream: Uint8Array, wanted: ReadonlySet<string>): Map<string, Uint8Array> {
	const tables = new Map<string, Uint8Array>()
	let offset = 0

	for (const entry of directory.entries) {
		if (wanted.has(entry.tag) && !entry.transformed && !tables.has(entry.tag)) {
			if (offset + entry.length > stream.length) throw new FontError("truncated", `Table ${entry.tag} lies past the stream`)

			tables.set(entry.tag, stream.subarray(offset, offset + entry.length))
		}

		offset += entry.length
	}

	return tables
}

interface ByteStreamLike {
	readonly writable: WritableStream<Uint8Array>
	readonly readable: ReadableStream<Uint8Array>
}

// The platform's brotli decoder, where it has one (Firefox, Safari; not Chromium).
function nativeBrotli(): ByteStreamLike | null {
	const Decompression = Reflect.get(globalThis, "DecompressionStream") as (new (format: string) => ByteStreamLike) | undefined

	if (typeof Decompression !== "function") return null

	try {
		return new Decompression("brotli")
	} catch {
		return null
	}
}

// Decompresses a brotli stream that holds exactly `length` bytes. Only the first `needed` bytes are wanted: the
// platform's decoder stops once it has them, the JavaScript one (brotli/decompress) decodes the whole stream into a
// buffer of exactly `length`, refusing more.
export async function decompressBrotli(compressed: Uint8Array, length: number, needed: number = length): Promise<Uint8Array> {
	const stream = nativeBrotli()

	if (stream === null) {
		try {
			return brotliDecompress(compressed, length)
		} catch {
			throw new FontError("corrupt", "The table stream does not decompress")
		}
	}

	const out = new Uint8Array(Math.min(needed, length))
	const writer = stream.writable.getWriter()
	const reader = stream.readable.getReader()
	let written = 0
	const feed = writer.write(compressed).then(
		() => writer.close(),
		() => undefined
	)

	feed.catch(() => undefined)

	try {
		while (written < out.length) {
			const chunk = await reader.read()

			if (chunk.done) break

			const take = Math.min(chunk.value.length, out.length - written)

			out.set(chunk.value.subarray(0, take), written)
			written += take
		}
	} catch {
		throw new FontError("corrupt", "The table stream does not decompress")
	} finally {
		await reader.cancel().catch(() => undefined)
		await writer.abort().catch(() => undefined)
	}

	if (written < out.length) throw new FontError("truncated", "The table stream ends early")

	return out
}

// A WOFF2 file's wanted, untransformed tables. The stream is decompressed up to the last wanted table only where the
// platform decoder allows it.
export async function readWoff2Tables(bytes: Uint8Array, wanted: ReadonlySet<string>): Promise<FontTableSet> {
	const directory = readWoff2Directory(bytes)
	let needed = 0
	let offset = 0

	for (const entry of directory.entries) {
		offset += entry.length

		if (wanted.has(entry.tag) && !entry.transformed) needed = offset
	}

	const compressed = bytes.subarray(directory.streamOffset, directory.streamOffset + directory.compressedLength)
	const stream = needed === 0 ? new Uint8Array(0) : await decompressBrotli(compressed, directory.streamLength, needed)

	return {
		container: "woff2",
		flavor: directory.flavor,
		tags: directory.entries.map(({ tag }) => tag),
		tables: woff2Tables(directory, stream, wanted)
	}
}

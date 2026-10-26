import { Inflate } from "fflate"
import { sliceClock, type SliceClock, type Slicing } from "../slicing"
import { decodeUtf8 } from "../xml/utf8"
import { crc32 } from "./crc32"
import { ZipError } from "./errors"
import type { ByteSource } from "./io"

export const EOCD_SIGNATURE = 0x06054b50
export const ZIP64_EOCD_SIGNATURE = 0x06064b50
export const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
export const CENTRAL_SIGNATURE = 0x02014b50
export const LOCAL_SIGNATURE = 0x04034b50
export const DESCRIPTOR_SIGNATURE = 0x08074b50
export const ZIP64_EXTRA_ID = 0x0001

export const METHOD_STORED = 0
export const METHOD_DEFLATE = 8

export const FLAG_ENCRYPTED = 0x0001
export const FLAG_DESCRIPTOR = 0x0008
export const FLAG_STRONG_ENCRYPTION = 0x0040
export const FLAG_UTF8 = 0x0800

// Fixed central-record fields that defer to the ZIP64 extra field.
export const ZIP64_UNCOMPRESSED = 1
export const ZIP64_COMPRESSED = 2
export const ZIP64_OFFSET = 4

const EOCD_SIZE = 22
const MAX_COMMENT = 0xffff
const ZIP64_LOCATOR_SIZE = 20
const ZIP64_EOCD_SIZE = 56
const CENTRAL_SIZE = 46
const LOCAL_SIZE = 30
// How far from the end an end record is looked for: the longest comment, plus junk some tools append.
const MAX_END_SEARCH = 1024 * 1024
const END_SEARCH_WINDOW = 256 * 1024
// End-record signatures tried before the search gives up: each costs reads, and a file can hold one every
// 22 bytes.
const MAX_END_CANDIDATES = 256
const READ_STEP = 1024 * 1024
// Compressed bytes per inflate step: one step expands at most ~1032-fold before the output is checked, so
// steps shrink as the declared size runs out. fflate holds a step's whole output twice (its buffer and the
// chunk it hands over), so its steps stay smaller than a native inflate's, which streams its output.
const MAX_FFLATE_STEP = 8 * 1024
const MAX_HOOK_STEP = 64 * 1024
const MIN_INFLATE_STEP = 1024
// Stored bytes CRC-checked between two looks at the clock.
const CRC_STEP = 1024 * 1024

// The code page zip names use when the UTF-8 flag is clear and the bytes are not UTF-8 either.
const CP437_HIGH =
	"ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ "

// One central-directory record. Plain data, so a zip plan holding entries can cross a thread or bridge.
export interface ZipEntry {
	readonly index: number
	readonly name: string
	// The name as stored, written back unchanged when the entry is copied or replaced.
	readonly nameBytes: Uint8Array
	readonly versionMadeBy: number
	readonly versionNeeded: number
	readonly flags: number
	readonly method: number
	readonly modTime: number
	readonly modDate: number
	readonly crc32: number
	readonly compressedSize: number
	readonly uncompressedSize: number
	// Where the local header really is (corrected for bytes prepended to the archive).
	readonly localHeaderOffset: number
	readonly internalAttributes: number
	readonly externalAttributes: number
	// Central-directory extra fields, minus the ZIP64 field (rewritten from the sizes on save).
	readonly extra: Uint8Array
	// Fields the central record left to its ZIP64 field (ZIP64_UNCOMPRESSED | ZIP64_COMPRESSED |
	// ZIP64_OFFSET), so a copy keeps that form even where the values would fit.
	readonly zip64Fields: number
	readonly comment: Uint8Array
}

export interface ZipLimits {
	readonly maxEntries: number
	// Sum of the declared uncompressed sizes.
	readonly maxTotalUncompressed: number
	readonly maxEntryUncompressed: number
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
	maxEntries: 20_000,
	maxTotalUncompressed: 512 * 1024 * 1024,
	maxEntryUncompressed: 512 * 1024 * 1024
}

// A raw-deflate decompressor to use instead of fflate's, e.g. a native DecompressionStream("deflate-raw").
// It must pull `input` only as it needs more, and stop when the caller stops iterating its output: that is
// how an entry outgrowing its declared size is cut off early.
export type InflateHook = (input: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>

export interface ZipOpenOptions {
	// Merged over DEFAULT_ZIP_LIMITS; a platform with less memory passes lower ones.
	readonly limits?: Partial<ZipLimits>
	readonly inflate?: InflateHook
}

function view(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function uint64(data: DataView, offset: number): number {
	const value = data.getUint32(offset, true) + data.getUint32(offset + 4, true) * 0x1_0000_0000

	if (!Number.isSafeInteger(value)) throw new ZipError("tooLarge", "Zip offset beyond 2^53")

	return value
}

// Walks extra fields as (id, size, data); the walk stops at a truncated field rather than failing, as
// several writers pad the extra area.
export function forEachExtraField(extra: Uint8Array, visit: (id: number, start: number, end: number) => void): void {
	const data = view(extra)
	let offset = 0

	while (offset + 4 <= extra.length) {
		const id = data.getUint16(offset, true)
		const size = data.getUint16(offset + 2, true)

		if (offset + 4 + size > extra.length) break

		visit(id, offset + 4, offset + 4 + size)
		offset += 4 + size
	}
}

export function withoutExtraField(extra: Uint8Array, removeId: number): Uint8Array {
	const kept: Uint8Array[] = []
	let total = 0

	forEachExtraField(extra, (id, start, end) => {
		if (id === removeId) return

		const field = extra.subarray(start - 4, end)

		kept.push(field)
		total += field.length
	})

	if (total === extra.length) return extra

	const out = new Uint8Array(total)
	let offset = 0

	for (const field of kept) {
		out.set(field, offset)
		offset += field.length
	}

	return out
}

function isUtf8(bytes: Uint8Array): boolean {
	for (let i = 0; i < bytes.length;) {
		const b0 = bytes[i] ?? 0
		const size = b0 < 0x80 ? 1 : b0 >= 0xc2 && b0 <= 0xdf ? 2 : b0 >= 0xe0 && b0 <= 0xef ? 3 : b0 >= 0xf0 && b0 <= 0xf4 ? 4 : 0

		if (size === 0 || i + size > bytes.length) return false

		for (let k = 1; k < size; k++) {
			if (((bytes[i + k] ?? 0) & 0xc0) !== 0x80) return false
		}

		i += size
	}

	return true
}

// Names flagged UTF-8 are UTF-8. Unflagged ones are CP437 by the format, but many writers store UTF-8
// without the flag: bytes that are valid UTF-8 are read as such, anything else as CP437, which maps every
// byte to its own character so distinct names never collide.
export function decodeEntryName(bytes: Uint8Array, flags: number): string {
	if ((flags & FLAG_UTF8) !== 0 || isUtf8(bytes)) return decodeUtf8(bytes)

	let name = ""

	for (const b of bytes) name += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH.charAt(b - 0x80)

	return name
}

function isCompoundFile(head: Uint8Array): boolean {
	return head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0 && head[4] === 0xa1 && head[5] === 0xb1
}

export interface EntryLayout {
	readonly dataOffset: number
	// Bytes after the data: an optional data descriptor (0 when the entry has none).
	readonly descriptorLength: number
}

// Where an entry's data starts and how long its trailing data descriptor is, from its local header. The
// descriptor layout varies (signature optional, 32- or 64-bit sizes), so it is matched against the
// central directory's CRC and sizes, 64-bit first when the local header carries a ZIP64 field (an empty
// entry matches both).
export async function readEntryLayout(source: ByteSource, entry: ZipEntry, limit: number = source.size): Promise<EntryLayout> {
	const nameLength = entry.nameBytes.length

	if (entry.localHeaderOffset + LOCAL_SIZE + nameLength > limit) {
		throw new ZipError("corrupt", `Local header of ${entry.name} outside the archive`)
	}

	const header = await source.read(entry.localHeaderOffset, LOCAL_SIZE + nameLength)
	const data = view(header)

	if (data.getUint32(0, true) !== LOCAL_SIGNATURE) {
		throw new ZipError("corrupt", `Missing local header for ${entry.name}`)
	}

	// A local name differing from the central one is how archives show different files to different readers.
	if (data.getUint16(26, true) !== nameLength || header.subarray(LOCAL_SIZE).some((b, k) => b !== entry.nameBytes[k])) {
		throw new ZipError("corrupt", `Local header name differs for ${entry.name}`)
	}

	const extraStart = entry.localHeaderOffset + LOCAL_SIZE + nameLength
	const extraLength = data.getUint16(28, true)
	const dataOffset = extraStart + extraLength
	const dataEnd = dataOffset + entry.compressedSize

	if (dataEnd > limit) throw new ZipError("corrupt", `Data of ${entry.name} runs past its bounds`)

	if ((entry.flags & FLAG_DESCRIPTOR) === 0) return { dataOffset, descriptorLength: 0 }

	let localZip64 = false

	if (extraLength > 0) forEachExtraField(await source.read(extraStart, extraLength), id => (localZip64 ||= id === ZIP64_EXTRA_ID))

	const available = Math.min(24, limit - dataEnd)
	const tail = view(await source.read(dataEnd, available))
	const matches = (at: number, wide: boolean): boolean => {
		const size = wide ? 20 : 12

		if (at + size > available || tail.getUint32(at, true) !== entry.crc32) return false

		if (wide) {
			return uint64(tail, at + 4) === entry.compressedSize && uint64(tail, at + 12) === entry.uncompressedSize
		}

		return (
			tail.getUint32(at + 4, true) === entry.compressedSize % 0x1_0000_0000 &&
			tail.getUint32(at + 8, true) === entry.uncompressedSize % 0x1_0000_0000
		)
	}
	const signed = available >= 4 && tail.getUint32(0, true) === DESCRIPTOR_SIGNATURE

	for (const wide of localZip64 ? [true, false] : [false, true]) {
		if (signed && matches(4, wide)) return { dataOffset, descriptorLength: wide ? 24 : 16 }
		if (matches(0, wide)) return { dataOffset, descriptorLength: wide ? 20 : 12 }
	}

	throw new ZipError("corrupt", `Data descriptor of ${entry.name} does not match the central directory`)
}

// Every record of the central directory, which must be consumed exactly. A declared count that disagrees
// (16-bit wrap past 65,535 entries, or a writer bug) does not hide records: all present are read.
function readCentralDirectory(directory: Uint8Array, delta: number, limits: ZipLimits): ZipEntry[] {
	const data = view(directory)
	const entries: ZipEntry[] = []
	const names = new Set<string>()
	let offset = 0
	let total = 0

	while (offset < directory.length) {
		if (offset + CENTRAL_SIZE > directory.length || data.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
			throw new ZipError("corrupt", "Damaged central directory")
		}

		if (entries.length === limits.maxEntries) throw new ZipError("tooManyEntries", "Too many zip entries")

		const flags = data.getUint16(offset + 8, true)
		const method = data.getUint16(offset + 10, true)
		const nameLength = data.getUint16(offset + 28, true)
		const extraLength = data.getUint16(offset + 30, true)
		const commentLength = data.getUint16(offset + 32, true)
		const nameStart = offset + CENTRAL_SIZE
		const extraStart = nameStart + nameLength
		const commentStart = extraStart + extraLength
		const next = commentStart + commentLength

		if (next > directory.length) throw new ZipError("corrupt", "Damaged central directory")

		if ((flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0) {
			throw new ZipError("encrypted", "Encrypted zip entries are not supported")
		}

		let compressedSize = data.getUint32(offset + 20, true)
		let uncompressedSize = data.getUint32(offset + 24, true)
		let localHeaderOffset = data.getUint32(offset + 42, true)
		const disk = data.getUint16(offset + 34, true)
		const extra = directory.subarray(extraStart, commentStart)
		const zip64Fields =
			(uncompressedSize === 0xffffffff ? ZIP64_UNCOMPRESSED : 0) |
			(compressedSize === 0xffffffff ? ZIP64_COMPRESSED : 0) |
			(localHeaderOffset === 0xffffffff ? ZIP64_OFFSET : 0)

		if (zip64Fields !== 0 || disk === 0xffff) {
			let found = false

			forEachExtraField(extra, (id, start, end) => {
				if (id !== ZIP64_EXTRA_ID || found) return

				const field = view(extra.subarray(start, end))
				let at = 0
				const take = (): number => {
					if (at + 8 > field.byteLength) throw new ZipError("corrupt", "Truncated ZIP64 extra field")

					const value = uint64(field, at)

					at += 8

					return value
				}

				found = true

				// Only the fields saturated in the fixed record are present, in this order.
				if (uncompressedSize === 0xffffffff) uncompressedSize = take()
				if (compressedSize === 0xffffffff) compressedSize = take()
				if (localHeaderOffset === 0xffffffff) localHeaderOffset = take()
			})

			if (!found) throw new ZipError("corrupt", "Missing ZIP64 extra field")
		}

		if (disk !== 0 && disk !== 0xffff) throw new ZipError("unsupported", "Multi-disk archives are not supported")

		const nameBytes = directory.slice(nameStart, extraStart)
		const name = decodeEntryName(nameBytes, flags)

		if (names.has(name)) throw new ZipError("duplicateName", `Duplicate entry ${name}`)

		names.add(name)

		if (method === METHOD_STORED && compressedSize !== uncompressedSize) {
			throw new ZipError("corrupt", `Stored entry ${name} declares two sizes`)
		}

		const size = method === METHOD_STORED ? compressedSize : uncompressedSize

		total += size

		if (size > limits.maxEntryUncompressed) throw new ZipError("tooLarge", `Entry ${name} inflates past the size limit`)
		if (total > limits.maxTotalUncompressed) throw new ZipError("tooLarge", "Archive inflates past the size limit")

		entries.push({
			index: entries.length,
			name,
			nameBytes,
			versionMadeBy: data.getUint16(offset + 4, true),
			versionNeeded: data.getUint16(offset + 6, true),
			flags,
			method,
			modTime: data.getUint16(offset + 12, true),
			modDate: data.getUint16(offset + 14, true),
			crc32: data.getUint32(offset + 16, true),
			compressedSize,
			uncompressedSize,
			localHeaderOffset: localHeaderOffset + delta,
			internalAttributes: data.getUint16(offset + 36, true),
			externalAttributes: data.getUint32(offset + 38, true),
			extra: withoutExtraField(extra.slice(), ZIP64_EXTRA_ID),
			zip64Fields,
			comment: directory.slice(commentStart, next)
		})

		offset = next
	}

	return entries
}

interface EndRecord {
	readonly count: number
	readonly directoryOffset: number
	readonly directorySize: number
	readonly comment: Uint8Array
	readonly zip64: boolean
	// Added to every stored offset: bytes prepended to the archive shift everything by this much.
	readonly delta: number
	readonly repaired: boolean
}

// Reads near the end record come from the search window already in hand; anything else is one ranged read.
class Peek {
	private readonly source: ByteSource
	private readonly window: Uint8Array
	private readonly windowStart: number

	constructor(source: ByteSource, window: Uint8Array, windowStart: number) {
		this.source = source
		this.window = window
		this.windowStart = windowStart
	}

	read(offset: number, length: number): Promise<Uint8Array> {
		const at = offset - this.windowStart

		return at >= 0 && at + length <= this.window.length
			? Promise.resolve(this.window.subarray(at, at + length))
			: this.source.read(offset, length)
	}

	async signature(offset: number, signature: number): Promise<boolean> {
		if (offset < 0 || offset + 4 > this.source.size) return false

		return view(await this.read(offset, 4)).getUint32(0, true) === signature
	}
}

// The end record at `at` if it leads to a central directory: at its declared offset, or at the offset its
// size implies when bytes were prepended to the archive. Otherwise null, so the search goes on (a comment
// or stored data can contain the signature).
async function endRecordAt(source: Peek, size: number, record: DataView, at: number): Promise<EndRecord | null> {
	let count = record.getUint16(10, true)
	let directorySize = record.getUint32(12, true)
	let directoryOffset = record.getUint32(16, true)
	const declaredComment = record.getUint16(20, true)
	const available = size - at - EOCD_SIZE
	// A comment running past the end is clamped; bytes after a shorter one are ignored.
	const commentLength = Math.min(declaredComment, available)
	const repaired = declaredComment !== available
	let directoryEnd = at
	let zip64 = false

	if (at >= ZIP64_LOCATOR_SIZE && (await source.signature(at - ZIP64_LOCATOR_SIZE, ZIP64_LOCATOR_SIGNATURE))) {
		const locator = view(await source.read(at - ZIP64_LOCATOR_SIZE, ZIP64_LOCATOR_SIZE))
		const declared = uint64(locator, 8)
		// Prepended bytes move the ZIP64 record too; without extensible data it sits right before the locator.
		const adjacent = at - ZIP64_LOCATOR_SIZE - ZIP64_EOCD_SIZE
		const recordOffset = (await source.signature(declared, ZIP64_EOCD_SIGNATURE)) ? declared : adjacent

		if (recordOffset < 0 || !(await source.signature(recordOffset, ZIP64_EOCD_SIGNATURE))) return null

		const zip64Record = view(await source.read(recordOffset, ZIP64_EOCD_SIZE))

		if (zip64Record.getUint32(16, true) !== 0 || zip64Record.getUint32(20, true) !== 0) {
			throw new ZipError("unsupported", "Multi-disk archives are not supported")
		}

		count = uint64(zip64Record, 32)
		directorySize = uint64(zip64Record, 40)
		directoryOffset = uint64(zip64Record, 48)
		directoryEnd = recordOffset
		zip64 = true
	} else if (record.getUint16(4, true) !== 0 || record.getUint16(6, true) !== 0) {
		throw new ZipError("unsupported", "Multi-disk archives are not supported")
	}

	if (directorySize > directoryEnd) return null

	const delta = directoryEnd - directorySize - directoryOffset
	const comment = await source.read(at + EOCD_SIZE, commentLength)
	const result = (shift: number): EndRecord => ({
		count,
		directoryOffset: directoryOffset + shift,
		directorySize,
		comment: comment.slice(),
		zip64,
		delta: shift,
		repaired: repaired || shift !== 0
	})

	if (directorySize === 0) return delta >= 0 ? result(0) : null
	if (directoryOffset + directorySize <= directoryEnd && (await source.signature(directoryOffset, CENTRAL_SIGNATURE))) return result(0)
	if (delta !== 0 && (await source.signature(directoryOffset + delta, CENTRAL_SIGNATURE))) return result(delta)

	return null
}

// The last valid end record, searched backwards from the end: first the longest possible comment's worth,
// then further back in overlapping windows up to MAX_END_SEARCH for junk appended after the archive.
async function findEndRecord(source: ByteSource): Promise<EndRecord | null> {
	const size = source.size
	let windowEnd = size
	let windowLength = EOCD_SIZE + MAX_COMMENT + ZIP64_LOCATOR_SIZE
	let candidates = 0

	while (windowEnd >= EOCD_SIZE && size - windowEnd < MAX_END_SEARCH) {
		const windowStart = Math.max(0, windowEnd - windowLength)
		const window = await source.read(windowStart, windowEnd - windowStart)
		const data = view(window)
		const peek = new Peek(source, window, windowStart)

		windowLength = END_SEARCH_WINDOW

		for (let at = window.length - EOCD_SIZE; at >= 0; at--) {
			if (window[at] !== 0x50 || data.getUint32(at, true) !== EOCD_SIGNATURE) continue
			if (++candidates > MAX_END_CANDIDATES) return null

			const found = await endRecordAt(peek, size, new DataView(window.buffer, window.byteOffset + at, EOCD_SIZE), windowStart + at)

			if (found !== null) return found
		}

		if (windowStart === 0) break

		// Overlap by a record's length less one, so a record across the boundary is seen whole.
		windowEnd = windowStart + EOCD_SIZE - 1
	}

	return null
}

// Output stream() aims each inflate step at.
const STREAM_CHUNK = 512 * 1024

async function* counted(chunks: AsyncIterable<Uint8Array>, count: (length: number) => void): AsyncGenerator<Uint8Array> {
	for await (const chunk of chunks) {
		count(chunk.length)

		yield chunk
	}
}

async function* steps(chunks: AsyncIterable<Uint8Array>, size: () => number): AsyncGenerator<Uint8Array> {
	for await (const chunk of chunks) {
		for (let at = 0; at < chunk.length;) {
			const end = Math.min(chunk.length, at + size())

			yield chunk.subarray(at, end)
			at = end
		}
	}
}

// Errors of the source's own reads (a network failure, a read refused as stale): they reach the caller as they are,
// never as damage of the deflate data they interrupted.
const sourceFailures = new WeakSet<Error>()

function sourceFailure(error: unknown): Error {
	const failure = error instanceof Error ? error : new Error(String(error))

	sourceFailures.add(failure)

	return failure
}

// A zip read through its central directory, without touching entry data until asked: opening reads the
// tail and the directory, an entry costs its local header and its own bytes. Every limit is checked
// before anything inflates, and inflating stops as soon as an entry outgrows its declared size.
// Damage that loses nothing is repaired on open (bytes before or after the archive, a wrong comment
// length or entry count): `repaired` says so, and a rewrite produces a clean archive.
export class ZipArchive {
	readonly source: ByteSource
	readonly entries: readonly ZipEntry[]
	readonly comment: Uint8Array
	// Whether the archive ends with ZIP64 records, which a rewrite keeps.
	readonly zip64: boolean
	readonly repaired: boolean
	// End of the entry data region (start of the central directory).
	readonly dataEnd: number
	private readonly byName = new Map<string, ZipEntry>()
	// Next local header (or the central directory) after each entry: no entry's bytes may cross it.
	private readonly bounds: Float64Array
	private readonly layouts = new Map<number, EntryLayout>()
	private readonly inflateHook: InflateHook | undefined

	private constructor(source: ByteSource, entries: ZipEntry[], end: EndRecord, inflateHook: InflateHook | undefined) {
		this.source = source
		this.entries = entries
		this.comment = end.comment
		this.zip64 = end.zip64
		this.repaired = end.repaired || entries.length !== end.count
		this.dataEnd = end.directoryOffset
		this.bounds = new Float64Array(entries.length)
		this.inflateHook = inflateHook

		for (const entry of entries) this.byName.set(entry.name, entry)

		// Entries may not overlap: overlapping entries are how a few kilobytes inflate to gigabytes.
		const order = entries
			.map(entry => entry.index)
			.sort((a, b) => (entries[a]?.localHeaderOffset ?? 0) - (entries[b]?.localHeaderOffset ?? 0))

		for (let k = 0; k < order.length; k++) {
			const entry = entries[order[k] ?? 0]

			if (entry === undefined) continue

			const next = k + 1 < order.length ? (entries[order[k + 1] ?? 0]?.localHeaderOffset ?? this.dataEnd) : this.dataEnd

			if (
				entry.localHeaderOffset < 0 ||
				entry.localHeaderOffset + LOCAL_SIZE + entry.nameBytes.length + entry.compressedSize > next
			) {
				throw new ZipError("corrupt", `Entry ${entry.name} overlaps the next one`)
			}

			this.bounds[entry.index] = next
		}
	}

	static async open(source: ByteSource, options: ZipOpenOptions = {}): Promise<ZipArchive> {
		const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, ...options.limits }

		if (source.size < EOCD_SIZE) throw new ZipError("notZip", "Not a zip archive")

		const end = await findEndRecord(source)

		if (end === null) {
			if (isCompoundFile(await source.read(0, Math.min(8, source.size)))) {
				throw new ZipError("compoundFile", "An OLE2 compound file (an encrypted document or a legacy binary format)")
			}

			throw new ZipError("notZip", "Not a zip archive")
		}

		if (end.count > limits.maxEntries) throw new ZipError("tooManyEntries", "Too many zip entries")

		const directory = await source.read(end.directoryOffset, end.directorySize)
		const entries = readCentralDirectory(directory, end.delta, limits)

		// Fewer records than declared means some are missing: refuse rather than drop them silently.
		if (entries.length < end.count) {
			throw new ZipError("truncated", "Central directory holds fewer entries than declared")
		}

		return new ZipArchive(source, entries, end, options.inflate)
	}

	get(name: string): ZipEntry | undefined {
		return this.byName.get(name)
	}

	async layout(entry: ZipEntry): Promise<EntryLayout> {
		let layout = this.layouts.get(entry.index)

		if (layout === undefined) {
			layout = await readEntryLayout(this.source, entry, this.bounds[entry.index] ?? this.dataEnd)
			this.layouts.set(entry.index, layout)
		}

		return layout
	}

	// The entry's bytes as stored (compressed for deflated entries).
	async raw(entry: ZipEntry): Promise<Uint8Array> {
		const { dataOffset } = await this.layout(entry)

		return this.source.read(dataOffset, entry.compressedSize)
	}

	// The entry's content: inflated, size- and CRC-checked. A stored entry is a view of the source bytes.
	read(entry: ZipEntry): Promise<Uint8Array> {
		return this.content(entry, undefined)
	}

	// read() giving the host a turn between inflate (or CRC) steps whenever the slice is used up.
	readSliced(entry: ZipEntry, slicing: Slicing): Promise<Uint8Array> {
		return this.content(entry, sliceClock(slicing))
	}

	// The entry's content in chunks, never held whole: what one inflate step gives (kept near STREAM_CHUNK by sizing
	// the steps to the ratio seen so far), or views of a stored entry. A chunk is the caller's only until the next one
	// is asked for. Size and CRC are checked as read() checks them, the CRC once the last chunk was handed over, so a
	// caller keeps nothing it read until the stream ends without an error.
	async *stream(entry: ZipEntry): AsyncGenerator<Uint8Array, void, undefined> {
		if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
			throw new ZipError("unsupported", `Compression method ${entry.method} of ${entry.name} is not supported`)
		}

		const { dataOffset } = await this.layout(entry)
		let crc = 0
		let written = 0

		if (entry.method === METHOD_STORED) {
			for (let read = 0; read < entry.compressedSize;) {
				const length = Math.min(STREAM_CHUNK, entry.compressedSize - read)
				const chunk = await this.source.read(dataOffset + read, length)

				crc = crc32(chunk, crc)
				read += length

				yield chunk
			}

			if (crc !== entry.crc32) throw new ZipError("corrupt", `CRC mismatch in ${entry.name}`)

			return
		}

		const size = entry.uncompressedSize
		const take = (chunk: Uint8Array): void => {
			if (written + chunk.length > size) throw new ZipError("corrupt", `${entry.name} inflates past its declared size`)

			crc = crc32(chunk, crc)
			written += chunk.length
		}
		let consumed = 0
		// Compressed bytes per step: what yields about STREAM_CHUNK at the ratio seen so far, never past what the entry
		// may still produce (as read() steps).
		const stepSize = (): number => {
			const ratio = consumed === 0 ? 1032 : Math.max(1, written / consumed)

			return Math.max(MIN_INFLATE_STEP, Math.min(MAX_HOOK_STEP, Math.floor(STREAM_CHUNK / ratio), Math.ceil((size - written) / 1024)))
		}
		const input = steps(this.compressed(entry, dataOffset), stepSize)
		// Set while the caller holds a chunk: what it throws is its own, not damage.
		let yielding = false

		try {
			if (this.inflateHook !== undefined) {
				for await (const chunk of this.inflateHook(counted(input, length => (consumed += length)))) {
					take(chunk)
					yielding = true
					yield chunk
					yielding = false
				}
			} else {
				const pending: Uint8Array[] = []
				const inflater = new Inflate(chunk => pending.push(chunk))

				for await (const step of input) {
					consumed += step.length
					inflater.push(step, consumed === entry.compressedSize)

					for (const chunk of pending) take(chunk)

					yielding = true

					for (const chunk of pending) yield chunk

					yielding = false
					pending.length = 0
				}

				if (entry.compressedSize === 0) inflater.push(new Uint8Array(0), true)
			}
		} catch (error) {
			if (error instanceof ZipError || yielding || (error instanceof Error && sourceFailures.has(error))) throw error

			throw new ZipError("corrupt", `Damaged deflate data in ${entry.name}`)
		}

		if (written !== size) throw new ZipError("corrupt", `${entry.name} is shorter than its declared size`)
		if (crc !== entry.crc32) throw new ZipError("corrupt", `CRC mismatch in ${entry.name}`)
	}

	private async content(entry: ZipEntry, clock: SliceClock | undefined): Promise<Uint8Array> {
		if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
			throw new ZipError("unsupported", `Compression method ${entry.method} of ${entry.name} is not supported`)
		}

		const { dataOffset } = await this.layout(entry)

		if (entry.method === METHOD_DEFLATE) return this.inflate(entry, dataOffset, clock)

		const out = await this.source.read(dataOffset, entry.compressedSize)
		let crc = 0

		for (let at = 0; at < out.length; at += CRC_STEP) {
			crc = crc32(out.subarray(at, Math.min(out.length, at + CRC_STEP)), crc)

			if (clock?.due === true) await clock.pause()
		}

		if (crc !== entry.crc32) throw new ZipError("corrupt", `CRC mismatch in ${entry.name}`)

		return out
	}

	private async *compressed(entry: ZipEntry, dataOffset: number): AsyncGenerator<Uint8Array> {
		for (let read = 0; read < entry.compressedSize;) {
			const length = Math.min(READ_STEP, entry.compressedSize - read)

			let bytes: Uint8Array

			try {
				bytes = await this.source.read(dataOffset + read, length)
			} catch (error) {
				throw sourceFailure(error)
			}

			yield bytes
			read += length
		}
	}

	// No compression-ratio limit: deflate legitimately reaches ~1030:1 on uniform data, and nothing needs
	// one. Memory is bounded by the declared-size limits (the output buffer is the declared size, and its
	// untouched pages stay unbacked) and by the overflow cut-off below; CPU by both plus one step. The CRC
	// is taken as the output arrives.
	private async inflate(entry: ZipEntry, dataOffset: number, clock: SliceClock | undefined): Promise<Uint8Array> {
		const out = new Uint8Array(entry.uncompressedSize)
		let written = 0
		let crc = 0
		let overflow = false
		const accept = (chunk: Uint8Array): void => {
			if (overflow) return

			if (written + chunk.length > out.length) {
				overflow = true

				return
			}

			out.set(chunk, written)
			crc = crc32(chunk, crc)
			written += chunk.length
		}
		// Small enough that one step cannot expand far past what the entry may still produce.
		const maxStep = this.inflateHook === undefined ? MAX_FFLATE_STEP : MAX_HOOK_STEP
		const stepSize = (): number => Math.min(maxStep, Math.max(MIN_INFLATE_STEP, Math.ceil((out.length - written) / 1024)))
		const input = steps(this.compressed(entry, dataOffset), stepSize)
		// Set while the host has its turn: what that throws (a cancelled open) is not damage.
		let pausing = false

		try {
			if (this.inflateHook !== undefined) {
				for await (const chunk of this.inflateHook(input)) {
					accept(chunk)

					if (overflow) break

					if (clock?.due === true) {
						pausing = true
						await clock.pause()
						pausing = false
					}
				}
			} else {
				const inflater = new Inflate(accept)
				let consumed = 0

				for await (const step of input) {
					consumed += step.length
					inflater.push(step, consumed === entry.compressedSize)

					if (overflow) break

					if (clock?.due === true) {
						pausing = true
						await clock.pause()
						pausing = false
					}
				}

				if (entry.compressedSize === 0) inflater.push(new Uint8Array(0), true)
			}
		} catch (error) {
			if (error instanceof ZipError || pausing || (error instanceof Error && sourceFailures.has(error))) throw error

			throw new ZipError("corrupt", `Damaged deflate data in ${entry.name}`)
		}

		if (overflow) throw new ZipError("corrupt", `${entry.name} inflates past its declared size`)
		if (written !== out.length) throw new ZipError("corrupt", `${entry.name} is shorter than its declared size`)
		if (crc !== entry.crc32) throw new ZipError("corrupt", `CRC mismatch in ${entry.name}`)

		return out
	}
}

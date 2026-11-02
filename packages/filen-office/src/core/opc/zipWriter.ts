import { appendAll } from "../arrays"
import { Deflate, deflateSync } from "fflate"
import { encodeUtf8 } from "../xml/utf8"
import { crc32 } from "./crc32"
import { sliceClock, type SliceClock, type Slicing } from "../slicing"
import { ZipError } from "./errors"
import type { ByteSink, ByteSource } from "./io"
import type { ByteChunks, PartBytes } from "./pieces"
import {
	CENTRAL_SIGNATURE,
	EOCD_SIGNATURE,
	FLAG_UTF8,
	LOCAL_SIGNATURE,
	METHOD_DEFLATE,
	METHOD_STORED,
	ZIP64_EOCD_SIGNATURE,
	ZIP64_EXTRA_ID,
	ZIP64_COMPRESSED,
	ZIP64_LOCATOR_SIGNATURE,
	ZIP64_OFFSET,
	ZIP64_UNCOMPRESSED,
	ZipArchive,
	readEntryLayout,
	type ZipEntry
} from "./zipReader"

// One output entry: either an original entry copied as stored (local header, compressed data and data
// descriptor byte for byte, nothing re-deflated), or new content. A replaced part passes the entry it
// replaces as `template`, keeping its timestamps, attributes and extra fields.
export type ZipPlanItem =
	| { readonly kind: "copy"; readonly entry: ZipEntry }
	| {
			readonly kind: "data"
			readonly name: string
			readonly bytes: PartBytes
			readonly compress: boolean
			readonly template?: ZipEntry
			// The CRC-32 the content must have (see PartChange.crc32).
			readonly crc32?: number
			// When the content was made, stamped in DOS local time (APPNOTE 4.4.6); without it (and no
			// template) the DOS epoch.
			readonly modified?: Date
	  }

// A run of content already raw-deflated, spliced into an entry's stream as is: non-final blocks ending on a byte
// boundary (a sync flush), from a fresh stream (no back-reference before its start). `crc` and `size` are those
// of the bytes it inflates to.
export interface DeflatedPiece {
	readonly deflated: Uint8Array
	readonly crc: number
	readonly size: number
}

// Pieces of which some are already deflated: a compressed entry takes them through pieces(), the others
// through chunks() (raw throughout).
export interface DeflatedChunks extends ByteChunks {
	pieces(): AsyncIterable<Uint8Array | DeflatedPiece>
}

export interface ZipPlan {
	readonly items: readonly ZipPlanItem[]
	readonly comment?: Uint8Array
	// End with ZIP64 records even when nothing needs them (kept from an archive that had them).
	readonly zip64End?: boolean
}

// New entries as something makes them (one at a time, each asked for once the one before was written out): an
// archive streamed while its content is still being made, holding one entry's content at a time.
export interface StreamedZipPlan {
	readonly items: AsyncIterable<ZipPlanItem>
	readonly comment?: Uint8Array
	readonly zip64End?: boolean
}

export interface WriteZipOptions {
	readonly level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
	// Raw deflate for new content in place of fflate's, e.g. a native CompressionStream("deflate-raw")
	// where the host has one: several times faster on large parts. `level` does not apply to it.
	readonly deflate?: (data: Uint8Array) => Promise<Uint8Array>
	// The same for content given as pieces (ByteChunks), streamed through without joining it. Without it,
	// fflate's streaming deflate.
	readonly deflateChunks?: (chunks: AsyncIterable<Uint8Array>) => Promise<Uint8Array>
	// ZIP64 fields and end records on everything, as some writers always emit.
	readonly forceZip64?: boolean
	readonly copyChunkSize?: number
	// Gives the host a turn between chunks once its slice is up (checksumming large new parts is long work).
	readonly slicing?: Slicing
}

export interface WriteZipReport {
	readonly size: number
	readonly entries: number
	// Entry name -> CRC-32 of each new entry's content as it was fed to the writer.
	readonly crcs: ReadonlyMap<string, number>
	// Entry name -> CRC-32 and length of each copied entry's raw bytes (local header to the end of its data,
	// descriptor included) as the source checksummed them (ByteSource.readChecked; none without it): the copy
	// can be checked against them without reading the original again.
	readonly copies: ReadonlyMap<string, { readonly crc: number; readonly length: number }>
}

const MAX_32 = 0xffffffff
const MAX_16 = 0xffff
// 1980-01-01 00:00, the DOS epoch: what Word stamps on every entry, and deterministic.
const DOS_EPOCH_DATE = (1 << 5) | 1
const DOS_LAST_YEAR = 2107

// A local time as a DOS date and time (two-second steps); outside the years DOS can hold, the nearest end.
function dosTime(at: Date): { readonly time: number; readonly date: number } {
	const year = at.getFullYear()

	if (Number.isNaN(year) || year < 1980) return { time: 0, date: DOS_EPOCH_DATE }
	if (year > DOS_LAST_YEAR) return { time: (23 << 11) | (59 << 5) | 29, date: ((DOS_LAST_YEAR - 1980) << 9) | (12 << 5) | 31 }

	return {
		time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
		date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()
	}
}
const VERSION_DEFLATE = 20
const VERSION_ZIP64 = 45
// Writes smaller than this are gathered into one chunk, so a sink behind a bridge sees few calls.
const BATCH = 64 * 1024

class BatchingSink {
	private readonly sink: ByteSink
	private buffer = new Uint8Array(BATCH)
	private filled = 0
	written = 0

	constructor(sink: ByteSink) {
		this.sink = sink
	}

	async write(chunk: Uint8Array): Promise<void> {
		this.written += chunk.length

		if (chunk.length >= BATCH) {
			await this.flush()
			await this.sink.write(chunk)

			return
		}

		if (this.filled + chunk.length > BATCH) await this.flush()

		this.buffer.set(chunk, this.filled)
		this.filled += chunk.length
	}

	async flush(): Promise<void> {
		if (this.filled === 0) return

		// The sink may keep what it is handed: a full batch buffer is handed over and replaced, a partial one copied out
		// (a view would pin the whole buffer for a few bytes, before every large entry of a kept zip) and reused.
		let chunk: Uint8Array

		if (this.filled === BATCH) {
			chunk = this.buffer
			this.buffer = new Uint8Array(BATCH)
		} else {
			chunk = this.buffer.slice(0, this.filled)
		}

		this.filled = 0

		await this.sink.write(chunk)
	}
}

interface CentralRecord {
	readonly versionMadeBy: number
	readonly versionNeeded: number
	readonly flags: number
	readonly method: number
	readonly modTime: number
	readonly modDate: number
	readonly crc32: number
	readonly compressedSize: number
	readonly uncompressedSize: number
	readonly localHeaderOffset: number
	readonly internalAttributes: number
	readonly externalAttributes: number
	readonly nameBytes: Uint8Array
	readonly extra: Uint8Array
	readonly comment: Uint8Array
	readonly zip64Fields: number
	// Position in the central directory: the original entry's index, new entries after all of them.
	readonly order: number
}

function zip64Field(values: readonly number[]): Uint8Array {
	const field = new Uint8Array(4 + values.length * 8)
	const data = new DataView(field.buffer)

	data.setUint16(0, ZIP64_EXTRA_ID, true)
	data.setUint16(2, values.length * 8, true)

	values.forEach((value, k) => setUint64(data, 4 + k * 8, value))

	return field
}

function setUint64(data: DataView, offset: number, value: number): void {
	data.setUint32(offset, value % 0x1_0000_0000, true)
	data.setUint32(offset + 4, Math.floor(value / 0x1_0000_0000), true)
}

// Forced ZIP64 leaves the sizes of stored entries alone: ODF requires its stored "mimetype" entry to carry
// no extra field, and a stored entry under 4 GiB never needs one.
function forcesSizes(record: CentralRecord, forceZip64: boolean): boolean {
	return forceZip64 && record.method !== METHOD_STORED
}

function centralBytes(record: CentralRecord, forceZip64: boolean): Uint8Array {
	const fields = record.zip64Fields
	const forceSizes = forcesSizes(record, forceZip64)
	const wideUncompressed = forceSizes || (fields & ZIP64_UNCOMPRESSED) !== 0 || record.uncompressedSize >= MAX_32
	const wideCompressed = forceSizes || (fields & ZIP64_COMPRESSED) !== 0 || record.compressedSize >= MAX_32
	const wideOffset = forceZip64 || (fields & ZIP64_OFFSET) !== 0 || record.localHeaderOffset >= MAX_32
	const zip64Values: number[] = []

	if (wideUncompressed) zip64Values.push(record.uncompressedSize)
	if (wideCompressed) zip64Values.push(record.compressedSize)
	if (wideOffset) zip64Values.push(record.localHeaderOffset)

	const zip64 = zip64Values.length > 0 ? zip64Field(zip64Values) : new Uint8Array(0)
	const extraLength = zip64.length + record.extra.length

	if (extraLength > MAX_16 || record.nameBytes.length > MAX_16 || record.comment.length > MAX_16) {
		throw new ZipError("tooLarge", "Zip entry header fields too long")
	}

	const out = new Uint8Array(46 + record.nameBytes.length + extraLength + record.comment.length)
	const data = new DataView(out.buffer)

	data.setUint32(0, CENTRAL_SIGNATURE, true)
	data.setUint16(4, record.versionMadeBy, true)
	data.setUint16(6, zip64.length > 0 ? Math.max(record.versionNeeded, VERSION_ZIP64) : record.versionNeeded, true)
	data.setUint16(8, record.flags, true)
	data.setUint16(10, record.method, true)
	data.setUint16(12, record.modTime, true)
	data.setUint16(14, record.modDate, true)
	data.setUint32(16, record.crc32, true)
	data.setUint32(20, wideCompressed ? MAX_32 : record.compressedSize, true)
	data.setUint32(24, wideUncompressed ? MAX_32 : record.uncompressedSize, true)
	data.setUint16(28, record.nameBytes.length, true)
	data.setUint16(30, extraLength, true)
	data.setUint16(32, record.comment.length, true)
	data.setUint16(34, 0, true)
	data.setUint16(36, record.internalAttributes, true)
	data.setUint32(38, record.externalAttributes, true)
	data.setUint32(42, wideOffset ? MAX_32 : record.localHeaderOffset, true)

	let offset = 46

	out.set(record.nameBytes, offset)
	offset += record.nameBytes.length
	out.set(zip64, offset)
	offset += zip64.length
	out.set(record.extra, offset)
	offset += record.extra.length
	out.set(record.comment, offset)

	return out
}

function localBytes(record: CentralRecord, forceZip64: boolean): Uint8Array {
	const wide = forcesSizes(record, forceZip64) || record.uncompressedSize >= MAX_32 || record.compressedSize >= MAX_32
	const zip64 = wide ? zip64Field([record.uncompressedSize, record.compressedSize]) : new Uint8Array(0)
	const out = new Uint8Array(30 + record.nameBytes.length + zip64.length)
	const data = new DataView(out.buffer)

	data.setUint32(0, LOCAL_SIGNATURE, true)
	data.setUint16(4, wide ? Math.max(record.versionNeeded, VERSION_ZIP64) : record.versionNeeded, true)
	data.setUint16(6, record.flags, true)
	data.setUint16(8, record.method, true)
	data.setUint16(10, record.modTime, true)
	data.setUint16(12, record.modDate, true)
	data.setUint32(14, record.crc32, true)
	data.setUint32(18, wide ? MAX_32 : record.compressedSize, true)
	data.setUint32(22, wide ? MAX_32 : record.uncompressedSize, true)
	data.setUint16(26, record.nameBytes.length, true)
	data.setUint16(28, zip64.length, true)
	out.set(record.nameBytes, 30)
	out.set(zip64, 30 + record.nameBytes.length)

	return out
}

function endRecords(count: number, directoryOffset: number, directorySize: number, comment: Uint8Array, forceZip64: boolean): Uint8Array {
	const zip64 = forceZip64 || count >= MAX_16 || directoryOffset >= MAX_32 || directorySize >= MAX_32
	const out = new Uint8Array((zip64 ? 56 + 20 : 0) + 22 + comment.length)
	const data = new DataView(out.buffer)
	let offset = 0

	if (zip64) {
		data.setUint32(0, ZIP64_EOCD_SIGNATURE, true)
		setUint64(data, 4, 44)
		data.setUint16(12, VERSION_ZIP64, true)
		data.setUint16(14, VERSION_ZIP64, true)
		setUint64(data, 24, count)
		setUint64(data, 32, count)
		setUint64(data, 40, directorySize)
		setUint64(data, 48, directoryOffset)
		data.setUint32(56, ZIP64_LOCATOR_SIGNATURE, true)
		setUint64(data, 64, directoryOffset + directorySize)
		data.setUint32(72, 1, true)
		offset = 76
	}

	data.setUint32(offset, EOCD_SIGNATURE, true)
	data.setUint16(offset + 8, zip64 ? MAX_16 : count, true)
	data.setUint16(offset + 10, zip64 ? MAX_16 : count, true)
	data.setUint32(offset + 12, zip64 ? MAX_32 : directorySize, true)
	data.setUint32(offset + 16, zip64 ? MAX_32 : directoryOffset, true)
	data.setUint16(offset + 20, comment.length, true)
	out.set(comment, offset + 22)

	return out
}

function isAscii(bytes: Uint8Array): boolean {
	for (let i = 0; i < bytes.length; i++) {
		if ((bytes[i] ?? 0) >= 0x80) return false
	}

	return true
}

interface EntryContent {
	// The CRC the archive records.
	readonly crc: number
	// Bytes stored in the archive (compressed or not).
	readonly size: number
	data(): AsyncIterable<Uint8Array>
	// The CRC of what was fed, once data() was read through.
	fed(): number
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
	yield bytes
}

async function* many(parts: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
	yield* parts
}

// fflate's streaming deflate over pieces.
async function deflateStream(chunks: AsyncIterable<Uint8Array>, level: WriteZipOptions["level"]): Promise<Uint8Array> {
	const parts: Uint8Array[] = []
	const deflate = new Deflate({ level: level ?? 6 }, chunk => {
		parts.push(chunk)
	})

	for await (const chunk of chunks) deflate.push(chunk)

	deflate.push(new Uint8Array(0), true)

	return parts.length === 1 && parts[0] !== undefined ? parts[0] : joinChunks(parts)
}

function joinChunks(parts: readonly Uint8Array[]): Uint8Array {
	let size = 0

	for (const part of parts) size += part.length

	const out = new Uint8Array(size)
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

function hasDeflated(bytes: ByteChunks): bytes is DeflatedChunks {
	return typeof (bytes as Partial<DeflatedChunks>).pieces === "function"
}

const CRC_POLY = 0xedb88320

// a(x)·b(x) mod the CRC polynomial, bit-reflected (zlib's multmodp).
function multModP(a: number, b: number): number {
	let m = 0x80000000
	let p = 0

	for (;;) {
		if ((a & m) !== 0) {
			p ^= b

			if ((a & (m - 1)) === 0) break
		}

		m >>>= 1
		b = b & 1 ? (b >>> 1) ^ CRC_POLY : b >>> 1
	}

	return p >>> 0
}

// x^(2^k) mod the CRC polynomial.
const X2N = (() => {
	const table = new Uint32Array(32)
	let p = 0x40000000

	table[0] = p

	for (let k = 1; k < 32; k++) table[k] = p = multModP(p, p)

	return table
})()

// The CRC of a + b from crc(a), crc(b) and b's length (zlib's crc32_combine).
function crc32Combine(first: number, second: number, length: number): number {
	// x^(8·length): length in bits, k from 3.
	let p = 0x80000000
	let k = 3

	for (let n = length; n > 0; n = Math.floor(n / 2), k++) {
		if (n % 2 === 1) p = multModP(X2N[k & 31] ?? 0, p)
	}

	return (multModP(p, first) ^ second) >>> 0
}

// An empty final block (fixed Huffman): closes a stream that ends on a sync flush.
const FINAL_EMPTY_BLOCK = new Uint8Array([0x03, 0x00])

// The sync flush that follows an empty final fixed-Huffman block's bits (BFINAL 1, BTYPE 01, end-of-block code
// 0000000; RFC 1951 3.2.3, 3.2.6) when they start at bit `at` of `last`'s first byte, whose lower bits end the
// data: that block rewritten as an empty non-final stored block (header 000, byte-aligned, LEN 0, NLEN FFFF).
// At level 0 the stream ends in an empty final stored block instead, byte-aligned: only BFINAL is cleared.
function syncTrailer(last: Uint8Array): Uint8Array | undefined {
	const first = last[0] ?? 0
	let at: number

	if (last.length === 5 && first === 1 && last[1] === 0 && last[2] === 0 && last[3] === 0xff && last[4] === 0xff) {
		return new Uint8Array([0, 0, 0, 0xff, 0xff])
	}

	if (last.length === 3 && last[1] === 1 && last[2] === 0 && first >= 0x80) at = 7
	else if (last.length === 2 && last[1] === 0 && first >= 2) {
		const high = 31 - Math.clz32(first)

		if ((first & (1 << (high - 1))) === 0) return undefined

		at = high - 1
	} else return undefined

	const data = first & ((1 << at) - 1)

	return at + 3 > 8 ? new Uint8Array([data, 0, 0, 0, 0xff, 0xff]) : new Uint8Array([data, 0, 0, 0xff, 0xff])
}

// A raw deflate stream that ends with a sync flush (non-final, byte-aligned), so other deflated content can follow
// it in one stream. fflate's flush(true) misplaces the stored block when the last byte is partly written: the
// data is flushed unsynced, the stream ended, and its empty final block rewritten (syncTrailer).
export class SyncDeflate {
	private readonly parts: Uint8Array[] = []
	private size = 0
	private readonly stream: Deflate

	constructor(level: NonNullable<WriteZipOptions["level"]>) {
		this.stream = new Deflate({ level }, chunk => {
			this.parts.push(chunk)
			this.size += chunk.length
		})
	}

	push(chunk: Uint8Array): void {
		this.stream.push(chunk)
	}

	// The stream's pieces and their total length, ending in the sync flush (or a final block when `final`).
	end(final: boolean): { readonly parts: Uint8Array[]; readonly size: number } {
		if (final) {
			this.stream.push(new Uint8Array(0), true)

			return { parts: this.parts, size: this.size }
		}

		this.stream.flush(false)

		const count = this.parts.length

		this.stream.push(new Uint8Array(0), true)

		const last = this.parts.pop()
		const trailer = last !== undefined && this.parts.length === count ? syncTrailer(last) : undefined

		if (last === undefined || trailer === undefined) throw new ZipError("unsupported", "Deflate stream did not end as expected")

		this.parts.push(trailer)
		this.size += trailer.length - last.length

		return { parts: this.parts, size: this.size }
	}
}

// One raw deflate stream over pieces some of which are already deflated: each run of raw pieces is deflated by
// a fresh stream ending in a sync flush (back-references cannot reach across a spliced piece), the deflated ones
// spliced in between, CRCs combined.
async function deflateMixed(
	bytes: DeflatedChunks,
	level: WriteZipOptions["level"],
	clock: SliceClock | undefined
): Promise<{ readonly parts: readonly Uint8Array[]; readonly size: number; readonly crc: number }> {
	const parts: Uint8Array[] = []
	let stream: SyncDeflate | undefined = undefined
	let crc = 0
	let fed = 0
	const close = (final: boolean): void => {
		if (stream !== undefined) appendAll(parts, stream.end(final).parts)

		stream = undefined
	}

	for await (const piece of bytes.pieces()) {
		if (piece instanceof Uint8Array) {
			for (let at = 0; at < piece.length; at += DEFLATE_SLICE) {
				const slice = piece.subarray(at, Math.min(piece.length, at + DEFLATE_SLICE))

				crc = crc32(slice, crc)
				stream ??= new SyncDeflate(level ?? 6)
				stream.push(slice)

				if (clock?.due === true) await clock.pause()
			}

			fed += piece.length

			continue
		}

		if (piece.size === 0) continue

		close(false)
		crc = crc32Combine(crc, piece.crc, piece.size)
		fed += piece.size
		parts.push(piece.deflated)
	}

	if (fed !== bytes.length) throw new ZipError("corrupt", `Entry content is ${fed} bytes, not ${bytes.length}`)

	if (stream !== undefined) close(true)
	else parts.push(FINAL_EMPTY_BLOCK)

	let size = 0

	for (const part of parts) size += part.length

	return { parts, size, crc }
}

// Bytes checksummed between looks at the slice clock.
const CRC_SLICE = 1 << 20
// Bytes deflated between looks at the slice clock (deflate is far slower than a checksum).
const DEFLATE_SLICE = 1 << 18

// A new entry's content as the archive stores it, with the CRC of what it holds. Pieces are streamed: read
// once to checksum and deflate (twice when stored: the CRC goes before the data).
async function dataOf(item: Extract<ZipPlanItem, { kind: "data" }>, options: WriteZipOptions): Promise<EntryContent> {
	const bytes = item.bytes
	const clock = options.slicing === undefined ? undefined : sliceClock(options.slicing)

	// Deflated on a clock, joined bytes go through the sliced stream below.
	if (bytes instanceof Uint8Array && !(item.compress && clock !== undefined && options.deflate === undefined)) {
		const data = !item.compress
			? bytes
			: options.deflate !== undefined
				? await options.deflate(bytes)
				: deflateSync(bytes, { level: options.level ?? 6 })

		let crc = 0

		for (let at = 0; at < bytes.length; at += CRC_SLICE) {
			crc = crc32(bytes.subarray(at, Math.min(bytes.length, at + CRC_SLICE)), crc)

			if (clock?.due === true) await clock.pause()
		}

		const fed = crc

		return { crc: fed, size: data.length, data: () => once(data), fed: () => fed }
	}

	let crc = 0

	if (bytes instanceof Uint8Array) {
		const checked = async function* (): AsyncIterable<Uint8Array> {
			for (let at = 0; at < bytes.length; at += DEFLATE_SLICE) {
				const slice = bytes.subarray(at, Math.min(bytes.length, at + DEFLATE_SLICE))

				crc = crc32(slice, crc)

				if (clock?.due === true) await clock.pause()

				yield slice
			}
		}
		const data = await deflateStream(checked(), options.level)

		return { crc, size: data.length, data: () => once(data), fed: () => crc }
	}

	if (!item.compress) {
		const known = item.crc32

		// The CRC goes before the data: with the CRC the content must have, the pieces are read once (what
		// they turn out to hold is checked against it after); without it, twice.
		if (known !== undefined) {
			const data = async function* (): AsyncIterable<Uint8Array> {
				for await (const chunk of bytes.chunks()) {
					crc = crc32(chunk, crc)

					if (clock?.due === true) await clock.pause()

					yield chunk
				}
			}

			return { crc: known, size: bytes.length, data, fed: () => crc }
		}

		for await (const chunk of bytes.chunks()) {
			crc = crc32(chunk, crc)

			if (clock?.due === true) await clock.pause()
		}

		return { crc, size: bytes.length, data: () => bytes.chunks(), fed: () => crc }
	}

	if (hasDeflated(bytes)) {
		const mixed = await deflateMixed(bytes, options.level, clock)

		crc = mixed.crc

		return { crc, size: mixed.size, data: () => many(mixed.parts), fed: () => crc }
	}

	const checked = async function* (): AsyncIterable<Uint8Array> {
		for await (const chunk of bytes.chunks()) {
			for (let at = 0; at < chunk.length; at += DEFLATE_SLICE) {
				const slice = chunk.subarray(at, Math.min(chunk.length, at + DEFLATE_SLICE))

				crc = crc32(slice, crc)

				if (clock?.due === true) await clock.pause()

				yield slice
			}
		}
	}
	const data =
		options.deflateChunks !== undefined ? await options.deflateChunks(checked()) : await deflateStream(checked(), options.level)

	return { crc, size: data.length, data: () => once(data), fed: () => crc }
}

function shortCopy(name: string, got: number, wanted: number): ZipError {
	return new ZipError("corrupt", `A copy of ${name} read ${String(got)} of ${String(wanted)} bytes`)
}

// Executes a zip plan: copied entries stream from the original unchanged (in copyChunkSize reads), new
// content is deflated here, and a fresh central directory follows. Only DataView, the CRC table and fflate's
// deflate are used, so the same code runs in a worker, a WebView or Hermes next to the file on disk. Given
// the archive the plan came from, entry layouts it already read are reused; given only the source bytes
// (as next to the file on mobile), each copied entry's local header is read once.
export async function writeZip(
	plan: ZipPlan | StreamedZipPlan,
	original: ZipArchive | ByteSource | null,
	sink: ByteSink,
	options: WriteZipOptions = {}
): Promise<WriteZipReport> {
	const archive = original instanceof ZipArchive ? original : null
	const source = archive?.source ?? (original instanceof ZipArchive ? null : original)
	const forceZip64 = options.forceZip64 ?? false
	const copyChunkSize = options.copyChunkSize ?? 4 * 1024 * 1024
	const out = new BatchingSink(sink)
	const records: CentralRecord[] = []
	const names = new Set<string>()
	const crcs = new Map<string, number>()
	const copies = new Map<string, { crc: number; length: number }>()

	const streamed = !Array.isArray(plan.items)

	for await (const item of plan.items) {
		const name = item.kind === "copy" ? item.entry.name : item.name

		if (names.has(name)) throw new ZipError("duplicateName", `Duplicate entry ${name} in the plan`)

		names.add(name)

		const localHeaderOffset = out.written

		if (item.kind === "copy") {
			if (source === null) throw new ZipError("corrupt", "Copying entries needs the original source")

			const entry = item.entry
			const layout = archive !== null ? await archive.layout(entry) : await readEntryLayout(source, entry)
			const end = layout.dataOffset + entry.compressedSize + layout.descriptorLength

			// With a source that checksums where its bytes live, the CRC of what it sent: the copy is checked
			// against it in the written file (what arrived damaged is caught there).
			let raw = 0

			for (let offset = entry.localHeaderOffset; offset < end; offset += copyChunkSize) {
				const length = Math.min(copyChunkSize, end - offset)

				// A short read would shift every later byte: the package must fail, never be written.
				if (source.readChecked !== undefined) {
					const read = await source.readChecked(offset, length, raw)

					if (read.bytes.length !== length) throw shortCopy(entry.name, read.bytes.length, length)

					raw = read.crc
					await out.write(read.bytes)
				} else {
					const bytes = await source.read(offset, length)

					if (bytes.length !== length) throw shortCopy(entry.name, bytes.length, length)

					await out.write(bytes)
				}
			}

			if (source.readChecked !== undefined) copies.set(entry.name, { crc: raw, length: end - entry.localHeaderOffset })
			records.push({ ...entry, localHeaderOffset, order: entry.index })

			continue
		}

		const template = item.template
		// A replaced entry keeps its stored name bytes and their UTF-8 flag, whatever code page they are in.
		const sameName = template !== undefined && template.name === item.name
		const nameBytes = sameName ? template.nameBytes : encodeUtf8(item.name)
		const content = await dataOf(item, options)
		// Keep the template's deflate-option and UTF-8 bits; sizes are known up front, so no descriptor.
		let flags = (template?.flags ?? 0) & (item.compress ? 0x0806 : 0x0800)

		if (!sameName) flags = isAscii(nameBytes) ? flags & ~FLAG_UTF8 : flags | FLAG_UTF8

		const stamp = item.modified === undefined ? undefined : dosTime(item.modified)

		const record: CentralRecord = {
			versionMadeBy: template?.versionMadeBy ?? VERSION_DEFLATE,
			versionNeeded: Math.max(template?.versionNeeded ?? 0, VERSION_DEFLATE),
			flags,
			method: item.compress ? METHOD_DEFLATE : METHOD_STORED,
			modTime: stamp?.time ?? template?.modTime ?? 0,
			modDate: stamp?.date ?? template?.modDate ?? DOS_EPOCH_DATE,
			crc32: content.crc,
			compressedSize: content.size,
			uncompressedSize: item.bytes.length,
			localHeaderOffset,
			internalAttributes: template?.internalAttributes ?? 0,
			externalAttributes: template?.externalAttributes ?? 0,
			nameBytes,
			extra: template?.extra ?? new Uint8Array(0),
			comment: template?.comment ?? new Uint8Array(0),
			zip64Fields: template?.zip64Fields ?? 0,
			order: template?.index ?? Number.MAX_SAFE_INTEGER
		}

		await out.write(localBytes(record, forceZip64))

		for await (const chunk of content.data()) await out.write(chunk)

		crcs.set(item.name, content.fed())
		records.push(record)

		// What is made as it streams goes out before the next entry is asked for.
		if (streamed) await out.flush()
	}

	const directoryOffset = out.written

	// Stable: new entries keep plan order after the originals.
	records.sort((a, b) => a.order - b.order)

	for (const record of records) await out.write(centralBytes(record, forceZip64))

	await out.write(
		endRecords(
			records.length,
			directoryOffset,
			out.written - directoryOffset,
			plan.comment ?? new Uint8Array(0),
			forceZip64 || (plan.zip64End ?? false)
		)
	)
	await out.flush()
	await sink.close()

	return { size: out.written, entries: records.length, crcs, copies }
}

export interface PartChange {
	readonly name: string
	readonly bytes: PartBytes
	// Compress a new entry (default true). A replaced entry keeps its original method.
	readonly compress?: boolean
	// The CRC-32 `bytes` must have, when the caller checked them already: a stored entry given as pieces then
	// reads them once (the writer reports what they turned out to hold, WriteZipReport.crcs).
	readonly crc32?: number
}

export interface ZipChanges {
	readonly replace?: readonly PartChange[]
	readonly remove?: readonly string[]
	// Appended after the original entries, in this order.
	readonly add?: readonly PartChange[]
}

export interface PlannedArchive {
	readonly entries: readonly ZipEntry[]
	readonly comment: Uint8Array
	readonly zip64: boolean
}

// The plan that applies `changes` to an archive: every untouched entry a raw copy, a replaced entry
// rewritten in its original place with its original metadata, new entries last. Entry data keeps the
// archive's physical order (ODF needs "mimetype" first) and the central directory keeps its own, so a
// plan without changes reproduces a well-formed archive byte for byte.
export function planZip(archive: PlannedArchive, changes: ZipChanges = {}): ZipPlan {
	const replace = new Map((changes.replace ?? []).map(change => [change.name, change]))
	const remove = new Set(changes.remove ?? [])
	const items: ZipPlanItem[] = []
	const physical = [...archive.entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset)

	for (const entry of physical) {
		if (remove.has(entry.name)) continue

		const change = replace.get(entry.name)

		if (change === undefined) {
			items.push({ kind: "copy", entry })

			continue
		}

		replace.delete(entry.name)
		// Stored stays stored: ODF requires its "mimetype" entry uncompressed.
		items.push({
			kind: "data",
			name: entry.name,
			bytes: change.bytes,
			compress: entry.method !== METHOD_STORED,
			template: entry,
			...(change.crc32 === undefined ? {} : { crc32: change.crc32 })
		})
	}

	const missing = replace.keys().next()

	if (!missing.done) throw new ZipError("corrupt", `No entry ${missing.value} to replace`)

	for (const change of changes.add ?? []) {
		items.push({
			kind: "data",
			name: change.name,
			bytes: change.bytes,
			compress: change.compress ?? true,
			...(change.crc32 === undefined ? {} : { crc32: change.crc32 })
		})
	}

	return { items, comment: archive.comment, zip64End: archive.zip64 }
}

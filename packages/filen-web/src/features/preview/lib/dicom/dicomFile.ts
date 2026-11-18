import { parseDicom, readPart10Header, type DataSet } from "dicom-parser"
import { DicomInflateCapError, inflateDataset } from "@/features/preview/lib/dicom/inflate"
import { DICOM_WHOLE_MAX_BYTES, transferSyntax, type TransferSyntax } from "@/features/preview/lib/dicom/transferSyntax"
import type { DicomOpenFailure } from "@/features/preview/lib/dicom/protocol"

// A DICOM file's header, read by the worker (dicom-parser) from a growing prefix of the file: 1 MiB first, doubling,
// up to the header cap, stopping at Pixel Data's element header (untilTag). A deflated data set is read whole (up to
// 256 MiB on any origin) and inflated once, under the worker's budget. Worker-only: the parser and its options never
// reach the page.

const MIB = 1024 * 1024
const FIRST_PREFIX = MIB
const PIXEL_DATA = "x7fe00010"

// dicom-parser keeps every element as an object: measured at about 23 to 31 bytes of heap a byte of header (a run of
// empty items the most), so the header read is capped at a share of the worker's budget as well as 64 MiB, and the
// parsed header's heap is held against the budget the frames decode in.
export const DICOM_HEADER_MAX_BYTES = 64 * MIB
export const DICOM_HEADER_HEAP_PER_BYTE = 32

export function headerCap(decodeBytes: number): number {
	return Math.min(DICOM_HEADER_MAX_BYTES, Math.floor(decodeBytes / DICOM_HEADER_HEAP_PER_BYTE))
}

export class DicomOpenError extends Error {
	override readonly name = "DicomOpenError"
	readonly reason: DicomOpenFailure

	constructor(reason: DicomOpenFailure, message: string) {
		super(message)
		this.reason = reason
	}
}

// The file's bytes as the worker reads them: whole in memory, or through the sync range reader.
export interface DicomSource {
	readonly size: number
	// Reads are views of bytes already held, not copies.
	readonly inMemory: boolean
	// Exactly `length` bytes at `offset`, or throws a DicomOpenError("unreadable").
	read(offset: number, length: number): Uint8Array
}

function checkRange(size: number, offset: number, length: number): void {
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) {
		throw new DicomOpenError("damaged", "a read past the end of the file")
	}
}

export function memorySource(bytes: Uint8Array): DicomSource {
	return {
		size: bytes.length,
		inMemory: true,
		read: (offset, length) => {
			checkRange(bytes.length, offset, length)

			return bytes.subarray(offset, offset + length)
		}
	}
}

// A file of `size` bytes read through `readInto` (the sync range reader: the bytes it wrote into `out`). A read past
// the end is refused before its buffer is allocated, so a length the file declares is never trusted for one.
export function rangeSource(size: number, readInto: (out: Uint8Array, offset: number) => number): DicomSource {
	return {
		size,
		inMemory: false,
		read: (offset, length) => {
			checkRange(size, offset, length)

			const out = new Uint8Array(length)

			if (length > 0 && readInto(out, offset) !== length) {
				throw new DicomOpenError("unreadable", "a read of the file failed")
			}

			return out
		}
	}
}

export interface DicomHeader {
	readonly dataSet: DataSet
	readonly transferSyntaxUid: string
	// Null for a transfer syntax the viewer does not know (its tags are still read).
	readonly syntax: TransferSyntax | null
	// Where frames are read from: the file, or the inflated data set held in memory.
	readonly pixels: DicomSource
	// Bytes the worker holds for the file beyond what it decodes: the inflated data set, or the whole file.
	readonly heldBytes: number
	// The parsed header's heap, and the prefix it was parsed from when that is a copy of its own.
	readonly headerBytes: number
}

// What the worker holds for an open file while its frames decode: the bytes read whole (an inflated data set, else
// `wholeBytes` of a file read into memory) and the parsed header.
export function fileHeld(header: DicomHeader, wholeBytes: number): number {
	return (header.heldBytes > 0 ? header.heldBytes : wholeBytes) + header.headerBytes
}

// The parsed header's heap: elements up to Pixel Data's (or the whole prefix), at the measured heap per byte, and the
// prefix itself when it is a copy rather than a view of bytes already held.
function headerBytes(dataSet: DataSet, prefix: Uint8Array, copied: boolean): number {
	const parsed = dataSet.elements[PIXEL_DATA]?.dataOffset ?? prefix.length

	return Math.min(parsed, prefix.length) * DICOM_HEADER_HEAP_PER_BYTE + (copied ? prefix.length : 0)
}

function isDicomPrefix(bytes: Uint8Array): boolean {
	return bytes.length >= 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d
}

const isUpper = (byte: number | undefined): boolean => byte !== undefined && byte >= 0x41 && byte <= 0x5a

// A data set with no preamble or meta group (older files): it starts with a group 0008 element, its VR spelled out or
// not. Null for anything else.
function rawSyntax(bytes: Uint8Array): string | null {
	if (bytes.length < 8 || bytes[0] !== 0x08 || bytes[1] !== 0x00) return null

	return isUpper(bytes[4]) && isUpper(bytes[5]) ? "1.2.840.10008.1.2.1" : "1.2.840.10008.1.2"
}

// dicom-parser throws strings and `{ exception, dataSet }` records as well as Errors.
function parseFailure(): DicomOpenError {
	return new DicomOpenError("damaged", "the header could not be parsed")
}

// The meta group's transfer syntax, or the one a raw data set is read with.
function metaSyntax(prefix: Uint8Array): { uid: string; raw: boolean; position: number } {
	if (!isDicomPrefix(prefix)) {
		const raw = rawSyntax(prefix)

		if (raw === null) throw new DicomOpenError("notDicom", "no DICM prefix and no data set")

		return { uid: raw, raw: true, position: 0 }
	}

	try {
		const meta = readPart10Header(prefix)
		const uid = meta.string("x00020010")

		if (uid === undefined) throw new DicomOpenError("damaged", "no transfer syntax in the meta group")

		// The parser leaves the data set's offset on the meta group it returns.
		const position = "position" in meta && typeof meta.position === "number" ? meta.position : 0

		return { uid, raw: false, position }
	} catch (error) {
		throw error instanceof DicomOpenError ? error : parseFailure()
	}
}

export interface HeaderOptions {
	// The worker's decode budget (workerDecodeBytes).
	readonly decodeBytes: number
}

// Reads the header of `source`. Throws a DicomOpenError.
export function readHeader(source: DicomSource, options: HeaderOptions): DicomHeader {
	const cap = headerCap(options.decodeBytes)
	const { size } = source
	let prefix = source.read(0, Math.min(size, FIRST_PREFIX))
	const meta = metaSyntax(prefix)
	const syntax = transferSyntax(meta.uid)
	const parseOptions = meta.raw ? { TransferSyntaxUID: meta.uid } : {}

	if (syntax?.deflated === true) {
		return readDeflated(source, prefix, meta.position, meta.uid, syntax, options.decodeBytes, cap)
	}

	for (let length = prefix.length; ;) {
		const parsed = tryParse(prefix, size, { untilTag: PIXEL_DATA, ...parseOptions })

		if (parsed === "damaged") throw parseFailure()

		const dataSet = parsed === "more" ? null : parsed.dataSet

		if (dataSet !== null && (dataSet.elements[PIXEL_DATA] !== undefined || length === size)) {
			return {
				dataSet,
				transferSyntaxUid: meta.uid,
				syntax,
				pixels: source,
				heldBytes: 0,
				headerBytes: headerBytes(dataSet, prefix, !source.inMemory)
			}
		}

		if (length === size) throw parseFailure()

		if (length >= cap) throw new DicomOpenError("tooLarge", "the header is larger than the viewer reads")

		const next = Math.min(size, length * 2, cap)

		// A file in memory is parsed in place; one read in ranges grows a copy.
		if (source.inMemory) {
			prefix = source.read(0, next)
		} else {
			const grown = new Uint8Array(next)

			grown.set(prefix)
			grown.set(source.read(length, next - length), length)
			prefix = grown
		}

		length = next
	}
}

// A parse of a prefix: its data set, or why there is none. "more" when the prefix ends inside the data set (a read past
// its end, which a longer prefix may satisfy); "damaged" for anything a longer prefix cannot mend: a value or item
// running past the end of the file itself, nesting deeper than the stack, or bytes that are not a data set.
type Parsed = { readonly dataSet: DataSet } | "more" | "damaged"

// dicom-parser's own wording for a read past the bytes it was given.
const PAST_END = /past end|buffer overrun|maxP ?osition/

function tryParse(bytes: Uint8Array, fileSize: number, options: Parameters<typeof parseDicom>[1]): Parsed {
	try {
		return { dataSet: parseDicom(bytes, options) }
	} catch (thrown) {
		// It throws strings, Errors, and `{ exception, dataSet }` records holding what it had read.
		const record = typeof thrown === "object" && thrown !== null && "exception" in thrown ? thrown : null
		const error: unknown = record === null ? thrown : record.exception
		const partial = record !== null && "dataSet" in record ? (record.dataSet as DataSet | undefined) : undefined
		const message = typeof error === "string" ? error : error instanceof Error && !(error instanceof RangeError) ? error.message : ""

		if (!PAST_END.test(message)) return "damaged"

		// An element whose value would end past the file is no truncation a longer read mends.
		const elements = partial === undefined ? [] : Object.values(partial.elements)

		return elements.some(element => element.length !== 0xffffffff && element.dataOffset + element.length > fileSize)
			? "damaged"
			: "more"
	}
}

// A deflated data set: the whole file (≤ 256 MiB), inflated under what is left of the budget once it is held, then read
// like any other from a growing prefix of the inflated bytes. The compressed bytes are let go once inflated.
function readDeflated(
	source: DicomSource,
	prefix: Uint8Array,
	position: number,
	uid: string,
	syntax: TransferSyntax,
	decodeBytes: number,
	cap: number
): DicomHeader {
	const { size } = source

	if (size > DICOM_WHOLE_MAX_BYTES) {
		throw new DicomOpenError("tooLarge", "a deflated data set is read whole, and this one is past the cap")
	}

	let inflated: Uint8Array

	try {
		inflated = inflateDataset(source.read(0, size), position, Math.max(0, decodeBytes - size))
	} catch (error) {
		if (error instanceof DicomInflateCapError) throw new DicomOpenError("tooLarge", error.message)
		if (error instanceof DicomOpenError) throw error

		throw parseFailure()
	}

	const meta = prefix.subarray(0, position)

	for (
		let length = Math.min(inflated.length, position + FIRST_PREFIX);
		;
		length = Math.min(inflated.length, length * 2, position + cap)
	) {
		const limit = length
		const parsed = tryParse(meta, inflated.length, { untilTag: PIXEL_DATA, inflater: () => inflated.subarray(0, limit) })

		if (parsed === "damaged") throw parseFailure()

		const dataSet = parsed === "more" ? null : parsed.dataSet

		if (dataSet !== null && (dataSet.elements[PIXEL_DATA] !== undefined || limit === inflated.length)) {
			return {
				dataSet,
				transferSyntaxUid: uid,
				syntax,
				pixels: memorySource(inflated),
				heldBytes: inflated.length,
				headerBytes: headerBytes(dataSet, inflated.subarray(0, limit), false)
			}
		}

		if (limit === inflated.length) throw parseFailure()

		if (limit >= position + cap) throw new DicomOpenError("tooLarge", "the header is larger than the viewer reads")
	}
}

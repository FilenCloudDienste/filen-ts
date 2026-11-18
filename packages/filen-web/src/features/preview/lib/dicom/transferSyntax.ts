// The DICOM viewer's transfer syntaxes (PS3.5 §10, Annex A) and its size figures: the one table the worker decodes by.

export const DICOM_EXTENSIONS = ["dcm", "dicom"] as const

const MIB = 1024 * 1024

// Read whole: an archive's entry or held bytes, and a deflated data set on any origin (its stream inflates from the
// start), up to this size.
export const DICOM_WHOLE_MAX_BYTES = 256 * MIB

// No frame side past this, whatever the budget.
export const DICOM_MAX_SIDE = 16_384

// The decoded frames kept for going back to them (cine loops, W/L on a frame already seen).
export const DICOM_FRAME_CACHE_BYTES = 64 * MIB

export type DicomDecoder =
	| "native"
	| "rle"
	// A baseline (8-bit) JPEG, decoded by the browser: always RGB out.
	| "jpegBaseline"
	| "jpegLossless"
	| "jpegLs"
	| "jpeg2000"
	| "htj2k"

export interface TransferSyntax {
	readonly decoder: DicomDecoder
	readonly littleEndian: boolean
	readonly explicitVr: boolean
	// Pixel data in items of fragments (PS3.5 A.4) rather than one native value.
	readonly encapsulated: boolean
	// The data set after the file meta group is raw deflate (PS3.5 A.5).
	readonly deflated: boolean
}

const native = (littleEndian: boolean, explicitVr: boolean, deflated = false): TransferSyntax => ({
	decoder: "native",
	littleEndian,
	explicitVr,
	encapsulated: false,
	deflated
})

const encapsulated = (decoder: DicomDecoder): TransferSyntax => ({
	decoder,
	littleEndian: true,
	explicitVr: true,
	encapsulated: true,
	deflated: false
})

export const DEFLATED_TRANSFER_SYNTAX = "1.2.840.10008.1.2.1.99"

const SYNTAXES: ReadonlyMap<string, TransferSyntax> = new Map([
	["1.2.840.10008.1.2", native(true, false)],
	["1.2.840.10008.1.2.1", native(true, true)],
	[DEFLATED_TRANSFER_SYNTAX, native(true, true, true)],
	["1.2.840.10008.1.2.2", native(false, true)],
	["1.2.840.10008.1.2.5", encapsulated("rle")],
	["1.2.840.10008.1.2.4.50", encapsulated("jpegBaseline")],
	["1.2.840.10008.1.2.4.57", encapsulated("jpegLossless")],
	["1.2.840.10008.1.2.4.70", encapsulated("jpegLossless")],
	["1.2.840.10008.1.2.4.80", encapsulated("jpegLs")],
	["1.2.840.10008.1.2.4.81", encapsulated("jpegLs")],
	["1.2.840.10008.1.2.4.90", encapsulated("jpeg2000")],
	["1.2.840.10008.1.2.4.91", encapsulated("jpeg2000")],
	["1.2.840.10008.1.2.4.201", encapsulated("htj2k")],
	["1.2.840.10008.1.2.4.202", encapsulated("htj2k")],
	["1.2.840.10008.1.2.4.203", encapsulated("htj2k")]
])

// `text` without the NULs and spaces a DICOM value is padded with, walked back from its end: in linear time, where a
// trailing-run regex is quadratic on a long run that something follows.
export function withoutPadding(text: string): string {
	let end = text.length

	while (end > 0 && (text.charCodeAt(end - 1) === 0 || text.charCodeAt(end - 1) === 0x20)) end--

	return end === text.length ? text : text.slice(0, end)
}

// A UID padded with its trailing NUL or space reads as the bare UID.
export function transferSyntax(uid: string): TransferSyntax | null {
	return SYNTAXES.get(withoutPadding(uid)) ?? null
}

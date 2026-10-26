import type { DeckVariant, Format } from "@filen/office/core/presentation"

// What a presentation file opens as: the reader (format) and the package it is (variant: a deck, a template, a show,
// macro-enabled or not), which the writer keeps.
export interface PresentationFileKind {
	readonly format: Format
	readonly variant: DeckVariant
}

// The one list of presentation extensions: the preview category, the editable gate and the worker's format all read
// it. A Map, so a name like "constructor" is not found on a prototype.
const KINDS: ReadonlyMap<string, PresentationFileKind> = new Map(
	(
		[
			["pptx", "pptx"],
			["pptm", "pptx"],
			["potx", "pptx"],
			["potm", "pptx"],
			["ppsx", "pptx"],
			["ppsm", "pptx"],
			["odp", "odp"],
			["otp", "odp"],
			// PowerPoint 97–2003 decks, shows and templates: viewed, and saved as a .pptx.
			["ppt", "ppt"],
			["pps", "ppt"],
			["pot", "ppt"]
		] as const
	).map(([extension, format]) => [extension, { format, variant: extension }])
)

export const PRESENTATION_EXTENSIONS: readonly string[] = [...KINDS.keys()]

export function presentationFileKind(extension: string): PresentationFileKind | null {
	return KINDS.get(extension) ?? null
}

// A 97–2003 deck opens to be looked at only (Save as .pptx writes a new file); every other kind saves as itself.
export function isEditablePresentationExtension(extension: string): boolean {
	const kind = presentationFileKind(extension)

	return kind !== null && kind.format !== "ppt"
}

// The format a name promises, for telling whether a rename changed it: an OOXML or ODF extension names its own
// package (content types differ), the 97–2003 ones one view-only format.
export function presentationSaveFormat(extension: string): string | null {
	const kind = presentationFileKind(extension)

	if (kind === null) return null

	return kind.format === "ppt" ? "ppt" : extension
}

const ZIP = [0x50, 0x4b, 0x03, 0x04]
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
// The local header of a zip's first entry: name length at 26, extra length at 28, the name at 30.
const ZIP_NAME_LENGTH = 26
const ZIP_EXTRA_LENGTH = 28
const ZIP_NAME = 30
const ODF_MIMETYPE = "mimetype"
const ODP_MIME = "application/vnd.oasis.opendocument.presentation"

function startsWith(bytes: Uint8Array, magic: readonly number[], at = 0): boolean {
	return bytes.length >= at + magic.length && magic.every((byte, index) => bytes[at + index] === byte)
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
	return String.fromCharCode(...bytes.subarray(start, start + length))
}

// What the first bytes of a file say it is: a zip whose first entry is an ODF `mimetype` (ODF 1.3 Part 2 §3.3) is an
// ODF presentation (or template) when that type says so and none otherwise; any other zip is taken for an OOXML deck
// (the reader refuses it typed if it is not one); an OLE2 compound file for a 97–2003 deck; anything else for none
// (a `.pot` that is a gettext template). Reads at most the first entry's header and type (≤ 128 bytes).
export function sniffPresentationKind(bytes: Uint8Array): Format | null {
	if (startsWith(bytes, OLE2)) return "ppt"

	if (!startsWith(bytes, ZIP)) return null

	const nameLength = (bytes[ZIP_NAME_LENGTH] ?? 0) | ((bytes[ZIP_NAME_LENGTH + 1] ?? 0) << 8)
	const extraLength = (bytes[ZIP_EXTRA_LENGTH] ?? 0) | ((bytes[ZIP_EXTRA_LENGTH + 1] ?? 0) << 8)

	if (nameLength !== ODF_MIMETYPE.length || ascii(bytes, ZIP_NAME, nameLength) !== ODF_MIMETYPE) return "pptx"

	const body = ZIP_NAME + nameLength + extraLength

	return ascii(bytes, body, ODP_MIME.length) === ODP_MIME ? "odp" : null
}

// The verdict a sniffed `.pot` leaves for its next open: an OLE2 deck is a 97–2003 template, text is text. A zip deck
// records none (the shared `.pot` verdicts name the binary format alone), so it is sniffed again on its next open.
export function presentationVerdict(sniffed: Format | "text"): "presentationBinary" | "notPresentationBinary" | undefined {
	if (sniffed === "ppt") return "presentationBinary"

	return sniffed === "text" ? "notPresentationBinary" : undefined
}

// Bytes sniffPresentationKind reads at most.
export const PRESENTATION_SNIFF_BYTES = 128

import type { ContentTypes } from "./contentTypes"
import { partKey } from "./partNames"
import type { Relationships } from "./relationships"
import type { ZipEntry, ZipLimits } from "./zipReader"

// Package limits for presentations, and which entries count as media. A deck may carry gigabytes of video, so its
// zip is opened with wide limits (PRESENTATION_ZIP_LIMITS) and this policy decides, from the central directory's
// declared sizes and before any part is read, what each entry may be:
//   media   the target of an audio, video or media relationship AND an audio/* or video/* content type (and, at
//           first read, a container sniff that agrees): excluded from the total, at most 4 GiB, only ever streamed
//           or read by range;
//   image   an image/* content type: at most 256 MiB, and at most 50 M decoded pixels;
//   other   everything else (XML parts, fonts, embeddings): at most 64 MiB.
// Images and other parts together stay within 512 MiB. An entry claimed as media that fails a check is an image
// or other part (and refused when it is too large for that), with a notice; it is never played.

const GIB = 1024 * 1024 * 1024
const MIB = 1024 * 1024

export const PRESENTATION_ZIP_LIMITS: ZipLimits = {
	maxEntries: 20_000,
	maxEntryUncompressed: 4 * GIB,
	maxTotalUncompressed: 2 ** 53
}

export interface MediaLimits {
	readonly mediaEntry: number
	readonly imageEntry: number
	readonly otherEntry: number
	readonly nonMediaTotal: number
	readonly decodedPixels: number
}

export const MEDIA_LIMITS: MediaLimits = {
	mediaEntry: 4 * GIB,
	imageEntry: 256 * MIB,
	otherEntry: 64 * MIB,
	nonMediaTotal: 512 * MIB,
	decodedPixels: 50_000_000
}

export type EntryClass = "media" | "image" | "other"

// Relationship types whose targets are media (ECMA-376 Part 1 §15.2.x audio and video, and PowerPoint 2010's
// p14:media), transitional and Strict.
const MEDIA_RELATIONSHIP_TYPES: ReadonlySet<string> = new Set([
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio",
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships/video",
	"http://purl.oclc.org/ooxml/officeDocument/relationships/audio",
	"http://purl.oclc.org/ooxml/officeDocument/relationships/video",
	"http://schemas.microsoft.com/office/2007/relationships/media"
])

export function isMediaRelationship(type: string): boolean {
	return MEDIA_RELATIONSHIP_TYPES.has(type)
}

// The part keys (partKey) the given relationships point to as media.
export function mediaTargets(all: Iterable<Relationships>): Set<string> {
	const out = new Set<string>()

	for (const relationships of all) {
		for (const relationship of relationships.all) {
			if (!relationship.external && relationship.partName !== undefined && isMediaRelationship(relationship.type)) {
				out.add(partKey(relationship.partName))
			}
		}
	}

	return out
}

function isMediaType(contentType: string | undefined): boolean {
	if (contentType === undefined) return false

	const lower = contentType.toLowerCase()

	return lower.startsWith("audio/") || lower.startsWith("video/")
}

function isImageType(contentType: string | undefined): boolean {
	return contentType !== undefined && contentType.toLowerCase().startsWith("image/")
}

// The parts a package's reader reads before it knows any content type: [Content_Types].xml and the relationships
// parts (OPC, ECMA-376 Part 2). Never media, whatever type they are given.
export function isStructurePart(name: string): boolean {
	return name === "[Content_Types].xml" || name.toLowerCase().endsWith(".rels")
}

// Whether an entry needs the media relationships to be classified (an audio/* or video/* content type).
export function isMediaCandidate(entry: ZipEntry, contentTypes: ContentTypes): boolean {
	return !isStructurePart(entry.name) && isMediaType(contentTypes.typeOf(entry.name))
}

export type MediaNotice =
	// A media relationship's target whose content type is not audio/* or video/*.
	| { readonly kind: "notMediaType"; readonly part: string }
	// An audio/* or video/* part no media relationship points to.
	| { readonly kind: "unreferencedMedia"; readonly part: string }
	// A media part whose bytes are no audio or video container we know.
	| { readonly kind: "notMediaContainer"; readonly part: string }

export type PackagePolicy =
	| {
			readonly kind: "ok"
			// Part keys of the entries classed media.
			readonly media: ReadonlySet<string>
			readonly nonMediaBytes: number
			readonly notices: readonly MediaNotice[]
	  }
	| {
			readonly kind: "tooLarge"
			readonly part: string
			readonly class: EntryClass | "total"
			readonly size: number
			readonly limit: number
	  }

// The first check, from the central directory alone and before anything is read: every structure part within
// `partLimit` (the reader's per-XML-part budget, at most the other-part limit) and all of them together within the
// non-media total.
export function checkStructure(
	entries: Iterable<ZipEntry>,
	partLimit: number,
	limits: MediaLimits = MEDIA_LIMITS
): Extract<PackagePolicy, { kind: "tooLarge" }> | undefined {
	const limit = Math.min(partLimit, limits.otherEntry)
	let total = 0

	for (const entry of entries) {
		if (!isStructurePart(entry.name)) continue
		if (entry.uncompressedSize > limit)
			return { kind: "tooLarge", part: entry.name, class: "other", size: entry.uncompressedSize, limit }

		total += entry.uncompressedSize

		if (total > limits.nonMediaTotal) {
			return { kind: "tooLarge", part: entry.name, class: "total", size: total, limit: limits.nonMediaTotal }
		}
	}

	return undefined
}

// The part keys of every media candidate: checkPackage over them as targets is the check that holds whatever the
// relationships say (each candidate within the media limit, every other entry within its class and the total), run
// before the relationships parts are read.
export function mediaCandidates(entries: Iterable<ZipEntry>, contentTypes: ContentTypes): Set<string> {
	const out = new Set<string>()

	for (const entry of entries) if (isMediaCandidate(entry, contentTypes)) out.add(partKey(entry.name))

	return out
}

function classOf(entry: ZipEntry, contentTypes: ContentTypes, targets: ReadonlySet<string>, notices: MediaNotice[]): EntryClass {
	if (isStructurePart(entry.name)) return "other"

	const type = contentTypes.typeOf(entry.name)
	const targeted = targets.has(partKey(entry.name))

	if (targeted && isMediaType(type)) return "media"
	if (targeted) notices.push({ kind: "notMediaType", part: entry.name })
	else if (isMediaType(type)) notices.push({ kind: "unreferencedMedia", part: entry.name })

	return isImageType(type) ? "image" : "other"
}

function limitOf(kind: EntryClass, limits: MediaLimits): number {
	return kind === "media" ? limits.mediaEntry : kind === "image" ? limits.imageEntry : limits.otherEntry
}

// Classifies every entry by its declared size, before anything is read. `targets`: mediaTargets() of every
// relationships part (needed only when some entry is a media candidate).
export function checkPackage(
	entries: Iterable<ZipEntry>,
	contentTypes: ContentTypes,
	targets: ReadonlySet<string>,
	limits: MediaLimits = MEDIA_LIMITS
): PackagePolicy {
	const media = new Set<string>()
	const notices: MediaNotice[] = []
	let total = 0

	for (const entry of entries) {
		if (entry.name.endsWith("/") && entry.uncompressedSize === 0) continue

		const kind = classOf(entry, contentTypes, targets, notices)
		const limit = limitOf(kind, limits)

		if (entry.uncompressedSize > limit) {
			return { kind: "tooLarge", part: entry.name, class: kind, size: entry.uncompressedSize, limit }
		}

		if (kind === "media") {
			media.add(partKey(entry.name))

			continue
		}

		total += entry.uncompressedSize

		if (total > limits.nonMediaTotal) {
			return { kind: "tooLarge", part: entry.name, class: "total", size: total, limit: limits.nonMediaTotal }
		}
	}

	return { kind: "ok", media, nonMediaBytes: total, notices }
}

export type MediaContainer =
	"isoBmff" | "matroska" | "ogg" | "avi" | "wav" | "asf" | "mpegPs" | "mpegTs" | "mpegVideo" | "mp3" | "aiff" | "flac" | "midi" | "amr"

const ISO_BOXES: ReadonlySet<string> = new Set(["ftyp", "moov", "mdat", "free", "wide", "skip", "pnot"])

function ascii(bytes: Uint8Array, from: number, length: number): string {
	let out = ""

	for (let index = from; index < from + length && index < bytes.length; index++) out += String.fromCharCode(bytes[index] ?? 0)

	return out
}

// The audio or video container the first bytes of an entry are (at least 16 bytes; 400 lets MPEG-TS show its
// second sync byte), or undefined.
export function sniffMedia(head: Uint8Array): MediaContainer | undefined {
	if (head.length < 4) return undefined

	const b0 = head[0] ?? 0
	const b1 = head[1] ?? 0
	const b2 = head[2] ?? 0
	const b3 = head[3] ?? 0

	if (ISO_BOXES.has(ascii(head, 4, 4))) return "isoBmff"
	if (b0 === 0x1a && b1 === 0x45 && b2 === 0xdf && b3 === 0xa3) return "matroska"
	if (ascii(head, 0, 4) === "OggS") return "ogg"
	if (ascii(head, 0, 4) === "RIFF") {
		const form = ascii(head, 8, 4)

		if (form === "WAVE") return "wav"
		if (form === "AVI ") return "avi"

		return undefined
	}
	if (ascii(head, 0, 4) === "FORM" && (ascii(head, 8, 4) === "AIFF" || ascii(head, 8, 4) === "AIFC")) return "aiff"
	if (b0 === 0x30 && b1 === 0x26 && b2 === 0xb2 && b3 === 0x75 && head[4] === 0x8e && head[5] === 0x66) return "asf"
	if (b0 === 0 && b1 === 0 && b2 === 1 && b3 === 0xba) return "mpegPs"
	if (b0 === 0 && b1 === 0 && b2 === 1 && b3 === 0xb3) return "mpegVideo"
	if (b0 === 0x47 && (head.length < 189 || head[188] === 0x47)) return "mpegTs"
	if (ascii(head, 0, 4) === "fLaC") return "flac"
	if (ascii(head, 0, 4) === "MThd") return "midi"
	if (ascii(head, 0, 5) === "#!AMR") return "amr"
	if (ascii(head, 0, 3) === "ID3") return "mp3"
	// An MPEG audio frame (or ADTS AAC) sync word.
	if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return "mp3"

	return undefined
}

// The first-read check of an entry classed media: its container must sniff as one, else it is an image or other
// part from here on, held to that class's size limit.
export function confirmMedia(
	entry: ZipEntry,
	head: Uint8Array,
	contentTypes: ContentTypes,
	limits: MediaLimits = MEDIA_LIMITS
):
	| { readonly kind: "media"; readonly container: MediaContainer }
	| { readonly kind: "notMedia"; readonly class: EntryClass; readonly tooLarge: boolean; readonly notice: MediaNotice } {
	const container = sniffMedia(head)

	if (container !== undefined) return { kind: "media", container }

	const kind: EntryClass = isImageType(contentTypes.typeOf(entry.name)) ? "image" : "other"

	return {
		kind: "notMedia",
		class: kind,
		tooLarge: entry.uncompressedSize > limitOf(kind, limits),
		notice: { kind: "notMediaContainer", part: entry.name }
	}
}

function uint16be(bytes: Uint8Array, at: number): number {
	return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)
}

function uint32be(bytes: Uint8Array, at: number): number {
	return (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0
}

function uint16le(bytes: Uint8Array, at: number): number {
	return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
}

function int32le(bytes: Uint8Array, at: number): number {
	return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24)
}

// Whether the bytes start like one of the raster formats imageDimensions reads (PNG, GIF, BMP, WebP, JPEG).
function rasterSignature(head: Uint8Array): boolean {
	return (
		(head[0] === 0x89 && ascii(head, 1, 3) === "PNG") ||
		ascii(head, 0, 4) === "GIF8" ||
		ascii(head, 0, 2) === "BM" ||
		(ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") ||
		(head[0] === 0xff && head[1] === 0xd8)
	)
}

// JPEG markers walked before the frame header (SOFn) is given up on: APP and other segments are each at least 4
// bytes, so this bounds the walk whatever the entry's size.
const MAX_JPEG_MARKERS = 65_536

// The frame header's size of a JPEG (ITU-T T.81 §B.2.2), walking the markers by their segment lengths; undefined
// when the SOFn is not within the bytes given (or the walk meets the scan, or runs past MAX_JPEG_MARKERS).
function jpegDimensions(head: Uint8Array): { readonly width: number; readonly height: number } | undefined {
	let at = 2

	for (let markers = 0; markers < MAX_JPEG_MARKERS && at + 9 <= head.length; markers++) {
		if (head[at] !== 0xff) return undefined

		const marker = head[at + 1] ?? 0

		// Fill bytes and standalone markers.
		if (marker === 0xff) {
			at++

			continue
		}

		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			at += 2

			continue
		}

		// SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return { width: uint16be(head, at + 7), height: uint16be(head, at + 5) }
		}

		// Start of scan or end of image: no frame header came first.
		if (marker === 0xda || marker === 0xd9) return undefined

		const length = uint16be(head, at + 2)

		if (length < 2) return undefined

		at += 2 + length
	}

	return undefined
}

// The pixel size an image header declares (PNG, GIF, BMP, WebP, JPEG within the bytes given), or undefined when
// the header is none of those or does not say.
export function imageDimensions(head: Uint8Array): { readonly width: number; readonly height: number } | undefined {
	if (head.length >= 24 && head[0] === 0x89 && ascii(head, 1, 3) === "PNG" && ascii(head, 12, 4) === "IHDR") {
		return { width: uint32be(head, 16), height: uint32be(head, 20) }
	}

	if (head.length >= 10 && ascii(head, 0, 3) === "GIF") return { width: uint16le(head, 6), height: uint16le(head, 8) }

	if (head.length >= 26 && ascii(head, 0, 2) === "BM") {
		return { width: Math.abs(int32le(head, 18)), height: Math.abs(int32le(head, 22)) }
	}

	if (head.length >= 30 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") {
		const chunk = ascii(head, 12, 4)

		if (chunk === "VP8X") {
			const width = 1 + ((head[24] ?? 0) | ((head[25] ?? 0) << 8) | ((head[26] ?? 0) << 16))
			const height = 1 + ((head[27] ?? 0) | ((head[28] ?? 0) << 8) | ((head[29] ?? 0) << 16))

			return { width, height }
		}

		if (chunk === "VP8 ") return { width: uint16le(head, 26) & 0x3fff, height: uint16le(head, 28) & 0x3fff }

		if (chunk === "VP8L") {
			const bits = int32le(head, 21) >>> 0

			return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
		}
	}

	if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) return jpegDimensions(head)

	return undefined
}

// Whether an image may be decoded: its declared pixels within the budget. A raster format whose header does not give
// its size within the bytes given (truncated, or a JPEG whose frame header lies past them) is refused, never passed
// on as unknown; formats without such a header (SVG, metafiles) pass to their own decoders' limits.
export function imageWithinBudget(head: Uint8Array, limits: Pick<MediaLimits, "decodedPixels"> = MEDIA_LIMITS): boolean {
	const size = imageDimensions(head)

	if (size === undefined) return !rasterSignature(head)

	return size.width * size.height <= limits.decodedPixels
}

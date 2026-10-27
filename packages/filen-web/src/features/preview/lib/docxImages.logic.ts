import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, sniffImage, type DocxEditorCommand, type DocxImageInfo } from "@filen/office/core/docx/edit"
import type { DriveItem } from "@/features/drive/lib/item"
import { itemTypeExtension, previewCategoryForExtension } from "@/features/drive/lib/preview.logic"
import type { PreviewKey } from "@/lib/i18n"

// A picture on its way into a DOCX document, from any source (this device, the drive, the clipboard, a drop):
// checked by size before it is read, by its header after (never decoded to be checked, never downscaled),
// WebP turned into PNG, an SVG given the PNG Word shows where it cannot draw one, then registered with the
// editor and inserted. Media registered for a picture that does not go in is given back.

// Why a picture does not go in.
export type DocxPictureRefusal =
	// Over 25 MB (as read, or as converted to PNG).
	| "tooLarge"
	// Over 20 megapixels.
	| "pixels"
	// Not a picture Word shows.
	| "format"
	// HEIC/HEIF or AVIF: pictures Word does not show, named as such.
	| "heic"
	| "avif"
	| "corrupt"
	// The document holds as many new pictures as it can until it is saved.
	| "full"
	// Not at the caret (a place a picture cannot go, the document read-only).
	| "place"
	// Reading, converting or drawing it failed.
	| "failed"

const REFUSAL_KEYS: Readonly<Record<DocxPictureRefusal, PreviewKey>> = {
	tooLarge: "previewDocxPictureTooLarge",
	pixels: "previewDocxPicturePixels",
	format: "previewDocxPictureFormat",
	heic: "previewDocxPictureHeic",
	avif: "previewDocxPictureAvif",
	corrupt: "previewDocxPictureCorrupt",
	full: "previewDocxPictureFull",
	place: "previewDocxPicturePlace",
	failed: "previewDocxPictureFailed"
}

export function pictureRefusalKey(refusal: DocxPictureRefusal): PreviewKey {
	return REFUSAL_KEYS[refusal]
}

// A file this large is refused before a byte of it is read.
export function oversizedPicture(size: number): boolean {
	return size > MAX_IMAGE_BYTES
}

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
	for (let k = 0; k < text.length; k++) {
		if (bytes[at + k] !== text.charCodeAt(k)) {
			return false
		}
	}

	return true
}

function u16le(bytes: Uint8Array, at: number): number {
	return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
}

function u24le(bytes: Uint8Array, at: number): number {
	return u16le(bytes, at) | ((bytes[at + 2] ?? 0) << 16)
}

// A WebP picture's canvas size from its first chunk (RFC 9649: VP8, VP8L, VP8X), undefined when the header
// does not hold one. Read before anything is decoded.
export function webpSize(bytes: Uint8Array): { width: number; height: number } | undefined {
	if (bytes.length < 30 || !ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WEBP")) {
		return undefined
	}

	if (ascii(bytes, 12, "VP8X")) {
		return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 }
	}

	if (ascii(bytes, 12, "VP8L")) {
		if (bytes[20] !== 0x2f) {
			return undefined
		}

		const bits = ((bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16) | ((bytes[24] ?? 0) << 24)) >>> 0

		return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
	}

	// A key frame's start code, then 14-bit width and height (the top two bits scale, not size).
	if (ascii(bytes, 12, "VP8 ") && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
		return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff }
	}

	return undefined
}

// Whether a WebP picture is animated (its VP8X header's animation flag, RFC 9649 §2.7).
export function webpAnimated(bytes: Uint8Array): boolean {
	return bytes.length >= 21 && ascii(bytes, 12, "VP8X") && ((bytes[20] ?? 0) & 0x02) !== 0
}

// Whether clipboard HTML holds pictures and nothing else (what a browser's Copy Image writes beside the picture
// itself): no text, no other element.
export function htmlHoldsOnlyImages(html: string | undefined): boolean {
	if (html === undefined || !/<img\b/i.test(html)) {
		return false
	}

	const rest = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(head|style|script)\b[\s\S]*?<\/\1>/gi, "")
		.replace(/<(img|meta|br|source)\b[^>]*>/gi, "")
		.replace(/<\/?(html|body|div|span|p|a|picture|figure)\b[^>]*>/gi, "")
		.replace(/&nbsp;|\s/g, "")

	return rest === ""
}

// ISO-BMFF pictures browsers or Word cannot take, by their major brand.
const HEIC_BRANDS: ReadonlySet<string> = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"])
const AVIF_BRANDS: ReadonlySet<string> = new Set(["avif", "avis"])

function unsupportedFormat(bytes: Uint8Array): "heic" | "avif" | "format" {
	if (bytes.length >= 12 && ascii(bytes, 4, "ftyp")) {
		const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0)

		if (AVIF_BRANDS.has(brand)) {
			return "avif"
		}

		if (HEIC_BRANDS.has(brand)) {
			return "heic"
		}
	}

	return "format"
}

// The PNG an SVG picture carries for Word: at its own size, or as large as the pixel limit allows.
export function svgFallbackSize(width: number, height: number): { width: number; height: number } {
	const scale = Math.min(1, Math.sqrt(MAX_IMAGE_PIXELS / Math.max(1, width * height)))

	return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
}

export interface PictureSource {
	// Bytes, known before reading (File.size, the drive item's size).
	readonly size: number
	readonly name?: string
	// The MIME type the source gives (a File's; "" or absent when unknown).
	readonly type?: string
	read(signal: AbortSignal): Promise<Uint8Array>
}

// Extensions of pictures (the formats Word shows, and WebP, converted).
const PICTURE_EXTENSIONS: ReadonlySet<string> = new Set([
	"png",
	"jpg",
	"jpeg",
	"jpe",
	"jfif",
	"gif",
	"bmp",
	"dib",
	"tif",
	"tiff",
	"svg",
	"emf",
	"wmf",
	"webp"
])
const HEIC_EXTENSIONS: ReadonlySet<string> = new Set(["heic", "heif", "hif"])

// What a source is by its name and type alone (before a byte is read): HEIC or AVIF (refused without reading),
// a picture, something else, or unknown (no extension, no type).
export function sourceKind(source: Pick<PictureSource, "name" | "type">): "heic" | "avif" | "picture" | "other" | "unknown" {
	const dot = source.name?.lastIndexOf(".") ?? -1
	const extension = source.name === undefined || dot <= 0 ? "" : source.name.slice(dot + 1).toLowerCase()
	const type = (source.type ?? "").toLowerCase()

	if (HEIC_EXTENSIONS.has(extension) || type === "image/heic" || type === "image/heif") {
		return "heic"
	}

	if (extension === "avif" || type === "image/avif") {
		return "avif"
	}

	if (PICTURE_EXTENSIONS.has(extension) || type.startsWith("image/")) {
		return "picture"
	}

	return extension === "" && type === "" ? "unknown" : "other"
}

// What draws and encodes pictures (a browser's canvas; stand-ins in tests).
export interface PictureCodecs {
	webpToPng(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array>
	svgToPng(bytes: Uint8Array, size: { width: number; height: number }, signal: AbortSignal): Promise<Uint8Array>
}

export interface PreparedPicture {
	readonly bytes: Uint8Array
	readonly info: DocxImageInfo
	readonly name?: string
	// The PNG shown where an SVG cannot be drawn.
	readonly fallback?: Uint8Array
	// An animated WebP: its first frame is what goes in.
	readonly animated?: true
}

export type PictureResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: DocxPictureRefusal }

function refused(refusal: DocxPictureRefusal): { ok: false; refusal: DocxPictureRefusal } {
	return { ok: false, refusal }
}

// The header's verdict on bytes Word takes as they are (WebP is converted first).
function sniffed(bytes: Uint8Array, maxPixels: number): PictureResult<DocxImageInfo> {
	const info = sniffImage(bytes, maxPixels)

	switch (info) {
		case "tooLarge":
		case "pixels":
		case "corrupt":
			return refused(info)
		case "format":
			return refused(unsupportedFormat(bytes))
		case "webp":
		case "fallback":
			return refused("format")
		default:
			return { ok: true, value: info }
	}
}

// Steps up to registering it: size, read, header, WebP to PNG, SVG fallback. Throws an AbortError once
// `signal` aborts; any other failure is a refusal. `maxPixels`: the decoded raster budget (Word's by default).
export async function preparePicture(
	source: PictureSource,
	codecs: PictureCodecs,
	signal: AbortSignal,
	maxPixels = MAX_IMAGE_PIXELS
): Promise<PictureResult<PreparedPicture>> {
	const kind = sourceKind(source)

	// Formats Word never shows are refused by name, never read (nor downloaded).
	if (kind === "heic" || kind === "avif") {
		return refused(kind)
	}

	if (oversizedPicture(source.size)) {
		return refused(kind === "other" ? "format" : "tooLarge")
	}

	const named = source.name === undefined ? {} : { name: source.name }

	try {
		let bytes = await source.read(signal)

		signal.throwIfAborted()

		if (oversizedPicture(bytes.length)) {
			return refused("tooLarge")
		}

		let animated = false

		if (sniffImage(bytes) === "webp") {
			const size = webpSize(bytes)

			animated = webpAnimated(bytes)

			if (size === undefined || size.width < 1 || size.height < 1) {
				return refused("corrupt")
			}

			if (size.width * size.height > maxPixels) {
				return refused("pixels")
			}

			bytes = await codecs.webpToPng(bytes, signal)
			signal.throwIfAborted()
		}

		const info = sniffed(bytes, maxPixels)

		if (!info.ok) {
			return info
		}

		if (info.value.format !== "svg") {
			return { ok: true, value: { bytes, info: info.value, ...named, ...(animated ? { animated: true } : {}) } }
		}

		const fallback = await codecs.svgToPng(bytes, svgFallbackSize(info.value.width, info.value.height), signal)

		signal.throwIfAborted()

		if (oversizedPicture(fallback.length)) {
			return refused("tooLarge")
		}

		return { ok: true, value: { bytes, info: info.value, fallback, ...named } }
	} catch (error) {
		if (signal.aborted) {
			throw error
		}

		return refused("failed")
	}
}

export interface PictureMedia {
	addMedia(bytes: Uint8Array, info: { name?: string; contentType: string }): number | undefined
	releaseMedia(handle: number): void
}

// What running the insert did: in, refused, or waiting (for the author's name) — then `settle` gives the
// media back once that is decided (a no-op for media the document uses by then).
export type PictureRun = "inserted" | "refused" | "waiting"

export type PictureInsert =
	| { readonly status: "inserted" }
	| { readonly status: "waiting"; settle: () => void }
	| { readonly status: "refused"; readonly refusal: DocxPictureRefusal }

// Registers the picture (and its fallback) and runs image.insert; media no command uses is released when
// it is refused, when it throws, and (through `settle`) after a wait.
export function insertPicture(
	picture: PreparedPicture,
	media: PictureMedia,
	run: (command: DocxEditorCommand) => PictureRun
): PictureInsert {
	const named = picture.name === undefined ? {} : { name: picture.name }
	const main = media.addMedia(picture.bytes, { contentType: picture.info.contentType, ...named })

	if (main === undefined) {
		return { status: "refused", refusal: "full" }
	}

	let fallback: number | undefined

	if (picture.fallback !== undefined) {
		fallback = media.addMedia(picture.fallback, { contentType: "image/png" })

		if (fallback === undefined) {
			media.releaseMedia(main)

			return { status: "refused", refusal: "full" }
		}
	}

	const release = (): void => {
		media.releaseMedia(main)

		if (fallback !== undefined) {
			media.releaseMedia(fallback)
		}
	}
	let outcome: PictureRun

	try {
		outcome = run({ type: "image.insert", media: main, ...(fallback === undefined ? {} : { fallback }) })
	} catch (error) {
		release()

		throw error
	}

	if (outcome === "inserted") {
		return { status: "inserted" }
	}

	if (outcome === "waiting") {
		return { status: "waiting", settle: release }
	}

	release()

	return { status: "refused", refusal: "place" }
}

// Extensions of pictures Word shows that the drive's preview categories do not count as images.
const WORD_PICTURES: ReadonlySet<string> = new Set(["tif", "tiff", "emf", "wmf"])

// The drive files the picture picker offers: images (HEIC and AVIF too, refused with a reason when picked).
export function isPictureFile(item: DriveItem): boolean {
	const extension = itemTypeExtension(item)

	return previewCategoryForExtension(extension) === "image" || WORD_PICTURES.has(extension)
}

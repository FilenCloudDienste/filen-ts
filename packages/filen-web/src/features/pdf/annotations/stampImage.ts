import { PDF_STAMP_MAX_BYTES } from "@filen/office/dom/pdfedit"
import type { DriveItem } from "@/features/drive/lib/item"
import { extensionOf, itemTypeExtension } from "@/features/drive/lib/preview.logic"
import { IMAGE_FORMATS, type ImageDecode } from "@/features/preview/lib/imageFormat"
import { decodeRasterRgba, RASTER_BYTES_PER_PIXEL } from "@/features/preview/lib/rasterDecode"
import { deviceProfile } from "@/lib/deviceProfile"
import { workerDecodePixels } from "@/lib/pixelBudget"
import { bytesOrigin } from "@/lib/sdk/byteOrigin"
import { mupdfImagePixels, openMupdfReader } from "@/lib/mupdf/reader"
import { readerPageSource } from "@/features/preview/lib/imagePageSource"

// A picture for an image stamp, as the editor takes it: PNG or JPEG bytes no wider or taller than STAMP_MAX_SIDE and
// within the engine's size limit. A PNG or JPEG that already fits goes in as it is; HEIC, QOI and JPEG XL are decoded
// off the main thread (the raster decode pool, whatever the browser decodes itself), a TIFF's first page is drawn by the
// MuPDF engine, and every other picture the browser decodes; those are drawn into a PNG, scaled down to fit.

export const STAMP_MAX_SIDE = 2048

// The image formats a stamp is made from: the browser's own, and those the raster decode pool decodes.
const STAMP_DECODES: ReadonlySet<ImageDecode> = new Set(["native", "heic", "qoi", "jxl", "mupdf"])

// What the device file picker offers: any image type, and the extensions of the formats the stamp decodes that a
// browser may not type as images.
export const STAMP_FILE_ACCEPT = [
	"image/*",
	...[...IMAGE_FORMATS].filter(([, format]) => STAMP_DECODES.has(format.decode)).map(([extension]) => `.${extension}`)
].join(",")

// A drive file the picture picker offers: what the previews show as a picture, HEIC included.
export function isStampPicture(item: DriveItem): boolean {
	const format = IMAGE_FORMATS.get(itemTypeExtension(item))

	return format !== undefined && STAMP_DECODES.has(format.decode)
}

export interface PdfStampImage {
	readonly bytes: Uint8Array
	// Pixels.
	readonly width: number
	readonly height: number
}

function kind(bytes: Uint8Array): "png" | "jpeg" | null {
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png"
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg"

	return null
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(blob => {
			if (blob === null) reject(new Error("the picture could not be encoded"))
			else
				blob.arrayBuffer().then(buffer => {
					resolve(new Uint8Array(buffer))
				}, reject)
		}, "image/png")
	})
}

async function drawn(source: CanvasImageSource, width: number, height: number): Promise<PdfStampImage> {
	const scale = Math.min(1, STAMP_MAX_SIDE / Math.max(width, height))
	const canvas = document.createElement("canvas")

	canvas.width = Math.max(1, Math.round(width * scale))
	canvas.height = Math.max(1, Math.round(height * scale))
	canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height)

	const bytes = await canvasPng(canvas)

	// The canvas's pixels go now rather than with the next collection.
	canvas.width = 0
	canvas.height = 0

	return { bytes, width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

// A TIFF's first page from an engine of its own over the bytes in hand, drawn no larger than the stamp takes.
async function tiffPage(bytes: Uint8Array): Promise<{ data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }> {
	const origin = bytesOrigin(new Blob([bytes as Uint8Array<ArrayBuffer>]), `stamp:${crypto.randomUUID()}`)
	const reader = await openMupdfReader({
		origin,
		access: "authed",
		scope: null,
		format: "tiff",
		maxImagePixels: mupdfImagePixels(deviceProfile(), origin, "tiff")
	})

	try {
		const page = await readerPageSource(reader, 0).renderRgba(STAMP_MAX_SIDE * STAMP_MAX_SIDE, new AbortController().signal)

		return { data: page.rgba, width: page.width, height: page.height }
	} finally {
		await reader.close()
	}
}

async function prepared(bytes: Uint8Array, name: string): Promise<PdfStampImage> {
	const decode = IMAGE_FORMATS.get(extensionOf(name))?.decode

	if (decode === "mupdf") {
		const page = await tiffPage(bytes)
		const bitmap = await createImageBitmap(new ImageData(page.data, page.width, page.height))

		try {
			return await drawn(bitmap, bitmap.width, bitmap.height)
		} finally {
			bitmap.close()
		}
	}

	if (decode === "heic" || decode === "qoi" || decode === "jxl") {
		const maxPixels =
			decode === "heic"
				? Number.POSITIVE_INFINITY
				: workerDecodePixels(deviceProfile(), bytes.byteLength, RASTER_BYTES_PER_PIXEL[decode])
		const decoded = await decodeRasterRgba(decode, bytes, maxPixels)
		const bitmap = await createImageBitmap(new ImageData(decoded.data, decoded.width, decoded.height))

		try {
			return await drawn(bitmap, bitmap.width, bitmap.height)
		} finally {
			bitmap.close()
		}
	}

	const bitmap = await createImageBitmap(new Blob([bytes.slice()]))

	try {
		if (kind(bytes) !== null && Math.max(bitmap.width, bitmap.height) <= STAMP_MAX_SIDE && bytes.byteLength <= PDF_STAMP_MAX_BYTES)
			return { bytes, width: bitmap.width, height: bitmap.height }

		return await drawn(bitmap, bitmap.width, bitmap.height)
	} finally {
		bitmap.close()
	}
}

// The picture `bytes` (named `name`, whose extension tells a format the pool decodes) ready to stamp; rejects when it can't be read or is
// still too large.
export async function prepareStampImage(bytes: Uint8Array, name: string): Promise<PdfStampImage> {
	const image = await prepared(bytes, name)

	if (image.bytes.byteLength > PDF_STAMP_MAX_BYTES) throw new Error("the picture is too large")

	return image
}

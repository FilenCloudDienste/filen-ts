import { PDF_STAMP_MAX_BYTES } from "@filen/office/dom/pdfedit"
import type { DriveItem } from "@/features/drive/lib/item"
import { extensionOf, itemTypeExtension } from "@/features/drive/lib/preview.logic"
import { IMAGE_FORMATS, type ImageDecode, type ImageFormat } from "@/features/preview/lib/imageFormat"
import { decodeRasterRgba, displayRaster, RASTER_BYTES_PER_PIXEL } from "@/features/preview/lib/rasterDecode"
import { deviceProfile } from "@/lib/deviceProfile"
import { workerDecodePixels } from "@/lib/pixelBudget"
import { bytesOrigin } from "@/lib/sdk/byteOrigin"
import { mupdfImagePixels, openMupdfReader } from "@/lib/mupdf/reader"
import { readerPageSource } from "@/features/preview/lib/imagePageSource"

// A picture for an image stamp, as the editor takes it: PNG or JPEG bytes no wider or taller than STAMP_MAX_SIDE and
// within the engine's size limit. A PNG or JPEG that already fits goes in as it is; HEIC, QOI and JPEG XL are decoded
// off the main thread (the raster decode pool, whatever the browser decodes itself), a TIFF's first page or a Photoshop
// composite is drawn by the MuPDF engine, and every other picture the browser decodes; those are drawn into a PNG,
// scaled down to fit.

export const STAMP_MAX_SIDE = 2048

// The image formats a stamp is made from: the browser's own, and those the raster decode pool decodes.
const STAMP_DECODES: ReadonlySet<ImageDecode> = new Set(["native", "heic", "qoi", "jxl", "mupdf"])

// A format a stamp is made from. Not a Large Document Format file, which the engine does not read (its row is not
// editable).
function stampTakes(format: ImageFormat): boolean {
	return STAMP_DECODES.has(format.decode) && (format.decode !== "mupdf" || format.editable)
}

// What the device file picker offers: any image type, and the extensions of the formats the stamp decodes that a
// browser may not type as images.
export const STAMP_FILE_ACCEPT = [
	"image/*",
	...[...IMAGE_FORMATS].filter(([, format]) => stampTakes(format)).map(([extension]) => `.${extension}`)
].join(",")

// A drive file the picture picker offers: what the previews show as a picture, HEIC included.
export function isStampPicture(item: DriveItem): boolean {
	const format = IMAGE_FORMATS.get(itemTypeExtension(item))

	return format !== undefined && stampTakes(format)
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

// A TIFF's first page or a Photoshop file's composite, from an engine of its own over the bytes in hand, drawn no larger
// than the stamp takes.
async function mupdfPage(
	bytes: Uint8Array,
	format: "tiff" | "psd"
): Promise<{ data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }> {
	const origin = bytesOrigin(new Blob([bytes as Uint8Array<ArrayBuffer>]), `stamp:${crypto.randomUUID()}`)
	const reader = await openMupdfReader({
		origin,
		access: "authed",
		scope: null,
		format,
		maxImagePixels: mupdfImagePixels(deviceProfile(), origin, format)
	})

	try {
		const page = await readerPageSource(reader, 0).renderRgba(STAMP_MAX_SIDE * STAMP_MAX_SIDE, new AbortController().signal)

		return { data: page.rgba, width: page.width, height: page.height }
	} finally {
		await reader.close()
	}
}

// A HEIC picture as a bitmap whose long side is at most `maxSide`, never scaled up. The worker decodes it at full size
// (orientation applied); the bitmap is made at the smaller size, so the page never holds a full-size bitmap beside that
// frame, and the frame goes with this call.
export async function fittedHeicBitmap(bytes: Uint8Array, maxSide: number): Promise<ImageBitmap> {
	const decoded = await decodeRasterRgba("heic", bytes, Number.POSITIVE_INFINITY)
	const frame = new ImageData(decoded.data, decoded.width, decoded.height)
	const scale = maxSide / Math.max(decoded.width, decoded.height)

	if (scale >= 1) return await createImageBitmap(frame)

	return await createImageBitmap(frame, {
		resizeWidth: Math.max(1, Math.round(decoded.width * scale)),
		resizeHeight: Math.max(1, Math.round(decoded.height * scale)),
		resizeQuality: "high"
	})
}

async function prepared(bytes: Uint8Array, name: string): Promise<PdfStampImage> {
	const format = IMAGE_FORMATS.get(extensionOf(name))
	const decode = format?.decode

	if (format?.mupdf !== undefined) {
		const page = await mupdfPage(bytes, format.mupdf)
		const bitmap = await createImageBitmap(new ImageData(page.data, page.width, page.height))

		try {
			return await drawn(bitmap, bitmap.width, bitmap.height)
		} finally {
			bitmap.close()
		}
	}

	// Scaled to the stamp's size in the worker: only that bitmap reaches the page.
	if (decode === "qoi" || decode === "jxl") {
		const maxPixels = workerDecodePixels(deviceProfile(), bytes.byteLength, RASTER_BYTES_PER_PIXEL[decode])
		const { bitmap } = await displayRaster(decode, bytes, { maxPixels, maxLongSide: STAMP_MAX_SIDE })

		try {
			return await drawn(bitmap, bitmap.width, bitmap.height)
		} finally {
			bitmap.close()
		}
	}

	if (decode === "heic") {
		const bitmap = await fittedHeicBitmap(bytes, STAMP_MAX_SIDE)

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

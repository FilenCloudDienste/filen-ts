import { PDF_STAMP_MAX_BYTES } from "@filen/office/dom/pdfedit"
import type { DriveItem } from "@/features/drive/lib/item"
import { extensionOf, HEIC_EXTENSIONS, itemTypeExtension, previewCategoryForExtension } from "@/features/drive/lib/preview.logic"
import { decodeHeicRgba } from "@/features/preview/lib/heicTransform"

// A picture for an image stamp, as the editor takes it: PNG or JPEG bytes no wider or taller than STAMP_MAX_SIDE and
// within the engine's size limit. A PNG or JPEG that already fits goes in as it is; HEIC is decoded off the main
// thread (heic worker) and every other picture the browser decodes; those are drawn into a PNG, scaled down to fit.

export const STAMP_MAX_SIDE = 2048

// A drive file the picture picker offers: what the previews show as a picture, HEIC included.
export function isStampPicture(item: DriveItem): boolean {
	const extension = itemTypeExtension(item)

	return previewCategoryForExtension(extension) === "image" || HEIC_EXTENSIONS.has(extension)
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

async function prepared(bytes: Uint8Array, name: string): Promise<PdfStampImage> {
	if (HEIC_EXTENSIONS.has(extensionOf(name))) {
		const decoded = await decodeHeicRgba(bytes)
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

// The picture `bytes` (named `name`, whose extension tells HEIC) ready to stamp; rejects when it can't be read or is
// still too large.
export async function prepareStampImage(bytes: Uint8Array, name: string): Promise<PdfStampImage> {
	const image = await prepared(bytes, name)

	if (image.bytes.byteLength > PDF_STAMP_MAX_BYTES) throw new Error("the picture is too large")

	return image
}

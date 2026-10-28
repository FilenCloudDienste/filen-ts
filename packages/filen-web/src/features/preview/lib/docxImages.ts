import { attemptEncode } from "@/features/drive/lib/thumbGenerators.logic"
import { prepareSvgThumb } from "@filen/shared/svgThumb"
import type { PictureCodecs, PictureSource } from "@/features/preview/lib/docxImages.logic"
import { driveItemName } from "@filen/shared"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import type { DriveItem } from "@/features/drive/lib/item"
import { runOp } from "@/lib/actions/outcome"
import { sdkApi } from "@/lib/sdk/client"

// The browser's side of the DOCX picture pipeline (docxImages.logic.ts): WebP decoded and written as PNG, an
// SVG drawn to the PNG Word shows in its place. Pictures are drawn at their own size, never scaled down.

async function canvasPng(width: number, height: number, draw: (context: OffscreenCanvasRenderingContext2D) => void): Promise<Uint8Array> {
	const canvas = new OffscreenCanvas(width, height)
	const context = canvas.getContext("2d")

	if (context === null) {
		throw new Error("no 2D canvas context")
	}

	draw(context)

	const blob = await attemptEncode(canvas, "image/png")

	if (blob.type !== "image/png") {
		throw new Error("canvas did not encode PNG")
	}

	return new Uint8Array(await blob.arrayBuffer())
}

async function webpToPng(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
	const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/webp" }))

	try {
		signal.throwIfAborted()

		return await canvasPng(bitmap.width, bitmap.height, context => {
			context.drawImage(bitmap, 0, 0)
		})
	} finally {
		bitmap.close()
	}
}

// Only ever through an <img>: the SVG spec's secure mode runs no script and fetches nothing, so the markup is
// never sanitised (prepareSvgThumb refuses the entity bombs that mode does not cover).
async function svgToPng(bytes: Uint8Array, size: { width: number; height: number }, signal: AbortSignal): Promise<Uint8Array> {
	const prepared = prepareSvgThumb(new TextDecoder().decode(bytes), Math.max(size.width, size.height))

	if (prepared.type === "rejected") {
		throw new Error(`svg refused: ${prepared.reason}`)
	}

	const url = URL.createObjectURL(new Blob([prepared.markup], { type: "image/svg+xml" }))

	try {
		const image = new Image(prepared.width, prepared.height)

		image.src = url
		await image.decode()
		signal.throwIfAborted()

		return await canvasPng(prepared.width, prepared.height, context => {
			context.drawImage(image, 0, 0, prepared.width, prepared.height)
		})
	} finally {
		URL.revokeObjectURL(url)
	}
}

export const BROWSER_PICTURE_CODECS: PictureCodecs = { webpToPng, svgToPng }

export function fileSource(file: File): PictureSource {
	return {
		size: file.size,
		name: file.name,
		type: file.type,
		read: async () => new Uint8Array(await file.arrayBuffer())
	}
}

// A drive file's bytes for a picture going into a document: read through the SDK worker, cancelled when `signal`
// aborts, and kept nowhere (the preview's byte cache is for previews: a picture's bytes go into the document).
export async function readDriveFileBytes(item: DriveItem, signal: AbortSignal): Promise<Uint8Array> {
	const file = narrowToAnyFile(item)
	const token = crypto.randomUUID()
	const cancel = (): void => {
		void sdkApi.cancelPreviewDownload(token)
	}

	signal.addEventListener("abort", cancel, { once: true })

	try {
		return await runOp(sdkApi.downloadFileBytes(file, token))
	} finally {
		signal.removeEventListener("abort", cancel)
	}
}

export function driveSource(item: DriveItem): PictureSource {
	return {
		size: Number(narrowToAnyFile(item).size),
		name: driveItemName(item),
		read: signal => readDriveFileBytes(item, signal)
	}
}

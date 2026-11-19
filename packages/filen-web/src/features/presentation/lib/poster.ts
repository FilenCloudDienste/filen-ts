import type { InsertedImage } from "@filen/office/core/presentation"

// A medium's poster on a slide, one rule for every poster: at most POSTER_MAX px on its longest side, encoded at
// QUALITY (JPEG; PNG keeps its alpha).

// The poster's longest side, px.
const POSTER_MAX = 1280
const QUALITY = 0.85

export type PosterType = "image/png" | "image/jpeg"

// The canvas as a picture a slide holds.
export async function canvasImage(canvas: HTMLCanvasElement, type: PosterType): Promise<InsertedImage> {
	const blob = await new Promise<Blob | null>(resolve => {
		canvas.toBlob(resolve, type, QUALITY)
	})

	if (blob === null) throw new Error("the poster could not be encoded")

	return { bytes: new Uint8Array(await blob.arrayBuffer()), contentType: type, width: canvas.width, height: canvas.height }
}

// `source` (`width` x `height` px) drawn as a poster.
export function posterFromSource(source: CanvasImageSource, width: number, height: number, type: PosterType): Promise<InsertedImage> {
	const scale = Math.min(1, POSTER_MAX / Math.max(width, height))
	const canvas = document.createElement("canvas")

	canvas.width = Math.max(1, Math.round(width * scale))
	canvas.height = Math.max(1, Math.round(height * scale))
	canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height)

	return canvasImage(canvas, type)
}

import type { QuarterTurns } from "../../../core/pdfedit/ocrGeometry"

// 8-bit grey images as the recogniser reads them: rows of `stride` bytes, `width` used.

export interface GrayImage {
	readonly pixels: Uint8Array
	readonly width: number
	readonly height: number
	readonly stride: number
}

// The image turned clockwise by `turns` (a new, tightly packed buffer; the input when 0).
export function rotateGray(image: GrayImage, turns: QuarterTurns): GrayImage {
	if (turns === 0) return image

	const { pixels, width, height, stride } = image
	const outWidth = turns === 2 ? width : height
	const outHeight = turns === 2 ? height : width
	const out = new Uint8Array(outWidth * outHeight)

	for (let y = 0; y < height; y++) {
		const row = y * stride

		for (let x = 0; x < width; x++) {
			const value = pixels[row + x] ?? 255
			// Pixel (x, y) lands at quarterTurnMatrix's image of its centre.
			const index =
				turns === 1
					? x * outWidth + (height - 1 - y)
					: turns === 2
						? (height - 1 - y) * outWidth + (width - 1 - x)
						: (width - 1 - x) * outWidth + y

			out[index] = value
		}
	}

	return { pixels: out, width: outWidth, height: outHeight, stride: outWidth }
}

// Dark pixels in rows [top, top + rows), every 4th pixel of every 4th row.
function ink(image: GrayImage, top: number, rows: number): number {
	let dark = 0

	for (let y = top; y < top + rows; y += 4) {
		const row = y * image.stride

		for (let x = 0; x < image.width; x += 4) if ((image.pixels[row + x] ?? 255) < 128) dark++
	}

	return dark
}

// A third of the image's rows, shrunk by an integer `factor` (box average): a small sample of the page's text for
// orientation checks. The middle third, unless the top or bottom one holds more ink (a page with little text).
export function textStrip(image: GrayImage, factor: number): GrayImage {
	const step = Math.max(1, Math.floor(factor))
	const rows = Math.max(1, Math.floor(image.height / 3))
	const bands = [rows, 0, Math.max(0, image.height - rows)]
	let top = rows
	let most = -1

	for (const band of bands) {
		const dark = ink(image, band, rows)

		if (dark > most) {
			most = dark
			top = band
		}
	}
	const outWidth = Math.max(1, Math.floor(image.width / step))
	const outHeight = Math.max(1, Math.floor(rows / step))
	const out = new Uint8Array(outWidth * outHeight)
	const area = step * step

	for (let y = 0; y < outHeight; y++) {
		for (let x = 0; x < outWidth; x++) {
			let sum = 0

			for (let dy = 0; dy < step; dy++) {
				const row = (top + y * step + dy) * image.stride + x * step

				for (let dx = 0; dx < step; dx++) sum += image.pixels[row + dx] ?? 255
			}

			out[y * outWidth + x] = Math.round(sum / area)
		}
	}

	return { pixels: out, width: outWidth, height: outHeight, stride: outWidth }
}

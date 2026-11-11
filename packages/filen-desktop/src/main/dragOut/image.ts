import type { DesktopDragImage } from "@filen/shared/desktop"

// The drag image the page sends: a PNG of its chip, at most 640×160 CSS px at a scale of at most 3. Its pixel size is
// read from the IHDR chunk before anything decodes it, so a small file cannot unpack into a huge bitmap.

export const DRAG_IMAGE_MAX_BYTES = 2 * 1024 ** 2
export const DRAG_IMAGE_MAX_WIDTH = 640
export const DRAG_IMAGE_MAX_HEIGHT = 160
export const DRAG_IMAGE_MAX_SCALE = 3

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
// "IHDR", the first chunk's type, right after the signature and the chunk's length.
const IHDR = [0x49, 0x48, 0x44, 0x52]

// The PNG's size in pixels; null when the bytes do not start like a PNG.
export function pngPixels(png: Uint8Array): { width: number; height: number } | null {
	if (png.byteLength < 24 || SIGNATURE.some((byte, i) => png[i] !== byte) || IHDR.some((byte, i) => png[12 + i] !== byte)) {
		return null
	}

	const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
	const width = view.getUint32(16)
	const height = view.getUint32(20)

	return width === 0 || height === 0 ? null : { width, height }
}

// The PNG is no larger in pixels than its CSS size at its scale (one pixel of rounding allowed).
export function dragImageFits(image: DesktopDragImage): boolean {
	const pixels = pngPixels(image.png)

	return (
		pixels !== null &&
		pixels.width <= Math.ceil(image.width * image.scale) + 1 &&
		pixels.height <= Math.ceil(image.height * image.scale) + 1
	)
}

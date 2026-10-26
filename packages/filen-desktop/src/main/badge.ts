// Windows has no badge count; the taskbar button takes an overlay icon instead. A plain anti-aliased dot, drawn once,
// avoids rendering numbers: the count goes in the overlay's accessible description.
export const BADGE_DOT_SIZE = 16

// Premultiplied BGRA, what nativeImage.createFromBitmap reads.
export function badgeDotBitmap(size: number = BADGE_DOT_SIZE): Buffer {
	const bitmap = Buffer.alloc(size * size * 4)
	const center = size / 2
	const radius = size / 2 - 0.5
	// #e5484d
	const [red, green, blue] = [0xe5, 0x48, 0x4d]

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const coverage = Math.min(1, Math.max(0, radius + 0.5 - Math.hypot(x + 0.5 - center, y + 0.5 - center)))
			const offset = (y * size + x) * 4

			bitmap[offset] = Math.round(blue * coverage)
			bitmap[offset + 1] = Math.round(green * coverage)
			bitmap[offset + 2] = Math.round(red * coverage)
			bitmap[offset + 3] = Math.round(255 * coverage)
		}
	}

	return bitmap
}

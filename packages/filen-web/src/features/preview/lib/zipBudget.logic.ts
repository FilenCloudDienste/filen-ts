// A zip a viewer unpacks itself (a KMZ's KML, a 3MF's or USDZ's parts) is checked against its viewer's budget from the
// central directory, before anything inflates: what it declares in all, and how far one entry expands. Inflating
// stops at the declared size (@filen/office's ZipArchive), so a lying header is cut off there.

// Past 1 MiB, an entry may expand at most this far (text and meshes deflate well under it; a bomb is far over).
export const ZIP_MAX_RATIO = 200
const RATIO_FLOOR = 1024 * 1024

export interface ZipEntrySize {
	readonly compressed: number
	readonly uncompressed: number
}

export function entryFits(entry: ZipEntrySize, cap: number): boolean {
	return (
		entry.uncompressed <= cap &&
		(entry.uncompressed <= RATIO_FLOOR || entry.uncompressed <= Math.max(entry.compressed, 1) * ZIP_MAX_RATIO)
	)
}

// Every entry within the ratio, and all of them within `cap` together.
export function zipFits(entries: readonly ZipEntrySize[], cap: number): boolean {
	let total = 0

	for (const entry of entries) {
		total += entry.uncompressed

		if (!entryFits(entry, cap) || total > cap) return false
	}

	return true
}

import { sniffImage } from "@/features/preview/lib/imageSniff/sniffImage"
import { startsWith } from "@/features/preview/lib/imageSniff/bytes"
import { readExifSummary, type ExifSummary } from "@/features/preview/imageEdit/lib/exifSummary"

// What the item details show for a picture, read from its header: never the whole file.

// Enough for a JPEG's APP1 Exif, a PNG's or WebP's leading eXIf/EXIF chunk, a HEIF's or AVIF's meta box and Exif
// item, and a TIFF-based file's IFDs, in the files cameras and phones write. Metadata past it is skipped: one read.
export const IMAGE_DETAILS_HEAD_BYTES = 128 * 1024

export interface ImageDetails {
	// Upright, after orientation; 0 when the header does not say.
	width: number
	height: number
	exif: ExifSummary | null
}

export function imageDetailsQueryKey(uuid: string) {
	return ["drive", "imageDetails", uuid] as const
}

// "II*\0" / "MM\0*" and the RAW variants' "IIRO", "IIRS", "IIU\0": the file itself is the TIFF block.
function isTiffStructured(head: Uint8Array): boolean {
	return startsWith(head, [0x49, 0x49]) || startsWith(head, [0x4d, 0x4d, 0, 0x2a])
}

// The format sniffers locate the Exif block (JPEG APP1, PNG eXIf, WebP EXIF, HEIF/AVIF Exif item); a TIFF or
// TIFF-based camera RAW is read as the block itself. Null when the head is no picture this knows.
export function imageDetailsFromHead(head: Uint8Array, size: number): ImageDetails | null {
	const info = sniffImage(head, size)
	const tiff = info?.exif ?? (isTiffStructured(head) ? head : null)
	const exif = tiff === null ? null : readExifSummary(tiff)

	if (info === null && exif === null) {
		return null
	}

	return { width: info?.width ?? 0, height: info?.height ?? 0, exif }
}

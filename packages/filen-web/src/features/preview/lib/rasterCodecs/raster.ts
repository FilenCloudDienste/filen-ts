// What the raster decode pool's own decoders give: the whole image as RGBA (straight alpha), and whether it carries
// alpha, which picks an edited copy's format. `data` is a fresh ArrayBuffer, never shared memory, so it transfers.
export interface DecodedRaster {
	width: number
	height: number
	data: Uint8ClampedArray<ArrayBuffer>
	hasAlpha: boolean
}

// The formats the pool decodes itself: HEIC (libheif), QOI (in-house), JPEG XL (libjxl, where the browser has no
// decoder of its own).
export type RasterFormat = "heic" | "qoi" | "jxl"

// The formats it decodes for display, as a bitmap: HEIC is shown from its JPEG re-encode instead.
export type DisplayRasterFormat = Exclude<RasterFormat, "heic">

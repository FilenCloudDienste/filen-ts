import { sniffJxlUpright } from "@/features/preview/lib/imageSniff/jxl"
import { sniffQoi } from "@/features/preview/lib/imageSniff/qoi"
import { epsiHeader } from "@/features/preview/lib/rasterCodecs/epsi"
import type { DisplayRasterFormat } from "@/features/preview/lib/rasterCodecs/raster"

type RasterHeader = { readonly width: number; readonly height: number } | null

const HEADERS: Readonly<Record<DisplayRasterFormat, (bytes: Uint8Array) => RasterHeader>> = {
	qoi: sniffQoi,
	jxl: bytes => sniffJxlUpright(bytes, bytes.length),
	epsi: epsiHeader
}

// The size the header of an image the raster decode pool decodes names, upright as it is drawn, from the bytes in hand;
// null when it is not that format (or names no size).
export function rasterHeader(format: DisplayRasterFormat, bytes: Uint8Array): RasterHeader {
	return HEADERS[format](bytes)
}

import type { MupdfReader } from "@/lib/mupdf/reader"

// The page an image viewer shows from a document engine (a TIFF's page), for the image editor: its source pixels and
// the page drawn whole as RGBA, from the engine that already holds the file.
export interface ImagePageSource {
	readonly page: number
	readonly pageCount: number
	// The page image's own pixels, nothing decoded; null when it has none.
	extent(): Promise<{ readonly width: number; readonly height: number } | null>
	// The page drawn whole, at most `maxPixels` (never above its image's own).
	renderRgba(
		maxPixels: number,
		signal: AbortSignal
	): Promise<{ readonly rgba: Uint8ClampedArray<ArrayBuffer>; readonly width: number; readonly height: number }>
}

export function readerPageSource(reader: MupdfReader, page: number): ImagePageSource {
	return {
		page,
		pageCount: reader.pageCount,
		extent: () => reader.imageExtent(page),
		renderRgba: async (maxPixels, signal) => {
			const drawn = await reader.renderPage(page, { maxPixels, output: "rgba", signal })

			if (!("rgba" in drawn)) {
				drawn.close()

				throw new Error("the engine drew a bitmap where RGBA was asked")
			}

			return drawn
		}
	}
}

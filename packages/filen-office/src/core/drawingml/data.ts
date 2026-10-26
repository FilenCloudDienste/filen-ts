import type { DrawingClip, DrawingImage, DrawingText, Paint, Shadow, Stroke } from "./displayList"

// A drawing's display list as data (DrawingList.compact() without its interning maps).
export interface DrawingData {
	// The frame the drawing was built for (px); the renderer scales it onto the object's box.
	readonly width: number
	readonly height: number
	readonly commands: Uint8Array
	readonly coords: Float32Array
	readonly itemCount: number
	readonly itemFloats: Float32Array
	readonly itemInts: Int32Array
	readonly paints: readonly Paint[]
	readonly strokes: readonly Stroke[]
	readonly images: readonly DrawingImage[]
	readonly texts: readonly DrawingText[]
	readonly shadows: readonly Shadow[]
	readonly clips?: readonly DrawingClip[]
	// Per item: its clip, or -1; absent when no item is clipped.
	readonly itemClips?: Int32Array
	// Per text: the font family list the engine resolved for it (an internal alias and a generic family),
	// or "" for none.
	readonly textFonts?: readonly string[]
	// The surface the drawing starts on (0xRRGGBBAA), absent for a transparent one.
	readonly background?: number
}

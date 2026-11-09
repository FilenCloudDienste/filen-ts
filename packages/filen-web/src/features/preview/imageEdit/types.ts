// The image editor's shared vocabulary: the edit recipe (what the user did, never pixels), what the
// sniffers learn about the original, and where a save goes. Framework-free; the libs, the render worker,
// the editor and the overlay all speak these.

// Exif orientation (CIPA DC-008 §4.6.4); 1 when the file carries none.
export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

// Clockwise quarter turns.
export type QuarterTurns = 0 | 1 | 2 | 3

// Each −100..100 with 0 the identity, except sharpness and vignette (0..100).
export interface Adjustments {
	exposure: number
	brightness: number
	contrast: number
	highlights: number
	shadows: number
	warmth: number
	tint: number
	saturation: number
	vibrance: number
	sharpness: number
	vignette: number
}

export type AspectPreset = "free" | "original" | "square" | "4:3" | "3:2" | "16:9" | "3:4" | "2:3" | "9:16"

// Applied in this order to the UPRIGHT decoded source (its Exif orientation already applied by the decoder):
// 1. quarterTurns clockwise, then flipH/flipV in the turned frame;
// 2. straighten by `angle` degrees (−45..45) about the crop's centre;
// 3. an axis-aligned crop in the straightened frame, normalised 0..1 of the turned frame's width/height.
export interface Geometry {
	quarterTurns: QuarterTurns
	flipH: boolean
	flipV: boolean
	angle: number
	crop: { x: number; y: number; width: number; height: number }
	aspect: AspectPreset
}

// A hex colour from the markup palette.
export type MarkupColor = string

// Markup lives in UPRIGHT SOURCE pixel space (before geometry), widths and sizes in source pixels, so a later
// crop or turn never stretches it. Text is drawn upright in output space, anchored at its mapped point.
// Composited after the colour pipeline and the vignette.
export type MarkupItem =
	| { kind: "pen" | "highlighter"; id: string; color: MarkupColor; width: number; points: readonly number[] }
	| { kind: "arrow"; id: string; color: MarkupColor; width: number; from: readonly [number, number]; to: readonly [number, number] }
	| { kind: "text"; id: string; color: MarkupColor; size: number; at: readonly [number, number]; text: string }

export interface ImageEditRecipe {
	geometry: Geometry
	adjustments: Adjustments
	// A FILTER_PRESETS id; its adjustments are added to `adjustments` at render.
	filter: string | null
	markup: readonly MarkupItem[]
}

export type SourceMime =
	"image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/bmp" | "image/x-icon" | "image/avif" | "image/heic"

// What the sniffers learn about the original from its header bytes (magic, never the extension).
export interface SourceInfo {
	mime: SourceMime
	// Upright, after orientation.
	width: number
	height: number
	// As stored.
	orientation: Orientation
	// From header flags, never a pixel scan.
	hasAlpha: boolean
	animated: boolean
	// PNG colour type 2 or 6 at bit depth 8: the only PNG saved in place.
	pngTruecolor8: boolean
	webpLossless: boolean
	// The JPEG's quality estimated from its luminance quantisation table, 1..100.
	jpegQuality: number | null
	// JPEG/WebP/HEIF: the ICC profile, reassembled. PNG: the raw iCCP chunk data (name, method, zlib stream).
	icc: Uint8Array | null
	// The TIFF block (from "II*\0" / "MM\0*"), without the "Exif\0\0" prefix.
	exif: Uint8Array | null
	// WebP: the header says Exif follows the image data, past the bytes read.
	needsTail: boolean
}

export type SaveTarget =
	| { kind: "inPlace"; mime: "image/jpeg" | "image/png" | "image/webp" }
	| { kind: "copy"; mime: "image/jpeg" | "image/png"; extension: "jpg" | "png" }

// Where the editor gets the original's full-resolution pixels: the held bytes (decoded in the render worker),
// a bitmap taken from the viewer's already decoded <img> (transferred to the worker), or RGBA a decoder made
// (HEIC, through the HEIC worker).
export type ImageEditSource =
	| { kind: "blob"; blob: Blob }
	| { kind: "bitmap"; bitmap: ImageBitmap }
	| { kind: "rgba"; width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }

// What the overlay asks the open editor for when saving to `target`. `geometryOnly` is set for a JPEG saved in
// place whose edit only turned or flipped it: the overlay then rewrites the original's Orientation losslessly
// (to `orientation`) and `blob` is null.
export type ImageExportSource = (target: SaveTarget) => Promise<{ blob: Blob | null; geometryOnly: { orientation: Orientation } | null }>

// The editor's commands the overlay header drives.
export interface ImageEditorCommands {
	undo(): void
	redo(): void
	revert(): void
}

// What the render worker can do on this device, asked once per session on entering edit mode.
export interface EditCapabilities {
	webgl2: boolean
	maxTextureSize: number
	// The largest source (width × height) the export may take on this device.
	maxPixels: number
	canEncodeWebp: boolean
}

// One editing session in the render worker (renderClient.ts), opened on Edit and closed on leaving edit mode.
// Big buffers are always transferred, never cloned.
export interface EditSession {
	// `canvas` comes from transferControlToOffscreen on an element made for this call; sizes in CSS px.
	attach(canvas: OffscreenCanvas, cssWidth: number, cssHeight: number, devicePixelRatio: number): Promise<void>
	resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void
	// Takes ownership of the source (its bitmap or buffer is transferred); resolves with the upright size.
	load(source: ImageEditSource, info: SourceInfo): Promise<{ width: number; height: number }>
	// Coalesced to one draw per frame. `compare`: the original's colours, geometry kept.
	render(recipe: ImageEditRecipe, options: { compare: boolean }): void
	// One square thumbnail without a filter, then one per FILTER_PRESETS entry, in order.
	filterThumbnails(recipe: ImageEditRecipe, size: number): Promise<ImageBitmap[]>
	// Full resolution, tiled; the source stays loaded so a failed upload can export again.
	export(
		recipe: ImageEditRecipe,
		target: { mime: "image/jpeg" | "image/png" | "image/webp"; quality: number },
		meta: { exif: Uint8Array | null; icc: Uint8Array | null; hasAlpha: boolean; webpLossless: boolean }
	): Promise<Blob>
	close(): void
}

// Bounds on what one metafile may cost. Metafiles come from untrusted documents: every count below is checked
// before the work it guards, and reaching one ends playback with what was drawn so far.

// Input bytes (after .emz/.wmz decompression).
export const MAX_METAFILE_BYTES = 64 * 1024 * 1024
// Records played, EMF+ records inside comments included.
export const MAX_RECORDS = 2_000_000
// Items in the output list (the renderer draws at most 200 000 per drawing).
export const MAX_ITEMS = 150_000
// Path coordinates in the output list, clips included.
export const MAX_COORDS = 8_000_000
// Points in a path bracket or a single EMF+ path.
export const MAX_PATH_POINTS = 1_000_000
// Text characters drawn.
export const MAX_TEXT_CHARS = 1_000_000
// Objects in the handle table (EMF's header declares at most 65 535 handles; EMF+ uses 64).
export const MAX_OBJECTS = 65_536
// SaveDC / EMF+ Save and container depth.
export const MAX_SAVE_DEPTH = 1024
// Pixels of one bitmap decoded to RGBA (64 MiB).
export const MAX_DECODE_PIXELS = 16 * 1024 * 1024
// Pixels decoded over the whole conversion (bitmaps, masks, pattern brushes, nested pictures excluded).
export const MAX_TOTAL_DECODE_PIXELS = 64 * 1024 * 1024
// Bytes of bitmaps embedded in one metafile.
export const MAX_IMAGE_BYTES = 128 * 1024 * 1024
// Bytes of compressed bitmaps inflated over the whole conversion: what the decoding budget's pixels take at
// four bytes each, drawn or not.
export const MAX_INFLATED_BYTES = MAX_TOTAL_DECODE_PIXELS * 4
// Rectangles read from one region, region nodes of one EMF+ region, and their nesting.
export const MAX_REGION_RECTS = 20_000
export const MAX_REGION_NODES = 4096
export const MAX_REGION_DEPTH = 64
// Clip regions: nesting of a region's parents and members, and the coordinates a live region retains.
export const MAX_CLIP_DEPTH = 512
export const MAX_CLIP_WEIGHT = 2_000_000
// Work units (coordinates and rectangles touched) building, combining and moving clip regions and
// rasterising gradients over the whole conversion.
export const MAX_WORK = 64_000_000
// Metafiles nested in metafiles (EMF+ metafile images, EMF comment alternatives).
export const MAX_NESTING = 2
// An EMF+ object split over continuation records.
export const MAX_CONTINUED_OBJECT = 64 * 1024 * 1024

// Thrown to end playback when a bound is reached; the conversion keeps what it drew.
export class MetafileLimit extends Error {
	constructor(what: string) {
		super(`Metafile limit reached: ${what}`)
		this.name = "MetafileLimit"
	}
}

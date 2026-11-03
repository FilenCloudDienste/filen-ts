import type { DrawingList } from "../drawingml/displayList"

export type MetafileFormat = "emf" | "emf+" | "wmf" | "svm" | "pict"

export type MetafileFailure =
	// Not a metafile, or its header is unreadable.
	| "malformed"
	// Larger than the input bound.
	| "tooLarge"
	// Nested deeper than allowed.
	| "nested"
	// Conversion failed unexpectedly (a defect).
	| "failed"

export type MetafileConversion =
	| {
			readonly ok: true
			// "emf+" when the picture was drawn from its EMF+ records.
			readonly format: MetafileFormat
			readonly list: DrawingList
			// The picture's frame in list coordinates (x, y, width, height): what maps onto the image's box.
			readonly frame: readonly [number, number, number, number]
			// Records or objects that were not drawn.
			readonly unsupported: number
			// Playback stopped at a limit or a truncated record; what came before is drawn.
			readonly truncated: boolean
	  }
	| { readonly ok: false; readonly reason: MetafileFailure }

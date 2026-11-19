import type { ChartText } from "../../drawingml/chart/builder"
import type { InflateHook } from "../../opc/zipReader"
import { SliceClock, type Slicing } from "../../slicing"
import { parseNumFmt, Tok } from "../../sheet/numfmt/parse"
import type { SheetLossyFeature } from "./report"

// A spreadsheet's family: SpreadsheetML (xlsx, xlsm, xltx, xltm) or OpenDocument (ods, ots).
export type SheetSourceFormat = "xlsx" | "ods"
export type SheetConversionFormat = "ods" | "xlsx"

export type SheetConversionRefusal =
	// Not a conversion (a family to itself), or the target cannot hold what may not be dropped.
	| "unsupported"
	// The bytes are not a workbook of the family named.
	| "notSource"
	| "encrypted"
	// The reader could not read it.
	| "corrupt"
	| "tooLarge"
	| "aborted"
	// The file written did not read back as what was converted: nothing is handed out.
	| "verify"

export type SheetConversion =
	| { readonly ok: true; readonly bytes: Uint8Array; readonly lossy: readonly SheetLossyFeature[] }
	| { readonly ok: false; readonly reason: SheetConversionRefusal; readonly message: string }

export interface SheetConvertOptions {
	// Slices, and the signal looked at between them: an aborted conversion is refused "aborted".
	readonly turns?: { readonly signal: { readonly aborted: boolean }; readonly slicing: Slicing }
	readonly inflate?: InflateHook
	// The user's language (BCP 47): an .ods written takes it as its default cell style's (fo:language, fo:country), as
	// a blank one does, so a reader shows and reads numbers in it. en-US without one.
	readonly language?: string
	// What a chart's automatic title reads in an .ods written, in the app's language; English without it.
	readonly chartText?: ChartText
}

export class Aborted extends Error {
	constructor() {
		super("The conversion was aborted")
	}
}

// A clock over the turns that throws Aborted once their signal is.
export function abortClock(options: SheetConvertOptions): SliceClock | undefined {
	const turns = options.turns

	if (turns === undefined) return undefined

	const { signal, slicing } = turns

	return new SliceClock({
		sliceMs: slicing.sliceMs,
		now: slicing.now,
		pause: async () => {
			if (signal.aborted) throw new Aborted()

			await slicing.pause()

			if (signal.aborted) throw new Aborted()
		}
	})
}

// Whether the turns' signal is aborted now (read anew at each call).
export function aborted(options: SheetConvertOptions): boolean {
	return options.turns?.signal.aborted === true
}

// Whether a number format shows a calendar date (not only a time of day or an elapsed span).
export function showsDate(code: string, memo: Map<string, boolean>): boolean {
	let shows = memo.get(code)

	if (shows === undefined) {
		const format = parseNumFmt(code)

		shows =
			format.isDate &&
			format.sections.some(section =>
				section.tokens.some(
					token =>
						token.kind === Tok.YEAR ||
						token.kind === Tok.MONTH ||
						token.kind === Tok.DAY ||
						token.kind === Tok.BUDDHIST_YEAR ||
						token.kind === Tok.ERA
				)
			)
		memo.set(code, shows)
	}

	return shows
}

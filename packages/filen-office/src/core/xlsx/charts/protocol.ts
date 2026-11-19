import type { ImagePlacement } from "../drawings/media"
import type { ChartEditType, SheetChartEdit } from "./edit"
import type { ChartGrouping, ChartInfo } from "./model"
import type { ChartRender } from "./render"

// The charts feature's commands, queries and refusal (feature.ts handles them).

// Where a new chart goes: its top-left cell and offsets, and its size in EMU (Excel's 5 x 3 inches when absent).
export type ChartPlacement = ImagePlacement

declare module "../../sheet/protocol" {
	interface SheetCommandMap {
		// `part`: the chart part a frame on `sheet` shows (the drawings layout lists it).
		"chart.edit": { readonly sheet: SheetId; readonly part: string; readonly edit: SheetChartEdit }
		// A chart of `range` (Excel's reading of a selection), placed at `placement` (5 x 3 inches when no size is given).
		"chart.insert": {
			readonly sheet: SheetId
			readonly range: SheetRange
			readonly chart: ChartEditType
			readonly grouping?: ChartGrouping
			readonly placement: ChartPlacement
		}
	}
	interface SheetQueryMap {
		// A chart drawn at `width` x `height` EMU; `since` the stamp of the drawing the caller holds.
		"chart.render": {
			request: { readonly part: string; readonly width: number; readonly height: number; readonly since?: string }
			result: ChartRender
		}
		// The chart a chartsheet shows, with the size its drawing gives it (EMU); null for another kind of sheet or a
		// chartsheet without a chart this session reads.
		"chart.sheet": {
			request: { readonly sheet: SheetId }
			result: { readonly part: string; readonly width: number; readonly height: number } | null
		}
		// A chart as the chart editor shows it, and why it cannot be edited (null when it can).
		"chart.get": {
			request: { readonly sheet: SheetId; readonly part: string }
			result: { readonly info: ChartInfo; readonly refusal: SheetRefusal | null } | null
		}
	}
	interface SheetRefusalReasons {
		// The chart holds something this editor cannot change without losing it (detail: what), or the part is not a
		// chart this sheet shows.
		chartUnsupported: true
		// A value typed into the chart editor cannot be used (detail: which): not a number, a unit that is not
		// positive, or a minimum not below the maximum. The user can correct it.
		chartValue: true
	}
}

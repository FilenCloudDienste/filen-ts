import type { DataPoint } from "./data"

// What a diagram's text takes where its own pPr sets nothing, as PowerPoint writes it on every drawing it caches
// (MS-ODRAWXML §1.3.4 dsp:txBody): 90% lines, nothing before, 35% of the size after a node's own paragraph and 15%
// after a child's; a child's bullet hangs by three quarters of its size. The text is measured (measure.ts) and drawn
// (emit.ts) with these same values.
export const LINE_PCT = 90000
export const SPACE_AFTER_NODE_PCT = 35000
export const SPACE_AFTER_CHILD_PCT = 15000
export const BULLET_HANG = 0.75
// The deepest paragraph level (a:pPr lvl is 0 to 8).
export const MAX_TEXT_LEVEL = 8

// The paragraph level of the `index`th text point a node presents, by its depth under `base` (the presenting point):
// the first point is level 0, every later one at least 1.
export function textLevel(point: Pick<DataPoint, "depth">, index: number, base: number): number {
	return Math.max(index === 0 ? 0 : 1, Math.min(MAX_TEXT_LEVEL, point.depth - base))
}

// The size a node's children's text is set at: the secondary size where one is given, never above the node's own.
export function childFontPt(secondary: number | undefined, pt: number): number {
	return secondary !== undefined && Number.isFinite(secondary) && secondary > 0 ? Math.min(secondary, pt) : pt
}

// Our own SmartArt gallery (layouts written from ECMA-376 §21.4 semantics; no Microsoft definition files): what
// Insert ▸ SmartArt and "change layout" list. This registry holds names and sample data only, so the page may import
// it; the definitions themselves (defs.ts) are worker-only, kept out of the main bundle. Each family's generated
// data is one names module listed here and one definitions module listed in defs.ts, in gallery order.

import { COLORS_COLORS } from "./colors"
import { CYCLE_LAYOUTS } from "./cycle"
import { HIERARCHY_LAYOUTS } from "./hierarchy"
import { LIST_LAYOUTS } from "./list"
import { MATRIX_LAYOUTS } from "./matrix"
import { PICTURE_LAYOUTS } from "./picture"
import { PROCESS_LAYOUTS } from "./process"
import { PYRAMID_LAYOUTS } from "./pyramid"
import { RELATIONSHIP_LAYOUTS } from "./relationship"
import { STYLES_STYLES } from "./styles"

export type SmartArtCategory = "list" | "process" | "cycle" | "hierarchy" | "relationship" | "matrix" | "pyramid" | "picture"

export interface SmartArtLayoutEntry {
	// dgm:layoutDef@uniqueId.
	readonly uniqueId: string
	readonly category: SmartArtCategory
	// The locale key of its name in the gallery.
	readonly nameKey: string
	// The sample data the gallery preview is laid out with (node texts, by level).
	readonly sample: readonly { readonly level: number; readonly text: string }[]
}

export interface SmartArtStyleEntry {
	readonly uniqueId: string
	readonly nameKey: string
}

export interface SmartArtColorsEntry {
	readonly uniqueId: string
	readonly nameKey: string
}

// In category order; ours first, so Insert ▸ SmartArt's defaults (the first layout, style and colours) are ours. The
// test definitions stay registered, last.
export const SMARTART_LAYOUTS: readonly SmartArtLayoutEntry[] = [
	...LIST_LAYOUTS,
	...PROCESS_LAYOUTS,
	...CYCLE_LAYOUTS,
	...HIERARCHY_LAYOUTS,
	...RELATIONSHIP_LAYOUTS,
	...MATRIX_LAYOUTS,
	...PYRAMID_LAYOUTS,
	...PICTURE_LAYOUTS
]

export const SMARTART_STYLES: readonly SmartArtStyleEntry[] = [...STYLES_STYLES]

export const SMARTART_COLORS: readonly SmartArtColorsEntry[] = [...COLORS_COLORS]

export function smartArtLayout(uniqueId: string): SmartArtLayoutEntry | undefined {
	return SMARTART_LAYOUTS.find(entry => entry.uniqueId === uniqueId)
}

export function smartArtStyle(uniqueId: string): SmartArtStyleEntry | undefined {
	return SMARTART_STYLES.find(entry => entry.uniqueId === uniqueId)
}

export function smartArtColors(uniqueId: string): SmartArtColorsEntry | undefined {
	return SMARTART_COLORS.find(entry => entry.uniqueId === uniqueId)
}

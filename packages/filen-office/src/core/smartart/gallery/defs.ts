// The gallery's definitions by uniqueId (worker-only: the presentation worker lays them out; the page never imports
// this module, so no definition reaches the main bundle). Names and samples are in index.ts.

import { COLORS_COLORS_DEFS } from "./colorsDefs"
import { CYCLE_LAYOUT_DEFS } from "./cycleDefs"
import { HIERARCHY_LAYOUT_DEFS } from "./hierarchyDefs"
import { LIST_LAYOUT_DEFS } from "./listDefs"
import { MATRIX_LAYOUT_DEFS } from "./matrixDefs"
import { PICTURE_LAYOUT_DEFS } from "./pictureDefs"
import { PROCESS_LAYOUT_DEFS } from "./processDefs"
import { PYRAMID_LAYOUT_DEFS } from "./pyramidDefs"
import { RELATIONSHIP_LAYOUT_DEFS } from "./relationshipDefs"
import { STYLES_STYLE_DEFS } from "./stylesDefs"

// uniqueId → the dgm:layoutDef, dgm:styleDef and dgm:colorsDef part.
const LAYOUT_DEFS: ReadonlyMap<string, string> = new Map([
	...LIST_LAYOUT_DEFS,
	...PROCESS_LAYOUT_DEFS,
	...CYCLE_LAYOUT_DEFS,
	...HIERARCHY_LAYOUT_DEFS,
	...RELATIONSHIP_LAYOUT_DEFS,
	...MATRIX_LAYOUT_DEFS,
	...PYRAMID_LAYOUT_DEFS,
	...PICTURE_LAYOUT_DEFS
])
const STYLE_DEFS: ReadonlyMap<string, string> = new Map([...STYLES_STYLE_DEFS])
const COLORS_DEFS: ReadonlyMap<string, string> = new Map([...COLORS_COLORS_DEFS])

export function smartArtLayoutDef(uniqueId: string): string | undefined {
	return LAYOUT_DEFS.get(uniqueId)
}

export function smartArtStyleDef(uniqueId: string): string | undefined {
	return STYLE_DEFS.get(uniqueId)
}

export function smartArtColorsDef(uniqueId: string): string | undefined {
	return COLORS_DEFS.get(uniqueId)
}

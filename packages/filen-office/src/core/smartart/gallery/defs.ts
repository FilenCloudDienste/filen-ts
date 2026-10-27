// The gallery's definitions by uniqueId (worker-only: the presentation worker lays them out; the page never imports
// this module, so no definition reaches the main bundle). Names and samples are in index.ts.

import { TEST_COLORS_DEFS, TEST_LAYOUT_DEFS, TEST_STYLE_DEFS } from "./testDefs"

// uniqueId → the dgm:layoutDef, dgm:styleDef and dgm:colorsDef part.
const LAYOUT_DEFS: ReadonlyMap<string, string> = new Map([...TEST_LAYOUT_DEFS])
const STYLE_DEFS: ReadonlyMap<string, string> = new Map([...TEST_STYLE_DEFS])
const COLORS_DEFS: ReadonlyMap<string, string> = new Map([...TEST_COLORS_DEFS])

export function smartArtLayoutDef(uniqueId: string): string | undefined {
	return LAYOUT_DEFS.get(uniqueId)
}

export function smartArtStyleDef(uniqueId: string): string | undefined {
	return STYLE_DEFS.get(uniqueId)
}

export function smartArtColorsDef(uniqueId: string): string | undefined {
	return COLORS_DEFS.get(uniqueId)
}

/// <reference lib="webworker" />
import * as Comlink from "comlink"
import { fontInfoTables, readFontInfo, type FontInfo, type FontTableSet } from "@filen/office/core/fonts"

// Reads a previewed font's info off the page: from the few table slices of a TrueType/OpenType file the page cut
// out, or from a whole WOFF/WOFF2 file, whose tables must be inflated first. The code point runs go back
// transferred.
function answer(info: FontInfo): FontInfo {
	return Comlink.transfer(info, [info.codePoints.buffer])
}

const api = {
	inspectTables: (set: FontTableSet): FontInfo => answer(readFontInfo(set)),
	inspectFile: async (bytes: Uint8Array): Promise<FontInfo> => answer(readFontInfo(await fontInfoTables(bytes)))
}

export type FontInspectWorkerApi = typeof api

Comlink.expose(api)

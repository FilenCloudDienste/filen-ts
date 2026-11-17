import * as Comlink from "comlink"
import { fontContainer, sfntInfoTables, type FontInfo } from "@filen/office/core/fonts"
import FontInspectWorker from "@/features/preview/workers/fontInspect.worker.ts?worker"
import type { FontInspectWorkerApi } from "@/features/preview/workers/fontInspect.worker"
import { statelessWorker } from "@/lib/workers/ownedWorker"

// Idles out with nothing to read: most sessions never open a font.
const FONT_INSPECT_IDLE_MS = 30_000

const fontInspectWorker = statelessWorker<FontInspectWorkerApi>(() => new FontInspectWorker(), FONT_INSPECT_IDLE_MS, "font-inspect")

// A font's info, read in the worker. The page keeps `bytes` (the preview cache's, which the FontFace reads too) and
// posts copies: for a TrueType/OpenType file only its info tables, cut out after a bounded read of its table
// directory; a WOFF/WOFF2 file whole, since its tables are compressed.
export async function inspectFont(bytes: Uint8Array): Promise<FontInfo> {
	if (fontContainer(bytes) === "sfnt") {
		const set = sfntInfoTables(bytes)
		const buffers = [...set.tables.values()].map(table => table.buffer)

		return await fontInspectWorker.use(({ remote }) => remote.inspectTables(Comlink.transfer(set, buffers)))
	}

	const copy = bytes.slice()

	return await fontInspectWorker.use(({ remote }) => remote.inspectFile(Comlink.transfer(copy, [copy.buffer])))
}

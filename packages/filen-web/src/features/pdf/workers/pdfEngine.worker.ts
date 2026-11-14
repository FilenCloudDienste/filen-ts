// First: installs MuPDF's wasm hook before MuPDF's module evaluates.
import { engineScope } from "@/features/pdf/workers/mupdfBoot"
import * as mupdf from "mupdf"
import { macrotaskYield } from "@filen/office/dom/docx"
import { servePdfEngine } from "@filen/office/dom/pdfedit"
import { RANGE_READ_TIMEOUT_MS } from "@/lib/media/rangePort"

// The PDF engine worker (one per open document): MuPDF with the document, reading the file synchronously from the
// sync range bridge the SDK worker fills (lib/media/syncRange.ts), served over @filen/office's PDF engine protocol.
// Terminated with its document; a poisoned engine (a wasm trap, out of memory) is terminated at once.
servePdfEngine(mupdf, engineScope, {
	toBitmap: (rgba, width, height) => createImageBitmap(new ImageData(rgba, width, height)),
	readDeadlineMs: RANGE_READ_TIMEOUT_MS,
	now: () => performance.now(),
	yieldTask: macrotaskYield()
})

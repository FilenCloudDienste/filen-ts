// First: installs MuPDF's wasm hook before MuPDF's module evaluates.
import { engineScope } from "@/features/pdf/workers/mupdfBoot"
import * as mupdf from "mupdf"
import { macrotaskYield } from "@filen/office/dom/docx"
import { servePdfEngine } from "@filen/office/dom/pdfedit"
import { textPrepareRequest } from "@filen/office/dom/pdfedit/toolRequests"
import { signatureHintsRequest, verifySignaturesRequest } from "@filen/office/dom/pdfedit/verifyRequest"
import { fetchOfficePdfFontSync, officePdfFontAssets } from "@/features/office/lib/pdfFontAssets"
import { log } from "@/lib/log"
import { verifyRedactionRequest } from "@filen/office/dom/pdfedit/protectRequests"
import { RANGE_READ_TIMEOUT_MS } from "@/lib/media/rangePort"
import { E2E_TRACE } from "@/e2e-hooks/trace"

// The PDF engine worker (one per open document): MuPDF with the document, reading the file synchronously from the
// sync range bridge the SDK worker fills (lib/media/syncRange.ts), served over @filen/office's PDF engine protocol.
// Terminated with its document; a poisoned engine (a wasm trap, out of memory) is terminated at once. Edited and added
// text is laid out here in the office PDF writer's faces, fetched from the app's origin on first use; a book read in the
// read role takes its fallback faces (scripts no embedded face covers) from the same files, fetched synchronously.
servePdfEngine(mupdf, engineScope, {
	toBitmap: (rgba, width, height) => createImageBitmap(new ImageData(rgba, width, height)),
	readDeadlineMs: RANGE_READ_TIMEOUT_MS,
	now: () => performance.now(),
	yieldTask: macrotaskYield(),
	readFonts: {
		fetchSync: fetchOfficePdfFontSync,
		onError: (file, error) => {
			log.warn("pdf", "fallback face unavailable", { file, error: error instanceof Error ? error.message : String(error) })
		}
	},
	requests: {
		// E2E builds report each step of a check to the page's console, for a failed test's diagnostics (e2e/fixtures.ts).
		verifySignatures: verifySignaturesRequest(
			crypto.subtle,
			import.meta.env.VITE_E2E === "1"
				? step => {
						console.debug(`${E2E_TRACE} pdf-engine verify: ${step}`)
					}
				: undefined
		),
		signatureHints: signatureHintsRequest,
		verifyRedaction: verifyRedactionRequest,
		textPrepare: textPrepareRequest(officePdfFontAssets)
	}
})

// A PDF engine worker for the tests: servePdfEngine on a worker thread with the real MuPDF, reading its file
// through the sync range bridge from the test's thread. Started with tsx (`--import tsx`), like the web's worker
// entry but with Node's port and a plain-object "bitmap" (ImageBitmap does not exist here).
import { parentPort, workerData } from "node:worker_threads"
import * as mupdf from "mupdf"
import { servePdfEngine, type PdfEngineScope } from "../../dom/pdfedit/server"
import type { PdfBitmapLike } from "../../dom/pdfedit/protocol"
import type { PdfRequestTable } from "../../dom/pdfedit/requests"
import { textPrepareRequest } from "../../dom/pdfedit/toolRequests"
import { signatureHintsRequest, verifySignaturesRequest } from "../../dom/pdfedit/verifyRequest"
import { verifyRedactionRequest } from "../../dom/pdfedit/protectRequests"
import { nodeFontAssets } from "../sheetPdfFixtures"
import { nodeSubtle } from "../pdfSignFixtures"
import { wasmTrap } from "./fixtures"

const port = parentPort

if (port === null) throw new Error("not a worker")

const options = workerData as { readonly trapOnHeap?: boolean; readonly deadlineMs?: number }
const listeners = new Map<(event: { readonly data: unknown }) => void, (data: unknown) => void>()
const scope: PdfEngineScope = {
	postMessage: (message, transfer) => {
		port.postMessage(
			message,
			transfer.filter(item => item instanceof ArrayBuffer)
		)
	},
	addEventListener: (_type, listener) => {
		const wrapped = (data: unknown) => {
			listener({ data })
		}

		listeners.set(listener, wrapped)
		port.on("message", wrapped)
	},
	removeEventListener: (_type, listener) => {
		const wrapped = listeners.get(listener)

		if (wrapped !== undefined) port.off("message", wrapped)
	}
}
const requests: Partial<PdfRequestTable> = {
	verifySignatures: verifySignaturesRequest(nodeSubtle),
	signatureHints: signatureHintsRequest,
	verifyRedaction: verifyRedactionRequest,
	textPrepare: textPrepareRequest(nodeFontAssets),
	...(options.trapOnHeap === true
		? {
				heap: () => {
					throw wasmTrap()
				}
			}
		: {})
}

servePdfEngine(mupdf, scope, {
	readDeadlineMs: options.deadlineMs ?? 60_000,
	now: () => performance.now(),
	requests,
	toBitmap: (rgba, width, height) => Promise.resolve({ width, height, rgba, close: undefined } as unknown as PdfBitmapLike)
})

import { OCR_ASSETS } from "virtual:ocr-assets"
import { serveOcr, type OcrEngineVariant, type TesseractCore, type TesseractFactory } from "@filen/office/dom/pdfedit/ocr"
import { readOcrModel } from "@/features/pdf/ocr/ocrWorkerHost"
import { transferList } from "@/lib/transferList"

// The text recognition worker: one tesseract.js-core LSTM-only build served over @filen/office's OCR protocol. Each
// build has its worker entry (ocr<Build>.worker.ts) bundling only that build's glue; the page starts the one for the
// best build its browser validates (ocrSession.ts). The build's wasm is compiled from its same-origin, content-hashed
// URL (HTTP-cached). Language models are fetched only when a load names them, inflated straight into one buffer and
// verified against their pinned size and SHA-256 before Tesseract reads them. Terminated when recognition ends or is
// cancelled.

async function compile(url: string): Promise<WebAssembly.Module> {
	try {
		return await WebAssembly.compileStreaming(fetch(url, { credentials: "same-origin" }))
	} catch {
		// A server answering without application/wasm: compile from the bytes instead.
		const response = await fetch(url, { credentials: "same-origin" })

		if (!response.ok) throw new Error(`ocr wasm ${String(response.status)}`)

		return await WebAssembly.compile(await response.arrayBuffer())
	}
}

export function serveOcrWorker(variant: OcrEngineVariant, factory: TesseractFactory): void {
	const load = async (): Promise<TesseractCore> => {
		const wasm = await compile(OCR_ASSETS.engines[variant].wasm)

		return {
			factory,
			instantiate: async imports => ({ instance: await WebAssembly.instantiate(wasm, imports as WebAssembly.Imports), module: wasm })
		}
	}

	serveOcr(
		load,
		{
			postMessage: (message, transfer) => {
				self.postMessage(message, { transfer: transferList(transfer) })
			},
			addEventListener: (type, listener) => {
				self.addEventListener(type, listener)
			},
			removeEventListener: (type, listener) => {
				self.removeEventListener(type, listener)
			}
		},
		{
			fetchModel: readOcrModel,
			sha256: async bytes => {
				const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))

				return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")
			}
		}
	)
}

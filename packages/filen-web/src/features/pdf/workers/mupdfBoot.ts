import { PDF_ENGINE_WASM, type PdfEngineScope } from "@filen/office/dom/pdfedit"

// Runs before MuPDF's module evaluates (imported first by pdfEngine.worker.ts): MuPDF awaits its wasm at import, through
// the Emscripten hook installed here, which instantiates the module the page compiled and posted (no second fetch or
// compile). Messages arriving meanwhile (the open request) are held and handed to the engine's listener once it is
// added.

interface WasmMessage {
	readonly [PDF_ENGINE_WASM]: WebAssembly.Module
}

function isWasmMessage(data: unknown): data is WasmMessage {
	return typeof data === "object" && data !== null && Reflect.get(data, PDF_ENGINE_WASM) instanceof WebAssembly.Module
}

const compiled = Promise.withResolvers<WebAssembly.Module>()
const held: MessageEvent[] = []
const hold = (event: MessageEvent): void => {
	if (isWasmMessage(event.data)) compiled.resolve(event.data[PDF_ENGINE_WASM])
	else held.push(event)
}

self.addEventListener("message", hold)

globalThis.$libmupdf_wasm_Module = {
	instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void): object {
		void compiled.promise
			.then(async module => {
				done(await WebAssembly.instantiate(module, imports), module)
			})
			.catch((error: unknown) => {
				// MuPDF waits forever on a failed instantiation: the page hears it as a poisoned engine.
				self.postMessage({ t: "poisoned", message: error instanceof Error ? error.message : String(error) })
			})

		return {}
	}
}

// The worker's scope for servePdfEngine; its first listener also gets the messages held so far.
export const engineScope: PdfEngineScope = {
	postMessage: (message, transfer) => {
		self.postMessage(message, { transfer: transfer as Transferable[] })
	},
	addEventListener: (type, listener) => {
		self.removeEventListener("message", hold)
		self.addEventListener(type, listener)

		for (const event of held.splice(0)) listener(event)
	},
	removeEventListener: (type, listener) => {
		self.removeEventListener(type, listener)
	}
}

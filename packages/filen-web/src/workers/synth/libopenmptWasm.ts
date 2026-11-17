import wasmUrl from "@/vendor/libopenmpt/libopenmpt.wasm?url"
import { SourceReadError } from "@/lib/media/remuxTypes"

// libopenmpt's wasm, fetched same-origin and compiled once per remux worker: every module worker instance it starts
// (one after each idle) is handed the compiled module rather than compiling it again.
let compiled: Promise<WebAssembly.Module> | null = null

export function compileLibopenmpt(): Promise<WebAssembly.Module> {
	compiled ??= fetch(new URL(wasmUrl, self.location.href))
		.then(async response => {
			if (!response.ok) {
				throw new Error(`libopenmpt answered ${String(response.status)}`)
			}

			return WebAssembly.compile(await response.arrayBuffer())
		})
		.catch((error: unknown) => {
			// A failed fetch is tried again by the next module.
			compiled = null

			throw new SourceReadError(error)
		})

	return compiled
}

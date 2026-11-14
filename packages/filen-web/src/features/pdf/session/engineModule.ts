import mupdfWasmUrl from "mupdf-wasm?url"
import { idleResource } from "@/lib/idleResource"
import { pdfMemoryConstrained } from "@/features/preview/lib/pdfLimits"

// MuPDF's wasm (10 MB, a hashed same-origin asset) compiled once on the page and posted to each engine worker, which
// instantiates it without fetching or compiling again. Fetched only when the editor is about to be needed
// (prefetchPdfEngine on hover or focus of an editing tool and on print; prefetchPdfEngineIdle on idle with forms
// present) and HTTP-cached afterwards; the compiled module is dropped a while after the last engine closed.

const MODULE_IDLE_MS = 5 * 60_000

async function compile(): Promise<WebAssembly.Module> {
	const response = fetch(mupdfWasmUrl, { credentials: "same-origin" })

	try {
		return await WebAssembly.compileStreaming(response)
	} catch {
		// A server answering without application/wasm: compile from the bytes instead.
		const fallback = await fetch(mupdfWasmUrl, { credentials: "same-origin" })

		if (!fallback.ok) throw new Error(`mupdf wasm ${String(fallback.status)}`)

		return await WebAssembly.compile(await fallback.arrayBuffer())
	}
}

const compiled = idleResource<{ readonly module: Promise<WebAssembly.Module> }>(
	() => {
		const module = compile()

		// A failed compile is not kept: the next use tries again.
		module.catch(() => {
			compiled.invalidate(entry)
		})

		const entry = { module }

		return entry
	},
	() => undefined,
	MODULE_IDLE_MS
)

// Holds the compiled module for as long as `run` runs (an engine's life).
export function withPdfEngineModule<R>(run: (module: WebAssembly.Module) => Promise<R>): Promise<R> {
	return compiled.use(async entry => run(await entry.module))
}

// Starts the download and compile ahead of the first engine; a no-op once under way.
export function prefetchPdfEngine(): void {
	void compiled.use(entry => entry.module).catch(() => undefined)
}

type PdfEngineIdlePrefetch = "compile" | "cache" | "none"

// What a view that may be edited prefetches while idle: nothing when the user asked to save data; on a phone or tablet
// only the HTTP cache is filled (a compiled module holds its machine code in the tab's memory for minutes, for an
// editor that may never start); elsewhere the module is compiled, so the first change starts at once.
function pdfEngineIdlePrefetch(): PdfEngineIdlePrefetch {
	const connection: unknown = Reflect.get(navigator, "connection")

	if (typeof connection === "object" && connection !== null && Reflect.get(connection, "saveData") === true) return "none"

	return pdfMemoryConstrained() ? "cache" : "compile"
}

let cached: Promise<void> | null = null

// Fills the HTTP cache at low priority, the body streamed away (never held or compiled).
function warmCache(): Promise<void> {
	cached ??= fetch(mupdfWasmUrl, { credentials: "same-origin", priority: "low" })
		.then(async response => {
			await response.body?.pipeTo(new WritableStream())
		})
		.catch(() => {
			// A failed warm-up is tried again by the next one; the engine fetches for itself when it starts.
			cached = null
		})

	return cached
}

// The idle prefetch of a view with forms or signatures (pdfEngineIdlePrefetch).
export function prefetchPdfEngineIdle(): void {
	const kind = pdfEngineIdlePrefetch()

	if (kind === "compile") prefetchPdfEngine()
	else if (kind === "cache") void warmCache()
}

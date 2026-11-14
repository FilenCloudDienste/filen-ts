// The PDF engine's memory budget. MuPDF's wasm memory can grow to 2 GiB but never shrinks, and devices kill a tab far
// earlier, so limits apply per operation: an operation whose estimated peak exceeds the budget is refused before it
// runs.
//
// Measured with mupdf 1.28.6 under Node (wasm memory size after each step, a fresh instance per run; files of
// incompressible image pages):
// - an instance starts at 22 MiB;
// - opening through a stream reads lazily: the heap stays at 22 MiB for a 117 MiB file, and rendering a page adds
//   only what that page decodes;
// - rendering every page levels off at ~92 MiB above the start (the resource store's limit; it is not settable from
//   JavaScript), the same for a 39 MiB and a 117 MiB file;
// - saveToBuffer peaks at 1.85x (39 MiB), 2.12x (78 MiB) and 2.74x (117 MiB) the input above the start, incremental
//   and full rewrite alike: the output buffer doubles as it grows (old and new copies at once), and the memory grows
//   in steps of up to 96 MiB beyond what is asked.

const MIB = 1024 * 1024

export interface PdfMemoryProfile {
	// The most the engine's heap may reach for one operation.
	readonly heapBudget: number
	// Largest file the tools edit (a full rewrite of it fits the budget).
	readonly editMaxBytes: number
	// After a save whose heap reached this, the engine is restarted on the saved file to give the memory back.
	readonly respawnHeapBytes: number
}

// The heap of an instance before any document.
export const PDF_HEAP_BASELINE = 22 * MIB

// A save's peak above the baseline, per input byte: the largest measured factor, rounded up.
export const PDF_SAVE_PEAK_FACTOR = 2.8

function profile(heapBudget: number, respawnHeapBytes: number): PdfMemoryProfile {
	return { heapBudget, editMaxBytes: Math.floor((heapBudget - PDF_HEAP_BASELINE) / PDF_SAVE_PEAK_FACTOR), respawnHeapBytes }
}

export const PDF_DESKTOP_MEMORY: PdfMemoryProfile = profile(512 * MIB, 256 * MIB)
// Phones and tablets (WebKit on iOS is killed first); provisional until measured on devices.
export const PDF_MOBILE_MEMORY: PdfMemoryProfile = profile(256 * MIB, 128 * MIB)

// The heap a save of `inputBytes` is expected to reach; `thenSign` adds an incremental signing save of the output in
// the same heap (the output, about the input's size, is saved again while the first save's memory is still held).
export function estimateSavePeak(inputBytes: number, thenSign: boolean): number {
	const save = inputBytes * PDF_SAVE_PEAK_FACTOR

	return PDF_HEAP_BASELINE + (thenSign ? 2 * save : save)
}

export function fitsBudget(estimate: number, memory: PdfMemoryProfile): boolean {
	return estimate <= memory.heapBudget
}

export function shouldRespawn(heapBytes: number, memory: PdfMemoryProfile): boolean {
	return heapBytes >= memory.respawnHeapBytes
}

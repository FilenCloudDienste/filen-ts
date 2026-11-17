// The parts of the libopenmpt module (built by scripts/codecs/build-libopenmpt.sh with libopenmpt-bridge.c) the module
// worker calls; pointers are byte offsets into HEAPU8.
export interface LibopenmptModule {
	HEAPU8: Uint8Array
	HEAPF32: Float32Array
	UTF8ToString(pointer: number): string
	// 0 when the capped heap has no room.
	_malloc(size: number): number
	_free(pointer: number): void
	_filen_probe_size(): number
	// 1 a format libopenmpt reads, 0 not, -1 more bytes needed to tell.
	_filen_probe(head: number, size: number, fileSize: number): number
	// An openmpt_module, or 0 with libopenmpt's error code at `error`.
	_filen_open(data: number, size: number, skipSamples: number, error: number): number
	_filen_duration(module: number): number
	_filen_seek(module: number, seconds: number): number
	_filen_render(module: number, sampleRate: number, frames: number, interleaved: number): number
	_filen_close(module: number): void
	_filen_heap_bytes(): number
	// A string to _free.
	_filen_extensions(): number
}

export interface LibopenmptOptions {
	// Emscripten's hook: instantiates the wasm with `imports` and hands the instance to `done`.
	instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void): object
}

export default function createLibopenmpt(options: LibopenmptOptions): Promise<LibopenmptModule>

// The part of tesseract.js-core's Emscripten module (WebIDL bindings over Tesseract's C++ API) text recognition
// uses, typed structurally: the host imports the glue and its wasm; this package never does.

export interface TesseractFs {
	mkdir(path: string): void
	writeFile(path: string, data: Uint8Array, options?: { readonly canOwn?: boolean }): void
	readFile(path: string): Uint8Array
	unlink(path: string): void
}

export interface TessBaseApi {
	// 0 on success.
	Init(dataPath: string, languages: string, engineMode: number): number
	// The 5-argument overload: a heap pointer to rows of `bytesPerLine` bytes, `bytesPerPixel` 1 for grey.
	SetImage(pointer: number, width: number, height: number, bytesPerPixel: number, bytesPerLine: number): void
	SetSourceResolution(ppi: number): void
	SetPageSegMode(mode: number): void
	SetVariable(name: string, value: string): boolean
	// 0 on success; the monitor is unused (null).
	Recognize(monitor: null): number
	MeanTextConf(): number
	GetTSVText(page: number): string
	Clear(): void
	End(): void
}

export interface TessPdfRenderer {
	BeginDocument(title: string): boolean
	AddImage(api: TessBaseApi): boolean
	EndDocument(): boolean
}

export interface TesseractModule {
	readonly FS: TesseractFs
	readonly TessBaseAPI: new () => TessBaseApi
	// textOnly: the page image is left out, only invisible text (GlyphLessFont with a ToUnicode map) is written.
	readonly TessPDFRenderer: new (outputBase: string, dataDir: string, textOnly: boolean) => TessPdfRenderer
	// The enums' values, read from the wasm (the glue's OEM_* and PSM_* properties are only set by a runtime hook that
	// a module created this way never runs).
	_emscripten_enum_OcrEngineMode_OEM_LSTM_ONLY(): number
	_emscripten_enum_PageSegMode_PSM_AUTO(): number
	_malloc(bytes: number): number
	_free(pointer: number): void
	destroy(object: object): void
}

// Emscripten's instantiateWasm hook, as the module calls it.
export type InstantiateWasm = (imports: object, done: (instance: object, module: object) => void) => object

// The glue's factory (`TesseractCore`).
export type TesseractFactory = (moduleArg: {
	readonly instantiateWasm: InstantiateWasm
	readonly print: (text: string) => void
	readonly printErr: (text: string) => void
}) => Promise<TesseractModule>

export interface TesseractInstance {
	readonly instance: { readonly exports: Readonly<Record<string, unknown>> }
	readonly module: object
}

// One build of the engine: its glue's factory, and how to instantiate its wasm (a module compiled once).
export interface TesseractCore {
	readonly factory: TesseractFactory
	instantiate(imports: object): Promise<TesseractInstance>
}

// The wasm memory, found among the instance's exports (the glue keeps its own views private).
export interface WasmMemoryLike {
	readonly buffer: ArrayBuffer
	grow(pages: number): number
}

function isWasmMemory(value: unknown): value is WasmMemoryLike {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "buffer") instanceof ArrayBuffer &&
		typeof Reflect.get(value, "grow") === "function"
	)
}

export function wasmMemoryOf(exports: Readonly<Record<string, unknown>>): WasmMemoryLike {
	const memory = Object.values(exports).find(isWasmMemory)

	if (memory === undefined) throw new Error("the recogniser's wasm exports no memory")

	return memory
}

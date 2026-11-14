import { OCR_ORIENTATION_CONFIDENCE, OCR_STRIP_DPI, type QuarterTurns } from "../../../core/pdfedit/ocrGeometry"
import { isFatalEngineError } from "../server"
import { textStrip, rotateGray, type GrayImage } from "./pixels"
import { isToOcr, type FromOcr, type OcrFailure, type OcrModel, type OcrOp, type OcrPageResult, type OcrRecogniseArgs } from "./protocol"
import { wasmMemoryOf, type TessBaseApi, type TesseractCore, type TesseractModule, type WasmMemoryLike } from "./tesseract"

// The text recognition worker's side: one Tesseract instance (LSTM only), its language models loaded on request
// and verified against their pinned size and SHA-256, and recognition of one rendered page at a time into a
// text-only PDF page (invisible GlyphLessFont text with a ToUnicode map). Tesseract's LSTM-only builds have no
// orientation detection: a page recognised poorly is tried again on a small strip turned by each quarter turn, and
// recognised turned when one reads clearly better. Requests run one at a time in arrival order. A wasm trap or out of
// memory poisons the worker: it refuses everything after, and the page terminates it.

export interface OcrScope {
	postMessage(message: FromOcr, transfer: unknown[]): void
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
	removeEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
}

export interface OcrHost {
	// The model's bytes, uncompressed, in one buffer; `onBytes` reports the uncompressed bytes received so far.
	fetchModel(model: OcrModel, onBytes: (bytes: number) => void): Promise<Uint8Array<ArrayBuffer>>
	// Hex SHA-256.
	sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string>
}

class OcrRefusal extends Error {
	override readonly name = "OcrRefusal"
	readonly failure: OcrFailure

	constructor(failure: OcrFailure, message: string = failure) {
		super(message)
		this.failure = failure
	}
}

interface Engine {
	readonly module: TesseractModule
	readonly memory: WasmMemoryLike
	readonly api: TessBaseApi
}

const DATA_DIR = "/tessdata"
const MODEL_CODE = /^[a-z][a-z_]{1,15}$/

async function startEngine(core: TesseractCore): Promise<Engine> {
	let memory: WasmMemoryLike | null = null
	const failed = Promise.withResolvers<never>()
	const module = await Promise.race([
		core.factory({
			instantiateWasm: (imports, done) => {
				core.instantiate(imports).then(
					instance => {
						memory = wasmMemoryOf(instance.instance.exports)
						done(instance.instance, instance.module)
					},
					(error: unknown) => {
						failed.reject(error)
					}
				)

				return {}
			},
			print: () => undefined,
			printErr: () => undefined
		}),
		failed.promise
	])

	if (memory === null) throw new Error("the recogniser started without its memory")

	module.FS.mkdir(DATA_DIR)

	return { module, memory, api: new module.TessBaseAPI() }
}

interface Recognised {
	readonly confidence: number
}

// Hands the image to Tesseract (which copies it) and recognises it.
function recognise(engine: Engine, image: GrayImage, dpi: number): Recognised {
	const { module, api } = engine
	const bytes = image.stride * image.height
	const pointer = module._malloc(bytes)

	if (pointer === 0) throw new RangeError("out of memory")

	try {
		new Uint8Array(engine.memory.buffer, pointer, bytes).set(image.pixels.subarray(0, bytes))
		api.SetImage(pointer, image.width, image.height, 1, image.stride)
	} finally {
		module._free(pointer)
	}

	api.SetSourceResolution(dpi)

	if (api.Recognize(null) !== 0) throw new OcrRefusal("failed", "recognition failed")

	return { confidence: api.MeanTextConf() }
}

// Word count and doubtful words from Tesseract's TSV (level 5 rows: conf in column 11, text in 12).
function wordStats(tsv: string): { readonly words: number; readonly doubtful: number } {
	let words = 0
	let doubtful = 0

	for (const line of tsv.split("\n")) {
		if (!line.startsWith("5\t")) continue

		const columns = line.split("\t")
		const confidence = Number(columns[10])

		if ((columns[11] ?? "").trim() === "" || !(confidence >= 0)) continue

		words++

		if (confidence < 50) doubtful++
	}

	return { words, doubtful }
}

let outputs = 0

function textOnlyPdf(engine: Engine): Uint8Array<ArrayBuffer> {
	const { module, api } = engine
	const base = `/ocr-${String(++outputs)}`
	const renderer = new module.TessPDFRenderer(base, DATA_DIR, true)

	try {
		if (!renderer.BeginDocument("") || !renderer.AddImage(api) || !renderer.EndDocument())
			throw new OcrRefusal("failed", "the text layer could not be written")

		const written = module.FS.readFile(`${base}.pdf`)

		module.FS.unlink(`${base}.pdf`)

		// Out of the module's file system into a buffer of its own (transferable).
		return new Uint8Array(written)
	} finally {
		module.destroy(renderer)
	}
}

function recognisePage(engine: Engine, args: OcrRecogniseArgs): OcrPageResult {
	const { api } = engine
	const page: GrayImage = { pixels: args.pixels, width: args.width, height: args.height, stride: args.stride }
	let turns: QuarterTurns = 0
	let passes = 0

	api.SetPageSegMode(engine.module._emscripten_enum_PageSegMode_PSM_AUTO())

	let result = recognise(engine, page, args.dpi)

	if (args.orient && result.confidence < OCR_ORIENTATION_CONFIDENCE) {
		const strip = textStrip(page, args.dpi / OCR_STRIP_DPI)
		const stripDpi = Math.round(args.dpi / Math.max(1, Math.floor(args.dpi / OCR_STRIP_DPI)))
		let best = result.confidence

		for (const candidate of [1, 2, 3] as const) {
			passes++

			const confidence = recognise(engine, rotateGray(strip, candidate), stripDpi).confidence

			if (confidence > best) {
				best = confidence
				turns = candidate
			}
		}

		if (turns !== 0) result = recognise(engine, rotateGray(page, turns), args.dpi)
	}

	const stats = wordStats(api.GetTSVText(0))
	const pdf = textOnlyPdf(engine)

	api.Clear()

	return { pdf, turns, confidence: result.confidence, words: stats.words, doubtfulWords: stats.doubtful, orientationPasses: passes }
}

// `core` is loaded on the first request (a function), or given.
export function serveOcr(core: TesseractCore | (() => Promise<TesseractCore>), scope: OcrScope, host: OcrHost): () => void {
	let engine: Promise<Engine> | null = null
	let loaded = ""
	let poisoned: string | null = null
	let stopped = false
	let chain: Promise<void> = Promise.resolve()

	const started = (): Promise<Engine> => (engine ??= (typeof core === "function" ? core() : Promise.resolve(core)).then(startEngine))

	const post = (message: FromOcr, transfer: unknown[] = []): void => {
		if (!stopped) scope.postMessage(message, transfer)
	}

	const load = async (id: number, models: readonly OcrModel[]): Promise<void> => {
		if (!Array.isArray(models) || models.length === 0 || models.some(model => !MODEL_CODE.test(model.code)))
			throw new OcrRefusal("badRequest", "no valid models named")

		const running = await started()
		const key = models.map(model => model.code).join("+")

		if (key === loaded) return

		const total = models.reduce((sum, model) => sum + model.bytes, 0)
		const received = new Map<string, number>()
		const report = (code: string, bytes: number): void => {
			received.set(code, bytes)
			post({ t: "progress", id, loaded: [...received.values()].reduce((sum, value) => sum + value, 0), total })
		}
		// Fetched together, verified each.
		const files = await Promise.all(
			models.map(async model => {
				const bytes = await host.fetchModel(model, count => {
					report(model.code, count)
				})

				if (bytes.byteLength !== model.bytes || (await host.sha256(bytes)) !== model.sha256)
					throw new OcrRefusal("modelFailed", `${model.code} does not match its pinned size and SHA-256`)

				return { model, bytes }
			})
		)
		const { module, api } = running

		loaded = ""

		for (const { model, bytes } of files) module.FS.writeFile(`${DATA_DIR}/${model.code}.traineddata`, bytes, { canOwn: true })

		try {
			if (api.Init(DATA_DIR, key, module._emscripten_enum_OcrEngineMode_OEM_LSTM_ONLY()) !== 0)
				throw new OcrRefusal("modelFailed", `the models ${key} could not be loaded`)

			// Without the page image in the PDF (the overlay draws only text).
			api.SetVariable("textonly_pdf", "1")
		} finally {
			// Tesseract holds what it read; the files would only double the memory.
			for (const { model } of files) module.FS.unlink(`${DATA_DIR}/${model.code}.traineddata`)
		}

		loaded = key
	}

	const heapBytes = async (): Promise<number> => (await started()).memory.buffer.byteLength

	const handle = async (id: number, op: OcrOp, args: unknown): Promise<{ value: unknown; transfer?: unknown[] }> => {
		switch (op) {
			case "load":
				await load(id, (args as { readonly models: readonly OcrModel[] }).models)

				return { value: { heapBytes: await heapBytes() } }
			case "recognise": {
				if (loaded === "") throw new OcrRefusal("notReady", "no language model is loaded")

				const page = args as OcrRecogniseArgs

				if (
					!(page.pixels instanceof Uint8Array) ||
					!(page.width > 0) ||
					!(page.height > 0) ||
					page.stride < page.width ||
					!(page.dpi > 0) ||
					page.pixels.byteLength < page.stride * page.height
				)
					throw new OcrRefusal("badRequest", "malformed page image")

				const result = recognisePage(await started(), page)

				return { value: result, transfer: [result.pdf.buffer] }
			}
			case "heap":
				return { value: { heapBytes: await heapBytes() } }
		}
	}

	const run = async (id: number, op: OcrOp, args: unknown): Promise<void> => {
		if (poisoned !== null) {
			post({ t: "error", id, failure: "poisoned", message: poisoned })

			return
		}

		try {
			const handled = await handle(id, op, args)

			post({ t: "ok", id, value: handled.value }, handled.transfer ?? [])
		} catch (error) {
			if (isFatalEngineError(error)) {
				poisoned = error instanceof Error ? error.message : String(error)
				post({ t: "error", id, failure: "poisoned", message: poisoned })
				post({ t: "poisoned", message: poisoned })
			} else if (error instanceof OcrRefusal) post({ t: "error", id, failure: error.failure, message: error.message })
			else
				post({
					t: "error",
					id,
					failure: op === "load" ? "modelFailed" : "failed",
					message: error instanceof Error ? error.message : String(error)
				})
		}
	}

	const onMessage = (event: { readonly data: unknown }): void => {
		const data = event.data

		if (!isToOcr(data)) return

		if (data.op !== "load" && data.op !== "recognise" && data.op !== "heap") {
			post({ t: "error", id: data.id, failure: "badRequest", message: `unknown request ${String(data.op)}` })

			return
		}

		chain = chain.then(() => run(data.id, data.op, data.args))
	}

	scope.addEventListener("message", onMessage)

	return () => {
		stopped = true
		scope.removeEventListener("message", onMessage)
	}
}

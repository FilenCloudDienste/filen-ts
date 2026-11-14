import { OCR_ASSETS } from "virtual:ocr-assets"
import {
	OcrClient,
	runOcrPages,
	type OcrEngineVariant,
	type OcrModel,
	type OcrPageEdit,
	type OcrPageOutcome,
	type OcrRecogniseArgs,
	type OcrRenderedPage,
	type OcrRunReport
} from "@filen/office/dom/pdfedit/ocr"
import OcrRelaxedSimdWorker from "@/features/pdf/workers/ocrRelaxedSimd.worker.ts?worker"
import OcrSimdWorker from "@/features/pdf/workers/ocrSimd.worker.ts?worker"
import OcrPlainWorker from "@/features/pdf/workers/ocrPlain.worker.ts?worker"
import type { OcrLanguage } from "@/features/pdf/ocr/languages"
import { ocrEngineVariant } from "@/features/pdf/ocr/ocrWorkerHost"
import { transferList } from "@/lib/transferList"

// Recognising text in a document: the OCR workers (one; two on a large Chromium machine), the picked languages'
// models loaded into each, then @filen/office's pipeline over the pages with the engine's render, store flush and
// graft (the editor session supplies them). Workers live for one run and are terminated after it, or at once on
// cancel (a recognition in progress takes no message).

export interface OcrMachine {
	// Chromium-based (navigator.userAgentData's brands); deviceMemory exists there only.
	readonly chromium: boolean
	readonly deviceMemory: number | undefined
	readonly hardwareConcurrency: number
}

// Two workers only where memory and cores are plenty and the browser reports them (Chromium); WebKit and Firefox one.
export function ocrWorkerCount(machine: OcrMachine): 1 | 2 {
	return machine.chromium && (machine.deviceMemory ?? 0) >= 8 && machine.hardwareConcurrency >= 8 ? 2 : 1
}

export function currentOcrMachine(): OcrMachine {
	const brands: unknown = Reflect.get(Reflect.get(navigator, "userAgentData") ?? {}, "brands")
	const memory: unknown = Reflect.get(navigator, "deviceMemory")

	return {
		chromium: Array.isArray(brands) && brands.some(brand => Reflect.get(brand ?? {}, "brand") === "Chromium"),
		deviceMemory: typeof memory === "number" ? memory : undefined,
		hardwareConcurrency: navigator.hardwareConcurrency
	}
}

export function ocrModels(languages: readonly OcrLanguage[]): OcrModel[] {
	return languages.map(code => {
		const asset = OCR_ASSETS.languages[code]

		if (asset === undefined) throw new Error(`no model for ${code}`)

		return { code, ...asset }
	})
}

// What downloading these languages' models costs (the browser caches them afterwards).
export function ocrDownloadBytes(languages: readonly OcrLanguage[]): number {
	return languages.reduce((sum, code) => sum + (OCR_ASSETS.languages[code]?.transferBytes ?? 0), 0)
}

// Each engine build's worker, which bundles only that build's glue.
const OCR_WORKERS: Readonly<Record<OcrEngineVariant, new (options?: WorkerOptions) => Worker>> = {
	"relaxedsimd-lstm": OcrRelaxedSimdWorker,
	"simd-lstm": OcrSimdWorker,
	lstm: OcrPlainWorker
}

function spawn(variant: OcrEngineVariant): OcrClient {
	const worker = new OCR_WORKERS[variant]({ name: "pdf-ocr" })

	return new OcrClient({
		postMessage: (message, transfer) => {
			worker.postMessage(message, { transfer: transferList(transfer) })
		},
		addEventListener: (type: "message" | "error", listener: (event: { readonly data: unknown }) => void) => {
			worker.addEventListener(type, event => {
				listener({ data: event instanceof MessageEvent ? event.data : event })
			})
		},
		terminate: () => {
			worker.terminate()
		}
	})
}

// The engine's side, as the editor session serves it.
export interface OcrEngineSteps {
	readonly render: (page: number) => Promise<OcrRenderedPage>
	readonly flush: () => Promise<void>
	readonly apply: (edit: OcrPageEdit) => Promise<void>
}

export interface RecogniseOptions {
	readonly engine: OcrEngineSteps
	readonly pages: readonly number[]
	readonly languages: readonly OcrLanguage[]
	readonly workers?: 1 | 2
	// Render a batch only while no recognition runs (mobile WebKit: one heavy worker at a time).
	readonly exclusive?: boolean
	readonly signal: AbortSignal
	// Model download: uncompressed bytes so far of all.
	readonly onModels?: (loaded: number, total: number) => void
	readonly onPage?: (page: number, outcome: OcrPageOutcome | null) => void
}

export class OcrModelsError extends Error {
	override readonly name = "OcrModelsError"
}

export async function recogniseDocument(options: RecogniseOptions): Promise<OcrRunReport> {
	const variant = ocrEngineVariant()
	const clients = Array.from({ length: options.workers ?? ocrWorkerCount(currentOcrMachine()) }, () => spawn(variant))
	const stop = (): void => {
		for (const client of clients) client.terminate()
	}

	options.signal.addEventListener("abort", stop, { once: true })

	try {
		const models = ocrModels(options.languages)
		// The first worker downloads (and reports it); a second reads the models from the HTTP cache.
		const [first, ...rest] = clients

		if (first === undefined) throw new Error("no OCR worker")

		await first.call("load", { models }, [], options.onModels).catch((error: unknown) => {
			throw new OcrModelsError(error instanceof Error ? error.message : String(error))
		})
		await Promise.all(rest.map(client => client.call("load", { models })))

		return await runOcrPages({
			pages: options.pages,
			render: options.engine.render,
			flush: options.engine.flush,
			apply: options.engine.apply,
			recognisers: clients.map(client => (args: OcrRecogniseArgs) => client.call("recognise", args, [args.pixels.buffer])),
			exclusive: options.exclusive ?? false,
			signal: options.signal,
			...(options.onPage === undefined ? {} : { onPage: options.onPage })
		})
	} finally {
		options.signal.removeEventListener("abort", stop)
		stop()
	}
}

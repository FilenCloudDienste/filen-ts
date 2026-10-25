import { afterEach, describe, expect, it, vi } from "vitest"
import {
	classifyPdfError,
	openPdf,
	pdfDocumentParams,
	PdfReadError,
	type PdfDocument,
	type PdfJs,
	type PdfRangeTransport
} from "../dom/pdf/index"

interface FakeTask {
	params: unknown
	onPassword: unknown
	resolve: (document: PdfDocument) => void
	reject: (error: unknown) => void
	destroy: ReturnType<typeof vi.fn>
}

const transports: FakeTransport[] = []

class FakeTransport implements PdfRangeTransport {
	readonly length: number
	readonly ranges: [number, Uint8Array | null][] = []

	constructor(length: number) {
		this.length = length
		transports.push(this)
	}

	requestDataRange(_begin: number, _end: number): void {
		throw new Error("not replaced")
	}

	onDataRange(begin: number, chunk: Uint8Array | null): void {
		this.ranges.push([begin, chunk])
	}

	abort(): void {
		// Nothing to abort.
	}
}

function fakePdfJs(): { pdfjs: PdfJs; tasks: FakeTask[]; transports: FakeTransport[] } {
	const tasks: FakeTask[] = []

	transports.length = 0

	const pdfjs: PdfJs = {
		GlobalWorkerOptions: { workerSrc: "" },
		PDFDataRangeTransport: FakeTransport,
		getDocument(params) {
			let resolve: (document: PdfDocument) => void = () => undefined
			let reject: (error: unknown) => void = () => undefined
			const promise = new Promise<PdfDocument>((yes, no) => {
				resolve = yes
				reject = no
			})
			const task = { params, onPassword: null as unknown, resolve, reject, destroy: vi.fn(() => Promise.resolve()), promise }

			tasks.push(task)

			return task
		}
	}

	return { pdfjs, tasks, transports }
}

const DOCUMENT: PdfDocument = {
	numPages: 1,
	getPage: () => Promise.reject(new Error("unused")),
	getDestination: () => Promise.resolve(null),
	getPageIndex: () => Promise.resolve(0),
	getOutline: () => Promise.resolve(null),
	getMetadata: () => Promise.resolve({ info: {} })
}

const SCRIPT = { kind: "script", src: "/pdf.worker.mjs" } as const

function only<T>(list: readonly T[]): T {
	expect(list).toHaveLength(1)

	return list[0] as T
}

afterEach(() => {
	Reflect.deleteProperty(globalThis, "pdfjsWorker")
})

describe("pdf document parameters", () => {
	it("pins XFA off and logs errors only, with no base URL or password", () => {
		const params = pdfDocumentParams({ kind: "bytes", bytes: new Uint8Array([1]) }, { kind: "none" }, {})

		expect(params.enableXfa).toBe(false)
		expect(params.verbosity).toBe(0)
		expect("docBaseUrl" in params).toBe(false)
		expect("password" in params).toBe(false)
	})

	it("hands pdf.js a copy of the bytes, as it transfers and detaches what it is given", () => {
		const bytes = new Uint8Array([1, 2, 3])
		const params = pdfDocumentParams({ kind: "bytes", bytes }, { kind: "none" }, {})

		expect(params.data).toEqual(bytes)
		expect(params.data?.buffer).not.toBe(bytes.buffer)
	})

	it("serves inline assets without fetching, with the bundled standard fonts", async () => {
		const read = vi.fn((kind: string, filename: string) => Promise.resolve(new TextEncoder().encode(`${kind}/${filename}`)))
		const params = pdfDocumentParams({ kind: "bytes", bytes: new Uint8Array(1) }, { kind: "inline", read }, {})
		const Factory = params.BinaryDataFactory as new (urls: object) => {
			fetch(request: { kind: string; filename: string }): Promise<Uint8Array>
		}
		const factory = new Factory({ cMapUrl: null })

		expect(new TextDecoder().decode(await factory.fetch({ kind: "wasmUrl", filename: "jbig2.wasm" }))).toBe("wasmUrl/jbig2.wasm")
		expect(params.useWorkerFetch).toBe(false)
		expect(params.useSystemFonts).toBe(false)
	})

	it("passes asset directories and limits through", () => {
		const params = pdfDocumentParams(
			{ kind: "bytes", bytes: new Uint8Array(1) },
			{ kind: "urls", cMapUrl: "/cmaps/", standardFontDataUrl: "/fonts/", wasmUrl: "/wasm/" },
			{ maxImageSize: 80_000_000, canvasMaxAreaInBytes: 1024 }
		)

		expect(params).toMatchObject({
			cMapUrl: "/cmaps/",
			cMapPacked: true,
			standardFontDataUrl: "/fonts/",
			wasmUrl: "/wasm/",
			maxImageSize: 80_000_000,
			canvasMaxAreaInBytes: 1024
		})
		expect(params.useWorkerFetch).toBeUndefined()
	})

	it("turns streaming and read-ahead off together for a ranged source", () => {
		const params = pdfDocumentParams(
			{ kind: "ranges", length: 10, read: () => Promise.resolve(new Uint8Array(1)) },
			{ kind: "none" },
			{}
		)

		expect(params).toMatchObject({ disableStream: true, disableAutoFetch: true, rangeChunkSize: 256 * 1024 })
		expect(params.data).toBeUndefined()
	})
})

describe("openPdf", () => {
	it("points pdf.js at the worker script", () => {
		const { pdfjs } = fakePdfJs()

		openPdf(pdfjs, { kind: "bytes", bytes: new Uint8Array(1) }, { worker: SCRIPT, onPassword: () => undefined })

		expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe("/pdf.worker.mjs")
	})

	it("refuses the in-thread worker when the host did not load pdf.js's worker module", async () => {
		const { pdfjs, tasks } = fakePdfJs()
		const opening = openPdf(
			pdfjs,
			{ kind: "bytes", bytes: new Uint8Array(1) },
			{ worker: { kind: "inThread" }, onPassword: () => undefined }
		)

		await expect(opening.promise.catch(classifyPdfError)).resolves.toEqual({ type: "error", kind: "workerUnavailable" })
		expect(tasks).toHaveLength(0)
	})

	it("opens with the in-thread worker once the worker module is loaded", () => {
		const { pdfjs, tasks } = fakePdfJs()

		Reflect.set(globalThis, "pdfjsWorker", { WorkerMessageHandler: () => undefined })
		openPdf(pdfjs, { kind: "bytes", bytes: new Uint8Array(1) }, { worker: { kind: "inThread" }, onPassword: () => undefined })

		expect(tasks).toHaveLength(1)
		expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe("")
	})

	it("asks for a password and answers it on the same task", async () => {
		const { pdfjs, tasks } = fakePdfJs()
		const reasons: string[] = []
		const opening = openPdf(
			pdfjs,
			{ kind: "bytes", bytes: new Uint8Array(1) },
			{ worker: SCRIPT, onPassword: reason => reasons.push(reason) }
		)
		const task = only(tasks)
		const update = vi.fn()

		expect(opening.password("early")).toBe(false)
		;(task.onPassword as (update: (password: string) => void, reason: number) => void)(update, 1)
		expect(opening.password("wrong")).toBe(true)
		expect(opening.password("again")).toBe(false)
		;(task.onPassword as (update: (password: string) => void, reason: number) => void)(update, 2)
		expect(opening.password("right")).toBe(true)
		expect(reasons).toEqual(["required", "incorrect"])
		expect(update.mock.calls).toEqual([["wrong"], ["right"]])

		task.resolve(DOCUMENT)
		await expect(opening.promise).resolves.toBe(DOCUMENT)
		expect(tasks).toHaveLength(1)
	})

	it("destroys the task and ignores a password after that", async () => {
		const { pdfjs, tasks } = fakePdfJs()
		const opening = openPdf(pdfjs, { kind: "bytes", bytes: new Uint8Array(1) }, { worker: SCRIPT, onPassword: () => undefined })
		const task = only(tasks)

		;(task.onPassword as (update: (password: string) => void, reason: number) => void)(() => undefined, 1)
		await opening.destroy()

		expect(task.destroy).toHaveBeenCalledTimes(1)
		expect(opening.password("late")).toBe(false)
	})

	it("serves ranged requests in reads of at most maxRead bytes, merged into one answer", async () => {
		const { pdfjs, transports } = fakePdfJs()
		const file = Uint8Array.from({ length: 100 }, (_, index) => index)
		const read = vi.fn((offset: number, length: number) => Promise.resolve(file.slice(offset, offset + length)))

		openPdf(pdfjs, { kind: "ranges", length: 100, read, maxRead: 16 }, { worker: SCRIPT, onPassword: () => undefined })

		const transport = only(transports)

		transport.requestDataRange(10, 50)
		await vi.waitFor(() => {
			expect(transport.ranges).toHaveLength(1)
		})

		expect(read.mock.calls).toEqual([
			[10, 16],
			[26, 16],
			[42, 8]
		])
		expect(transport.ranges[0]).toEqual([10, file.slice(10, 50)])
	})

	it("fails the open when a ranged read fails before the document opened", async () => {
		const { pdfjs, transports } = fakePdfJs()
		const opening = openPdf(
			pdfjs,
			{ kind: "ranges", length: 10, read: () => Promise.reject(new Error("bridge")) },
			{ worker: SCRIPT, onPassword: () => undefined }
		)

		only(transports).requestDataRange(0, 10)

		await expect(opening.promise).rejects.toBeInstanceOf(PdfReadError)
		await expect(opening.promise.catch(classifyPdfError)).resolves.toEqual({ type: "error", kind: "transportFailed" })
	})

	it("refuses a short or oversized read instead of handing pdf.js a gap", async () => {
		const { pdfjs, transports } = fakePdfJs()
		const opening = openPdf(
			pdfjs,
			{ kind: "ranges", length: 10, read: () => Promise.resolve(new Uint8Array(0)) },
			{ worker: SCRIPT, onPassword: () => undefined }
		)

		only(transports).requestDataRange(0, 10)

		await expect(opening.promise).rejects.toBeInstanceOf(PdfReadError)
		expect(only(transports).ranges).toEqual([])
	})

	it("reports a ranged read that fails after the document opened", async () => {
		const { pdfjs, tasks, transports } = fakePdfJs()
		const onReadError = vi.fn()
		const opening = openPdf(
			pdfjs,
			{ kind: "ranges", length: 10, read: () => Promise.reject(new Error("bridge")) },
			{ worker: SCRIPT, onPassword: () => undefined, onReadError }
		)

		only(tasks).resolve(DOCUMENT)
		await opening.promise
		only(transports).requestDataRange(0, 10)

		await vi.waitFor(() => {
			expect(onReadError).toHaveBeenCalledTimes(1)
		})
	})
})

describe("classifyPdfError", () => {
	it("maps pdf.js exceptions by name, never passing their messages on", () => {
		const named = (name: string, extra: object = {}): object => ({ name, message: "document-controlled text", ...extra })

		expect(classifyPdfError(named("PasswordException", { code: 2 }))).toEqual({ type: "password", reason: "incorrect" })
		expect(classifyPdfError(named("PasswordException", { code: 1 }))).toEqual({ type: "password", reason: "required" })
		expect(classifyPdfError(named("InvalidPDFException"))).toEqual({ type: "error", kind: "invalidDocument" })
		expect(classifyPdfError(named("ResponseException"))).toEqual({ type: "error", kind: "transportFailed" })
		expect(classifyPdfError(named("RenderingCancelledException"))).toEqual({ type: "aborted" })
		expect(classifyPdfError(named("AbortException"))).toEqual({ type: "aborted" })
		expect(classifyPdfError(named("UnknownErrorException"))).toEqual({ type: "error", kind: "unknown" })
		expect(classifyPdfError("text")).toEqual({ type: "error", kind: "unknown" })
		expect(classifyPdfError(null)).toEqual({ type: "error", kind: "unknown" })
	})
})

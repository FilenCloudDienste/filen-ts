import { afterEach, describe, expect, it, vi } from "vitest"
import { createSyncRangeBuffer, PDF_ENGINE_WASM, PdfEngineError, type ToPdfEngine } from "@filen/office/dom/pdfedit"
import type { AnyFile } from "@filen/sdk-rs"
import { bytesOrigin, type ByteOrigin } from "@/lib/sdk/byteOrigin"
import type { DeviceProfile } from "@/lib/deviceProfile"

// The MuPDF read service over a stand-in engine worker: how it opens an origin (whole bytes transferred, or a sync
// range bridge), the pixel floor, and what its pages, relayouts and closes ask the engine.

type Call = Extract<ToPdfEngine, { t: "call" }>
type Answer = { readonly value: unknown } | { readonly failure: string } | "hang"

const { workers, respond, closeRange, openOriginSyncSource, loadOriginBytes, getPreviewBytes, takePreviewBytes, cancelPreviewDownload } =
	vi.hoisted(() => ({
		workers: [] as FakeEngineWorker[],
		respond: { current: (_call: Call): Answer => ({ value: null }) },
		closeRange: vi.fn(),
		openOriginSyncSource: vi.fn(),
		loadOriginBytes: vi.fn(),
		getPreviewBytes: vi.fn((): Uint8Array | undefined => undefined),
		takePreviewBytes: vi.fn((): Uint8Array | undefined => undefined),
		cancelPreviewDownload: vi.fn(() => Promise.resolve())
	}))

class FakeEngineWorker extends EventTarget {
	readonly terminate = vi.fn()
	readonly calls: Call[] = []
	readonly cancels: number[] = []

	constructor() {
		super()
		workers.push(this)
	}

	postMessage(message: unknown): void {
		if (typeof message !== "object" || message === null || PDF_ENGINE_WASM in message) return

		const sent = message as ToPdfEngine

		if (sent.t === "cancel") {
			this.cancels.push(...sent.ids)

			return
		}

		this.calls.push(sent)

		const answer = respond.current(sent)

		if (answer === "hang") return

		queueMicrotask(() => {
			const data =
				"value" in answer
					? { t: "ok", id: sent.id, value: answer.value }
					: { t: "error", id: sent.id, failure: answer.failure, message: answer.failure }

			this.dispatchEvent(new MessageEvent("message", { data }))
		})
	}

	ops(): string[] {
		return this.calls.map(call => call.op)
	}

	args(op: string): Record<string, unknown>[] {
		return this.calls.filter(call => call.op === op).map(call => call.args as Record<string, unknown>)
	}
}

vi.mock("@/features/pdf/workers/pdfEngine.worker.ts?worker", () => ({ default: FakeEngineWorker }))
vi.mock("@/features/pdf/session/engineModule", () => ({
	withPdfEngineModule: (run: (module: WebAssembly.Module) => Promise<unknown>) => run({})
}))
vi.mock("@/features/preview/lib/origin/syncSource", () => ({ openOriginSyncSource }))
vi.mock("@/features/preview/lib/origin/loadBytes", () => ({ loadOriginBytes }))
vi.mock("@/features/preview/lib/previewCache", () => ({ getPreviewBytes, takePreviewBytes }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { cancelPreviewDownload } }))
vi.mock("@/lib/appUpdate", () => ({ recoverIfNewerBuild: vi.fn() }))

const { MUPDF_MIN_IMAGE_PIXELS, mupdfImagePixels, openMupdfReader } = await import("@/lib/mupdf/reader")

openOriginSyncSource.mockImplementation(() =>
	Promise.resolve({
		channel: { buffer: createSyncRangeBuffer(4, 64 * 1024), port: new MessageChannel().port1, length: 100 },
		close: closeRange
	})
)
loadOriginBytes.mockImplementation(
	async (origin: Extract<ByteOrigin, { kind: "bytes" }>) => new Uint8Array(await origin.blob.arrayBuffer())
)

const METADATA = { format: "EPUB", title: "A Book", author: "An Author", subject: null }
const BUDGET = MUPDF_MIN_IMAGE_PIXELS * 4

// An engine that opens with `pageCount` pages and answers the read requests.
function engine(pageCount = 10, overrides: (call: Call) => Answer | undefined = () => undefined): void {
	respond.current = call =>
		overrides(call) ??
		(call.op === "open"
			? { value: { status: "open", document: { pageCount }, access: "none" } }
			: call.op === "metadata"
				? { value: METADATA }
				: call.op === "close"
					? { value: { heapBytes: 0 } }
					: { value: null })
}

function file(size: number): ByteOrigin {
	return { kind: "file", file: { uuid: "u", size: BigInt(size) } as unknown as AnyFile }
}

function wholeEntry(size: number): ByteOrigin {
	return { kind: "entry", reader: "r", entry: 0 as never, size, access: "whole", anon: false, cacheKey: "archive#0" }
}

function failure(error: unknown): string {
	return error instanceof PdfEngineError ? error.failure : String(error)
}

afterEach(() => {
	workers.length = 0
	vi.clearAllMocks()
})

describe("the MuPDF read service", () => {
	it("refuses a pixel budget below the floor without starting an engine", async () => {
		engine()

		const opening = openMupdfReader({
			origin: file(10),
			access: "authed",
			scope: null,
			format: "tiff",
			maxImagePixels: MUPDF_MIN_IMAGE_PIXELS - 1
		})

		await expect(opening).rejects.toSatisfy(error => failure(error) === "overBudget")
		expect(workers).toHaveLength(0)
	})

	it("transfers a whole origin's bytes, from the preview cache when it holds them", async () => {
		engine(1)

		const blob = new Blob([new Uint8Array([1, 2, 3])])
		const reader = await openMupdfReader({
			origin: bytesOrigin(blob, "mail#att0"),
			access: "anon",
			scope: "s",
			format: "tiff",
			maxImagePixels: BUDGET
		})
		const open = workers[0]?.args("open")[0]

		expect(loadOriginBytes).toHaveBeenCalledWith(expect.objectContaining({ kind: "bytes" }), expect.any(String), {
			access: "anon",
			cap: 3,
			store: false,
			scope: "s"
		})
		expect(open).toMatchObject({ role: "read", format: "tiff", maxImagePixels: BUDGET })
		expect(open).toHaveProperty("memory.heapBudget")
		expect(Reflect.get(open ?? {}, "bytes")).toBeInstanceOf(Uint8Array)
		expect(open).not.toHaveProperty("channel")
		expect(openOriginSyncSource).not.toHaveBeenCalled()
		expect(reader.reflowable).toBe(false)
		expect(reader.metadata).toEqual(METADATA)

		const cached = new Uint8Array([9, 9])

		getPreviewBytes.mockReturnValueOnce(cached)
		await openMupdfReader({ origin: wholeEntry(2), access: "authed", scope: "s", format: "psd", maxImagePixels: BUDGET })

		expect(getPreviewBytes).toHaveBeenLastCalledWith("s", "archive#0")
		expect(takePreviewBytes).toHaveBeenCalledExactlyOnceWith("s", "archive#0")
		expect(Reflect.get(workers[1]?.args("open")[0] ?? {}, "bytes")).toBe(cached)
		expect(loadOriginBytes).toHaveBeenCalledOnce()
	})

	it("reads a ranged origin through a sync range bridge, and closes it once", async () => {
		engine(3)

		const reader = await openMupdfReader({
			origin: file(100),
			access: "authed",
			scope: null,
			format: "epub",
			layout: { width: 400, height: 600, em: 11 },
			maxImagePixels: BUDGET
		})
		const worker = workers[0]

		expect(openOriginSyncSource).toHaveBeenCalledWith(expect.objectContaining({ kind: "file" }), expect.any(String), {
			access: "authed"
		})
		expect(worker?.args("open")[0]).toMatchObject({ format: "epub", layout: { width: 400, height: 600, em: 11 } })
		expect(worker?.args("open")[0]).toHaveProperty("channel")
		expect(reader.pageCount).toBe(3)
		expect(reader.reflowable).toBe(true)

		await Promise.all([reader.close(), reader.close()])

		expect(worker?.ops().filter(op => op === "close")).toHaveLength(1)
		expect(worker?.terminate).toHaveBeenCalledOnce()
		expect(closeRange).toHaveBeenCalledOnce()
		expect(cancelPreviewDownload).toHaveBeenCalledOnce()
	})

	it("draws a page whole as a bitmap or RGBA, and cancels a draw its signal aborts", async () => {
		const rgba = new Uint8ClampedArray(8)
		const bitmap = { width: 2, height: 1, close: vi.fn() }

		engine(2, call =>
			call.op === "renderPage"
				? Reflect.get(call.args as object, "page") === 1
					? "hang"
					: Reflect.get(call.args as object, "output") === "rgba"
						? { value: { output: "rgba", rgba, width: 2, height: 1 } }
						: { value: { output: "bitmap", bitmap } }
				: call.op === "imageExtent"
					? { value: { width: 300, height: 200 } }
					: undefined
		)

		const reader = await openMupdfReader({ origin: file(10), access: "authed", scope: null, format: "tiff", maxImagePixels: BUDGET })
		const worker = workers[0]

		expect(await reader.renderPage(0, { maxPixels: 2, output: "rgba" })).toEqual({ rgba, width: 2, height: 1 })
		expect(await reader.renderPage(0, { maxPixels: 2, output: "bitmap" })).toBe(bitmap)
		expect(await reader.imageExtent(0)).toEqual({ width: 300, height: 200 })
		expect(worker?.args("renderPage")).toEqual([
			{ page: 0, generation: 0, maxPixels: 2, output: "rgba" },
			{ page: 0, generation: 0, maxPixels: 2, output: "bitmap" }
		])
		expect(worker?.args("imageExtent")).toEqual([{ page: 0, generation: 0 }])

		const abort = new AbortController()
		const drawing = reader.renderPage(1, { maxPixels: 2, output: "bitmap", signal: abort.signal })

		abort.abort()

		expect(worker?.cancels).toEqual([worker?.calls.at(-1)?.id])
		await expect(reader.renderPage(0, { maxPixels: 2, output: "rgba", signal: abort.signal })).rejects.toBe(abort.signal.reason)

		await reader.close()
		await expect(drawing).rejects.toBe(abort.signal.reason)
	})

	it("lays a book out again: anchor text first, then the layout, then the outward search", async () => {
		engine(10, call => {
			switch (call.op) {
				case "text":
					return { value: { lines: [{ str: "  " }, { str: "It was a bright cold day in April, and the clocks" }], links: [] } }
				case "layout":
					return { value: { pageCount: 20, generation: Reflect.get(call.args as object, "generation") as number } }
				case "locate":
					return { value: 13 }
				case "pages":
					return { value: [{ width: 300, height: 400, label: "1" }] }
				default:
					return undefined
			}
		})

		const reader = await openMupdfReader({ origin: file(10), access: "authed", scope: null, format: "epub", maxImagePixels: BUDGET })
		const worker = workers[0]
		const before = reader.document
		const { document, page } = await reader.relayout({ width: 300, height: 500, em: 14 }, 6)

		expect(worker?.ops().slice(-3)).toEqual(["text", "layout", "locate"])
		expect(worker?.args("text")).toEqual([{ page: 6, generation: 0 }])
		expect(worker?.args("layout")).toEqual([{ width: 300, height: 500, em: 14, generation: 1 }])
		expect(worker?.args("locate")).toEqual([{ text: "It was a bright cold day", around: 12, radius: 12, generation: 1 }])
		expect(page).toBe(13)
		expect(document).not.toBe(before)
		expect(reader.document).toBe(document)
		expect(reader.pageCount).toBe(20)

		await document.getPage(1)

		expect(worker?.args("pages").at(-1)).toEqual({ from: 0, count: 1, generation: 1 })
	})

	it("lays nothing out again for the layout the book already has", async () => {
		engine(10, call => {
			if (call.op === "text") return { value: { lines: [{ str: "some words on the page here" }], links: [] } }
			if (call.op === "layout")
				return { value: { pageCount: 12, generation: Reflect.get(call.args as object, "generation") as number } }
			if (call.op === "locate") return { value: 3 }

			return undefined
		})

		const layout = { width: 400, height: 600, em: 11 }
		const reader = await openMupdfReader({
			origin: file(10),
			access: "authed",
			scope: null,
			format: "epub",
			layout,
			maxImagePixels: BUDGET
		})
		const same = await reader.relayout(layout, 4)

		expect(same).toEqual({ document: reader.document, page: 4 })
		expect(workers[0]?.ops()).not.toContain("layout")

		await reader.relayout({ ...layout, em: 14 }, 4)
		await reader.relayout({ ...layout, em: 14 }, 3)
		expect(workers[0]?.ops().filter(op => op === "layout")).toHaveLength(1)
	})

	it("keeps the anchor for a relayout asked while one runs, and the newest layout wins", async () => {
		let layouts = 0

		engine(10, call => {
			if (call.op === "text") return { value: { lines: [{ str: "the anchor words of this page" }], links: [] } }
			if (call.op === "layout") {
				layouts++

				return layouts === 1
					? { failure: "cancelled" }
					: { value: { pageCount: 5, generation: Reflect.get(call.args as object, "generation") as number } }
			}
			if (call.op === "locate") return { value: null }

			return undefined
		})

		const reader = await openMupdfReader({ origin: file(10), access: "authed", scope: null, format: "fb2", maxImagePixels: BUDGET })
		const first = reader.relayout({ width: 300, height: 500, em: 11 }, 4)
		const second = reader.relayout({ width: 300, height: 500, em: 16 }, 4)

		await expect(first).rejects.toSatisfy(error => failure(error) === "cancelled")
		expect((await second).page).toBe(2)
		expect(workers[0]?.args("text")).toHaveLength(1)
		expect(reader.pageCount).toBe(5)
	})

	it("refuses to relayout a fixed document, and closes an engine whose heap outgrew its budget", async () => {
		engine(1, call => (call.op === "layout" ? { failure: "overBudget" } : undefined))

		const image = await openMupdfReader({ origin: file(10), access: "authed", scope: null, format: "tiff", maxImagePixels: BUDGET })

		await expect(image.relayout({ width: 300, height: 500, em: 11 }, 0)).rejects.toSatisfy(error => failure(error) === "badRequest")

		const book = await openMupdfReader({ origin: file(10), access: "authed", scope: null, format: "epub", maxImagePixels: BUDGET })

		await expect(book.relayout({ width: 300, height: 500, em: 11 }, 0)).rejects.toSatisfy(error => failure(error) === "overBudget")
		expect(workers[1]?.terminate).toHaveBeenCalledOnce()
	})

	it("closes an engine whose open was aborted after it opened, and returns no reader", async () => {
		const abort = new AbortController()

		engine(1, call => {
			// Aborted while the metadata is read: the engine had opened.
			if (call.op === "metadata") abort.abort()

			return undefined
		})

		const opening = openMupdfReader({
			origin: file(10),
			access: "authed",
			scope: null,
			format: "tiff",
			maxImagePixels: BUDGET,
			signal: abort.signal
		})

		await expect(opening).rejects.toSatisfy(error => failure(error) === "closed")
		expect(workers[0]?.terminate).toHaveBeenCalledOnce()
		expect(closeRange).toHaveBeenCalledOnce()
	})

	it("rejects an open aborted before the transfer as closed, leaving the cached bytes in the cache", async () => {
		engine(1)

		const loading = new AbortController()

		loadOriginBytes.mockImplementationOnce((_origin: unknown, _token: string, options: { readonly signal?: AbortSignal }) => {
			loading.abort()
			options.signal?.throwIfAborted()

			return Promise.resolve(new Uint8Array(1))
		})
		await expect(
			openMupdfReader({
				origin: bytesOrigin(new Blob([new Uint8Array(1)]), "x#0"),
				access: "authed",
				scope: "s",
				format: "tiff",
				maxImagePixels: BUDGET,
				signal: loading.signal
			})
		).rejects.toSatisfy(error => failure(error) === "closed")

		const cachedAbort = new AbortController()

		getPreviewBytes.mockImplementationOnce(() => {
			cachedAbort.abort()

			return new Uint8Array([9, 9])
		})
		await expect(
			openMupdfReader({
				origin: wholeEntry(2),
				access: "authed",
				scope: "s",
				format: "psd",
				maxImagePixels: BUDGET,
				signal: cachedAbort.signal
			})
		).rejects.toSatisfy(error => failure(error) === "closed")
		expect(takePreviewBytes).not.toHaveBeenCalled()
		expect(workers.flatMap(worker => worker.ops())).not.toContain("open")

		const before = new AbortController()

		before.abort()
		await expect(
			openMupdfReader({
				origin: file(10),
				access: "authed",
				scope: null,
				format: "tiff",
				maxImagePixels: BUDGET,
				signal: before.signal
			})
		).rejects.toSatisfy(error => failure(error) === "closed")
	})

	it("budgets pixels with the file only for formats MuPDF reads whole", () => {
		const profile = { mobile: false } as DeviceProfile
		const origin = file(64 * 1024 * 1024)

		expect(mupdfImagePixels(profile, origin, "epub")).toBe(mupdfImagePixels(profile, file(0), "epub"))
		expect(mupdfImagePixels(profile, origin, "tiff")).toBeLessThan(mupdfImagePixels(profile, origin, "epub"))
		expect(mupdfImagePixels(profile, origin, "mobi")).toBe(mupdfImagePixels(profile, origin, "psd"))
	})
})

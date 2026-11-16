import { afterEach, describe, expect, it, vi } from "vitest"
import { createSyncRangeBuffer, PDF_ENGINE_WASM, PdfEngineError, type ToPdfEngine } from "@filen/office/dom/pdfedit"
import type { AnyFile } from "@filen/sdk-rs"

// Every MuPDF engine is a preview worker sign-out terminates: its pending calls reject "closed", its byte bridge and
// download stop. One the editor closes itself leaves the registry.

const { workers, closeRange, cancelPreviewDownload } = vi.hoisted(() => ({
	workers: [] as FakeEngineWorker[],
	closeRange: vi.fn(),
	cancelPreviewDownload: vi.fn(() => Promise.resolve())
}))

class FakeEngineWorker extends EventTarget {
	readonly terminate = vi.fn()
	readonly calls: ToPdfEngine[] = []

	constructor() {
		super()
		workers.push(this)
	}

	postMessage(message: unknown): void {
		if (typeof message !== "object" || message === null || PDF_ENGINE_WASM in message || Reflect.get(message, "t") !== "call") return

		const call = message as Extract<ToPdfEngine, { t: "call" }>

		this.calls.push(call)

		// Opens answer at once; every other call hangs, as a busy engine's does.
		if (call.op === "open" || call.op === "close")
			queueMicrotask(() => {
				const value = call.op === "open" ? { status: "open", document: { pageCount: 1 }, access: "none" } : { heapBytes: 0 }

				this.dispatchEvent(new MessageEvent("message", { data: { t: "ok", id: call.id, value } }))
			})
	}
}

vi.mock("@/features/pdf/workers/pdfEngine.worker.ts?worker", () => ({ default: FakeEngineWorker }))
vi.mock("@/features/pdf/session/engineModule", () => ({
	withPdfEngineModule: (run: (module: WebAssembly.Module) => Promise<unknown>) => run({})
}))
vi.mock("@/lib/media/syncRange", () => ({
	openSyncRange: () =>
		Promise.resolve({
			channel: { buffer: createSyncRangeBuffer(4, 64 * 1024), port: new MessageChannel().port1, length: 1024 },
			close: closeRange
		})
}))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { cancelPreviewDownload } }))
vi.mock("@/lib/appUpdate", () => ({ recoverIfNewerBuild: vi.fn() }))

const { openPdfEngine } = await import("@/features/pdf/session/engineWorker")
const { releaseAllPreviewWorkers } = await import("@/lib/workers/ownedWorker")

afterEach(() => {
	workers.length = 0
	closeRange.mockClear()
	cancelPreviewDownload.mockClear()
})

const FILE = { size: 1024n } as unknown as AnyFile

describe("PDF engines and sign-out", () => {
	it("terminates an open engine at sign-out, rejecting its calls and stopping its reads", async () => {
		const engine = await openPdfEngine({ file: FILE, access: "authed", role: "edit" })
		const worker = workers[0]
		const pending = engine.client.call("pages", { from: 0, count: 1 })

		expect(worker?.terminate).not.toHaveBeenCalled()

		releaseAllPreviewWorkers()

		await expect(pending).rejects.toSatisfy(error => error instanceof PdfEngineError && error.failure === "closed")
		expect(worker?.terminate).toHaveBeenCalledOnce()
		expect(closeRange).toHaveBeenCalledOnce()
		expect(cancelPreviewDownload).toHaveBeenCalledOnce()
	})

	it("leaves the registry when its owner closes it", async () => {
		const engine = await openPdfEngine({ file: FILE, access: "authed", role: "verify" })
		const worker = workers[0]

		await engine.close()

		expect(worker?.terminate).toHaveBeenCalledOnce()

		releaseAllPreviewWorkers()

		expect(worker?.terminate).toHaveBeenCalledOnce()
		expect(closeRange).toHaveBeenCalledOnce()
	})
})

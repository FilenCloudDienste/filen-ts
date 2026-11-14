import { MessageChannel, Worker, type MessagePort } from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import { PdfEngineClient, PdfEngineError, type PdfEngineWorkerLike } from "../../dom/pdfedit/client"
import { isFatalEngineError } from "../../dom/pdfedit/server"
import {
	abortSyncRange,
	createSyncRangeBuffer,
	serveSyncRange,
	type SyncRangePort,
	type SyncRangeServerStats
} from "../../dom/pdfedit/syncRange"
import type { PdfOpenResult } from "../../dom/pdfedit/protocol"
import { estimateSavePeak, fitsBudget, PDF_DESKTOP_MEMORY, PDF_MOBILE_MEMORY } from "../../core/pdfedit/budget"
import { makePdf, wasmTrap } from "./fixtures"
import { budget } from "../timing"

interface EngineSetup {
	readonly blockBytes?: number
	readonly slots?: number
	// Blocks whose first read rejects, or never settles; later reads of them succeed.
	readonly failBlocks?: Set<number>
	readonly hangBlocks?: Set<number>
	readonly readAhead?: number
	readonly trapOnHeap?: boolean
	readonly deadlineMs?: number
}

interface Engine {
	readonly client: PdfEngineClient
	readonly stats: SyncRangeServerStats
	readonly buffer: SharedArrayBuffer
	readonly reads: { start: number; end: number }[]
	open(password?: string): Promise<PdfOpenResult>
}

const running: PdfEngineClient[] = []

// Node's MessagePort as the bridge's port (its message events carry `data` like the DOM's).
function syncPort(port: MessagePort): SyncRangePort {
	return {
		postMessage: message => {
			port.postMessage(message)
		},
		addEventListener: (_type, listener) => {
			port.on("message", data => {
				listener({ data })
			})
		},
		close: () => {
			port.close()
		}
	}
}

afterEach(() => {
	for (const client of running.splice(0)) client.terminate()
})

function startEngine(bytes: Uint8Array, setup: EngineSetup = {}): Engine {
	const blockBytes = setup.blockBytes ?? 64 * 1024
	const buffer = createSyncRangeBuffer(setup.slots ?? 16, blockBytes)
	const channel = new MessageChannel()
	const lifetime = new AbortController()
	const reads: { start: number; end: number }[] = []
	const stats = serveSyncRange(
		buffer,
		syncPort(channel.port2),
		{
			length: bytes.length,
			read: (start, end) => {
				reads.push({ start, end })

				for (let block = Math.floor(start / blockBytes); block * blockBytes < end; block++) {
					if (setup.hangBlocks?.delete(block) === true) return new Promise<Uint8Array>(() => undefined)
					if (setup.failBlocks?.delete(block) === true) return Promise.reject(new Error("read failed"))
				}

				return Promise.resolve(bytes.slice(start, end))
			}
		},
		{ lifetime: lifetime.signal, readAhead: setup.readAhead ?? 3, onReaderClose: () => lifetime.abort() }
	)
	const worker = new Worker(new URL("./engineWorker.ts", import.meta.url), {
		execArgv: ["--import", "tsx"],
		workerData: { trapOnHeap: setup.trapOnHeap ?? false, deadlineMs: setup.deadlineMs ?? 60_000 }
	})
	const like: PdfEngineWorkerLike = {
		postMessage: (message, transfer) => {
			worker.postMessage(message, transfer as never[])
		},
		addEventListener: (type: "message" | "error", listener: (event: { readonly data: unknown }) => void) => {
			if (type === "message") worker.on("message", data => listener({ data }))
			else worker.on("error", error => listener({ data: error }))
		},
		terminate: () => {
			lifetime.abort()
			void worker.terminate()
		}
	}
	const client = new PdfEngineClient(like)

	running.push(client)

	return {
		client,
		stats,
		buffer,
		reads,
		open: password =>
			client.call(
				"open",
				{
					// Transferred to the engine thread, where it is Node's port again.
					channel: { buffer, port: channel.port1 as unknown as SyncRangePort, length: bytes.length },
					role: "edit",
					...(password === undefined ? {} : { password })
				},
				[channel.port1]
			)
	}
}

function rgbaOf(value: unknown): Uint8ClampedArray {
	const bitmap: unknown = Reflect.get(value as object, "bitmap")

	return Reflect.get(bitmap as object, "rgba") as Uint8ClampedArray
}

const TIMEOUT = budget(30_000)

describe("the PDF engine over the sync range bridge", () => {
	const imagePdf = makePdf({ pages: 60, imageBytes: 48 * 1024 })

	it(
		"opens a document and renders a tile reading only part of the file",
		async () => {
			const engine = startEngine(imagePdf)
			const opened = await engine.open()

			expect(opened.status).toBe("open")
			expect(opened.status === "open" ? opened.document.pageCount : 0).toBe(60)

			const pages = await engine.client.call("pages", { from: 0, count: 2 })

			expect(pages[0]).toMatchObject({ width: 595, height: 842 })

			const tile = await engine.client.call("render", {
				page: 0,
				scale: 0.5,
				rotation: 0,
				tile: [0, 0, 256, 256],
				priority: "visible"
			})

			expect(tile.tile).toEqual([0, 0, 256, 256])
			expect(engine.stats.bytesRead).toBeLessThan(imagePdf.length / 3)
		},
		TIMEOUT
	)

	it(
		"draws a tile exactly as MuPDF draws the whole page",
		async () => {
			const engine = startEngine(imagePdf)

			await engine.open()

			const scale = 0.75
			const tile = await engine.client.call("render", {
				page: 3,
				scale,
				rotation: 0,
				tile: [100, 200, 300, 380],
				priority: "visible"
			})
			const document = mupdf.Document.openDocument(imagePdf.slice(), "application/pdf")
			const page = document.loadPage(3)
			const whole = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false)
			const samples = whole.getPixels()
			const stride = whole.getStride()
			const rgba = rgbaOf(tile)
			let differing = 0

			for (let y = 0; y < 180; y++) {
				for (let x = 0; x < 200; x++) {
					const from = (y + 200) * stride + (x + 100) * 3
					const to = (y * 200 + x) * 4

					for (let channel = 0; channel < 3; channel++) {
						if (Math.abs((samples[from + channel] ?? 0) - (rgba[to + channel] ?? 0)) > 2) differing++
					}

					if (rgba[to + 3] !== 255) differing++
				}
			}

			whole.destroy()
			page.destroy()
			document.destroy()
			expect(differing).toBe(0)
		},
		TIMEOUT
	)

	it(
		"fails a read that fails or never comes back by its deadline, and reads it again on the next request",
		async () => {
			const blockBytes = 64 * 1024
			const lastBlock = Math.floor((imagePdf.length - 1) / blockBytes)
			const engine = startEngine(imagePdf, {
				blockBytes,
				failBlocks: new Set([lastBlock - 30]),
				hangBlocks: new Set([lastBlock - 20]),
				deadlineMs: 400,
				readAhead: 0
			})

			await engine.open()

			const failures: string[] = []
			let rendered = 0

			for (let page = 0; page < 60; page++) {
				const render = () =>
					engine.client.call("render", { page, scale: 0.1, rotation: 0, tile: [0, 0, 60, 84], priority: "visible" })

				await render().then(
					() => {
						rendered++
					},
					async (error: unknown) => {
						failures.push(error instanceof PdfEngineError ? `${error.failure}:${error.message}` : String(error))
						// The same page again: its bytes arrive this time.
						await render()
						rendered++
					}
				)
			}

			expect(failures).toEqual(["readFailed:failed", "readFailed:timeout"])
			expect(rendered).toBe(60)
		},
		TIMEOUT
	)

	it(
		"fails a waiting read at once when the reads are aborted",
		async () => {
			const blockBytes = 64 * 1024
			const lastBlock = Math.floor((imagePdf.length - 1) / blockBytes)
			const engine = startEngine(imagePdf, { blockBytes, hangBlocks: new Set([lastBlock - 30]) })

			await engine.open()

			const started = Date.now()
			const pending: Promise<unknown>[] = []

			for (let page = 0; page < 60; page++) {
				pending.push(
					engine.client
						.call("render", { page, scale: 0.1, rotation: 0, tile: [0, 0, 60, 84], priority: "visible" })
						.catch((error: unknown) => error)
				)
			}

			setTimeout(() => {
				abortSyncRange(engine.buffer)
			}, 300)

			const outcomes = await Promise.all(pending)

			expect(outcomes.some(outcome => outcome instanceof PdfEngineError && outcome.message === "aborted")).toBe(true)
			expect(Date.now() - started).toBeLessThan(budget(10_000))
		},
		TIMEOUT
	)

	it(
		"asks for a password and opens with the right one",
		async () => {
			const locked = makePdf({ pages: 2, userPassword: "user pass", ownerPassword: "owner pass" })
			const engine = startEngine(locked)

			expect((await engine.open()).status).toBe("password")
			expect((await engine.client.call("authenticate", { password: "wrong" })).status).toBe("password")

			const owner = await engine.client.call("authenticate", { password: "owner pass" })

			expect(owner).toMatchObject({ status: "open", access: "owner" })

			const user = startEngine(locked)
			const opened = await user.open("user pass")

			expect(opened).toMatchObject({ status: "open", access: "user" })
			expect(opened.status === "open" ? opened.document.encryption : "").toMatch(/AES/i)
		},
		TIMEOUT
	)

	it(
		"refuses a file that is not a PDF",
		async () => {
			const engine = startEngine(new TextEncoder().encode("not a pdf at all ".repeat(100)))

			await expect(engine.open()).rejects.toBeInstanceOf(PdfEngineError)
		},
		TIMEOUT
	)

	it(
		"poisons the engine on a wasm trap and refuses everything after it",
		async () => {
			const engine = startEngine(imagePdf, { trapOnHeap: true })
			let heard = ""

			engine.client.onPoisoned(message => {
				heard = message
			})
			await engine.open()
			await expect(engine.client.call("heap", {})).rejects.toMatchObject({ failure: "poisoned" })
			expect(heard).toBe("unreachable")
			expect(engine.client.poisoned).toBe("unreachable")
			await expect(engine.client.call("pages", { from: 0, count: 1 })).rejects.toMatchObject({ failure: "poisoned" })
		},
		TIMEOUT
	)

	it(
		"reports the heap and frees the document on close",
		async () => {
			const engine = startEngine(imagePdf)

			await engine.open()

			const { heapBytes } = await engine.client.call("close", {})

			expect(heapBytes).toBeGreaterThan(1024 * 1024)
			await expect(engine.client.call("pages", { from: 0, count: 1 })).rejects.toMatchObject({ failure: "closed" })
		},
		TIMEOUT
	)
})

describe("engine errors and budgets", () => {
	it("tells fatal engine errors from refusals", () => {
		expect(isFatalEngineError(wasmTrap())).toBe(true)
		expect(isFatalEngineError("ABORT")).toBe(true)
		expect(isFatalEngineError(new Error("malloc (1048576 bytes) failed"))).toBe(true)
		expect(isFatalEngineError(new RangeError("Maximum call stack size exceeded"))).toBe(true)
		expect(isFatalEngineError("TRYLATER")).toBe(false)
		expect(isFatalEngineError(new Error("cannot find object in xref"))).toBe(false)
	})

	it("sizes saves against the budget", () => {
		expect(fitsBudget(estimateSavePeak(PDF_DESKTOP_MEMORY.editMaxBytes, false), PDF_DESKTOP_MEMORY)).toBe(true)
		expect(fitsBudget(estimateSavePeak(PDF_DESKTOP_MEMORY.editMaxBytes + 1024 * 1024, false), PDF_DESKTOP_MEMORY)).toBe(false)
		expect(PDF_MOBILE_MEMORY.editMaxBytes).toBeLessThan(PDF_DESKTOP_MEMORY.editMaxBytes)
		expect(estimateSavePeak(10, true)).toBeGreaterThan(estimateSavePeak(10, false))
	})
})

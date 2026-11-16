import { setTimer } from "../presentation/svgPort"
import {
	isFatalEngineError,
	PdfEngineRefusal,
	type OpenDocument,
	type PdfEngineContext,
	type PdfEngineHost,
	type ReadDocument
} from "./context"
import {
	isToPdfEngine,
	type FromPdfEngine,
	type MupdfModule,
	type PdfEngineFailure,
	type PdfEngineOp,
	type PdfRenderArgs,
	type PdfRenderPriority
} from "./protocol"
import { PDF_ENGINE_REQUESTS, type PdfRequestTable } from "./requests"
import { READ_REQUESTS } from "./readRequests"
import { wasmHeapBytes } from "./render"

// The engine worker's side: requests are taken from the scope's messages and run one at a time. Renders wait in a
// queue ordered by priority (visible tiles before overlays, thumbnails and prefetch) and can be cancelled until they
// start; every other request runs in arrival order ahead of queued renders. Any wasm trap, out-of-memory or internal
// abort poisons the engine: it answers everything with "poisoned" from then on, and the page terminates it. While a
// read document (the read role) is open, only the read requests and heap are served; every other request is refused.

export interface PdfEngineScope {
	postMessage(message: FromPdfEngine, transfer: unknown[]): void
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
	removeEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
}

export interface PdfEngineServeOptions extends PdfEngineHost {
	// Replaces or adds request handlers (tests; roles' own requests).
	readonly requests?: Partial<PdfRequestTable>
}

const PRIORITY: Readonly<Record<PdfRenderPriority, number>> = { visible: 0, overlay: 1, thumbnail: 2, prefetch: 3 }

interface Queued {
	readonly id: number
	readonly op: PdfEngineOp
	readonly args: unknown
	readonly rank: number
}

export { isFatalEngineError } from "./context"

function rankOf(op: PdfEngineOp, args: unknown): number {
	if (op !== "render") return -1

	const priority: unknown = typeof args === "object" && args !== null ? Reflect.get(args, "priority") : undefined

	return typeof priority === "string" && priority in PRIORITY ? (PRIORITY[priority as PdfRenderArgs["priority"]] ?? 3) : 3
}

export function servePdfEngine(mupdf: MupdfModule, scope: PdfEngineScope, options: PdfEngineServeOptions): () => void {
	const table: PdfRequestTable = { ...PDF_ENGINE_REQUESTS, ...options.requests }
	const queue: Queued[] = []
	let current: OpenDocument | null = null
	let reading: ReadDocument | null = null
	let poisoned: string | null = null
	let running = false
	let stopped = false

	const context: PdfEngineContext = {
		mupdf,
		host: options,
		get current() {
			return current
		},
		setCurrent(open) {
			current = open
		},
		open() {
			if (reading !== null) throw new PdfEngineRefusal("badRequest", "the open document is not a PDF")
			if (current === null) throw new PdfEngineRefusal("closed", "no document is open")

			return current
		},
		get reading() {
			return reading
		},
		setReading(read) {
			reading = read
		},
		openRead() {
			if (current !== null) throw new PdfEngineRefusal("badRequest", "the open document is a PDF")
			if (reading === null) throw new PdfEngineRefusal("closed", "no document is open")

			return reading
		},
		readBytes(offset, length) {
			const { reader, heap } = context.open()

			if (heap !== null) {
				if (offset + length > heap.getLength()) throw new PdfEngineRefusal("readFailed", "end of file")

				return heap.asUint8Array().slice(offset, offset + length)
			}

			const bytes = new Uint8Array(length)
			let at = 0

			while (at < length) {
				const read = reader.read(bytes, at, length - at, offset + at)

				if (read <= 0) throw new PdfEngineRefusal("readFailed", reader.failure ?? "end of file")

				at += read
			}

			return bytes
		},
		heapBytes: () => wasmHeapBytes(mupdf)
	}

	const refuseRead = (): never => {
		throw new PdfEngineRefusal("badRequest", "not a request a read document serves")
	}

	const handlerOf = (op: PdfEngineOp): PdfRequestTable[PdfEngineOp] => {
		if (reading === null || op === "heap") return table[op]

		return Object.hasOwn(READ_REQUESTS, op) ? ((READ_REQUESTS as Partial<PdfRequestTable>)[op] ?? refuseRead) : refuseRead
	}

	const post = (message: FromPdfEngine, transfer: unknown[] = []): void => {
		if (!stopped) scope.postMessage(message, transfer)
	}

	const refuse = (id: number, failure: PdfEngineFailure, message: string): void => {
		post({ t: "error", id, failure, message })
	}

	const failureOf = (error: unknown): { readonly failure: PdfEngineFailure; readonly message: string } => {
		if (error instanceof PdfEngineRefusal) return { failure: error.failure, message: error.message }
		// MuPDF's "try later": a byte read failed under the operation (syncRangeStreamHandle).
		if (error === "TRYLATER") return { failure: "readFailed", message: current?.reader.failure ?? "read failed" }

		return { failure: "failed", message: error instanceof Error ? error.message : String(error) }
	}

	const run = async (item: Queued): Promise<void> => {
		if (poisoned !== null) {
			refuse(item.id, "poisoned", poisoned)

			return
		}

		const handler = handlerOf(item.op) as (context: PdfEngineContext, args: unknown) => ReturnType<PdfRequestTable[PdfEngineOp]>

		if (item.op === "render") post({ t: "started", id: item.id })

		try {
			const handled = await handler(context, item.args)

			post({ t: "ok", id: item.id, value: handled.value }, [...(handled.transfer ?? [])])
		} catch (error) {
			if (isFatalEngineError(error)) {
				poisoned = error instanceof Error ? error.message : String(error)
				refuse(item.id, "poisoned", poisoned)
				post({ t: "poisoned", message: poisoned })
			} else {
				const { failure, message } = failureOf(error)

				refuse(item.id, failure, message)
			}
		}
	}

	// The next request: non-render requests first in arrival order, then renders by priority, then arrival.
	const next = (): Queued | undefined => {
		let best = -1

		for (let index = 0; index < queue.length; index++) {
			const item = queue[index]
			const held = best === -1 ? undefined : queue[best]

			if (item !== undefined && (held === undefined || item.rank < held.rank)) best = index
		}

		return best === -1 ? undefined : queue.splice(best, 1)[0]
	}

	const drain = async (): Promise<void> => {
		if (running) return

		running = true

		for (let item = next(); item !== undefined && !stopped; item = next()) {
			await run(item)

			// Cancels and more urgent renders arrive between tiles.
			if (queue.length > 0) await (options.yieldTask?.() ?? new Promise<void>(resolve => setTimer(resolve, 0)))
		}

		running = false
	}

	const onMessage = (event: { readonly data: unknown }): void => {
		const data = event.data

		if (!isToPdfEngine(data)) return

		if (data.t === "cancel") {
			const ids = new Set(data.ids)

			for (let index = queue.length - 1; index >= 0; index--) {
				const item = queue[index]

				if (item !== undefined && ids.has(item.id)) {
					queue.splice(index, 1)
					refuse(item.id, "cancelled", "cancelled")
				}
			}

			return
		}

		if (!(data.op in table)) {
			refuse(data.id, "badRequest", `unknown request ${data.op}`)

			return
		}

		// A layout cannot be stopped once it runs, so only the newest of those waiting runs.
		if (data.op === "layout") {
			for (let index = queue.length - 1; index >= 0; index--) {
				const item = queue[index]

				if (item !== undefined && item.op === "layout") {
					queue.splice(index, 1)
					refuse(item.id, "cancelled", "a newer layout replaced it")
				}
			}
		}

		queue.push({ id: data.id, op: data.op, args: data.args, rank: rankOf(data.op, data.args) })
		void drain()
	}

	scope.addEventListener("message", onMessage)

	return () => {
		stopped = true
		scope.removeEventListener("message", onMessage)
		queue.length = 0
	}
}

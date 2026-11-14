import { setTimer } from "../presentation/svgPort"
import { PdfEngineRefusal, type OpenDocument, type PdfEngineContext, type PdfEngineHost } from "./context"
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

// The engine worker's side: requests are taken from the scope's messages and run one at a time. Renders wait in a
// queue ordered by priority (visible tiles before overlays, thumbnails and prefetch) and can be cancelled until they
// start; every other request runs in arrival order ahead of queued renders. Any wasm trap, out-of-memory or internal
// abort poisons the engine: it answers everything with "poisoned" from then on, and the page terminates it.

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

// Errors that leave MuPDF's heap untrustworthy: a wasm trap or abort, allocation failure, a stack overflow.
export function isFatalEngineError(error: unknown): boolean {
	if (error === "ABORT") return true
	if (!(error instanceof Error)) return false
	if (error.name === "RuntimeError" || error instanceof RangeError) return true

	return /out of memory|malloc|memory access out of bounds|cannot create mupdf context/i.test(error.message)
}

function rankOf(op: PdfEngineOp, args: unknown): number {
	if (op !== "render") return -1

	const priority: unknown = typeof args === "object" && args !== null ? Reflect.get(args, "priority") : undefined

	return typeof priority === "string" && priority in PRIORITY ? (PRIORITY[priority as PdfRenderArgs["priority"]] ?? 3) : 3
}

function wasmHeapBytes(mupdf: MupdfModule): number {
	const probe = new mupdf.Buffer()
	const bytes = probe.asUint8Array().buffer.byteLength

	probe.destroy()

	return bytes
}

export function servePdfEngine(mupdf: MupdfModule, scope: PdfEngineScope, options: PdfEngineServeOptions): () => void {
	const table: PdfRequestTable = { ...PDF_ENGINE_REQUESTS, ...options.requests }
	const queue: Queued[] = []
	let current: OpenDocument | null = null
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
			if (current === null) throw new PdfEngineRefusal("closed", "no document is open")

			return current
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

		const handler = table[item.op] as (context: PdfEngineContext, args: unknown) => ReturnType<PdfRequestTable[PdfEngineOp]>

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

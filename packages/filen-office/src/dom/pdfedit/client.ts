import {
	isFromPdfEngine,
	type FromPdfEngine,
	type PdfBitmapLike,
	type PdfEngineArgs,
	type PdfEngineFailure,
	type PdfEngineOp,
	type PdfEngineValue,
	type ToPdfEngine
} from "./protocol"
import { clearTimer, setTimer } from "../presentation/svgPort"
import { abortSyncRange, syncRangeWaiting } from "./syncRange"

// The page's side of one engine worker: a promise per request, the render watchdog and the poisoned state. A worker
// holds one document; terminate() stops its byte reads first (a reader blocked in Atomics.wait takes no message),
// then the worker.

export interface PdfEngineWorkerLike {
	postMessage(message: ToPdfEngine, transfer: unknown[]): void
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
	addEventListener(type: "error", listener: (event: unknown) => void): void
	terminate(): void
}

export class PdfEngineError extends Error {
	override readonly name = "PdfEngineError"
	readonly failure: PdfEngineFailure

	constructor(failure: PdfEngineFailure, message: string) {
		super(message === "" ? failure : message)
		this.failure = failure
	}
}

export interface PdfEngineClientOptions {
	// A render running longer than this (not counting time waiting for bytes) poisons the engine.
	readonly watchdogMs?: number
	readonly now?: () => number
}

export const PDF_RENDER_WATCHDOG_MS = 30_000

interface Pending {
	resolve(value: unknown): void
	reject(error: Error): void
	readonly op: PdfEngineOp
	// When a render started running (its "started" event), for the watchdog.
	started: number | null
}

function closeBitmap(value: unknown): void {
	const bitmap: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "bitmap") : undefined

	if (typeof bitmap === "object" && bitmap !== null && typeof Reflect.get(bitmap, "close") === "function")
		(bitmap as PdfBitmapLike).close()
}

export class PdfEngineClient {
	private readonly worker: PdfEngineWorkerLike
	private readonly pending = new Map<number, Pending>()
	private readonly poisonListeners = new Set<(message: string) => void>()
	private readonly now: () => number
	private readonly watchdogMs: number
	private timer: unknown
	private nextId = 1
	private channels: SharedArrayBuffer[] = []
	private poisonMessage: string | null = null
	private terminated = false

	constructor(worker: PdfEngineWorkerLike, options: PdfEngineClientOptions = {}) {
		this.worker = worker
		this.now = options.now ?? (() => Date.now())
		this.watchdogMs = options.watchdogMs ?? PDF_RENDER_WATCHDOG_MS

		this.timer = this.arm()
		worker.addEventListener("message", event => this.onMessage(event.data))
		worker.addEventListener("error", () => this.poison("the engine worker failed"))
	}

	private arm(): unknown {
		return setTimer(
			() => {
				this.checkWatchdog()

				if (!this.terminated) this.timer = this.arm()
			},
			Math.max(250, Math.floor(this.watchdogMs / 6))
		)
	}

	get poisoned(): string | null {
		return this.poisonMessage
	}

	onPoisoned(listener: (message: string) => void): () => void {
		this.poisonListeners.add(listener)

		return () => this.poisonListeners.delete(listener)
	}

	call<K extends PdfEngineOp>(op: K, args: PdfEngineArgs<K>, transfer: unknown[] = []): Promise<PdfEngineValue<K>> {
		if (this.poisonMessage !== null) return Promise.reject(new PdfEngineError("poisoned", this.poisonMessage))
		if (this.terminated) return Promise.reject(new PdfEngineError("closed", "the engine was terminated"))

		const id = this.nextId++

		if (op === "open") {
			const buffer: unknown = Reflect.get(Reflect.get(args, "channel") ?? {}, "buffer")

			if (buffer instanceof SharedArrayBuffer) this.channels.push(buffer)
		}

		return new Promise<PdfEngineValue<K>>((resolve, reject) => {
			this.pending.set(id, { resolve: value => resolve(value as PdfEngineValue<K>), reject, op, started: null })
			this.worker.postMessage({ t: "call", id, op, args }, transfer)
		})
	}

	// A call with an id the caller can cancel while it is queued (renders).
	queued<K extends PdfEngineOp>(op: K, args: PdfEngineArgs<K>): { readonly promise: Promise<PdfEngineValue<K>>; cancel(): void } {
		const id = this.nextId
		const promise = this.call(op, args)

		return {
			promise,
			cancel: () => {
				if (this.pending.has(id) && !this.terminated) this.worker.postMessage({ t: "cancel", ids: [id] }, [])
			}
		}
	}

	// Stops the byte reads, then the worker; every pending call rejects "closed".
	terminate(): void {
		if (this.terminated) return

		this.terminated = true
		clearTimer(this.timer)

		for (const buffer of this.channels) abortSyncRange(buffer)

		this.worker.terminate()
		this.rejectAll(new PdfEngineError("closed", "the engine was terminated"))
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error)

		this.pending.clear()
	}

	private poison(message: string): void {
		if (this.poisonMessage !== null || this.terminated) return

		this.poisonMessage = message
		this.rejectAll(new PdfEngineError("poisoned", message))

		for (const listener of this.poisonListeners) listener(message)

		this.terminate()
	}

	private checkWatchdog(): void {
		if (this.terminated) return

		const now = this.now()
		// Time spent waiting for bytes has its own deadline (the reader's).
		const waiting = this.channels.some(buffer => syncRangeWaiting(buffer))

		for (const pending of this.pending.values()) {
			if (pending.started === null) continue

			if (waiting) pending.started = now
			else if (now - pending.started > this.watchdogMs) {
				this.poison("a render took too long")

				return
			}
		}
	}

	private onMessage(data: unknown): void {
		if (!isFromPdfEngine(data)) return

		const message: FromPdfEngine = data

		if (message.t === "poisoned") {
			this.poison(message.message)

			return
		}

		const pending = this.pending.get(message.id)

		if (pending === undefined) {
			if (message.t === "ok") closeBitmap(message.value)

			return
		}

		if (message.t === "started") {
			pending.started = this.now()

			return
		}

		this.pending.delete(message.id)

		if (message.t === "ok") pending.resolve(message.value)
		else if (message.failure === "poisoned") {
			pending.reject(new PdfEngineError("poisoned", message.message))
			this.poison(message.message)
		} else pending.reject(new PdfEngineError(message.failure, message.message))
	}
}

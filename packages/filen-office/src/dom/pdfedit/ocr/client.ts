import { isFromOcr, type FromOcr, type OcrArgs, type OcrFailure, type OcrOp, type OcrValue, type ToOcr } from "./protocol"

// The page's side of one text recognition worker: a promise per request, model download progress, and the
// poisoned state. Cancelling recognition is terminating the worker (a running recognition takes no message).

export interface OcrWorkerLike {
	postMessage(message: ToOcr, transfer: unknown[]): void
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
	addEventListener(type: "error", listener: (event: unknown) => void): void
	terminate(): void
}

export class OcrError extends Error {
	override readonly name = "OcrError"
	readonly failure: OcrFailure

	constructor(failure: OcrFailure, message: string) {
		super(message === "" ? failure : message)
		this.failure = failure
	}
}

interface Pending {
	resolve(value: unknown): void
	reject(error: Error): void
	readonly progress: ((loaded: number, total: number) => void) | undefined
}

export class OcrClient {
	private readonly worker: OcrWorkerLike
	private readonly pending = new Map<number, Pending>()
	private nextId = 1
	private poisonMessage: string | null = null
	private terminated = false

	constructor(worker: OcrWorkerLike) {
		this.worker = worker
		worker.addEventListener("message", event => {
			this.onMessage(event.data)
		})
		worker.addEventListener("error", () => {
			this.poison("the text recognition worker failed")
		})
	}

	get poisoned(): string | null {
		return this.poisonMessage
	}

	get closed(): boolean {
		return this.terminated
	}

	call<K extends OcrOp>(
		op: K,
		args: OcrArgs<K>,
		transfer: unknown[] = [],
		progress?: (loaded: number, total: number) => void
	): Promise<OcrValue<K>> {
		if (this.poisonMessage !== null) return Promise.reject(new OcrError("poisoned", this.poisonMessage))
		if (this.terminated) return Promise.reject(new OcrError("closed", "the text recognition worker was terminated"))

		const id = this.nextId++

		return new Promise<OcrValue<K>>((resolve, reject) => {
			this.pending.set(id, { resolve: value => resolve(value as OcrValue<K>), reject, progress })
			this.worker.postMessage({ t: "call", id, op, args }, transfer)
		})
	}

	terminate(): void {
		if (this.terminated) return

		this.terminated = true
		this.worker.terminate()
		this.rejectAll(new OcrError("closed", "the text recognition worker was terminated"))
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error)

		this.pending.clear()
	}

	private poison(message: string): void {
		if (this.poisonMessage !== null || this.terminated) return

		this.poisonMessage = message
		this.rejectAll(new OcrError("poisoned", message))
		this.terminate()
	}

	private onMessage(data: unknown): void {
		if (!isFromOcr(data)) return

		const message: FromOcr = data

		if (message.t === "poisoned") {
			this.poison(message.message)

			return
		}

		const pending = this.pending.get(message.id)

		if (pending === undefined) return

		if (message.t === "progress") {
			pending.progress?.(message.loaded, message.total)

			return
		}

		this.pending.delete(message.id)

		if (message.t === "ok") pending.resolve(message.value)
		else pending.reject(new OcrError(message.failure, message.message))
	}
}

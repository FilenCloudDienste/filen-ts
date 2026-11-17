// A worker a worker starts for its own use (the FFmpeg decoders, the synthesizers): one instance for every user,
// started with the first and terminated after the last, at once or after an idle grace that keeps it for a
// following one. Requests carry an id their answer echoes. One that fails (a crash, a trap it reports as fatal, a
// script the browser refused) is dropped with everything waiting on it, and the next user starts another.

export interface NestedResponse {
	id: number
	// The request failed; the worker carries on.
	error?: string
	// The worker cannot carry on: it has closed itself.
	fatal?: string
}

export interface NestedWorkerOptions {
	// What the worker's errors are called in messages.
	name: string
	// How long it is kept after its last user; 0 terminates it at once.
	idleMs?: number
	// The error a request's `error` answer rejects with.
	toError?: (message: string) => Error
	// The error what waits on a worker that failed rejects with.
	toLostError?: (message: string) => Error
}

export class NestedWorker<Request extends object, Response extends NestedResponse> {
	private worker: Worker | null = null
	private users = 0
	private nextId = 0
	private idleTimer: ReturnType<typeof setTimeout> | null = null
	private readonly pending = new Map<number, { resolve: (response: Response) => void; reject: (error: Error) => void }>()
	private readonly spawn: () => Worker
	private readonly options: NestedWorkerOptions

	public constructor(spawn: () => Worker, options: NestedWorkerOptions) {
		this.spawn = spawn
		this.options = options
	}

	// The worker for a new user, started if none runs. Every acquire is balanced by exactly one release.
	public acquire(): Worker {
		this.users++
		this.cancelIdle()

		return this.worker ?? this.start()
	}

	public release(): void {
		this.users = Math.max(0, this.users - 1)

		if (this.users > 0 || this.worker === null) {
			return
		}

		const idleMs = this.options.idleMs ?? 0

		if (idleMs <= 0) {
			this.stop(new Error(`the ${this.options.name} worker was stopped`))

			return
		}

		this.idleTimer = setTimeout(() => {
			this.idleTimer = null

			if (this.users === 0) {
				this.stop(new Error(`the ${this.options.name} worker was stopped`))
			}
		}, idleMs)
	}

	// Whether `worker` (from acquire) still runs: a dropped one answers nothing more.
	public current(worker: Worker): boolean {
		return worker === this.worker
	}

	public request(worker: Worker, request: Request, transfer: Transferable[] = []): Promise<Response> {
		if (worker !== this.worker) {
			return Promise.reject(new Error(`the ${this.options.name} worker was lost`))
		}

		const id = this.nextId++

		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject })
			worker.postMessage({ id, ...request }, transfer)
		})
	}

	private start(): Worker {
		const worker = this.spawn()

		worker.addEventListener("message", (event: MessageEvent<Response>) => {
			const response = event.data

			if (response.fatal !== undefined) {
				if (this.worker === worker) {
					this.stop(this.lost(response.fatal))
				}

				return
			}

			const waiting = this.pending.get(response.id)

			this.pending.delete(response.id)

			if (response.error === undefined) {
				waiting?.resolve(response)
			} else {
				waiting?.reject(this.options.toError?.(response.error) ?? new Error(response.error))
			}
		})
		worker.addEventListener("error", event => {
			event.preventDefault()

			if (this.worker === worker) {
				this.stop(this.lost(event.message || `the ${this.options.name} worker failed`))
			}
		})

		this.worker = worker

		return worker
	}

	private lost(message: string): Error {
		return this.options.toLostError?.(message) ?? new Error(message)
	}

	private cancelIdle(): void {
		if (this.idleTimer !== null) {
			clearTimeout(this.idleTimer)
			this.idleTimer = null
		}
	}

	private stop(error: Error): void {
		this.cancelIdle()
		this.worker?.terminate()
		this.worker = null

		const waiting = [...this.pending.values()]

		this.pending.clear()

		for (const entry of waiting) {
			entry.reject(error)
		}
	}
}

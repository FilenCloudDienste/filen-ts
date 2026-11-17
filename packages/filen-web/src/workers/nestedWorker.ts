// A worker a worker starts for its own use (the FFmpeg decoders, the synthesizers): one instance for every user,
// started with the first and terminated after the last, at once or after an idle grace that keeps it for a
// following one. Requests carry an id their answer echoes. One that fails (a crash, a trap it reports as fatal, a
// script the browser refused, an answer that cannot be read, a request past its deadline) is dropped with everything
// waiting on it, and the next user starts another. A retired instance takes no new users and ends with its last.

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

interface Pending {
	worker: Worker
	resolve: (response: unknown) => void
	reject: (error: Error) => void
	timer: ReturnType<typeof setTimeout> | null
}

export class NestedWorker<Request extends object, Response extends NestedResponse> {
	private worker: Worker | null = null
	private users = 0
	private nextId = 0
	private idleTimer: ReturnType<typeof setTimeout> | null = null
	// Retired instances, with the users they have left; and every instance ended.
	private readonly retired = new Map<Worker, number>()
	private readonly ended = new WeakSet<Worker>()
	private readonly pending = new Map<number, Pending>()
	private readonly spawn: () => Worker
	private readonly options: NestedWorkerOptions

	public constructor(spawn: () => Worker, options: NestedWorkerOptions) {
		this.spawn = spawn
		this.options = options
	}

	// The worker for a new user, started if none runs. Every acquire is balanced by exactly one release, given the
	// worker it returned.
	public acquire(): Worker {
		this.users++
		this.cancelIdle()

		return this.worker ?? this.start()
	}

	public release(worker: Worker | null = this.worker): void {
		const left = worker === null ? undefined : this.retired.get(worker)

		if (worker !== null && left !== undefined) {
			if (left <= 1) {
				this.retired.delete(worker)
				this.end(worker, new Error(`the ${this.options.name} worker was stopped`))
			} else {
				this.retired.set(worker, left - 1)
			}

			return
		}

		this.users = Math.max(0, this.users - 1)

		if (this.users > 0 || this.worker === null) {
			return
		}

		const idleMs = this.options.idleMs ?? 0

		if (idleMs <= 0) {
			this.stop(new Error(`the ${this.options.name} worker was stopped`))

			return
		}

		this.cancelIdle()
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null

			if (this.users === 0) {
				this.stop(new Error(`the ${this.options.name} worker was stopped`))
			}
		}, idleMs)
	}

	// Whether `worker` (from acquire) still runs: a dropped one answers nothing more.
	public current(worker: Worker): boolean {
		return !this.ended.has(worker) && (worker === this.worker || this.retired.has(worker))
	}

	// Sends no new user to `worker` (the current instance): the next acquire starts another, and this one ends with the
	// last user it has, at once when it has none.
	public retire(worker: Worker): void {
		if (worker !== this.worker) {
			return
		}

		this.cancelIdle()
		this.worker = null

		if (this.users === 0) {
			this.end(worker, new Error(`the ${this.options.name} worker was stopped`))
		} else {
			this.retired.set(worker, this.users)
		}

		this.users = 0
	}

	// Answered by the worker, or rejected once it is lost; past `timeoutMs`, the worker is taken for stuck and dropped.
	public request(worker: Worker, request: Request, transfer: Transferable[] = [], timeoutMs?: number): Promise<Response> {
		if (!this.current(worker)) {
			return Promise.reject(new Error(`the ${this.options.name} worker was lost`))
		}

		const id = this.nextId++

		return new Promise((resolve, reject) => {
			const timer =
				timeoutMs === undefined
					? null
					: setTimeout(() => {
							this.end(worker, this.lost(`the ${this.options.name} worker did not answer within ${String(timeoutMs)} ms`))
						}, timeoutMs)

			this.pending.set(id, { worker, resolve: resolve as (response: unknown) => void, reject, timer })
			worker.postMessage({ id, ...request }, transfer)
		})
	}

	private start(): Worker {
		const worker = this.spawn()

		worker.addEventListener("message", (event: MessageEvent<Response>) => {
			const response = event.data

			if (response.fatal !== undefined) {
				this.end(worker, this.lost(response.fatal))

				return
			}

			const waiting = this.pending.get(response.id)

			if (waiting === undefined) {
				return
			}

			this.pending.delete(response.id)

			if (waiting.timer !== null) {
				clearTimeout(waiting.timer)
			}

			if (response.error === undefined) {
				waiting.resolve(response)
			} else {
				waiting.reject(this.options.toError?.(response.error) ?? new Error(response.error))
			}
		})
		worker.addEventListener("error", event => {
			event.preventDefault()
			this.end(worker, this.lost(event.message || `the ${this.options.name} worker failed`))
		})
		// An answer that cannot be read names no request: none of the worker's can be trusted to settle.
		worker.addEventListener("messageerror", () => {
			this.end(worker, this.lost(`an answer of the ${this.options.name} worker could not be read`))
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
		if (this.worker !== null) {
			this.end(this.worker, error)
		}
	}

	// Terminates `worker`, current or retired, and fails what waits on it. A retired one keeps its count of users, whose
	// releases still come.
	private end(worker: Worker, error: Error): void {
		if (this.ended.has(worker)) {
			return
		}

		this.ended.add(worker)

		if (worker === this.worker) {
			this.cancelIdle()
			this.worker = null
		}

		worker.terminate()

		for (const [id, entry] of [...this.pending]) {
			if (entry.worker === worker) {
				this.pending.delete(id)

				if (entry.timer !== null) {
					clearTimeout(entry.timer)
				}

				entry.reject(error)
			}
		}
	}
}

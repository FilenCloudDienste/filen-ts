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
	// No answer yet: the worker has started on the request (an `acknowledges` worker says so for every one).
	started?: true
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
	// The worker posts `started` as it takes each request up: a request's deadline then counts from there, not the time
	// it waited behind others on the same thread. Meanwhile a worker that says nothing at all for `silenceMs` while a
	// request waits to be taken up (its script never loaded, a thread stuck in a request without a deadline) is dropped.
	acknowledges?: boolean
	silenceMs?: number
}

interface Pending {
	worker: Worker
	resolve: (response: unknown) => void
	reject: (error: Error) => void
	timer: ReturnType<typeof setTimeout> | null
	timeoutMs: number | undefined
	started: boolean
}

const DEFAULT_SILENCE_MS = 30_000

export class NestedWorker<Request extends object, Response extends NestedResponse> {
	private worker: Worker | null = null
	// The users of every instance still held, current, retired or ended: a release counts against the instance it was
	// acquired from, never another.
	private readonly users = new Map<Worker, number>()
	private nextId = 0
	private idleTimer: ReturnType<typeof setTimeout> | null = null
	private readonly retired = new Set<Worker>()
	private readonly ended = new WeakSet<Worker>()
	private readonly pending = new Map<number, Pending>()
	// Per acknowledging worker with a request not yet taken up: dropped when it stays silent this long.
	private readonly silence = new Map<Worker, ReturnType<typeof setTimeout>>()
	private readonly spawn: () => Worker
	private readonly options: NestedWorkerOptions

	public constructor(spawn: () => Worker, options: NestedWorkerOptions) {
		this.spawn = spawn
		this.options = options
	}

	// The worker for a new user, started if none runs. Every acquire is balanced by exactly one release, given the
	// worker it returned.
	public acquire(): Worker {
		const worker = this.worker ?? this.start()

		this.users.set(worker, (this.users.get(worker) ?? 0) + 1)
		this.cancelIdle()

		return worker
	}

	// Another user of `worker`, current or retired, while it still runs; false, and no user counted, once it does not.
	// Balanced by one release like an acquire.
	public join(worker: Worker): boolean {
		if (!this.current(worker)) {
			return false
		}

		this.users.set(worker, (this.users.get(worker) ?? 0) + 1)

		if (worker === this.worker) {
			this.cancelIdle()
		}

		return true
	}

	public release(worker: Worker): void {
		const count = this.users.get(worker)

		if (count === undefined) {
			return
		}

		if (count > 1) {
			this.users.set(worker, count - 1)

			return
		}

		this.users.delete(worker)

		// A retired instance ends with its last user; an ended one only forgets it.
		if (this.retired.delete(worker) || this.ended.has(worker)) {
			this.end(worker, new Error(`the ${this.options.name} worker was stopped`))

			return
		}

		if (worker !== this.worker) {
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

			if (this.worker !== null && !this.users.has(this.worker)) {
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

		if (this.users.has(worker)) {
			this.retired.add(worker)
		} else {
			this.end(worker, new Error(`the ${this.options.name} worker was stopped`))
		}
	}

	// Answered by the worker, or rejected once it is lost; past `timeoutMs`, the worker is taken for stuck and dropped.
	public request(worker: Worker, request: Request, transfer: Transferable[] = [], timeoutMs?: number): Promise<Response> {
		if (!this.current(worker)) {
			return Promise.reject(new Error(`the ${this.options.name} worker was lost`))
		}

		const id = this.nextId++

		return new Promise((resolve, reject) => {
			const entry: Pending = {
				worker,
				resolve: resolve as (response: unknown) => void,
				reject,
				timer: null,
				timeoutMs,
				started: false
			}

			if (this.options.acknowledges !== true) {
				this.arm(entry)
			}

			this.pending.set(id, entry)
			worker.postMessage({ id, ...request }, transfer)

			if (this.options.acknowledges === true && !this.silence.has(worker)) {
				this.listen(worker)
			}
		})
	}

	// Drops `worker` if it says nothing for the silence deadline while a request of it waits to be taken up; heard from,
	// it is listened for again while one still does.
	private listen(worker: Worker): void {
		const previous = this.silence.get(worker)

		if (previous !== undefined) {
			clearTimeout(previous)
			this.silence.delete(worker)
		}

		if (![...this.pending.values()].some(entry => entry.worker === worker && !entry.started)) {
			return
		}

		const silenceMs = this.options.silenceMs ?? DEFAULT_SILENCE_MS

		this.silence.set(
			worker,
			setTimeout(() => {
				this.silence.delete(worker)
				this.end(worker, this.lost(`the ${this.options.name} worker said nothing for ${String(silenceMs)} ms`))
			}, silenceMs)
		)
	}

	// Starts `entry`'s deadline, if it has one.
	private arm(entry: Pending): void {
		const { timeoutMs, worker } = entry

		if (timeoutMs === undefined || entry.timer !== null) {
			return
		}

		entry.timer = setTimeout(() => {
			this.end(worker, this.lost(`the ${this.options.name} worker did not answer within ${String(timeoutMs)} ms`))
		}, timeoutMs)
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

			if (response.started === true) {
				waiting.started = true
				this.arm(waiting)
				this.listen(worker)

				return
			}

			this.pending.delete(response.id)

			if (this.options.acknowledges === true) {
				this.listen(worker)
			}

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

	// Terminates `worker`, current or retired, and fails what waits on it. Its users' releases still come, and count
	// against it alone.
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

		const silent = this.silence.get(worker)

		if (silent !== undefined) {
			clearTimeout(silent)
			this.silence.delete(worker)
		}

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

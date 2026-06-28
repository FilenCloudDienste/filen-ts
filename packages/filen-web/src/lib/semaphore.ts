export class DisposeSemaphoreWrapper implements AsyncDisposable {
	private readonly semaphore: Semaphore
	private released: boolean = false

	public constructor(semaphore: Semaphore) {
		this.semaphore = semaphore
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (this.released) {
			return Promise.resolve()
		}

		this.semaphore.release()

		this.released = true

		return Promise.resolve()
	}
}

export class Semaphore {
	private counter: number = 0
	// FIFO queue of pending acquirers. Appended on acquire and consumed from `head` on release, instead of
	// `Array.shift()` — shift is O(n) (it re-indexes the whole array), so a large fan-out (e.g. a huge batch
	// of concurrent operations awaiting one semaphore) was O(N²): the queue grows to ~N and each of the N
	// release() calls shifted an ~N-length array. The head pointer makes each dequeue O(1) amortized; the
	// consumed prefix is compacted occasionally so a long-lived semaphore never retains an unbounded array.
	private waiting: Array<
		| {
				resolve: (value: DisposeSemaphoreWrapper | PromiseLike<DisposeSemaphoreWrapper>) => void
				reject: (reason?: unknown) => void
		  }
		| undefined
	> = []
	private head: number = 0
	private maxCount: number

	public constructor(max: number = 1) {
		if (max < 1) {
			throw new Error("Max must be at least 1")
		}

		this.maxCount = max
	}

	public acquire(): Promise<DisposeSemaphoreWrapper> {
		if (this.counter < this.maxCount) {
			this.counter++

			return Promise.resolve(new DisposeSemaphoreWrapper(this))
		} else {
			return new Promise<DisposeSemaphoreWrapper>((resolve, reject) => {
				this.waiting.push({
					resolve,
					reject
				})
			})
		}
	}

	public release(): void {
		if (this.counter <= 0) {
			return
		}

		this.counter--

		this.processQueue()
	}

	private processQueue(): void {
		if (this.head < this.waiting.length && this.counter < this.maxCount) {
			this.counter++

			const waiter = this.waiting[this.head]

			// Null the consumed slot so its closure can be GC'd, then advance the head pointer (O(1) dequeue).
			this.waiting[this.head] = undefined
			this.head++

			// Compact once the consumed prefix dominates the array (amortized O(1)) so a long-running
			// semaphore doesn't grow without bound.
			if (this.head >= 1024 && this.head * 2 >= this.waiting.length) {
				this.waiting = this.waiting.slice(this.head)
				this.head = 0
			}

			if (waiter) {
				waiter.resolve(new DisposeSemaphoreWrapper(this))
			}
		}
	}
}

export class Mutex {
	private semaphore: Semaphore = new Semaphore(1)

	public acquire(): Promise<DisposeSemaphoreWrapper> {
		return this.semaphore.acquire()
	}

	public release(): void {
		this.semaphore.release()
	}
}

export default Semaphore

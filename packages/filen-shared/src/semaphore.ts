type SemaphoreWaiter = {
	resolve: (value: void | PromiseLike<void>) => void
	reject: (reason?: unknown) => void
}

export class Semaphore {
	private counter: number = 0
	// FIFO waiter queue as a head-indexed array: dequeuing advances `waitingHead`
	// instead of calling Array.prototype.shift(), which memmoves the entire backing
	// array per call — O(queue) per release and O(queue²) to drain. With ~100k
	// queued acquires (camera-roll-scale fan-outs in filen-mobile) the shift-based
	// queue alone cost multiple seconds per drain.
	private waiting: Array<SemaphoreWaiter | undefined> = []
	private waitingHead: number = 0
	private maxCount: number

	public constructor(max: number = 1) {
		this.maxCount = max
	}

	public acquire(): Promise<void> {
		if (this.counter < this.maxCount) {
			this.counter++

			return Promise.resolve()
		}

		return new Promise<void>((resolve, reject) => {
			this.waiting.push({
				resolve,
				reject
			})
		})
	}

	public release(): void {
		if (this.counter <= 0) {
			return
		}

		this.counter--

		this.processQueue()
	}

	public count(): number {
		return this.counter
	}

	public setMax(newMax: number): void {
		this.maxCount = newMax

		this.processQueue()
	}

	public purge(): number {
		let unresolved = 0

		for (let i = this.waitingHead; i < this.waiting.length; i++) {
			const waiter = this.waiting[i]

			if (waiter) {
				unresolved++

				waiter.reject("Task has been purged")
			}
		}

		this.counter = 0
		this.waiting = []
		this.waitingHead = 0

		return unresolved
	}

	private processQueue(): void {
		while (this.waitingHead < this.waiting.length && this.counter < this.maxCount) {
			this.counter++

			const waiter = this.waiting[this.waitingHead]

			// Free the slot so a resolved waiter (and everything its callbacks
			// capture) is collectable while later waiters keep the array alive.
			this.waiting[this.waitingHead] = undefined
			this.waitingHead++

			if (waiter) {
				waiter.resolve()
			}
		}

		if (this.waitingHead >= this.waiting.length) {
			// Fully drained — drop the consumed backing array.
			if (this.waiting.length > 0) {
				this.waiting = []
				this.waitingHead = 0
			}
		} else if (this.waitingHead > 4096 && this.waitingHead * 2 > this.waiting.length) {
			// Compact occasionally so a long-lived, never-empty queue cannot retain
			// an unbounded consumed prefix. Amortized O(1) per dequeue: an element
			// is moved at most once for each doubling of the consumed prefix.
			this.waiting = this.waiting.slice(this.waitingHead)
			this.waitingHead = 0
		}
	}
}

export default Semaphore

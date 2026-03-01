export class Semaphore {
	private counter: number = 0
	private waiting: Array<{
		resolve: (value: void | PromiseLike<void>) => void
		reject: (reason?: unknown) => void
	}> = []
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
		const unresolved = this.waiting.length

		for (const waiter of this.waiting) {
			waiter.reject("Task has been purged")
		}

		this.counter = 0
		this.waiting = []

		return unresolved
	}

	private processQueue(): void {
		while (this.waiting.length > 0 && this.counter < this.maxCount) {
			this.counter++

			const waiter = this.waiting.shift()

			if (waiter) {
				waiter.resolve()
			}
		}
	}
}

export default Semaphore

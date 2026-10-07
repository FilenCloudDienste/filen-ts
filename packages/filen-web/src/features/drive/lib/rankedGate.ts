interface Waiter {
	rank: () => number
	wake: () => void
}

// A counting gate whose next permit goes to the waiter with the lowest rank, read at the moment a permit
// frees rather than when the waiter arrived: a grid scrolled meanwhile ranks its tiles by where they are
// now. Equal ranks keep arrival order. A rank of 0 or below takes a free permit at once; a higher rank
// first waits holdMs, so the tiles mounting in the same pass get to claim the free permits before it.
// Ranks are read only on a free permit, never per frame, and the queue is bounded by the mounted cells.
export class RankedGate {
	private readonly limit: number
	private readonly holdMs: number
	private running = 0
	private waiting: Waiter[] = []
	private holdTimer: ReturnType<typeof setTimeout> | undefined

	public constructor(limit: number, holdMs: number) {
		this.limit = limit
		this.holdMs = holdMs
	}

	public acquire(rank: () => number): Promise<void> {
		if (this.running < this.limit && rank() <= 0) {
			this.running++

			return Promise.resolve()
		}

		return new Promise<void>(wake => {
			this.waiting.push({ rank, wake })

			if (this.running < this.limit && this.holdTimer === undefined) {
				this.holdTimer = setTimeout(() => {
					this.holdTimer = undefined
					this.drain()
				}, this.holdMs)
			}
		})
	}

	public release(): void {
		if (this.running <= 0) {
			return
		}

		this.running--
		this.drain()
	}

	public async withPermit<T>(rank: () => number, fn: () => Promise<T>): Promise<T> {
		await this.acquire(rank)

		try {
			return await fn()
		} finally {
			this.release()
		}
	}

	private drain(): void {
		while (this.running < this.limit && this.waiting.length > 0) {
			let best = 0
			let bestRank = Infinity

			for (let i = 0; i < this.waiting.length; i++) {
				const rank = this.waiting[i]?.rank() ?? Infinity

				if (rank < bestRank) {
					best = i
					bestRank = rank
				}
			}

			const [next] = this.waiting.splice(best, 1)

			this.running++
			next?.wake()
		}
	}
}

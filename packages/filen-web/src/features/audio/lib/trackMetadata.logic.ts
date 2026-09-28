// The admission queue for metadata reads: at most `concurrency` run at once, the rest wait in FIFO order,
// and a waiting job nobody wants any more (its row scrolled away before a slot freed) is dropped without
// ever starting. A running job always finishes, since its result is persisted and useful to the next
// visit. `priority` jobs (the track the player needs) go to the front. Plain and DOM-free for testing.

export interface QueuedJob {
	// Drops the job if it has not started; a no-op once it has.
	cancel: () => void
	// Moves a waiting job to the front.
	prioritize: () => void
}

interface Entry {
	run: () => Promise<void>
}

export class JobQueue {
	private readonly concurrency: number
	private readonly waiting: Entry[] = []
	private running = 0

	public constructor(concurrency: number) {
		this.concurrency = Math.max(1, concurrency)
	}

	public get pendingCount(): number {
		return this.waiting.length
	}

	public get runningCount(): number {
		return this.running
	}

	public enqueue(run: () => Promise<void>, priority: boolean): QueuedJob {
		const entry: Entry = { run }

		if (priority) {
			this.waiting.unshift(entry)
		} else {
			this.waiting.push(entry)
		}

		this.pump()

		return {
			cancel: () => {
				this.remove(entry)
			},
			prioritize: () => {
				if (this.remove(entry)) {
					this.waiting.unshift(entry)
				}
			}
		}
	}

	// Drops every waiting job; running ones finish on their own.
	public clear(): void {
		this.waiting.length = 0
	}

	private remove(entry: Entry): boolean {
		const index = this.waiting.indexOf(entry)

		if (index === -1) {
			return false
		}

		this.waiting.splice(index, 1)

		return true
	}

	private pump(): void {
		while (this.running < this.concurrency) {
			const next = this.waiting.shift()

			if (next === undefined) {
				return
			}

			this.running++

			void next
				.run()
				.catch(() => undefined)
				.finally(() => {
					this.running--
					this.pump()
				})
		}
	}
}

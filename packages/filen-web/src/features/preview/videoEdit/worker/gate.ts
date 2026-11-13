// Keeps the tracks an export writes side by side in output time. A fragmented MP4 muxer holds every track's media
// until all of them reach a fragment's end, so a track allowed to run ahead would pile up in memory (the video of a
// whole file waiting for its audio). Each lane waits while it is more than `slack` seconds past the slowest lane still
// running; a finished lane no longer holds anyone back.

export class InterleaveGate {
	private readonly times = new Map<string, number>()
	private readonly waiters = new Set<() => void>()
	private readonly slack: number
	private stopped = false

	public constructor(slack: number) {
		this.slack = slack
	}

	// A track that will write; added before any writes.
	public addLane(lane: string): void {
		this.times.set(lane, 0)
	}

	// The slowest running lane's time: how far every track has been written.
	public get progress(): number {
		let slowest = Number.POSITIVE_INFINITY

		for (const time of this.times.values()) {
			slowest = Math.min(slowest, time)
		}

		return slowest
	}

	// Resolves once `lane` may write media at `time` (and records it there).
	public async advance(lane: string, time: number): Promise<void> {
		this.times.set(lane, Math.max(this.times.get(lane) ?? 0, time))
		this.wake()

		while (!this.stopped && time > this.slowestOther(lane) + this.slack) {
			await new Promise<void>(resolve => {
				this.waiters.add(resolve)
			})
		}
	}

	public finish(lane: string): void {
		this.times.delete(lane)
		this.wake()
	}

	// Releases every waiter for good (the export is ending).
	public stop(): void {
		this.stopped = true
		this.wake()
	}

	private slowestOther(lane: string): number {
		let slowest = Number.POSITIVE_INFINITY

		for (const [other, time] of this.times) {
			if (other !== lane) {
				slowest = Math.min(slowest, time)
			}
		}

		return slowest
	}

	private wake(): void {
		const waiting = [...this.waiters]

		this.waiters.clear()

		for (const resolve of waiting) {
			resolve()
		}
	}
}

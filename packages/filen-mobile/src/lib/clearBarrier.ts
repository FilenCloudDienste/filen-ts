// Coordinates a destructive "clear" operation against concurrent reads/writes on the
// same disk-backed cache. Many enter()/leave() pairs may run in parallel;
// runExclusive() waits for the in-flight count to drain to 0 and blocks new enter()
// callers until the exclusive task finishes.
//
// Usage:
//
//   const barrier = new ClearBarrier()
//
//   public async readOrWrite(...) {
//       return await run(async defer => {
//           await this.barrier.enter()
//           defer(() => this.barrier.leave())
//           // ... read or write disk
//       })
//   }
//
//   public async clear() {
//       await this.barrier.runExclusive(async () => {
//           // ... delete + recreate
//       })
//   }
export class ClearBarrier {
	private inflight = 0
	private exclusiveActive = false
	private exclusivePromise: Promise<void> | null = null
	private drained: Promise<void> = Promise.resolve()
	private resolveDrained: (() => void) | null = null

	public async enter(): Promise<void> {
		// Wait for any active runExclusive — and any that queue up while we wait.
		while (this.exclusiveActive && this.exclusivePromise) {
			await this.exclusivePromise
		}

		if (this.inflight === 0) {
			this.drained = new Promise<void>(resolve => {
				this.resolveDrained = resolve
			})
		}

		this.inflight++
	}

	public leave(): void {
		if (this.inflight === 0) {
			return
		}

		this.inflight--

		if (this.inflight === 0 && this.resolveDrained) {
			this.resolveDrained()
			this.resolveDrained = null
		}
	}

	public async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
		// Queue behind any other active runExclusive.
		while (this.exclusiveActive && this.exclusivePromise) {
			await this.exclusivePromise
		}

		let resolveExclusive!: () => void

		this.exclusivePromise = new Promise<void>(resolve => {
			resolveExclusive = resolve
		})
		this.exclusiveActive = true

		try {
			if (this.inflight > 0) {
				await this.drained
			}

			return await fn()
		} finally {
			this.exclusiveActive = false
			this.exclusivePromise = null
			resolveExclusive()
		}
	}
}

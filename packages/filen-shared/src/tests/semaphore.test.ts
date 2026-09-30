import { describe, it, expect, vi } from "vitest"
import { Semaphore, KeyedSemaphores } from "@filen/shared"

describe("Semaphore", () => {
	describe("constructor", () => {
		it("should default to max count of 1", async () => {
			const sem = new Semaphore()

			await sem.acquire()

			expect(sem.count()).toBe(1)
		})

		it("should accept custom max count", async () => {
			const sem = new Semaphore(3)

			await sem.acquire()
			await sem.acquire()
			await sem.acquire()

			expect(sem.count()).toBe(3)
		})
	})

	describe("acquire", () => {
		it("should resolve immediately when under max", async () => {
			const sem = new Semaphore(2)
			const fn = vi.fn()

			await sem.acquire()

			fn()

			expect(fn).toHaveBeenCalled()
			expect(sem.count()).toBe(1)
		})

		it("should block when at max capacity", async () => {
			const sem = new Semaphore(1)

			await sem.acquire()

			let acquired = false

			sem.acquire().then(() => {
				acquired = true
			})

			await new Promise(resolve => setTimeout(resolve, 10))

			expect(acquired).toBe(false)

			sem.release()

			await new Promise(resolve => setTimeout(resolve, 10))

			expect(acquired).toBe(true)
		})

		it("should queue multiple waiters", async () => {
			const sem = new Semaphore(1)

			await sem.acquire()

			const order: number[] = []

			sem.acquire().then(() => order.push(1))
			sem.acquire().then(() => order.push(2))
			sem.acquire().then(() => order.push(3))

			sem.release()
			await new Promise(resolve => setTimeout(resolve, 10))
			sem.release()
			await new Promise(resolve => setTimeout(resolve, 10))
			sem.release()
			await new Promise(resolve => setTimeout(resolve, 10))

			expect(order).toEqual([1, 2, 3])
		})
	})

	describe("release", () => {
		it("should decrement counter", async () => {
			const sem = new Semaphore(2)

			await sem.acquire()
			await sem.acquire()

			expect(sem.count()).toBe(2)

			sem.release()

			expect(sem.count()).toBe(1)
		})

		it("should not go below 0", () => {
			const sem = new Semaphore(1)

			sem.release()

			expect(sem.count()).toBe(0)
		})

		it("should wake next waiter on release", async () => {
			const sem = new Semaphore(1)

			await sem.acquire()

			let resolved = false

			sem.acquire().then(() => {
				resolved = true
			})

			sem.release()

			await new Promise(resolve => setTimeout(resolve, 10))

			expect(resolved).toBe(true)
		})
	})

	describe("setMax", () => {
		it("should update max count", async () => {
			const sem = new Semaphore(1)

			await sem.acquire()

			sem.setMax(2)

			const p = sem.acquire()
			let resolved = false

			p.then(() => {
				resolved = true
			})

			await new Promise(resolve => setTimeout(resolve, 10))

			expect(resolved).toBe(true)
		})

		it("should process multiple waiters when max increases", async () => {
			const sem = new Semaphore(1)

			await sem.acquire()

			let count = 0

			sem.acquire().then(() => count++)
			sem.acquire().then(() => count++)
			sem.acquire().then(() => count++)

			sem.setMax(4)

			await new Promise(resolve => setTimeout(resolve, 10))

			expect(count).toBe(3)
		})
	})

	describe("purge", () => {
		it("should reject all waiting promises", async () => {
			const sem = new Semaphore(1)

			await sem.acquire()

			const errors: unknown[] = []

			sem.acquire().catch(e => errors.push(e))
			sem.acquire().catch(e => errors.push(e))

			const purged = sem.purge()

			await new Promise(resolve => setTimeout(resolve, 10))

			expect(purged).toBe(2)
			expect(errors.length).toBe(2)
		})

		it("should reset counter to 0", async () => {
			const sem = new Semaphore(2)

			await sem.acquire()
			await sem.acquire()

			sem.purge()

			expect(sem.count()).toBe(0)
		})
	})

	describe("withPermit", () => {
		it("should hold a permit while fn runs and return its result", async () => {
			const sem = new Semaphore(1)

			const result = await sem.withPermit(() => {
				expect(sem.count()).toBe(1)

				return 42
			})

			expect(result).toBe(42)
			expect(sem.count()).toBe(0)
		})

		it("should release the permit when fn throws", async () => {
			const sem = new Semaphore(1)

			await expect(
				sem.withPermit(async () => {
					throw new Error("boom")
				})
			).rejects.toThrow("boom")

			expect(sem.count()).toBe(0)
		})

		it("should serialize callers", async () => {
			const sem = new Semaphore(1)
			const order: string[] = []

			await Promise.all([
				sem.withPermit(async () => {
					order.push("a:start")

					await new Promise(resolve => setTimeout(resolve, 10))

					order.push("a:end")
				}),
				sem.withPermit(() => {
					order.push("b")
				})
			])

			expect(order).toEqual(["a:start", "a:end", "b"])
		})

		it("should not run fn when the acquire is purged", async () => {
			const sem = new Semaphore(1)
			const fn = vi.fn()

			await sem.acquire()

			const pending = sem.withPermit(fn)

			sem.purge()

			await expect(pending).rejects.toBe("Task has been purged")
			expect(fn).not.toHaveBeenCalled()
		})
	})

	describe("count", () => {
		it("should reflect current active count", async () => {
			const sem = new Semaphore(3)

			expect(sem.count()).toBe(0)

			await sem.acquire()

			expect(sem.count()).toBe(1)

			await sem.acquire()

			expect(sem.count()).toBe(2)

			sem.release()

			expect(sem.count()).toBe(1)
		})
	})

	describe("waiter-queue scaling (O(1) dequeue regression)", () => {
		it(
			"drains 150k queued waiters in FIFO order without quadratic queue cost",
			{ timeout: 60_000 },
			async () => {
				const sem = new Semaphore(2)

				await sem.acquire()
				await sem.acquire()

				const queued = 150_000
				const order: number[] = []
				const all: Promise<void>[] = []

				for (let i = 0; i < queued; i++) {
					all.push(
						sem.acquire().then(() => {
							order.push(i)

							sem.release()
						})
					)
				}

				const start = performance.now()

				sem.release()
				sem.release()

				await Promise.all(all)

				const elapsed = performance.now() - start

				expect(order.length).toBe(queued)
				expect(order[0]).toBe(0)
				expect(order[queued - 1]).toBe(queued - 1)

				// Spot-check strict FIFO across the whole drain.
				for (let i = 1; i < queued; i += 997) {
					expect(order[i]).toBe(i)
				}

				// A shift()-based queue drains 150k waiters with O(queue²) element moves
				// (~7s measured); the head-indexed queue is linear (~150ms). The bound
				// sits ~13× above the linear cost so CI variance cannot flake it, while
				// the quadratic implementation exceeds it several times over.
				expect(elapsed).toBeLessThan(2000)
			}
		)

		it("purge rejects exactly the still-queued waiters after a partial drain", async () => {
			const sem = new Semaphore(1)

			await sem.acquire()

			const total = 1000
			const drained = 400
			const errors: unknown[] = []
			let resolved = 0

			const all: Promise<void>[] = []

			for (let i = 0; i < total; i++) {
				all.push(
					sem.acquire().then(
						() => {
							resolved++
						},
						error => {
							errors.push(error)
						}
					)
				)
			}

			// Each release admits exactly one waiter (it stays holding; we drive
			// externally), consuming the queue head 400 deep before the purge.
			for (let i = 0; i < drained; i++) {
				sem.release()
			}

			const purged = sem.purge()

			await new Promise(resolve => setTimeout(resolve, 10))

			expect(purged).toBe(total - drained)
			expect(resolved).toBe(drained)
			expect(errors.length).toBe(total - drained)
			expect(errors.every(error => error === "Task has been purged")).toBe(true)
		})

		it(
			"keeps FIFO order across a deep partial drain followed by new arrivals",
			{ timeout: 60_000 },
			async () => {
				const sem = new Semaphore(1)

				await sem.acquire()

				const firstWave = 6000
				const secondWave = 1000
				const order: number[] = []
				const all: Promise<void>[] = []

				for (let i = 0; i < firstWave; i++) {
					all.push(
						sem.acquire().then(() => {
							order.push(i)
						})
					)
				}

				// Drain deep into the first wave (past any internal compaction
				// threshold), then enqueue a second wave and drain everything.
				for (let i = 0; i < 5000; i++) {
					sem.release()
				}

				for (let i = 0; i < secondWave; i++) {
					const id = firstWave + i

					all.push(
						sem.acquire().then(() => {
							order.push(id)
						})
					)
				}

				for (let i = 0; i < firstWave + secondWave - 5000; i++) {
					sem.release()
				}

				await Promise.all(all)

				expect(order.length).toBe(firstWave + secondWave)

				for (let i = 0; i < firstWave + secondWave; i++) {
					expect(order[i]).toBe(i)
				}
			}
		)
	})
})

describe("KeyedSemaphores", () => {
	it("for() returns the same instance per key and distinct instances across keys", () => {
		const keyed = new KeyedSemaphores()

		expect(keyed.for("a")).toBe(keyed.for("a"))
		expect(keyed.for("a")).not.toBe(keyed.for("b"))
	})

	it("acquire() serializes callers of the same key", async () => {
		const keyed = new KeyedSemaphores()
		const order: string[] = []

		const releaseA = await keyed.acquire("k")
		const pendingB = keyed.acquire("k").then(release => {
			order.push("b")

			release()
		})

		await Promise.resolve()

		order.push("a")

		releaseA()

		await pendingB

		expect(order).toEqual(["a", "b"])
	})

	it("acquire() does not block other keys", async () => {
		const keyed = new KeyedSemaphores()

		await keyed.acquire("a")

		const releaseB = await keyed.acquire("b")

		expect(typeof releaseB).toBe("function")
	})

	it("drops the entry once idle and keeps it while a waiter is queued", async () => {
		const keyed = new KeyedSemaphores()
		const releaseA = await keyed.acquire("k")
		const held = keyed.for("k")
		const pendingB = keyed.acquire("k")

		releaseA()

		// The waiter holds the permit, so the entry survives.
		expect(keyed.for("k")).toBe(held)

		const releaseB = await pendingB

		releaseB()

		expect(keyed.for("k")).not.toBe(held)
	})

	it("release is idempotent", async () => {
		const keyed = new KeyedSemaphores()
		const releaseA = await keyed.acquire("k")
		const semaphore = keyed.for("k")
		const pendingB = keyed.acquire("k")

		releaseA()
		releaseA()

		expect(semaphore.count()).toBe(1)

		const releaseB = await pendingB

		releaseB()

		expect(semaphore.count()).toBe(0)
	})
})

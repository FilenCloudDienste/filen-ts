import { describe, it, expect, vi } from "vitest"
import { Semaphore } from "../semaphore"

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
})

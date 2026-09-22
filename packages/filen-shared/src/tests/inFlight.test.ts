import { describe, it, expect, vi } from "vitest"
import { InFlight } from "@filen/shared"

describe("InFlight", () => {
	describe("coalesce", () => {
		it("shares one fn invocation across concurrent callers", async () => {
			const inFlight = new InFlight<string, number>()
			const fn = vi.fn(
				() =>
					new Promise<number>(resolve => {
						setTimeout(() => resolve(1), 10)
					})
			)

			const [a, b, c] = await Promise.all([
				inFlight.coalesce("key", fn),
				inFlight.coalesce("key", fn),
				inFlight.coalesce("key", fn)
			])

			expect(fn).toHaveBeenCalledTimes(1)
			expect(a).toBe(1)
			expect(b).toBe(1)
			expect(c).toBe(1)
		})

		it("removes the entry after a resolve so the next call re-runs fn", async () => {
			const inFlight = new InFlight<string, number>()
			let calls = 0
			const fn = () => Promise.resolve(++calls)

			const first = await inFlight.coalesce("key", fn)

			expect(inFlight.has("key")).toBe(false)

			const second = await inFlight.coalesce("key", fn)

			expect(first).toBe(1)
			expect(second).toBe(2)
		})

		it("removes the entry after a reject so the next call re-runs fn", async () => {
			const inFlight = new InFlight<string, number>()
			let calls = 0
			const fn = () => {
				calls++

				return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(calls)
			}

			await expect(inFlight.coalesce("key", fn)).rejects.toThrow("boom")

			expect(inFlight.has("key")).toBe(false)

			await expect(inFlight.coalesce("key", fn)).resolves.toBe(2)
		})

		it("rejects every joined caller when fn rejects", async () => {
			const inFlight = new InFlight<string, number>()
			const fn = () => Promise.reject(new Error("boom"))

			const results = await Promise.allSettled([inFlight.coalesce("key", fn), inFlight.coalesce("key", fn)])

			expect(results[0]?.status).toBe("rejected")
			expect(results[1]?.status).toBe("rejected")
		})

		it("does not let a superseded promise's settle evict a newer registration for the same key (identity guard)", async () => {
			const inFlight = new InFlight<string, number>()
			let resolveOuter: ((value: number) => void) | undefined

			// fn() starts running synchronously, and — before the OUTER coalesce() call registers
			// its own promise (registration happens only once fn() returns a promise object) —
			// makes a NESTED coalesce() call for the SAME key. That nested call finds nothing
			// registered yet, so it registers its own (already-resolved) promise and starts
			// awaiting it, all before fn() yields back to the outer coalesce() call. The outer
			// call then registers ITS OWN promise, clobbering the nested one's entry. Once the
			// nested call's await resolves, its cleanup must find the entry is no longer its own
			// and leave the outer (newer) registration in place.
			const outerPromise = inFlight.coalesce("key", async () => {
				const inner = await inFlight.coalesce("key", () => Promise.resolve(-1))

				expect(inner).toBe(-1)

				return await new Promise<number>(resolve => {
					resolveOuter = resolve
				})
			})

			// Give the nested call's already-resolved promise a couple of microtask ticks to
			// settle and run its (guarded) cleanup.
			await Promise.resolve()
			await Promise.resolve()

			// The outer registration is still in place: the nested call's cleanup declined to
			// delete an entry it no longer owns.
			expect(inFlight.has("key")).toBe(true)

			resolveOuter?.(1)

			expect(await outerPromise).toBe(1)

			// Settling the current (outer) registration DOES clean up, since it is still its own.
			expect(inFlight.has("key")).toBe(false)
		})
	})

	describe("get / has", () => {
		it("has() and get() reflect whether a key currently has an in-flight entry", async () => {
			const inFlight = new InFlight<string, number>()

			expect(inFlight.has("key")).toBe(false)
			expect(inFlight.get("key")).toBeUndefined()

			let release: (() => void) | undefined
			const promise = inFlight.coalesce(
				"key",
				() =>
					new Promise<number>(resolve => {
						release = () => resolve(1)
					})
			)

			expect(inFlight.has("key")).toBe(true)
			expect(inFlight.get("key")).toBeInstanceOf(Promise)

			release?.()

			await promise

			expect(inFlight.has("key")).toBe(false)
		})
	})
})

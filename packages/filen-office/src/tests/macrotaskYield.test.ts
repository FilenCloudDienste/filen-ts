import { afterEach, describe, expect, it, vi } from "vitest"
import { macrotaskYield } from "../dom/docx/host"

// macrotaskYield shares one channel per realm: a started port is never collected, so a channel per caller would leak
// one pair per opened document. The channel is made on the first turn asked for with a MessageChannel present, so the
// counting stub below is the one this file's realm keeps.

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("macrotaskYield", () => {
	it("backs every caller with one channel and resolves turns in order", async () => {
		let made = 0

		class CountingChannel {
			readonly port1: { onmessage: ((event: unknown) => void) | null } = { onmessage: null }
			readonly port2 = {
				postMessage: (message: unknown): void => {
					setTimeout(() => this.port1.onmessage?.({ data: message }), 0)
				}
			}

			constructor() {
				made++
			}
		}

		vi.stubGlobal("MessageChannel", CountingChannel)

		const yields = [macrotaskYield(), macrotaskYield(), macrotaskYield()]
		const order: number[] = []

		await Promise.all(
			Array.from({ length: 30 }, (_, index) =>
				yields[index % yields.length]?.().then(() => {
					order.push(index)
				})
			)
		)

		for (let round = 0; round < 10; round++) for (const turn of yields) await turn()

		expect(made).toBe(1)
		expect(order).toEqual(Array.from({ length: 30 }, (_, index) => index))
	})

	it("falls back to the timer installed when the turn is taken", async () => {
		vi.stubGlobal("MessageChannel", undefined)

		const turn = macrotaskYield()

		vi.useFakeTimers()

		try {
			let done = false
			const waiting = turn().then(() => {
				done = true
			})

			expect(done).toBe(false)
			await vi.advanceTimersByTimeAsync(0)
			await waiting
			expect(done).toBe(true)
		} finally {
			vi.useRealTimers()
		}
	})
})

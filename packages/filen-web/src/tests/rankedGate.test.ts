import { afterEach, describe, expect, it, vi } from "vitest"
import { RankedGate } from "@/features/drive/lib/rankedGate"

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve()
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe("RankedGate", () => {
	it("hands a freed permit to the lowest rank, read when it frees", async () => {
		const gate = new RankedGate(1, 50)
		const started: string[] = []
		let laterRank = 5

		await gate.acquire(() => 0)
		void gate.acquire(() => 3).then(() => started.push("early"))
		void gate.acquire(() => laterRank).then(() => started.push("later"))
		laterRank = 1

		gate.release()
		await flushMicrotasks()

		expect(started).toEqual(["later"])
	})

	it("keeps arrival order between equal ranks", async () => {
		const gate = new RankedGate(1, 50)
		const started: string[] = []

		await gate.acquire(() => 0)
		void gate.acquire(() => 2).then(() => started.push("first"))
		void gate.acquire(() => 2).then(() => started.push("second"))

		gate.release()
		await flushMicrotasks()

		expect(started).toEqual(["first"])
	})

	it("lets a rank above 0 wait the hold before taking a free permit, unless a visible one claims it", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })

		const gate = new RankedGate(1, 50)
		const started: string[] = []

		void gate.acquire(() => 4).then(() => started.push("offscreen"))
		await flushMicrotasks()
		expect(started).toEqual([])

		void gate.acquire(() => 0).then(() => started.push("visible"))
		await flushMicrotasks()
		expect(started).toEqual(["visible"])

		gate.release()
		await flushMicrotasks()
		expect(started).toEqual(["visible", "offscreen"])
	})

	it("starts a lone offscreen waiter once the hold passes", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })

		const gate = new RankedGate(2, 50)
		const started: string[] = []

		void gate.acquire(() => 4).then(() => started.push("offscreen"))
		vi.advanceTimersByTime(49)
		await flushMicrotasks()
		expect(started).toEqual([])

		vi.advanceTimersByTime(1)
		await flushMicrotasks()
		expect(started).toEqual(["offscreen"])
	})
})

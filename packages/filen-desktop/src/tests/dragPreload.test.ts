import { describe, expect, it } from "vitest"
import { createDragStates } from "../preload/dragStates.ts"

const A = "0d3c6b1e-8f4a-4c2d-9b7e-5a1f3e2d4c6b"
const B = "1e4d7c2f-9a5b-4d3e-8c8f-6b2a4f3e5d7c"

describe("drag states in the preload", () => {
	it("replays the latest state per id to a late subscriber", () => {
		const states = createDragStates()

		states.push({ id: A, state: "staging", bytes: 1, total: 10 })
		states.push({ id: B, state: "ready" })
		states.push({ id: A, state: "staging", bytes: 5, total: 10 })

		expect(states.latest()).toEqual([
			{ id: A, state: "staging", bytes: 5, total: 10 },
			{ id: B, state: "ready" }
		])
	})

	it("drops an id after ended", () => {
		const states = createDragStates()

		states.push({ id: A, state: "ready" })
		states.push({ id: A, state: "ended", outcome: "dropped" })

		expect(states.latest()).toEqual([])
	})

	it("a released unbegun id is dropped once its ended arrives, and a late ended for an unknown id is not kept", () => {
		const states = createDragStates()

		states.push({ id: A, state: "staging", bytes: 0, total: 10 })
		// The page released A; main answers with its end.
		states.push({ id: A, state: "ended", outcome: "cancelled" })
		states.push({ id: B, state: "ended", outcome: "cancelled" })

		expect(states.latest()).toEqual([])
	})

	it("clear forgets every id", () => {
		const states = createDragStates()

		states.push({ id: A, state: "ready" })
		states.clear()

		expect(states.latest()).toEqual([])
	})
})

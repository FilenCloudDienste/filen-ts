import { describe, expect, it } from "vitest"
import { COALESCE_MS, HISTORY_LIMIT, createHistory } from "@/lib/editHistory"

// Any immutable recipe works: here a trim range, as a video editor holds one.
interface Trim {
	readonly start: number
	readonly end: number
}

const trim = (start: number, end: number): Trim => ({ start, end })

describe("createHistory (generic)", () => {
	it("undoes and redoes over a recipe type of the caller's own", () => {
		const initial = trim(0, 10)
		const history = createHistory<Trim>(initial)
		const shorter = trim(1, 10)

		history.push(shorter)

		expect(history.current).toBe(shorter)
		expect(history.undo()).toBe(initial)
		expect(history.redo()).toBe(shorter)
	})

	it("coalesces a drag under one key and splits it after seal()", () => {
		let time = 0
		const history = createHistory(trim(0, 10), () => time)

		history.push(trim(1, 10), "start")
		time += COALESCE_MS - 1
		history.push(trim(2, 10), "start")
		history.seal()
		history.push(trim(3, 10), "start")

		expect(history.current).toEqual(trim(3, 10))
		expect(history.undo()).toEqual(trim(2, 10))
		expect(history.undo()).toEqual(trim(0, 10))
		expect(history.canUndo).toBe(false)
	})

	it("keeps at most HISTORY_LIMIT entries", () => {
		const history = createHistory(0)

		for (let step = 1; step <= HISTORY_LIMIT + 5; step++) {
			history.push(step)
		}

		let undos = 0

		while (history.canUndo) {
			history.undo()
			undos++
		}

		expect(undos).toBe(HISTORY_LIMIT - 1)
		expect(history.current).toBe(6)
	})
})

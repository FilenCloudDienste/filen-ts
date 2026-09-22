import { describe, expect, it } from "vitest"
import { moveArrayItem } from "@/features/audio/lib/playlistOps"

describe("moveArrayItem", () => {
	it("moves an element forward", () => {
		expect(moveArrayItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"])
	})

	it("moves an element backward", () => {
		expect(moveArrayItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"])
	})

	it("returns an unchanged copy when from equals to", () => {
		const input = ["a", "b"]
		const result = moveArrayItem(input, 1, 1)

		expect(result).toEqual(input)
		expect(result).not.toBe(input)
	})

	it("returns an unchanged copy for an out-of-range index", () => {
		expect(moveArrayItem(["a", "b"], 0, 5)).toEqual(["a", "b"])
	})
})

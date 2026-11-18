import { describe, expect, it } from "vitest"
import { handleArguments, moveItems } from "@filen/shared/assistant"

describe("handleArguments", () => {
	it("reads a string and the strings of an array under the grounded handle keys", () => {
		expect(handleArguments(moveItems, { handles: ["f1", "f2"], destination: "d1" })).toEqual(["f1", "f2", "d1"])
	})

	it("drops values that are not strings, and keys that are not handle keys", () => {
		expect(handleArguments(moveItems, { handles: ["f1", 2, null, { handle: "f3" }], destination: 7, name: "f4" })).toEqual(["f1"])
	})
})

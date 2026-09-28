import { describe, expect, it } from "vitest"
import { blockingQueryError } from "@/queries/blockingError"

const failure = new Error("offline")

describe("blockingQueryError", () => {
	it("blocks on a failed first load, which has nothing to show", () => {
		expect(blockingQueryError({ status: "error", error: failure, data: undefined })).toBe(failure)
	})

	it("never blocks a failed background refresh over loaded data", () => {
		expect(blockingQueryError({ status: "error", error: failure, data: [] })).toBeNull()
	})

	it("is null while loading or loaded", () => {
		expect(blockingQueryError({ status: "pending", error: null, data: undefined })).toBeNull()
		expect(blockingQueryError({ status: "success", error: null, data: [] })).toBeNull()
	})
})

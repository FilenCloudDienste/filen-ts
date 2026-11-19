import { describe, expect, it } from "vitest"
import { isUuidStr } from "@/lib/uuidStr"

describe("isUuidStr", () => {
	it("accepts a full uuid in either case", () => {
		expect(isUuidStr("3f2b8c1e-9d4a-4b6f-8e2a-1c5d7e9f0a3b")).toBe(true)
		expect(isUuidStr("3F2B8C1E-9D4A-4B6F-8E2A-1C5D7E9F0A3B")).toBe(true)
	})

	it("rejects strings that only have enough dashes", () => {
		expect(isUuidStr("a-b-c-d")).toBe(false)
		expect(isUuidStr("a-b-c-d-e")).toBe(false)
		expect(isUuidStr("")).toBe(false)
	})
})

import { describe, it, expect } from "vitest"
import { validateUuid } from "@/lib/uuid"

describe("validateUuid", () => {
	it("accepts a standard v4 UUID", () => {
		expect(validateUuid("a0d3b6e1-2f4c-4a6b-8c2d-1e2f3a4b5c6d")).toBe(true)
	})

	it("is case-insensitive", () => {
		expect(validateUuid("A0D3B6E1-2F4C-4A6B-8C2D-1E2F3A4B5C6D")).toBe(true)
	})

	it("accepts other UUID versions (1-8)", () => {
		expect(validateUuid("a0d3b6e1-2f4c-1a6b-8c2d-1e2f3a4b5c6d")).toBe(true)
		expect(validateUuid("a0d3b6e1-2f4c-7a6b-9c2d-1e2f3a4b5c6d")).toBe(true)
		expect(validateUuid("a0d3b6e1-2f4c-8a6b-bc2d-1e2f3a4b5c6d")).toBe(true)
	})

	it("accepts the nil and max UUIDs (any case)", () => {
		expect(validateUuid("00000000-0000-0000-0000-000000000000")).toBe(true)
		expect(validateUuid("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(true)
		expect(validateUuid("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF")).toBe(true)
	})

	it("rejects an invalid version nibble (0 or 9)", () => {
		expect(validateUuid("a0d3b6e1-2f4c-0a6b-8c2d-1e2f3a4b5c6d")).toBe(false)
		expect(validateUuid("a0d3b6e1-2f4c-9a6b-8c2d-1e2f3a4b5c6d")).toBe(false)
	})

	it("rejects an invalid variant nibble (not 8-b)", () => {
		expect(validateUuid("a0d3b6e1-2f4c-4a6b-7c2d-1e2f3a4b5c6d")).toBe(false)
		expect(validateUuid("a0d3b6e1-2f4c-4a6b-cc2d-1e2f3a4b5c6d")).toBe(false)
	})

	it("rejects malformed strings", () => {
		expect(validateUuid("not-a-uuid")).toBe(false)
		expect(validateUuid("")).toBe(false)
		expect(validateUuid("a0d3b6e1-2f4c-4a6b-8c2d-1e2f3a4b5c6")).toBe(false)
		expect(validateUuid("a0d3b6e1-2f4c-4a6b-8c2d-1e2f3a4b5c6dd")).toBe(false)
		expect(validateUuid("g0d3b6e1-2f4c-4a6b-8c2d-1e2f3a4b5c6d")).toBe(false)
	})
})

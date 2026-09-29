import { describe, expect, it } from "vitest"
import { DELETE_ALL_VERSIONS_PHRASE, DELETE_ALL_ITEMS_PHRASE } from "@/features/settings/lib/dangerPhrases"

// The typed-confirm gate is an exact match, so the two bulk-delete cards' phrases must be distinct or
// typing one card's phrase would arm the other's dialog if both were ever composed onto one screen.
describe("destructive bulk-delete typed-confirm phrases", () => {
	it("the two phrases are non-empty and mutually distinct", () => {
		expect(DELETE_ALL_VERSIONS_PHRASE.length).toBeGreaterThan(0)
		expect(DELETE_ALL_ITEMS_PHRASE.length).toBeGreaterThan(0)
		expect(DELETE_ALL_VERSIONS_PHRASE).not.toBe(DELETE_ALL_ITEMS_PHRASE)
	})
})

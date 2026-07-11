import { describe, expect, it } from "vitest"
import { isArmed } from "@/components/dialogs/typedConfirmDialog.logic"
import { DELETE_ALL_VERSIONS_PHRASE, DELETE_ALL_ITEMS_PHRASE } from "@/features/settings/lib/dangerPhrases"

// The actual arm/disarm behavior (exact-match only, no trim/case-fold) is already proven once against
// the shared primitive in typedConfirmDialog.test.ts — this file only proves the two bulk-delete
// cards' OWN phrase constants behave correctly under that gate and can never collide with each other
// or with drive's own "EMPTY TRASH" phrase, which would let a copy-pasted dialog accidentally arm the
// wrong destructive op if the two cards were ever composed onto the same screen.
describe("D2 destructive bulk-delete typed-confirm phrases", () => {
	it("DELETE_ALL_VERSIONS_PHRASE only arms on an exact match", () => {
		expect(isArmed("delete versions", DELETE_ALL_VERSIONS_PHRASE)).toBe(false)
		expect(isArmed(`${DELETE_ALL_VERSIONS_PHRASE} `, DELETE_ALL_VERSIONS_PHRASE)).toBe(false)
		expect(isArmed(DELETE_ALL_VERSIONS_PHRASE, DELETE_ALL_VERSIONS_PHRASE)).toBe(true)
	})

	it("DELETE_ALL_ITEMS_PHRASE only arms on an exact match", () => {
		expect(isArmed("delete everything", DELETE_ALL_ITEMS_PHRASE)).toBe(false)
		expect(isArmed(DELETE_ALL_ITEMS_PHRASE, DELETE_ALL_ITEMS_PHRASE)).toBe(true)
	})

	it("the two phrases are non-empty and mutually distinct", () => {
		expect(DELETE_ALL_VERSIONS_PHRASE.length).toBeGreaterThan(0)
		expect(DELETE_ALL_ITEMS_PHRASE.length).toBeGreaterThan(0)
		expect(DELETE_ALL_VERSIONS_PHRASE).not.toBe(DELETE_ALL_ITEMS_PHRASE)
	})

	it("typing one card's phrase never arms the other card's dialog", () => {
		expect(isArmed(DELETE_ALL_VERSIONS_PHRASE, DELETE_ALL_ITEMS_PHRASE)).toBe(false)
		expect(isArmed(DELETE_ALL_ITEMS_PHRASE, DELETE_ALL_VERSIONS_PHRASE)).toBe(false)
	})
})

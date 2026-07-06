import { describe, expect, it } from "vitest"
import { isArmed, shouldResetOnOpen } from "@/components/dialogs/typed-confirm-dialog.logic"

describe("isArmed (typed-confirm-dialog match logic)", () => {
	it("arms on an exact match", () => {
		expect(isArmed("delete-me", "delete-me")).toBe(true)
	})

	it("stays disarmed on a partial match", () => {
		expect(isArmed("delete-m", "delete-me")).toBe(false)
	})

	it("stays disarmed on a case-different match (exact match only, never case-folded)", () => {
		expect(isArmed("Delete-Me", "delete-me")).toBe(false)
	})

	it("stays disarmed on extra surrounding whitespace (exact match only, never trimmed)", () => {
		expect(isArmed(" delete-me", "delete-me")).toBe(false)
	})

	it("stays disarmed on an empty typed value", () => {
		expect(isArmed("", "delete-me")).toBe(false)
	})
})

describe("shouldResetOnOpen (typed-confirm-dialog reopen logic)", () => {
	it("resets on the closed-to-open transition", () => {
		expect(shouldResetOnOpen(true, false)).toBe(true)
	})

	it("does not reset while already open", () => {
		expect(shouldResetOnOpen(true, true)).toBe(false)
	})

	it("does not reset on the open-to-closed transition", () => {
		expect(shouldResetOnOpen(false, true)).toBe(false)
	})

	it("does not reset while already closed", () => {
		expect(shouldResetOnOpen(false, false)).toBe(false)
	})
})

describe("TypedConfirmDialog arm/disarm integration", () => {
	it("clear-on-reopen: a value armed before close is disarmed again after reopening", () => {
		const matchValue = "delete-me"
		let typed = "delete-me"
		expect(isArmed(typed, matchValue)).toBe(true)

		// Dialog closes, then reopens — the component clears `typed` exactly when this is true.
		if (shouldResetOnOpen(true, false)) {
			typed = ""
		}

		expect(isArmed(typed, matchValue)).toBe(false)
	})
})

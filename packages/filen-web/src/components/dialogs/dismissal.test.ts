import { describe, expect, it } from "vitest"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"

describe("shouldForwardOpenChange (pending dismissal gate)", () => {
	it("blocks a dismissal while the operation is pending", () => {
		expect(shouldForwardOpenChange(false, true)).toBe(false)
	})

	it("forwards a dismissal once the operation has settled", () => {
		expect(shouldForwardOpenChange(false, false)).toBe(true)
	})

	it("never blocks an opening change", () => {
		expect(shouldForwardOpenChange(true, true)).toBe(true)
		expect(shouldForwardOpenChange(true, false)).toBe(true)
	})
})

describe("dismissal gate integration (the primitives' handleOpenChange wiring)", () => {
	// Mirrors the exact handler shape all three primitives use: a blocked change cancels the Base UI
	// event (so its internal store keeps the dialog open too) and never reaches the caller's
	// onOpenChange.
	function makeHarness(initialPending: boolean) {
		const state = { open: true, pending: initialPending, canceled: false }
		const handleOpenChange = (next: boolean): void => {
			if (!shouldForwardOpenChange(next, state.pending)) {
				state.canceled = true // stands in for details.cancel()
				return
			}
			state.open = next // stands in for the caller's onOpenChange
		}
		return { state, handleOpenChange }
	}

	it("a dismiss attempt during pending leaves the dialog open and cancels the Base UI event", () => {
		const h = makeHarness(true)

		h.handleOpenChange(false) // Escape / X button / outside-press while onConfirm runs

		expect(h.state.open).toBe(true)
		expect(h.state.canceled).toBe(true)
	})

	it("after settling, the same dismissal closes normally", () => {
		const h = makeHarness(true)
		h.handleOpenChange(false)
		expect(h.state.open).toBe(true)

		h.state.pending = false // operation settles
		h.handleOpenChange(false)

		expect(h.state.open).toBe(false)
	})
})

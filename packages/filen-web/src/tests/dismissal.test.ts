import { describe, expect, it, vi } from "vitest"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"

function run(next: boolean, pending: boolean) {
	const onChange = vi.fn()
	const cancel = vi.fn()

	pendingGuardedOpenChange(pending, onChange)(next, { cancel })

	return { onChange, cancel }
}

describe("pendingGuardedOpenChange (pending dismissal gate)", () => {
	it("blocks a dismissal while pending and cancels the Base UI event", () => {
		const { onChange, cancel } = run(false, true)

		expect(onChange).not.toHaveBeenCalled()
		expect(cancel).toHaveBeenCalledOnce()
	})

	it("forwards a dismissal once the operation has settled", () => {
		const { onChange, cancel } = run(false, false)

		expect(onChange).toHaveBeenCalledWith(false)
		expect(cancel).not.toHaveBeenCalled()
	})

	it("never blocks an opening change", () => {
		for (const pending of [true, false]) {
			const { onChange, cancel } = run(true, pending)

			expect(onChange).toHaveBeenCalledWith(true)
			expect(cancel).not.toHaveBeenCalled()
		}
	})
})

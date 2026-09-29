import { describe, expect, it, vi } from "vitest"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { settleTransferFailure } from "@/features/transfers/lib/settle"

function fakeStore() {
	return { settle: vi.fn(), remove: vi.fn() }
}

describe("settleTransferFailure", () => {
	it("settles a Cancelled rejection as cancelled and drops the row", () => {
		const store = fakeStore()
		const dto: ErrorDTO = { species: "sdk", kind: "Cancelled", label: "Cancelled", message: "cancelled" }

		expect(settleTransferFailure(store, "t1", dto)).toBe(true)
		expect(store.settle).toHaveBeenCalledWith("t1", "cancelled")
		expect(store.remove).toHaveBeenCalledWith("t1")
	})

	it("settles any other rejection as an error and keeps the row", () => {
		const store = fakeStore()
		const dto: ErrorDTO = { species: "sdk", kind: "Server", label: "Server", message: "boom" }

		expect(settleTransferFailure(store, "t1", dto)).toBe(false)
		expect(store.settle).toHaveBeenCalledWith("t1", "error", dto)
		expect(store.remove).not.toHaveBeenCalled()
	})
})

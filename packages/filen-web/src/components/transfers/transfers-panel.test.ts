import { describe, expect, it } from "vitest"
import { type Transfer } from "@/stores/transfers"
import { sortTransfersByStartedAt, hasFinishedTransfers } from "@/components/transfers/transfers-panel.logic"

function transfer(overrides: Partial<Transfer> = {}): Transfer {
	return {
		id: "t1",
		direction: "upload",
		name: "file.txt",
		size: 100,
		bytesTransferred: 0,
		status: "uploading",
		parentUuid: null,
		startedAt: 0,
		...overrides
	}
}

describe("sortTransfersByStartedAt", () => {
	it("orders newest (largest startedAt) first", () => {
		const oldest = transfer({ id: "a", startedAt: 1 })
		const middle = transfer({ id: "b", startedAt: 2 })
		const newest = transfer({ id: "c", startedAt: 3 })

		expect(sortTransfersByStartedAt([oldest, newest, middle]).map(t => t.id)).toEqual(["c", "b", "a"])
	})

	it("does not mutate the input array", () => {
		const input = [transfer({ id: "a", startedAt: 1 }), transfer({ id: "b", startedAt: 2 })]
		const original = [...input]

		sortTransfersByStartedAt(input)

		expect(input).toEqual(original)
	})

	it("returns an empty array unchanged", () => {
		expect(sortTransfersByStartedAt([])).toEqual([])
	})
})

describe("hasFinishedTransfers", () => {
	it("false when every row is still uploading", () => {
		expect(hasFinishedTransfers([transfer({ status: "uploading" }), transfer({ status: "uploading" })])).toBe(false)
	})

	it("false for an empty list", () => {
		expect(hasFinishedTransfers([])).toBe(false)
	})

	it("true when at least one row is done", () => {
		expect(hasFinishedTransfers([transfer({ status: "uploading" }), transfer({ status: "done" })])).toBe(true)
	})

	it("true when at least one row is error", () => {
		expect(hasFinishedTransfers([transfer({ status: "error" })])).toBe(true)
	})
})

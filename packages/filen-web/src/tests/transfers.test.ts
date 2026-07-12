import { describe, expect, it, vi } from "vitest"
import { type Transfer } from "@/features/transfers/store/useTransfersStore"
import {
	buildTransfersDisplayList,
	cancellableTransferIds,
	confirmCancelAllTransfers,
	hasFinishedTransfers,
	pausableTransferIds,
	resumableTransferIds,
	shouldShowTransfersAggregate
} from "@/features/transfers/screens/transfers.logic"

function transfer(overrides: Partial<Transfer> = {}): Transfer {
	return {
		id: "t1",
		direction: "upload",
		name: "file.txt",
		size: 100,
		bytesTransferred: 0,
		status: "uploading",
		paused: false,
		parentUuid: null,
		startedAt: 0,
		...overrides
	}
}

describe("buildTransfersDisplayList", () => {
	it("active section: oldest startedAt first", () => {
		const newest = transfer({ id: "a", status: "uploading", startedAt: 3 })
		const oldest = transfer({ id: "b", status: "downloading", startedAt: 1 })
		const middle = transfer({ id: "c", status: "uploading", startedAt: 2 })

		const list = buildTransfersDisplayList([newest, oldest, middle])

		expect(list.active.map(t => t.id)).toEqual(["b", "c", "a"])
	})

	it("finished section: newest startedAt first", () => {
		const oldest = transfer({ id: "a", status: "done", startedAt: 1 })
		const newest = transfer({ id: "b", status: "error", startedAt: 3 })
		const middle = transfer({ id: "c", status: "done", startedAt: 2 })

		const list = buildTransfersDisplayList([oldest, newest, middle])

		expect(list.finished.map(t => t.id)).toEqual(["b", "c", "a"])
	})

	it("splits active from finished regardless of direction", () => {
		const list = buildTransfersDisplayList([
			transfer({ id: "a", direction: "upload", status: "uploading" }),
			transfer({ id: "b", direction: "download", status: "downloading" }),
			transfer({ id: "c", direction: "upload", status: "done" }),
			transfer({ id: "d", direction: "download", status: "error" })
		])

		expect(list.active.map(t => t.id).sort()).toEqual(["a", "b"])
		expect(list.finished.map(t => t.id).sort()).toEqual(["c", "d"])
	})

	it("returns empty sections for an empty list", () => {
		expect(buildTransfersDisplayList([])).toEqual({ active: [], finished: [] })
	})

	it("does not mutate the input array", () => {
		const input = [transfer({ id: "a", startedAt: 2 }), transfer({ id: "b", startedAt: 1 })]
		const original = [...input]

		buildTransfersDisplayList(input)

		expect(input).toEqual(original)
	})
})

describe("cancellableTransferIds", () => {
	it("returns every active transfer id, including paused ones", () => {
		const ids = cancellableTransferIds([
			transfer({ id: "a", status: "uploading", paused: false }),
			transfer({ id: "b", status: "downloading", paused: true }),
			transfer({ id: "c", status: "done" })
		])

		expect(ids.sort()).toEqual(["a", "b"])
	})

	it("empty when nothing is active", () => {
		expect(cancellableTransferIds([transfer({ status: "done" }), transfer({ status: "error" })])).toEqual([])
	})

	it("empty for an empty list", () => {
		expect(cancellableTransferIds([])).toEqual([])
	})
})

describe("pausableTransferIds", () => {
	it("returns active, unpaused transfer ids only", () => {
		const ids = pausableTransferIds([
			transfer({ id: "a", status: "uploading", paused: false }),
			transfer({ id: "b", status: "downloading", paused: true }),
			transfer({ id: "c", status: "done", paused: false })
		])

		expect(ids).toEqual(["a"])
	})

	it("empty when every active transfer is already paused", () => {
		expect(pausableTransferIds([transfer({ status: "uploading", paused: true })])).toEqual([])
	})

	it("empty when nothing is active", () => {
		expect(pausableTransferIds([transfer({ status: "done", paused: false })])).toEqual([])
	})
})

describe("resumableTransferIds", () => {
	it("returns active, paused transfer ids only", () => {
		const ids = resumableTransferIds([
			transfer({ id: "a", status: "uploading", paused: true }),
			transfer({ id: "b", status: "downloading", paused: false }),
			transfer({ id: "c", status: "error", paused: true })
		])

		expect(ids).toEqual(["a"])
	})

	it("empty when nothing is paused", () => {
		expect(resumableTransferIds([transfer({ status: "uploading", paused: false })])).toEqual([])
	})

	it("empty when nothing is active", () => {
		expect(resumableTransferIds([transfer({ status: "done", paused: true })])).toEqual([])
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

	it("false when a row is downloading (active, not finished)", () => {
		expect(hasFinishedTransfers([transfer({ direction: "download", status: "downloading" })])).toBe(false)
	})

	it("true when a download row is done", () => {
		expect(hasFinishedTransfers([transfer({ direction: "download", status: "done" })])).toBe(true)
	})
})

// M5 — the header Cancel-all confirm's actual action, once the AlertDialog gating it has been
// confirmed. The gate itself (nothing cancels until the dialog's onConfirm fires) is UI wiring
// exercised via e2e/manual QA, not this pure DI'd action — see transfers.spec.ts.
describe("confirmCancelAllTransfers", () => {
	it("cancels every active transfer, paused or not, and nothing else", () => {
		const cancel = vi.fn<(id: string) => void>()
		const transfers = [
			transfer({ id: "a", status: "uploading", paused: false }),
			transfer({ id: "b", status: "downloading", paused: true }),
			transfer({ id: "c", status: "done" }),
			transfer({ id: "d", status: "error" })
		]

		confirmCancelAllTransfers(transfers, cancel)

		expect(cancel).toHaveBeenCalledTimes(2)
		expect(cancel.mock.calls.map(call => call[0]).sort()).toEqual(["a", "b"])
	})

	it("calls the injected cancel fn zero times when nothing is active", () => {
		const cancel = vi.fn<(id: string) => void>()

		confirmCancelAllTransfers([transfer({ status: "done" }), transfer({ status: "error" })], cancel)

		expect(cancel).not.toHaveBeenCalled()
	})

	it("is a no-op for an empty list", () => {
		const cancel = vi.fn<(id: string) => void>()

		confirmCancelAllTransfers([], cancel)

		expect(cancel).not.toHaveBeenCalled()
	})
})

describe("shouldShowTransfersAggregate", () => {
	it("false when nothing is active", () => {
		expect(shouldShowTransfersAggregate(0)).toBe(false)
	})

	it("true once at least one transfer is active", () => {
		expect(shouldShowTransfersAggregate(1)).toBe(true)
		expect(shouldShowTransfersAggregate(5)).toBe(true)
	})
})

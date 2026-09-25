import { describe, expect, it, vi } from "vitest"
import { type Transfer } from "@/features/transfers/store/useTransfersStore"
import { createCopyJob } from "@/features/drive/lib/copy.logic"
import {
	buildTransfersDisplayList,
	cancellableTransferIds,
	confirmCancelAllTransfers,
	endedCopyIds,
	hasFinishedTransfers,
	pausableTransferIds,
	resumableTransferIds,
	shouldShowTransfersAggregate
} from "@/features/transfers/screens/transfers.logic"

const NONE: ReadonlySet<string> = new Set()

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
		const ids = cancellableTransferIds(
			[
				transfer({ id: "a", status: "uploading", paused: false }),
				transfer({ id: "b", status: "downloading", paused: true }),
				transfer({ id: "c", status: "done" })
			],
			NONE
		)

		expect(ids.sort()).toEqual(["a", "b"])
	})

	it("empty when nothing is active", () => {
		expect(cancellableTransferIds([transfer({ status: "done" }), transfer({ status: "error" })], NONE)).toEqual([])
	})

	it("empty for an empty list", () => {
		expect(cancellableTransferIds([], NONE)).toEqual([])
	})
})

describe("pausableTransferIds", () => {
	it("returns active, unpaused transfer ids only", () => {
		const ids = pausableTransferIds(
			[
				transfer({ id: "a", status: "uploading", paused: false }),
				transfer({ id: "b", status: "downloading", paused: true }),
				transfer({ id: "c", status: "done", paused: false })
			],
			NONE
		)

		expect(ids).toEqual(["a"])
	})

	it("empty when every active transfer is already paused", () => {
		expect(pausableTransferIds([transfer({ status: "uploading", paused: true })], NONE)).toEqual([])
	})

	it("empty when nothing is active", () => {
		expect(pausableTransferIds([transfer({ status: "done", paused: false })], NONE)).toEqual([])
	})
})

describe("resumableTransferIds", () => {
	it("returns active, paused transfer ids only", () => {
		const ids = resumableTransferIds(
			[
				transfer({ id: "a", status: "uploading", paused: true }),
				transfer({ id: "b", status: "downloading", paused: false }),
				transfer({ id: "c", status: "error", paused: true })
			],
			NONE
		)

		expect(ids).toEqual(["a"])
	})

	it("empty when nothing is paused", () => {
		expect(resumableTransferIds([transfer({ status: "uploading", paused: false })], NONE)).toEqual([])
	})

	it("empty when nothing is active", () => {
		expect(resumableTransferIds([transfer({ status: "done", paused: true })], NONE)).toEqual([])
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

// The header Cancel-all confirm's actual action, once the AlertDialog gating it has been
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

		confirmCancelAllTransfers(transfers, NONE, cancel)

		expect(cancel).toHaveBeenCalledTimes(2)
		expect(cancel.mock.calls.map(call => call[0]).sort()).toEqual(["a", "b"])
	})

	it("calls the injected cancel fn zero times when nothing is active", () => {
		const cancel = vi.fn<(id: string) => void>()

		confirmCancelAllTransfers([transfer({ status: "done" }), transfer({ status: "error" })], NONE, cancel)

		expect(cancel).not.toHaveBeenCalled()
	})

	it("is a no-op for an empty list", () => {
		const cancel = vi.fn<(id: string) => void>()

		confirmCancelAllTransfers([], NONE, cancel)

		expect(cancel).not.toHaveBeenCalled()
	})
})

// Its row stays active while the copies it made move to the trash, which can be neither paused nor
// stopped.
describe("a copy whose job has ended", () => {
	const destination = { uuid: null, name: "Cloud Drive" }

	it("is named by endedCopyIds, a running one is not", () => {
		const ended = endedCopyIds({
			running: createCopyJob("running", destination, 1),
			stopped: { ...createCopyJob("stopped", destination, 1), outcome: { status: "cancelled" }, cancelRequest: "trash" },
			finished: { ...createCopyJob("finished", destination, 1), outcome: { status: "done" } }
		})

		expect([...ended].sort()).toEqual(["finished", "stopped"])
	})

	it("is left out of Cancel all, Pause all and Resume all, paused or not", () => {
		const ended = new Set(["copy", "pausedCopy"])
		const transfers = [
			transfer({ id: "upload", status: "uploading" }),
			transfer({ id: "pausedUpload", status: "uploading", paused: true }),
			transfer({ id: "copy", direction: "copy", status: "copying" }),
			transfer({ id: "pausedCopy", direction: "copy", status: "copying", paused: true })
		]
		const cancel = vi.fn<(id: string) => void>()

		expect(cancellableTransferIds(transfers, ended)).toEqual(["upload", "pausedUpload"])
		expect(pausableTransferIds(transfers, ended)).toEqual(["upload"])
		expect(resumableTransferIds(transfers, ended)).toEqual(["pausedUpload"])

		confirmCancelAllTransfers(transfers, ended, cancel)

		expect(cancel.mock.calls).toEqual([["upload"], ["pausedUpload"]])
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

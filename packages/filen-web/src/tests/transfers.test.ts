import { describe, expect, it } from "vitest"
import { type Transfer } from "@/features/transfers/store/useTransfersStore"
import { createCopyJob } from "@/features/drive/lib/copy.logic"
import type { ExternalTransferRow } from "@/features/transfers/lib/externalTransfers.logic"
import {
	cancelAllLeavesBrowserPartial,
	leavesBrowserPartial,
	buildTransfersDisplayList,
	cancellableTransferIds,
	isExternalRow,
	type TransfersDisplayList,
	endedJobIds,
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
	function ids(list: TransfersDisplayList): string[] {
		return list.rows.map(row => row.id)
	}

	it("orders by state, each state in start order, and splits active from finished", () => {
		const list = buildTransfersDisplayList(
			[
				transfer({ id: "done", status: "done" }),
				transfer({ id: "a", status: "uploading" }),
				transfer({ id: "paused", status: "downloading", paused: true }),
				transfer({ id: "partly", status: "completedWithErrors" }),
				transfer({ id: "slot", status: "downloading", waitingForSlot: true }),
				transfer({ id: "job", status: "compressing" }),
				transfer({ id: "b", status: "copying" }),
				transfer({ id: "failed", status: "error" })
			],
			[],
			new Set(["job"])
		)

		expect(ids(list)).toEqual(["a", "b", "slot", "job", "paused", "partly", "failed", "done"])
		expect(list.activeEnd).toBe(5)
	})

	it("lists the desktop app's rows with the page's rows of the same state, after them", () => {
		const moving: ExternalTransferRow = {
			kind: "transfer",
			id: "sync:p:upload:a.txt",
			path: "a.txt",
			direction: "upload",
			bytes: 1,
			total: 2,
			speed: null,
			source: { kind: "sync", pairId: "p", name: "Pair" }
		}
		const queued: ExternalTransferRow = { kind: "queued", id: "mounts:queued", count: 2, source: { kind: "mounts", role: "drive" } }
		const list = buildTransfersDisplayList(
			[
				transfer({ id: "slot", status: "downloading", waitingForSlot: true }),
				transfer({ id: "a", status: "uploading" }),
				transfer({ id: "done", status: "done" })
			],
			[queued, moving],
			NONE
		)

		expect(ids(list)).toEqual(["a", moving.id, "slot", queued.id, "done"])
		expect(list.activeEnd).toBe(4)
		expect(list.rows.map(isExternalRow)).toEqual([false, true, false, true, false])
	})

	it("keeps the order across a progress tick, and moves only a row whose state changed", () => {
		const rows = [transfer({ id: "a" }), transfer({ id: "b" }), transfer({ id: "c" })]
		const before = ids(buildTransfersDisplayList(rows, [], NONE))
		const ticked = rows.map(row => (row.id === "a" ? { ...row, bytesTransferred: 50 } : row))

		expect(ids(buildTransfersDisplayList(ticked, [], NONE))).toEqual(before)

		const paused = rows.map(row => (row.id === "a" ? { ...row, paused: true } : row))

		expect(ids(buildTransfersDisplayList(paused, [], NONE))).toEqual(["b", "c", "a"])
	})

	it("returns no rows for an empty list", () => {
		expect(buildTransfersDisplayList([], [], NONE)).toMatchObject({ rows: [], activeEnd: 0 })
	})

	it("does not mutate the input array", () => {
		const input = [transfer({ id: "a", status: "done" }), transfer({ id: "b" })]
		const original = [...input]

		buildTransfersDisplayList(input, [], NONE)

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

// Its row stays active while what it made moves to the trash, which can be neither paused nor stopped.
describe("a drive job that has ended", () => {
	const destination = { uuid: null, name: "Cloud Drive" }

	it("is named by endedJobIds, a running one is not", () => {
		const ended = endedJobIds({
			running: createCopyJob("running", destination, 1),
			stopped: { ...createCopyJob("stopped", destination, 1), outcome: { status: "cancelled" }, cancelRequest: "trash" },
			finished: { ...createCopyJob("finished", destination, 1), outcome: { status: "done" } }
		})

		expect([...ended].sort()).toEqual(["finished", "stopped"])
	})

	it("is left out of Cancel all, Pause all and Resume all, paused or not", () => {
		const ended = new Set(["copy", "pausedCopy", "extract"])
		const transfers = [
			transfer({ id: "upload", status: "uploading" }),
			transfer({ id: "pausedUpload", status: "uploading", paused: true }),
			transfer({ id: "copy", direction: "copy", status: "copying" }),
			transfer({ id: "pausedCopy", direction: "copy", status: "copying", paused: true }),
			transfer({ id: "extract", direction: "extract", status: "extracting" })
		]

		expect(cancellableTransferIds(transfers, ended)).toEqual(["upload", "pausedUpload"])
		expect(pausableTransferIds(transfers, ended)).toEqual(["upload"])
		expect(resumableTransferIds(transfers, ended)).toEqual(["pausedUpload"])
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

describe("leavesBrowserPartial", () => {
	it("is a browser-saved download that already holds bytes", () => {
		expect(leavesBrowserPartial(transfer({ status: "downloading", browserManaged: true, bytesTransferred: 1 }))).toBe(true)
		expect(leavesBrowserPartial(transfer({ status: "downloading", browserManaged: true, bytesTransferred: 0 }))).toBe(false)
		expect(leavesBrowserPartial(transfer({ status: "downloading", bytesTransferred: 1 }))).toBe(false)
	})

	it("counts toward Cancel all only while the download can still be cancelled", () => {
		const saving = transfer({ id: "a", status: "downloading", browserManaged: true, bytesTransferred: 1 })
		const failed = transfer({ id: "b", status: "error", browserManaged: true, bytesTransferred: 1 })

		expect(cancelAllLeavesBrowserPartial([saving], new Set())).toBe(true)
		expect(cancelAllLeavesBrowserPartial([failed], new Set())).toBe(false)
	})
})

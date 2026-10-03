import { describe, expect, it } from "vitest"
import {
	EMPTY_CAPPED_LIST,
	REPORT_LIST_CAP,
	addItemCounts,
	appendCapped,
	cappedList,
	cappedTotal,
	holdsArchiveSlot,
	isJobRunning,
	isWaitingForArchiveSlot,
	jobNumber,
	jobNumberOrNull,
	jobRate,
	jobRunFlags,
	mapCapped,
	pausedJobBlocksSlot,
	summarizeDispositions,
	toDisposition,
	type ArchiveSlotJob,
	type CopyJobCounts,
	type JobDisposition
} from "@filen/shared"

describe("jobRunFlags", () => {
	it("maps each run state onto one flag", () => {
		expect(jobRunFlags("running")).toEqual({ pausing: false, paused: false, cancelling: false })
		expect(jobRunFlags("pausing")).toEqual({ pausing: true, paused: false, cancelling: false })
		expect(jobRunFlags("paused")).toEqual({ pausing: false, paused: true, cancelling: false })
		expect(jobRunFlags("cancelling")).toEqual({ pausing: false, paused: false, cancelling: true })
	})

	it("hands out one object per state", () => {
		expect(jobRunFlags("paused")).toBe(jobRunFlags("paused"))
	})
})

describe("jobNumber", () => {
	it("is exact below 2^53", () => {
		expect(jobNumber(0n)).toBe(0)
		expect(jobNumber(123_456_789n)).toBe(123_456_789)
		expect(jobNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
	})

	it("holds larger figures at the safe edge", () => {
		expect(jobNumber(2n ** 64n)).toBe(Number.MAX_SAFE_INTEGER)
		expect(jobNumber(-(2n ** 64n))).toBe(-Number.MAX_SAFE_INTEGER)
	})

	it("reads undefined as null", () => {
		expect(jobNumberOrNull(undefined)).toBeNull()
		expect(jobNumberOrNull(5n)).toBe(5)
	})
})

describe("addItemCounts", () => {
	it("adds every field", () => {
		const one: CopyJobCounts = {
			dirsCreated: 1,
			dirsFailed: 2,
			filesDone: 3,
			filesFailed: 4,
			bytesDone: 5,
			bytesFailed: 6,
			dirsNotAttempted: 7,
			filesNotAttempted: 8,
			bytesNotAttempted: 9,
			entriesSkipped: 10,
			bytesSkipped: 11
		}

		expect(addItemCounts(one, one)).toEqual({
			dirsCreated: 2,
			dirsFailed: 4,
			filesDone: 6,
			filesFailed: 8,
			bytesDone: 10,
			bytesFailed: 12,
			dirsNotAttempted: 14,
			filesNotAttempted: 16,
			bytesNotAttempted: 18,
			entriesSkipped: 20,
			bytesSkipped: 22
		})
	})
})

describe("appendCapped", () => {
	it("returns the list itself when nothing was added", () => {
		const list = cappedList(["a"], 0)

		expect(appendCapped(list, [])).toBe(list)
		expect(appendCapped(list, [], 0)).toBe(list)
	})

	it("appends under the cap", () => {
		const next = appendCapped(cappedList(["a"], 0), ["b", "c"])

		expect(next).toEqual({ items: ["a", "b", "c"], omitted: 0 })
	})

	it("takes what fits and counts the rest", () => {
		const next = appendCapped(cappedList(["a"], 0), ["b", "c", "d"], 0, 2)

		expect(next).toEqual({ items: ["a", "b"], omitted: 2 })
	})

	it("only counts once full, keeping the items array", () => {
		const full = cappedList(["a", "b"], 1)
		const next = appendCapped(full, ["c"], 4, 2)

		expect(next.items).toBe(full.items)
		expect(next.omitted).toBe(6)
	})

	it("adds omissions counted upstream", () => {
		const list = cappedList(["a"], 0)
		const next = appendCapped(list, [], 3)

		expect(next.items).toBe(list.items)
		expect(next.omitted).toBe(3)
	})

	it("caps at the report cap by default", () => {
		const additions = Array.from({ length: REPORT_LIST_CAP + 5 }, (_, index) => index)
		const next = appendCapped(EMPTY_CAPPED_LIST, additions)

		expect(next.items).toHaveLength(REPORT_LIST_CAP)
		expect(next.omitted).toBe(5)
	})
})

describe("cappedList", () => {
	it("is the shared empty list when empty", () => {
		expect(cappedList([], 0)).toBe(EMPTY_CAPPED_LIST)
	})

	it("cuts a list past the cap", () => {
		const list = cappedList(
			Array.from({ length: REPORT_LIST_CAP + 2 }, () => "x"),
			3
		)

		expect(list.items).toHaveLength(REPORT_LIST_CAP)
		expect(list.omitted).toBe(5)
		expect(cappedTotal(list)).toBe(REPORT_LIST_CAP + 5)
	})

	it("converts only what fits", () => {
		let converted = 0
		const list = mapCapped(
			Array.from({ length: REPORT_LIST_CAP + 10 }, (_, index) => index),
			1,
			value => {
				converted++

				return value * 2
			}
		)

		expect(converted).toBe(REPORT_LIST_CAP)
		expect(list.items[1]).toBe(2)
		expect(list.omitted).toBe(11)
	})
})

describe("jobRate", () => {
	const running = { outcome: { status: "running" }, paused: false, pausing: false, bytesPerSecond: 2_000, etaMs: 1_500 }

	it("is the rate and the seconds left, rounded up", () => {
		expect(jobRate(running)).toEqual({ bytesPerSecond: 2_000, etaSeconds: 2 })
		expect(jobRate({ ...running, etaMs: null })).toEqual({ bytesPerSecond: 2_000, etaSeconds: null })
	})

	it("is null when nothing moves", () => {
		expect(jobRate({ ...running, paused: true })).toBeNull()
		expect(jobRate({ ...running, pausing: true })).toBeNull()
		expect(jobRate({ ...running, bytesPerSecond: null })).toBeNull()
		expect(jobRate({ ...running, bytesPerSecond: 0 })).toBeNull()
		expect(jobRate({ ...running, outcome: { status: "done" } })).toBeNull()
	})

	it("reads the outcome", () => {
		expect(isJobRunning(running)).toBe(true)
		expect(isJobRunning({ outcome: { status: "cancelled" } })).toBe(false)
	})
})

describe("toDisposition", () => {
	it("narrows the freed bytes and an unaccounted-data reason", () => {
		expect(toDisposition({ uuid: "a", outcome: { type: "disposed", how: "trash", bytesFreed: 10n } })).toEqual({
			uuid: "a",
			outcome: { type: "disposed", how: "trash", bytesFreed: 10 }
		})
		expect(
			toDisposition({ uuid: "b", outcome: { type: "kept", reason: { type: "unaccountedData", bytes: 7n }, bytesFreed: 0n } })
		).toEqual({ uuid: "b", outcome: { type: "kept", reason: { type: "unaccountedData", bytes: 7 }, bytesFreed: 0 } })
	})

	it("keeps any other reason as it is", () => {
		const reason = { type: "failed" as const, error: { kind: "Server" } }
		const disposition = toDisposition({ uuid: "c", outcome: { type: "kept", reason, bytesFreed: 0n } })

		expect(disposition.outcome.type === "kept" && disposition.outcome.reason).toBe(reason)
	})
})

describe("summarizeDispositions", () => {
	it("splits disposed by how, counts kept and adds up the freed bytes", () => {
		const list: JobDisposition<never>[] = [
			{ uuid: "a", outcome: { type: "disposed", how: "trash", bytesFreed: 10 } },
			{ uuid: "b", outcome: { type: "disposed", how: "deletePermanently", bytesFreed: 20 } },
			{ uuid: "c", outcome: { type: "kept", reason: { type: "interrupted" }, bytesFreed: 5 } },
			{ uuid: "d", outcome: { type: "disposed", how: "trash", bytesFreed: 0 } }
		]

		expect(summarizeDispositions(list)).toEqual({ disposed: 3, kept: 1, bytesFreed: 35, trashed: ["a", "d"], deleted: ["b"] })
	})

	it("is all zero for none", () => {
		expect(summarizeDispositions([])).toEqual({ disposed: 0, kept: 0, bytesFreed: 0, trashed: [], deleted: [] })
	})
})

describe("archive slot", () => {
	function slotJob(overrides: Partial<ArchiveSlotJob> = {}): ArchiveSlotJob {
		return { id: "j", kind: "extract", phase: "extracting", paused: false, outcome: { status: "running" }, ...overrides }
	}

	it("is waited for by a running archive job in waitingForWorker", () => {
		expect(isWaitingForArchiveSlot(slotJob({ phase: "waitingForWorker" }))).toBe(true)
		expect(isWaitingForArchiveSlot(slotJob({ kind: "compress", phase: "waitingForWorker" }))).toBe(true)
		expect(isWaitingForArchiveSlot(slotJob())).toBe(false)
		expect(isWaitingForArchiveSlot(slotJob({ phase: "waitingForWorker", outcome: { status: "cancelled" } }))).toBe(false)
		expect(isWaitingForArchiveSlot(slotJob({ kind: "copy", phase: "waitingForWorker" }))).toBe(false)
	})

	it("is held by a running archive job past waiting, except a compress still listing its sources", () => {
		expect(holdsArchiveSlot(slotJob())).toBe(true)
		expect(holdsArchiveSlot(slotJob({ phase: "scanning" }))).toBe(true)
		expect(holdsArchiveSlot(slotJob({ kind: "compress", phase: "scanning" }))).toBe(false)
		expect(holdsArchiveSlot(slotJob({ kind: "compress", phase: "compressing" }))).toBe(true)
		expect(holdsArchiveSlot(slotJob({ phase: "waitingForWorker" }))).toBe(false)
		expect(holdsArchiveSlot(slotJob({ outcome: { status: "done" } }))).toBe(false)
		expect(holdsArchiveSlot(slotJob({ kind: "copy" }))).toBe(false)
	})

	it("is blocked by a paused holder while another job waits", () => {
		const holder = slotJob({ id: "a", paused: true })
		const waiter = slotJob({ id: "b", phase: "waitingForWorker" })

		expect(pausedJobBlocksSlot([holder, waiter], "a")).toBe(true)
		expect(pausedJobBlocksSlot([waiter, holder], "a")).toBe(true)
		expect(pausedJobBlocksSlot([holder], "a")).toBe(false)
		expect(pausedJobBlocksSlot([{ ...holder, paused: false }, waiter], "a")).toBe(false)
		expect(pausedJobBlocksSlot([holder, waiter], "b")).toBe(false)
		expect(pausedJobBlocksSlot([slotJob({ id: "a", kind: "compress", phase: "scanning", paused: true }), waiter], "a")).toBe(false)
	})
})

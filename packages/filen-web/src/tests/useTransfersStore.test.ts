import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ErrorDTO } from "@/lib/sdk/errors"
import {
	capFinishedTransfers,
	computeTransfersAggregate,
	computeTransfersSpeed,
	isActiveTransfer,
	useTransfersStore,
	type SpeedSample,
	type Transfer
} from "@/features/transfers/store/useTransfersStore"

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
	return {
		id: "transfer-a",
		direction: "upload",
		name: "report.pdf",
		size: 1_000,
		bytesTransferred: 0,
		status: "uploading",
		paused: false,
		parentUuid: null,
		startedAt: 1_700_000_000_000,
		...overrides
	}
}

function sdkDto(kind: string): ErrorDTO {
	return { species: "sdk", kind, message: `${kind} message`, label: `${kind} label` }
}

beforeEach(() => {
	useTransfersStore.setState({ transfers: [], speedSamples: [] })
})

afterEach(() => {
	vi.useRealTimers()
})

describe("add", () => {
	it("appends a new transfer, present and uploading", () => {
		const transfer = makeTransfer()

		useTransfersStore.getState().add(transfer)

		expect(useTransfersStore.getState().transfers).toEqual([transfer])
	})

	it("appends without disturbing an already-present transfer", () => {
		const first = makeTransfer({ id: "a" })
		const second = makeTransfer({ id: "b" })

		useTransfersStore.getState().add(first)
		useTransfersStore.getState().add(second)

		expect(useTransfersStore.getState().transfers).toEqual([first, second])
	})

	it("does not mutate the previous array (returns a new reference)", () => {
		const prev = useTransfersStore.getState().transfers

		useTransfersStore.getState().add(makeTransfer())

		expect(useTransfersStore.getState().transfers).not.toBe(prev)
	})

	it("defaults paused to false on a newly added transfer", () => {
		useTransfersStore.getState().add({
			id: "a",
			direction: "upload",
			name: "report.pdf",
			size: 1_000,
			bytesTransferred: 0,
			status: "uploading",
			parentUuid: null,
			startedAt: 0
		})

		expect(useTransfersStore.getState().transfers[0]?.paused).toBe(false)
	})
})

describe("setPaused", () => {
	it("flips paused to true for the matching id, leaving status untouched", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a", status: "downloading" }))

		useTransfersStore.getState().setPaused("a", true)

		const transfer = useTransfersStore.getState().transfers[0]
		expect(transfer?.paused).toBe(true)
		expect(transfer?.status).toBe("downloading")
		expect(isActiveTransfer("downloading")).toBe(true) // paused never becomes part of the active predicate
	})

	it("flips paused back to false", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))
		useTransfersStore.getState().setPaused("a", true)

		useTransfersStore.getState().setPaused("a", false)

		expect(useTransfersStore.getState().transfers[0]?.paused).toBe(false)
	})

	it("leaves other transfers untouched", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))
		useTransfersStore.getState().add(makeTransfer({ id: "b" }))

		useTransfersStore.getState().setPaused("a", true)

		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "b")?.paused).toBe(false)
	})

	it("is a no-op for an unknown id", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))

		useTransfersStore.getState().setPaused("missing", true)

		expect(useTransfersStore.getState().transfers[0]?.paused).toBe(false)
	})
})

describe("setProgress", () => {
	it("updates bytesTransferred for the matching id", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))

		useTransfersStore.getState().setProgress("a", 500)

		expect(useTransfersStore.getState().transfers[0]?.bytesTransferred).toBe(500)
	})

	it("leaves other transfers untouched", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))
		useTransfersStore.getState().add(makeTransfer({ id: "b", bytesTransferred: 10 }))

		useTransfersStore.getState().setProgress("a", 500)

		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "b")?.bytesTransferred).toBe(10)
	})

	it("is a no-op for an unknown id", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))

		useTransfersStore.getState().setProgress("missing", 999)

		expect(useTransfersStore.getState().transfers[0]?.bytesTransferred).toBe(0)
	})
})

describe("setSize", () => {
	it("updates size for the matching id", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a", size: 0 }))

		useTransfersStore.getState().setSize("a", 5_000)

		expect(useTransfersStore.getState().transfers[0]?.size).toBe(5_000)
	})

	it("leaves other transfers untouched", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a", size: 0 }))
		useTransfersStore.getState().add(makeTransfer({ id: "b", size: 10 }))

		useTransfersStore.getState().setSize("a", 5_000)

		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "b")?.size).toBe(10)
	})

	it("is a no-op for an unknown id", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a", size: 0 }))

		useTransfersStore.getState().setSize("missing", 999)

		expect(useTransfersStore.getState().transfers[0]?.size).toBe(0)
	})

	it("can grow across repeated calls, mirroring a zip transfer's totalBytes discovered mid-walk", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a", size: 0 }))

		useTransfersStore.getState().setSize("a", 1_000)
		useTransfersStore.getState().setSize("a", 4_000)

		expect(useTransfersStore.getState().transfers[0]?.size).toBe(4_000)
	})
})

describe("settle", () => {
	it("marks a transfer done, with no error field set", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))

		useTransfersStore.getState().settle("a", "done")

		const transfer = useTransfersStore.getState().transfers[0]
		expect(transfer?.status).toBe("done")
		expect(transfer?.error).toBeUndefined()
	})

	it("marks a transfer errored, carrying the dto", () => {
		const dto = sdkDto("UploadFailed")
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))

		useTransfersStore.getState().settle("a", "error", dto)

		const transfer = useTransfersStore.getState().transfers[0]
		expect(transfer?.status).toBe("error")
		expect(transfer?.error).toEqual(dto)
	})

	it("only settles the matching id", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))
		useTransfersStore.getState().add(makeTransfer({ id: "b" }))

		useTransfersStore.getState().settle("a", "done")

		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "b")?.status).toBe("uploading")
	})

	it("marks a download cancelled (a transient state — the caller removes it right after)", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a", direction: "download", status: "downloading" }))

		useTransfersStore.getState().settle("a", "cancelled")

		expect(useTransfersStore.getState().transfers[0]?.status).toBe("cancelled")
	})

	it("marks a zip transfer completedWithErrors, carrying the dto", () => {
		const dto = sdkDto("PartialFailure")
		useTransfersStore.getState().add(makeTransfer({ id: "a", direction: "download", status: "downloading" }))

		useTransfersStore.getState().settle("a", "completedWithErrors", dto)

		const transfer = useTransfersStore.getState().transfers[0]
		expect(transfer?.status).toBe("completedWithErrors")
		expect(transfer?.error).toEqual(dto)
	})

	it("drops the oldest finished rows once the finished count exceeds the 200 cap, leaving active rows untouched", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "active", status: "uploading" }))

		for (let i = 0; i < 201; i++) {
			useTransfersStore.getState().add(makeTransfer({ id: `finished-${String(i)}`, status: "uploading" }))
		}

		for (let i = 0; i < 201; i++) {
			useTransfersStore.getState().settle(`finished-${String(i)}`, "done")
		}

		// The 201st settle() pushes the finished count to 201 -> drops exactly the oldest one, leaving
		// 200 finished + the 1 always-active row untouched (201 total).
		const ids = useTransfersStore.getState().transfers.map(transfer => transfer.id)
		expect(ids).toHaveLength(201)
		expect(ids).toContain("active")
		expect(ids).not.toContain("finished-0")
		expect(ids).toContain("finished-1")
		expect(ids).toContain("finished-200")
	})

	it("does not count a cancelled settle toward the finished cap (a cancel at the boundary never evicts a finished row)", () => {
		for (let i = 0; i < 200; i++) {
			useTransfersStore.getState().add(makeTransfer({ id: `finished-${String(i)}`, status: "uploading" }))
		}

		for (let i = 0; i < 200; i++) {
			useTransfersStore.getState().settle(`finished-${String(i)}`, "done")
		}

		useTransfersStore.getState().add(makeTransfer({ id: "cancelled-row", direction: "download", status: "downloading" }))
		useTransfersStore.getState().settle("cancelled-row", "cancelled")

		const ids = useTransfersStore.getState().transfers.map(transfer => transfer.id)
		expect(ids).toContain("finished-0")
		expect(ids).toContain("cancelled-row")
	})
})

describe("remove", () => {
	it("removes only the matching id", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))
		useTransfersStore.getState().add(makeTransfer({ id: "b" }))

		useTransfersStore.getState().remove("a")

		expect(useTransfersStore.getState().transfers.map(transfer => transfer.id)).toEqual(["b"])
	})
})

describe("clearFinished", () => {
	it("drops done/error transfers, keeps uploading ones", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a", status: "uploading" }))
		useTransfersStore.getState().add(makeTransfer({ id: "b", status: "done" }))
		useTransfersStore.getState().add(makeTransfer({ id: "c", status: "error", error: sdkDto("Boom") }))

		useTransfersStore.getState().clearFinished()

		expect(useTransfersStore.getState().transfers.map(transfer => transfer.id)).toEqual(["a"])
	})

	it("is a no-op when every transfer is still uploading", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))
		useTransfersStore.getState().add(makeTransfer({ id: "b" }))

		useTransfersStore.getState().clearFinished()

		expect(useTransfersStore.getState().transfers.map(transfer => transfer.id)).toEqual(["a", "b"])
	})

	it("keeps a downloading row (active, not finished)", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a", direction: "download", status: "downloading" }))
		useTransfersStore.getState().add(makeTransfer({ id: "b", direction: "download", status: "done" }))

		useTransfersStore.getState().clearFinished()

		expect(useTransfersStore.getState().transfers.map(transfer => transfer.id)).toEqual(["a"])
	})
})

describe("isActiveTransfer", () => {
	it("is true for uploading and downloading", () => {
		expect(isActiveTransfer("uploading")).toBe(true)
		expect(isActiveTransfer("downloading")).toBe(true)
	})

	it("is false for every terminal status", () => {
		expect(isActiveTransfer("done")).toBe(false)
		expect(isActiveTransfer("error")).toBe(false)
		expect(isActiveTransfer("cancelled")).toBe(false)
		expect(isActiveTransfer("completedWithErrors")).toBe(false)
	})
})

describe("capFinishedTransfers", () => {
	it("is a no-op under the cap", () => {
		const transfers = [makeTransfer({ id: "a", status: "uploading" }), makeTransfer({ id: "b", status: "done" })]

		expect(capFinishedTransfers(transfers)).toEqual(transfers)
	})

	it("drops only the oldest finished rows past the cap, never an active row", () => {
		const transfers = [
			makeTransfer({ id: "active", status: "uploading" }),
			...Array.from({ length: 201 }, (_, i) => makeTransfer({ id: `f${String(i)}`, status: "done" }))
		]

		const kept = capFinishedTransfers(transfers).map(transfer => transfer.id)

		expect(kept).toHaveLength(201) // 1 active + 200 finished
		expect(kept).toContain("active")
		expect(kept).not.toContain("f0")
		expect(kept).toContain("f1")
		expect(kept).toContain("f200")
	})
})

describe("computeTransfersSpeed", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(1_700_000_010_000)
	})

	function sample(overrides: Partial<SpeedSample> = {}): SpeedSample {
		return { timestamp: Date.now(), totalBytes: 0, ...overrides }
	}

	it("is 0 with no samples", () => {
		expect(computeTransfersSpeed([])).toBe(0)
	})

	it("is 0 with a single sample (no elapsed interval to divide by)", () => {
		expect(computeTransfersSpeed([sample({ timestamp: Date.now(), totalBytes: 1_000 })])).toBe(0)
	})

	it("computes bytes/sec between the earliest and latest in-window samples", () => {
		const now = Date.now()
		const samples = [sample({ timestamp: now - 2_000, totalBytes: 1_000 }), sample({ timestamp: now, totalBytes: 3_000 })]

		// 2000 bytes over 2s -> 1000 bytes/sec
		expect(computeTransfersSpeed(samples)).toBe(1_000)
	})

	it("ignores samples older than the 5s window", () => {
		const now = Date.now()
		const samples = [
			sample({ timestamp: now - 10_000, totalBytes: 0 }), // outside the window entirely
			sample({ timestamp: now - 1_000, totalBytes: 500 }),
			sample({ timestamp: now, totalBytes: 1_500 })
		]

		// only the last two count: 1000 bytes over 1s -> 1000 bytes/sec
		expect(computeTransfersSpeed(samples)).toBe(1_000)
	})

	it("never goes negative (e.g. totalBytes dropped because a transfer settled between samples)", () => {
		const now = Date.now()
		const samples = [sample({ timestamp: now - 1_000, totalBytes: 5_000 }), sample({ timestamp: now, totalBytes: 1_000 })]

		expect(computeTransfersSpeed(samples)).toBe(0)
	})
})

describe("setProgress (speed sample recording)", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(1_700_000_010_000)
	})

	it("appends a sample summing bytesTransferred across active transfers only", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a", status: "uploading" }))
		useTransfersStore.getState().add(makeTransfer({ id: "b", status: "done" }))

		useTransfersStore.getState().setProgress("a", 500)

		expect(useTransfersStore.getState().speedSamples).toEqual([{ timestamp: Date.now(), totalBytes: 500 }])
	})

	it("trims samples older than the 5s window on every call", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a", status: "uploading" }))

		useTransfersStore.getState().setProgress("a", 100)
		vi.advanceTimersByTime(6_000)
		useTransfersStore.getState().setProgress("a", 200)

		expect(useTransfersStore.getState().speedSamples).toHaveLength(1)
		expect(useTransfersStore.getState().speedSamples[0]?.totalBytes).toBe(200)
	})
})

describe("computeTransfersAggregate", () => {
	it("returns zero when there are no transfers", () => {
		expect(computeTransfersAggregate([])).toEqual({ activeCount: 0, percent: 0, speed: 0 })
	})

	it("counts only active (uploading/downloading) transfers, ignoring done/error", () => {
		const transfers = [
			makeTransfer({ id: "a", status: "uploading", size: 100, bytesTransferred: 50 }),
			makeTransfer({ id: "b", status: "done", size: 100, bytesTransferred: 100 }),
			makeTransfer({ id: "c", status: "error", size: 100, bytesTransferred: 20 })
		]

		expect(computeTransfersAggregate(transfers)).toEqual({ activeCount: 1, percent: 50, speed: 0 })
	})

	it("counts a downloading transfer as active, same as uploading", () => {
		const transfers = [
			makeTransfer({ id: "a", direction: "download", status: "downloading", size: 100, bytesTransferred: 25 }),
			makeTransfer({ id: "b", direction: "upload", status: "uploading", size: 100, bytesTransferred: 25 })
		]

		expect(computeTransfersAggregate(transfers)).toEqual({ activeCount: 2, percent: 25, speed: 0 })
	})

	it("sums bytesTransferred/size across every active transfer", () => {
		const transfers = [
			makeTransfer({ id: "a", status: "uploading", size: 100, bytesTransferred: 50 }),
			makeTransfer({ id: "b", status: "uploading", size: 300, bytesTransferred: 50 })
		]

		// 100 transferred / 400 total -> 25%
		expect(computeTransfersAggregate(transfers)).toEqual({ activeCount: 2, percent: 25, speed: 0 })
	})

	it("is 0 percent (not NaN) when every active transfer has zero size", () => {
		const transfers = [makeTransfer({ id: "a", status: "uploading", size: 0, bytesTransferred: 0 })]

		expect(computeTransfersAggregate(transfers)).toEqual({ activeCount: 1, percent: 0, speed: 0 })
	})

	it("folds in computeTransfersSpeed's result when samples are given", () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_700_000_010_000)
		const now = Date.now()
		const samples: SpeedSample[] = [
			{ timestamp: now - 1_000, totalBytes: 0 },
			{ timestamp: now, totalBytes: 2_000 }
		]

		expect(computeTransfersAggregate([], samples).speed).toBe(2_000)
	})
})

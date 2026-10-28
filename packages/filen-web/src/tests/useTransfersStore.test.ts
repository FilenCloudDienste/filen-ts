import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ErrorDTO } from "@/lib/sdk/errors"
import {
	capFinishedTransfers,
	computeTransfersAggregate,
	computeTransfersSpeed,
	hasActiveDriveJobs,
	hasActiveTransfers,
	hasSpeedSamples,
	isActiveTransfer,
	isDriveJobDirection,
	JOB_ACTIVE_STATUS,
	positionOf,
	transferById,
	transfersIndexOf,
	useTransfersStore,
	type SpeedSample,
	type Transfer
} from "@/features/transfers/store/useTransfersStore"
import { makeTransfer } from "@/tests/fixtures/transfers"

function sdkDto(kind: string): ErrorDTO {
	return { species: "sdk", kind, message: `${kind} message`, label: `${kind} label` }
}

beforeEach(() => {
	useTransfersStore.setState({ transfers: [], speedSamples: [], rowSpeedSamples: {} })
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

describe("setWaitingForSlot", () => {
	it("flags a row waiting for the archive slot and clears the flag off it again", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))
		useTransfersStore.getState().setWaitingForSlot("a", true)

		expect(useTransfersStore.getState().transfers[0]?.waitingForSlot).toBe(true)

		useTransfersStore.getState().setWaitingForSlot("a", false)

		expect(useTransfersStore.getState().transfers[0]).not.toHaveProperty("waitingForSlot")
	})

	it("leaves the store untouched when nothing changes", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))

		const before = useTransfersStore.getState()

		useTransfersStore.getState().setWaitingForSlot("a", false)
		useTransfersStore.getState().setWaitingForSlot("missing", true)

		expect(useTransfersStore.getState()).toBe(before)
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
	it("is true for uploading, downloading and every drive job's active status", () => {
		expect(isActiveTransfer("uploading")).toBe(true)
		expect(isActiveTransfer("downloading")).toBe(true)
		expect(isActiveTransfer("copying")).toBe(true)
		expect(isActiveTransfer("compressing")).toBe(true)
		expect(isActiveTransfer("extracting")).toBe(true)
	})

	it("counts the status each drive job runs under as active", () => {
		expect(JOB_ACTIVE_STATUS).toEqual({ copy: "copying", compress: "compressing", extract: "extracting" })
		expect(Object.values(JOB_ACTIVE_STATUS).every(isActiveTransfer)).toBe(true)
	})

	it("is false for every terminal status", () => {
		expect(isActiveTransfer("done")).toBe(false)
		expect(isActiveTransfer("error")).toBe(false)
		expect(isActiveTransfer("cancelled")).toBe(false)
		expect(isActiveTransfer("completedWithErrors")).toBe(false)
	})
})

describe("hasActiveTransfers", () => {
	it("is true while any transfer is active, paused ones included", () => {
		expect(
			hasActiveTransfers([makeTransfer({ status: "done" }), makeTransfer({ id: "b", direction: "copy", status: "copying" })])
		).toBe(true)
		expect(hasActiveTransfers([makeTransfer({ paused: true })])).toBe(true)
	})

	it("is false with nothing or only finished transfers", () => {
		expect(hasActiveTransfers([])).toBe(false)
		expect(hasActiveTransfers([makeTransfer({ status: "error" }), makeTransfer({ id: "b", status: "completedWithErrors" })])).toBe(
			false
		)
	})
})

describe("isDriveJobDirection", () => {
	it("names copy, compress and extract, never an upload or a download", () => {
		expect(isDriveJobDirection("copy")).toBe(true)
		expect(isDriveJobDirection("compress")).toBe(true)
		expect(isDriveJobDirection("extract")).toBe(true)
		expect(isDriveJobDirection("upload")).toBe(false)
		expect(isDriveJobDirection("download")).toBe(false)
	})
})

describe("hasActiveDriveJobs", () => {
	it("is true while any drive job's row is active, paused or not", () => {
		expect(hasActiveDriveJobs([makeTransfer({ id: "c", direction: "copy", status: "copying" })])).toBe(true)
		expect(hasActiveDriveJobs([makeTransfer({ id: "z", direction: "compress", status: "compressing", paused: true })])).toBe(true)
		expect(hasActiveDriveJobs([makeTransfer({ id: "x", direction: "extract", status: "extracting" })])).toBe(true)
	})

	it("is false with only uploads, downloads or finished jobs", () => {
		expect(hasActiveDriveJobs([])).toBe(false)
		expect(
			hasActiveDriveJobs([
				makeTransfer(),
				makeTransfer({ id: "d", direction: "download", status: "downloading" }),
				makeTransfer({ id: "c", direction: "copy", status: "done" }),
				makeTransfer({ id: "x", direction: "extract", status: "completedWithErrors" })
			])
		).toBe(false)
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

	it("ignores samples older than the 20s window", () => {
		const now = Date.now()
		const samples = [
			sample({ timestamp: now - 25_000, totalBytes: 0 }), // outside the window entirely
			sample({ timestamp: now - 1_000, totalBytes: 500 }),
			sample({ timestamp: now, totalBytes: 1_500 })
		]

		// only the last two count: 1000 bytes over 1s -> 1000 bytes/sec
		expect(computeTransfersSpeed(samples)).toBe(1_000)
	})

	it("reads 0 until a second of progress has been measured", () => {
		const now = Date.now()

		expect(
			computeTransfersSpeed([sample({ timestamp: now - 500, totalBytes: 0 }), sample({ timestamp: now, totalBytes: 9_000 })])
		).toBe(0)
	})

	it("lets a stalled transfer's speed fall off steadily rather than hold it", () => {
		const start = Date.now()
		const samples = [sample({ timestamp: start, totalBytes: 0 }), sample({ timestamp: start + 4_000, totalBytes: 4_000 })]

		// Within the grace after the last sample, the gap is the pause between chunks: no change.
		expect(computeTransfersSpeed(samples, start + 6_000)).toBe(1_000)
		// Past it, the window ends at the clock, so the speed sinks a little more each second.
		expect(computeTransfersSpeed(samples, start + 9_000)).toBeCloseTo(4_000 / 6)
		expect(computeTransfersSpeed(samples, start + 11_000)).toBe(500)
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

	it("appends a sample of the bytes moved, counting only active transfers' progress", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a", status: "uploading" }))
		useTransfersStore.getState().add(makeTransfer({ id: "b", status: "done" }))

		useTransfersStore.getState().setProgress("a", 500)

		expect(useTransfersStore.getState().speedSamples).toEqual([{ timestamp: Date.now(), totalBytes: 500 }])
	})

	it("trims samples older than the 20s window on every call", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a", status: "uploading" }))

		useTransfersStore.getState().setProgress("a", 100)
		vi.advanceTimersByTime(21_000)
		useTransfersStore.getState().setProgress("a", 200)

		expect(useTransfersStore.getState().speedSamples).toHaveLength(1)
		expect(useTransfersStore.getState().speedSamples[0]?.totalBytes).toBe(200)
	})

	it("keeps counting the bytes of transfers that settle or are removed within the window", () => {
		const store = useTransfersStore.getState()

		// Many small files, a few in flight at a time: each settles well inside the window.
		for (let i = 0; i < 10; i++) {
			store.add(makeTransfer({ id: `f${String(i)}`, size: 1_000 }))
		}

		for (let i = 0; i < 10; i++) {
			vi.advanceTimersByTime(100)
			store.setProgress(`f${String(i)}`, 500)
			vi.advanceTimersByTime(100)
			store.setProgress(`f${String(i)}`, 1_000)

			if (i % 2 === 0) {
				store.settle(`f${String(i)}`, "done")
			} else {
				store.remove(`f${String(i)}`)
			}
		}

		// 9_500 bytes moved between the first sample and the last, 1.9s apart.
		expect(computeTransfersSpeed(useTransfersStore.getState().speedSamples)).toBeCloseTo((9_500 / 1_900) * 1_000)
	})

	it("counts nothing for a transfer that restarts from fewer bytes", () => {
		vi.useFakeTimers()
		vi.setSystemTime(10_000)

		const store = useTransfersStore.getState()

		store.add(makeTransfer({ id: "a" }))
		store.setProgress("a", 800)
		vi.setSystemTime(10_200)
		store.setProgress("a", 100)
		vi.setSystemTime(10_400)
		store.setProgress("a", 300)

		expect(useTransfersStore.getState().speedSamples.map(sample => sample.totalBytes)).toEqual([800, 800, 1_000])
	})

	// Closer than that says nothing more about the speed: the window keeps its samples, not one per tick.
	it("moves the last sample's bytes for a tick under 100 ms after it, keeping its time", () => {
		vi.useFakeTimers()
		vi.setSystemTime(10_000)

		const store = useTransfersStore.getState()

		store.add(makeTransfer({ id: "a" }))
		store.setProgress("a", 100)
		vi.setSystemTime(10_050)
		store.setProgress("a", 200)
		vi.setSystemTime(10_100)
		store.setProgress("a", 300)

		expect(useTransfersStore.getState().speedSamples).toEqual([
			{ timestamp: 10_000, totalBytes: 200 },
			{ timestamp: 10_100, totalBytes: 300 }
		])
		expect(useTransfersStore.getState().rowSpeedSamples["a"]).toEqual([
			{ timestamp: 10_000, totalBytes: 200 },
			{ timestamp: 10_100, totalBytes: 300 }
		])
	})
})

describe("per-transfer speed samples", () => {
	it("records each transfer's own bytes, apart from the others", () => {
		vi.useFakeTimers()
		vi.setSystemTime(10_000)
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "a" }), makeTransfer({ id: "b" })] })

		useTransfersStore.getState().setProgress("a", 100)
		useTransfersStore.getState().setProgress("b", 700)

		expect(useTransfersStore.getState().rowSpeedSamples).toEqual({
			a: [{ timestamp: 10_000, totalBytes: 100 }],
			b: [{ timestamp: 10_000, totalBytes: 700 }]
		})
	})

	it("drops a transfer's samples once it settles or is removed", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "a" }), makeTransfer({ id: "b" })] })
		useTransfersStore.getState().setProgress("a", 100)
		useTransfersStore.getState().setProgress("b", 100)

		useTransfersStore.getState().settle("a", "done")
		useTransfersStore.getState().remove("b")

		expect(useTransfersStore.getState().rowSpeedSamples).toEqual({})
	})
})

describe("speed samples never outlive their transfer", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(10_000)
	})

	it("writes nothing for a trailing tick after its transfer settled, or for an unknown id", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "a", status: "done" })] })
		const before = useTransfersStore.getState()

		useTransfersStore.getState().setProgress("a", 500)
		useTransfersStore.getState().setProgress("missing", 500)

		expect(useTransfersStore.getState()).toBe(before)
	})

	it("keeps no row samples for a drive job, whose row reads its job's rate", () => {
		useTransfersStore.setState({
			transfers: [
				makeTransfer({ id: "c", direction: "copy", status: "copying" }),
				makeTransfer({ id: "z", direction: "compress", status: "compressing" }),
				makeTransfer({ id: "x", direction: "extract", status: "extracting" })
			]
		})

		useTransfersStore.getState().setProgress("c", 100)
		useTransfersStore.getState().setProgress("z", 50)
		useTransfersStore.getState().setProgress("x", 25)

		expect(useTransfersStore.getState().rowSpeedSamples).toEqual({})
		// One tick's worth of time apart from none: one sample counting all of it.
		expect(useTransfersStore.getState().speedSamples).toEqual([{ timestamp: 10_000, totalBytes: 175 }])
		expect(useTransfersStore.getState().transfers.map(transfer => transfer.bytesTransferred)).toEqual([100, 50, 25])
	})

	it("drops the samples of the row it settles and of the rows the cap evicts, and no others", () => {
		const finished = Array.from({ length: 200 }, (_, i) => makeTransfer({ id: `done-${String(i)}`, status: "done" }))

		useTransfersStore.setState({
			transfers: [...finished, makeTransfer({ id: "a" }), makeTransfer({ id: "b" })],
			rowSpeedSamples: {
				"done-0": [{ timestamp: 1, totalBytes: 1 }],
				"done-1": [{ timestamp: 1, totalBytes: 1 }],
				a: [{ timestamp: 1, totalBytes: 1 }],
				b: [{ timestamp: 1, totalBytes: 1 }]
			}
		})

		useTransfersStore.getState().settle("a", "done")

		expect(Object.keys(useTransfersStore.getState().rowSpeedSamples)).toEqual(["done-1", "b"])
		expect(useTransfersStore.getState().transfers[0]?.id).toBe("done-1")
	})

	it("clearFinished drops the samples of the rows it clears", () => {
		useTransfersStore.setState({
			transfers: [makeTransfer({ id: "done", status: "done" }), makeTransfer({ id: "a" })],
			rowSpeedSamples: { done: [{ timestamp: 1, totalBytes: 1 }], a: [{ timestamp: 1, totalBytes: 1 }] }
		})

		useTransfersStore.getState().clearFinished()

		expect(Object.keys(useTransfersStore.getState().rowSpeedSamples)).toEqual(["a"])
	})
})

describe("pruneSpeedSamples", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(10_000)
	})

	it("ages a stalled transfer's samples out of the window, until it has none", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "a" })] })
		useTransfersStore.getState().setProgress("a", 100)
		vi.setSystemTime(11_000)
		useTransfersStore.getState().setProgress("a", 200)

		vi.setSystemTime(30_500)
		useTransfersStore.getState().pruneSpeedSamples()

		expect(useTransfersStore.getState().rowSpeedSamples).toEqual({ a: [{ timestamp: 11_000, totalBytes: 200 }] })
		expect(useTransfersStore.getState().speedSamples).toEqual([{ timestamp: 11_000, totalBytes: 200 }])

		vi.setSystemTime(31_500)
		useTransfersStore.getState().pruneSpeedSamples()

		expect(useTransfersStore.getState().rowSpeedSamples).toEqual({})
		expect(useTransfersStore.getState().speedSamples).toEqual([])
		expect(hasSpeedSamples(useTransfersStore.getState())).toBe(false)
	})

	it("writes nothing when no sample has aged out", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "a" })] })
		useTransfersStore.getState().setProgress("a", 100)
		const before = useTransfersStore.getState()

		vi.setSystemTime(12_000)
		useTransfersStore.getState().pruneSpeedSamples()

		expect(useTransfersStore.getState()).toBe(before)
		expect(hasSpeedSamples(before)).toBe(true)
	})
})

describe("setItem", () => {
	it("keeps the landed item on its row only", () => {
		const item = { type: "file" } as unknown as NonNullable<Transfer["item"]>

		useTransfersStore.setState({ transfers: [makeTransfer({ id: "a" }), makeTransfer({ id: "b" })] })
		useTransfersStore.getState().setItem("a", item)

		expect(useTransfersStore.getState().transfers.map(transfer => transfer.item)).toEqual([item, undefined])
	})

	it("renames the row only when given a name", () => {
		const item = { type: "file" } as unknown as NonNullable<Transfer["item"]>

		useTransfersStore.setState({ transfers: [makeTransfer({ id: "a", name: "x.zip" }), makeTransfer({ id: "b", name: "y.zip" })] })
		useTransfersStore.getState().setItem("a", item, "x (1).zip")
		useTransfersStore.getState().setItem("b", item)

		expect(useTransfersStore.getState().transfers.map(transfer => transfer.name)).toEqual(["x (1).zip", "y.zip"])
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

	it("leaves a transfer of unknown size out of the percent, but still counts it as active", () => {
		const transfers = [
			makeTransfer({ id: "a", size: 1_000, bytesTransferred: 500 }),
			makeTransfer({ id: "zip", direction: "download", status: "downloading", size: 0, bytesTransferred: 5_000 })
		]

		expect(computeTransfersAggregate(transfers)).toMatchObject({ activeCount: 2, percent: 50 })
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

	it("clamps percent to 100 when an active transfer's bytesTransferred overshoots its size", () => {
		const transfers = [makeTransfer({ id: "a", status: "uploading", size: 100, bytesTransferred: 150 })]

		expect(computeTransfersAggregate(transfers)).toEqual({ activeCount: 1, percent: 100, speed: 0 })
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

// The index every subscriber reads instead of a pass over the rows: carried from one write to the next,
// it must always agree with what a fresh pass over the same rows says.
describe("the rows' index", () => {
	function readIndex(transfers: readonly Transfer[]) {
		const { activeCount, activeJobs, activeSize, activeTransferred, failedCount, units } = transfersIndexOf(transfers)

		return {
			totals: { activeCount, activeJobs, activeSize, activeTransferred, failedCount },
			// Positions are corrected lazily: read them the way every lookup does.
			positions: transfers.map(transfer => [transfer.id, positionOf(transfers, transfer.id)]),
			units: [...units].map(([parent, set]) => [parent, [...set.uploads], [...set.failed], [...set.jobs]])
		}
	}

	it("agrees with a fresh pass after adds, progress, settles, removals and the cap", () => {
		const batch = { id: "run", parentUuid: "dir" }
		const store = useTransfersStore.getState()

		store.startUploadBatch(batch, { files: 3, bytes: 3_000 })
		store.addMany([makeTransfer({ id: "a", batch }), makeTransfer({ id: "b", batch }), makeTransfer({ id: "c", batch, size: 0 })])
		store.add(makeTransfer({ id: "job", direction: "copy", status: "copying", parentUuid: "dir" }))
		store.setProgressMany({ a: 400, b: 100, job: 50 })
		store.settle("b", "error", sdkDto("UploadFailed"))
		store.remove("a")
		store.setSize("c", 700)
		store.setProgress("c", 300)

		const { transfers } = useTransfersStore.getState()

		// A copy is indexed afresh, never through the index the store carried along.
		expect(readIndex(transfers)).toEqual(readIndex([...transfers]))
		expect(readIndex(transfers).positions).toEqual(transfers.map((transfer, i) => [transfer.id, i]))
		expect(transfersIndexOf(transfers)).toMatchObject({
			activeCount: 2,
			activeJobs: 1,
			failedCount: 1,
			activeSize: 1_700,
			activeTransferred: 350
		})
		expect(transferById(transfers, "a")).toBeUndefined()
		expect(transferById(transfers, "c")?.bytesTransferred).toBe(300)
	})

	it("keeps a listing's running uploads in start order across progress ticks", () => {
		const batch = { id: "run", parentUuid: "dir" }

		useTransfersStore.getState().addMany([makeTransfer({ id: "a", batch }), makeTransfer({ id: "b", batch })])
		useTransfersStore.getState().setProgress("a", 10)

		expect([...(transfersIndexOf(useTransfersStore.getState().transfers).units.get("dir")?.uploads ?? [])]).toEqual(["a", "b"])
	})

	it("applies a whole progress batch in one write", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "a" }), makeTransfer({ id: "b" })] })

		const listener = vi.fn()
		const unsubscribe = useTransfersStore.subscribe(listener)

		useTransfersStore.getState().setProgressMany({ a: 100, b: 200, gone: 5 })
		unsubscribe()

		expect(listener).toHaveBeenCalledTimes(1)
		expect(useTransfersStore.getState().transfers.map(transfer => transfer.bytesTransferred)).toEqual([100, 200])
	})
})

// A directory upload's top-level directory is ONE row, its run's: the files move it, and only a failed one
// gets a row of its own.
describe("directory runs", () => {
	const run = { id: "run", parentUuid: null, directoryName: "photos" }

	beforeEach(() => {
		useTransfersStore.setState({ transfers: [], uploadBatches: {}, batchSpeedSamples: {}, rowSpeedSamples: {}, speedSamples: [] })
	})

	it("shows the run sized in full from the start, moved by its files' progress", () => {
		const store = useTransfersStore.getState()

		store.startUploadBatch(run, { files: 2, bytes: 1_000 })
		store.startRunFile({ id: "f1", batchId: "run", size: 600, counted: 600 })
		store.startRunFile({ id: "f2", batchId: "run", size: 400, counted: 400 })
		store.setProgressMany({ f1: 300, f2: 100 })

		expect(useTransfersStore.getState().transfers).toMatchObject([
			{ id: "run", name: "photos", status: "uploading", size: 1_000, bytesTransferred: 400 }
		])
		expect(useTransfersStore.getState().rowSpeedSamples["run"]).toHaveLength(1)

		store.settleRunFile("f1", "done")

		expect(useTransfersStore.getState().transfers[0]).toMatchObject({ bytesTransferred: 700 })
		expect(useTransfersStore.getState().uploadBatches["run"]).toMatchObject({ settledFiles: 1, transferred: 700 })
	})

	it("resizes the run for a file that changed size since it was counted", () => {
		const store = useTransfersStore.getState()

		store.startUploadBatch(run, { files: 1, bytes: 1_000 })
		store.startRunFile({ id: "f1", batchId: "run", size: 600, counted: 1_000 })

		expect(useTransfersStore.getState().transfers[0]?.size).toBe(600)
	})

	it("gives a failed file a row of its own and ends the run completed with errors", () => {
		const store = useTransfersStore.getState()

		store.startUploadBatch(run, { files: 2, bytes: 1_000 })
		store.startRunFile({ id: "f1", batchId: "run", size: 600, counted: 600 })
		store.startRunFile({ id: "f2", batchId: "run", size: 400, counted: 400 })
		store.settleRunFile("f1", "done")
		store.settleRunFile("f2", "error", sdkDto("UploadFailed"), { name: "photos/b.jpg", parentUuid: "sub" })
		store.endUploadBatch("run")

		expect(useTransfersStore.getState().transfers).toMatchObject([
			{ id: "run", status: "completedWithErrors", failedItems: 1, size: 600, bytesTransferred: 600 },
			{ id: "f2", name: "photos/b.jpg", status: "error", size: 400, parentUuid: "sub", batch: run }
		])
		// A failed file of a run is reported by its run in the listing, not as a plain failed upload.
		expect(transfersIndexOf(useTransfersStore.getState().transfers).units.size).toBe(0)
	})

	it("ends a clean run done, and removes a cancelled one's row", () => {
		const store = useTransfersStore.getState()
		const other = { id: "other", parentUuid: null, directoryName: "music" }

		store.startUploadBatch(run, { files: 1, bytes: 10 })
		store.startUploadBatch(other, { files: 1, bytes: 10 })
		store.startRunFile({ id: "f1", batchId: "run", size: 10, counted: 10 })
		store.settleRunFile("f1", "done")
		store.endUploadBatch("run")
		store.cancelUploadBatches(new Set(["other"]))
		store.endUploadBatch("other")

		expect(useTransfersStore.getState().transfers).toMatchObject([{ id: "run", status: "done", size: 10, bytesTransferred: 10 }])
		expect(useTransfersStore.getState().uploadBatches).toEqual({})
	})

	it("counts what a scanning run's walk found, and drops its row at once when it is cancelled", () => {
		const store = useTransfersStore.getState()

		store.startUploadBatch(run, { files: 0, bytes: 0 }, { scanning: true })
		store.updateUploadBatchScans(new Map([["run", { files: 3, bytes: 900 }]]))

		expect(useTransfersStore.getState().uploadBatches["run"]).toMatchObject({ scanning: true, files: 3, bytes: 900 })
		expect(useTransfersStore.getState().transfers[0]?.size).toBe(900)

		store.startUploadBatch(run, { files: 4, bytes: 1_000 })

		expect(useTransfersStore.getState().uploadBatches["run"]?.scanning).toBeUndefined()
		expect(useTransfersStore.getState().transfers).toHaveLength(1)

		store.startUploadBatch(run, { files: 0, bytes: 0 }, { scanning: true })
		store.cancelUploadBatches(new Set(["run"]))

		expect(useTransfersStore.getState().transfers).toEqual([])
		expect(useTransfersStore.getState().uploadBatches["run"]?.cancelled).toBe(true)
	})

	it("discards a run that never uploaded, with its row", () => {
		useTransfersStore.getState().startUploadBatch(run, { files: 0, bytes: 0 }, { scanning: true })
		useTransfersStore.getState().discardUploadBatches(new Set(["run"]))

		expect(useTransfersStore.getState().transfers).toEqual([])
		expect(useTransfersStore.getState().uploadBatches).toEqual({})
	})
})

describe("directory runs — fewer writes", () => {
	const run = { id: "run", parentUuid: null, directoryName: "photos" }

	beforeEach(() => {
		useTransfersStore.setState({ transfers: [], uploadBatches: {}, batchSpeedSamples: {}, rowSpeedSamples: {}, speedSamples: [] })
	})

	// The worker drops a run file's last count, so its settle counts those bytes: in the run and its speed.
	it("counts a done file's last bytes in the run and its speed windows on settle", () => {
		vi.useFakeTimers()
		vi.setSystemTime(10_000)

		const store = useTransfersStore.getState()

		store.startUploadBatch(run, { files: 1, bytes: 1_000 })
		store.startRunFile({ id: "f1", batchId: "run", size: 1_000, counted: 1_000 })
		store.setProgressMany({ f1: 400 })
		vi.setSystemTime(12_000)
		store.settleRunFile("f1", "done")

		const state = useTransfersStore.getState()

		expect(state.transfers[0]).toMatchObject({ bytesTransferred: 1_000 })
		expect(state.speedSamples.at(-1)).toEqual({ timestamp: 12_000, totalBytes: 1_000 })
		expect(state.batchSpeedSamples["run"]?.at(-1)).toEqual({ timestamp: 12_000, totalBytes: 1_000 })
		expect(state.rowSpeedSamples["run"]?.at(-1)).toEqual({ timestamp: 12_000, totalBytes: 1_000 })
	})

	it("writes nothing for a scan report that found nothing new, or for a cancelled run", () => {
		const store = useTransfersStore.getState()

		store.startUploadBatch(run, { files: 0, bytes: 0 }, { scanning: true })
		store.updateUploadBatchScans(new Map([["run", { files: 2, bytes: 20 }]]))

		const listener = vi.fn()
		const unsubscribe = useTransfersStore.subscribe(listener)

		store.updateUploadBatchScans(new Map([["run", { files: 2, bytes: 20 }]]))
		store.cancelUploadBatches(new Set(["run"]))
		listener.mockClear()
		store.updateUploadBatchScans(new Map([["run", { files: 5, bytes: 50 }]]))
		unsubscribe()

		expect(listener).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().uploadBatches["run"]).toMatchObject({ files: 2, bytes: 20 })
	})
})

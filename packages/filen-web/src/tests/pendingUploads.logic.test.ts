import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { useTransfersStore, type Transfer, type UploadBatchRef } from "@/features/transfers/store/useTransfersStore"
import {
	hasPendingUploads,
	parsePendingRowKey,
	pendingCancelSubject,
	pendingCancelTargets,
	pendingDismissTargets,
	pendingFailedCount,
	pendingGroupProgress,
	pendingGroupSpeed,
	pendingRunFigures,
	pendingSummaryFigures,
	pendingSummarySamples,
	pendingUploadRowKeys
} from "@/features/drive/lib/pendingUploads.logic"
import { makeTransfer } from "@/tests/fixtures/transfers"

const DIR = "dir-uuid"
const OTHER_DIR = "other-dir-uuid"

function sdkDto(kind: string): ErrorDTO {
	return { species: "sdk", kind, message: `${kind} message`, label: `${kind} label` }
}

function store() {
	return useTransfersStore.getState()
}

function plainRun(id: string, parentUuid: string | null = DIR): UploadBatchRef {
	const ref = { id, parentUuid }

	store().startUploadBatch(ref)

	return ref
}

function directoryRun(id: string, directoryName: string, parentUuid: string | null = DIR): UploadBatchRef {
	const ref = { id, parentUuid, directoryName }

	store().startUploadBatch(ref)

	return ref
}

function addUpload(id: string, batch: UploadBatchRef | undefined, overrides: Partial<Transfer> = {}): void {
	const transfer = makeTransfer({ id, name: `${id}.txt`, ...overrides })

	store().add(batch === undefined ? transfer : { ...transfer, batch })
}

function keys(parentUuid: string | null = DIR) {
	return pendingUploadRowKeys(store(), parentUuid)
}

beforeEach(() => {
	useTransfersStore.setState({ transfers: [], speedSamples: [], rowSpeedSamples: {}, uploadBatches: {}, batchSpeedSamples: {} })
})

afterEach(() => {
	vi.useRealTimers()
})

describe("pendingUploadRowKeys — grouping", () => {
	it("gives each of up to three running uploads its own row, in start order", () => {
		const run = plainRun("run")

		addUpload("a", run)
		addUpload("b", run)
		addUpload("c", run)

		expect(keys()).toEqual(["upload:a", "upload:b", "upload:c"])
	})

	it("folds four or more running uploads into one summary row", () => {
		const run = plainRun("run")

		for (const id of ["a", "b", "c", "d"]) {
			addUpload(id, run)
		}

		expect(keys()).toEqual(["uploading"])
	})

	it("counts runs started separately together, as the directory shows them together", () => {
		addUpload("a", plainRun("first"))
		addUpload("b", plainRun("second"))
		addUpload("c", plainRun("third"))
		addUpload("d", plainRun("fourth"))

		expect(keys()).toEqual(["uploading"])
	})

	it("gives a directory upload ONE row for its top-level directory, however many files it holds", () => {
		const tree = directoryRun("tree", "Photos")

		for (let index = 0; index < 50; index++) {
			addUpload(`file-${String(index)}`, tree)
		}

		expect(keys()).toEqual(["directory:tree"])
	})

	it("shows a directory upload's row before any of its files started", () => {
		directoryRun("tree", "Photos")

		expect(keys()).toEqual(["directory:tree"])
		expect(hasPendingUploads(store(), DIR)).toBe(true)
	})

	it("counts a directory upload as one unit toward the summary threshold", () => {
		directoryRun("tree-1", "A")
		directoryRun("tree-2", "B")

		const run = plainRun("run")

		addUpload("a", run)

		expect(keys()).toEqual(["directory:tree-1", "directory:tree-2", "upload:a"])

		addUpload("b", run)

		expect(keys()).toEqual(["uploading"])
	})

	it("leaves out uploads into other directories, downloads, and uploads that are not a drive run", () => {
		addUpload("elsewhere", plainRun("other", OTHER_DIR))
		addUpload("chat-attachment", undefined)
		store().add({ ...makeTransfer({ id: "download", direction: "download", status: "downloading" }) })

		expect(keys()).toEqual([])
		expect(hasPendingUploads(store(), DIR)).toBe(false)
		expect(keys(OTHER_DIR)).toEqual(["upload:elsewhere"])
	})

	it("keys the root listing as null", () => {
		addUpload("a", plainRun("run", null))

		expect(keys(null)).toEqual(["upload:a"])
		expect(keys()).toEqual([])
	})

	it("drops a finished upload's row and keeps a failed one, after the running rows", () => {
		const run = plainRun("run")

		addUpload("a", run)
		addUpload("b", run)
		addUpload("c", run)
		store().settle("a", "done")
		store().settle("b", "error", sdkDto("Timeout"))

		expect(keys()).toEqual(["upload:c", "failedUpload:b"])
	})

	it("drops a cancelled upload's row", () => {
		const run = plainRun("run")

		addUpload("a", run)
		store().settle("a", "cancelled")
		store().remove("a")

		expect(keys()).toEqual([])
	})

	it("keeps failed uploads after their run ended, folding four or more into one row", () => {
		const run = plainRun("run")

		for (const id of ["a", "b", "c", "d"]) {
			addUpload(id, run)
			store().settle(id, "error", sdkDto("Timeout"))
		}

		store().endUploadBatch(run.id)

		expect(keys()).toEqual(["failed"])
		expect(pendingFailedCount(store(), DIR)).toBe(4)
		expect(hasPendingUploads(store(), DIR)).toBe(true)
	})

	it("keeps a directory upload that ended with failures as a failed row, and drops one that ended clean", () => {
		const failedTree = directoryRun("failed-tree", "A")
		const cleanTree = directoryRun("clean-tree", "B")

		addUpload("a", failedTree)
		addUpload("b", cleanTree)
		store().settle("a", "error", sdkDto("Timeout"))
		store().settle("b", "done")

		expect(keys()).toEqual(["directory:failed-tree", "directory:clean-tree"])

		store().endUploadBatch(failedTree.id)
		store().endUploadBatch(cleanTree.id)

		expect(keys()).toEqual(["failedDirectory:failed-tree"])
	})

	it("drops a cancelled directory upload's row when it ends, failures and all", () => {
		const tree = directoryRun("tree", "A")

		store().failUploadBatchItems(tree.id, 1, sdkDto("Timeout"))
		store().cancelUploadBatches(new Set([tree.id]))
		store().endUploadBatch(tree.id)

		expect(keys()).toEqual([])
	})

	it("returns equal keys across a progress tick, so the listing's shallow read does not change", () => {
		const run = plainRun("run")

		addUpload("a", run, { size: 1_000 })

		const before = keys()

		store().setProgress("a", 500)

		expect(keys()).toEqual(before)
	})

	it("agrees with hasPendingUploads in every state", () => {
		const run = plainRun("run")

		expect(hasPendingUploads(store(), DIR)).toBe(keys().length > 0)

		addUpload("a", run)

		expect(hasPendingUploads(store(), DIR)).toBe(true)

		store().settle("a", "done")
		store().endUploadBatch(run.id)

		expect(keys()).toEqual([])
		expect(hasPendingUploads(store(), DIR)).toBe(false)
	})
})

describe("parsePendingRowKey", () => {
	it("reads every kind back with its id", () => {
		expect(parsePendingRowKey("upload:a")).toEqual({ kind: "upload", id: "a" })
		expect(parsePendingRowKey("failedUpload:a")).toEqual({ kind: "failedUpload", id: "a" })
		expect(parsePendingRowKey("directory:t")).toEqual({ kind: "directory", id: "t" })
		expect(parsePendingRowKey("failedDirectory:t")).toEqual({ kind: "failedDirectory", id: "t" })
		expect(parsePendingRowKey("uploading")).toEqual({ kind: "uploading", id: "" })
		expect(parsePendingRowKey("failed")).toEqual({ kind: "failed", id: "" })
	})
})

describe("run totals — the summary and directory rows' figures", () => {
	it("sums the files and bytes of every running run into the directory, and nothing else", () => {
		const first = plainRun("first")
		const tree = directoryRun("tree", "A")

		addUpload("a", first, { size: 1_000 })
		addUpload("b", tree, { size: 3_000 })
		addUpload("elsewhere", plainRun("other", OTHER_DIR), { size: 9_000 })
		store().setProgress("a", 400)
		store().setProgress("b", 600)

		expect(pendingSummaryFigures(store(), DIR)).toEqual({ files: 2, bytes: 4_000, transferred: 1_000 })
		expect(pendingRunFigures(store(), tree.id)).toEqual({ files: 1, bytes: 3_000, transferred: 600 })
	})

	it("keeps a finished file's bytes, so the run's progress never moves backwards", () => {
		const run = plainRun("run")

		addUpload("a", run, { size: 1_000 })
		addUpload("b", run, { size: 1_000 })
		store().setProgress("a", 900)
		store().setProgress("b", 100)

		const before = pendingGroupProgress(pendingSummaryFigures(store(), DIR), 0).percent

		// The last tick before the settle can be short of the size; the done file still counts whole.
		store().settle("a", "done")
		store().remove("a")

		const after = pendingSummaryFigures(store(), DIR)

		expect(after).toEqual({ files: 1, bytes: 2_000, transferred: 1_100 })
		expect(pendingGroupProgress(after, 0).percent).toBeGreaterThan(before)
	})

	it("takes a failed file's size out of what is left, and a cancelled one out of the run", () => {
		const run = plainRun("run")

		addUpload("a", run, { size: 1_000 })
		addUpload("b", run, { size: 2_000 })
		addUpload("c", run, { size: 4_000 })
		store().setProgress("a", 500)
		store().setProgress("b", 500)
		store().settle("a", "error", sdkDto("Timeout"))
		store().settle("b", "cancelled")

		expect(pendingSummaryFigures(store(), DIR)).toEqual({ files: 1, bytes: 4_000, transferred: 0 })
		expect(store().uploadBatches[run.id]).toMatchObject({ failed: 1, error: sdkDto("Timeout") })
	})

	it("counts a settle once, ignoring a second settle of an already finished row", () => {
		const run = plainRun("run")

		addUpload("a", run, { size: 1_000 })
		store().settle("a", "error", sdkDto("Timeout"))
		store().settle("a", "error", sdkDto("Timeout"))

		expect(store().uploadBatches[run.id]).toMatchObject({ failed: 1, settledFiles: 1, failedBytes: 1_000 })
	})

	it("keeps one rolling window per run over its cumulative bytes, which the aging tick prunes", () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)

		const run = plainRun("run")

		addUpload("a", run, { size: 10_000 })
		addUpload("b", run, { size: 10_000 })
		store().setProgress("a", 1_000)
		vi.setSystemTime(1_000)
		store().setProgress("b", 1_000)
		vi.setSystemTime(2_000)
		store().setProgress("a", 3_000)

		const samples = pendingSummarySamples(store(), DIR)

		expect(samples).toEqual([
			[
				{ timestamp: 0, totalBytes: 1_000 },
				{ timestamp: 1_000, totalBytes: 2_000 },
				{ timestamp: 2_000, totalBytes: 4_000 }
			]
		])
		// 3,000 bytes over 2 s, whichever file moved them.
		expect(pendingGroupSpeed(samples, 2_000)).toBe(1_500)

		vi.setSystemTime(60_000)
		store().pruneSpeedSamples()

		expect(pendingSummarySamples(store(), DIR)).toEqual([])
	})

	it("reports percent and a stepped time left from the measured speed", () => {
		expect(pendingGroupProgress({ files: 2, bytes: 4_000, transferred: 1_000 }, 100)).toEqual({ percent: 25, etaSeconds: 30 })
		expect(pendingGroupProgress({ files: 2, bytes: 4_000, transferred: 1_000 }, 0)).toEqual({ percent: 25, etaSeconds: null })
		expect(pendingGroupProgress({ files: 0, bytes: 0, transferred: 0 }, 100)).toEqual({ percent: 0, etaSeconds: null })
	})
})

describe("pendingCancelTargets / pendingDismissTargets", () => {
	it("cancels a single upload by its id", () => {
		addUpload("a", plainRun("run"))

		expect(pendingCancelTargets(store(), "upload:a", DIR)).toEqual({ transferIds: new Set(["a"]), batchIds: new Set() })
	})

	it("cancels a directory upload's run and only its running files", () => {
		const tree = directoryRun("tree", "A")
		const other = directoryRun("other-tree", "B")

		addUpload("a", tree)
		addUpload("done", tree)
		addUpload("b", other)
		store().settle("done", "done")

		expect(pendingCancelTargets(store(), "directory:tree", DIR)).toEqual({
			transferIds: new Set(["a"]),
			batchIds: new Set(["tree"])
		})
	})

	it("cancels every running run into the directory from the summary row, and nothing elsewhere", () => {
		const first = plainRun("first")
		const tree = directoryRun("tree", "A")

		addUpload("a", first)
		addUpload("b", tree)
		addUpload("elsewhere", plainRun("other", OTHER_DIR))

		expect(pendingCancelTargets(store(), "uploading", DIR)).toEqual({
			transferIds: new Set(["a", "b"]),
			batchIds: new Set(["first", "tree"])
		})
	})

	it("cancels nothing from a failed row", () => {
		expect(pendingCancelTargets(store(), "failed", DIR)).toEqual({ transferIds: new Set(), batchIds: new Set() })
	})

	it("dismisses every failed unit into the directory from the failed summary row", () => {
		const run = plainRun("run")
		const tree = directoryRun("tree", "A")

		addUpload("a", run)
		addUpload("running", run)
		addUpload("b", plainRun("other", OTHER_DIR))
		store().settle("a", "error", sdkDto("Timeout"))
		store().settle("b", "error", sdkDto("Timeout"))
		store().failUploadBatchItems(tree.id, 1)
		store().endUploadBatch(tree.id)

		expect(pendingDismissTargets(store(), "failed", DIR)).toEqual({ transferIds: new Set(["a"]), batchIds: new Set(["tree"]) })
		expect(pendingDismissTargets(store(), "failedUpload:a", DIR)).toEqual({ transferIds: new Set(["a"]), batchIds: new Set() })
		expect(pendingDismissTargets(store(), "failedDirectory:tree", DIR)).toEqual({ transferIds: new Set(), batchIds: new Set(["tree"]) })
	})
})

describe("pendingCancelSubject", () => {
	it("names what a confirm would stop, and nothing once it is gone", () => {
		const tree = directoryRun("tree", "Photos")

		addUpload("a", plainRun("run"))
		addUpload("b", tree)

		expect(pendingCancelSubject(store(), "upload:a", DIR)).toBe("a.txt")
		expect(pendingCancelSubject(store(), "directory:tree", DIR)).toBe("Photos")
		expect(pendingCancelSubject(store(), "uploading", DIR)).toBe(2)

		store().settle("a", "done")
		store().cancelUploadBatches(new Set([tree.id]))

		expect(pendingCancelSubject(store(), "upload:a", DIR)).toBeNull()
		expect(pendingCancelSubject(store(), "directory:tree", DIR)).toBeNull()
	})
})

describe("store — removeMany and removeUploadBatches", () => {
	it("removes many rows and runs in one update each", () => {
		const run = plainRun("run")
		const listener = vi.fn()

		addUpload("a", run)
		addUpload("b", run)
		addUpload("c", run)

		const unsubscribe = useTransfersStore.subscribe(listener)

		store().removeMany(new Set(["a", "b"]))
		store().removeUploadBatches(new Set([run.id]))
		unsubscribe()

		expect(listener).toHaveBeenCalledTimes(2)
		expect(store().transfers.map(transfer => transfer.id)).toEqual(["c"])
		expect(store().uploadBatches).toEqual({})
	})
})

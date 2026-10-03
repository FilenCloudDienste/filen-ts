import { beforeEach, describe, expect, it, vi } from "vitest"

// Same mock boundary as download.test.ts's own cancel test: the real sdk client module
// touches a Vite `?worker`, unresolvable/unwanted under node vitest.
const { sdkCancel, sdkPause, sdkResume, cancelSwDownload } = vi.hoisted(() => ({
	sdkCancel: vi.fn(),
	sdkPause: vi.fn(),
	sdkResume: vi.fn(),
	cancelSwDownload: vi.fn((_id: string) => false)
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { cancelTransfer: sdkCancel, pauseTransfer: sdkPause, resumeTransfer: sdkResume }
}))
vi.mock("@/features/drive/lib/saveDownload", () => ({ cancelSwDownload }))

import {
	cancelUploadRuns,
	cancelActiveTransfers,
	cancelTransfer,
	cancelTransfers,
	requestJobCancel,
	setTransferPaused,
	setTransfersPaused
} from "@/features/transfers/lib/control"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { getCopyJob, getDriveJob, useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { createCopyJob } from "@/features/drive/lib/copy.logic"
import { makeTransfer } from "@/tests/fixtures/transfers"
import { compressJob, extractJob } from "@/tests/support/archiveJobFixtures"

const DESTINATION = { uuid: null, name: "Cloud Drive" }

beforeEach(() => {
	vi.clearAllMocks()
	cancelSwDownload.mockImplementation(() => false)
	useTransfersStore.setState({ transfers: [], uploadBatches: {} })
	useDriveJobsStore.setState({ jobs: {} })
})

describe("cancelTransfer", () => {
	it("calls sdkApi.cancelTransfer for an active upload-direction transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t1", direction: "upload", status: "uploading" })] })

		cancelTransfer("t1")

		expect(sdkCancel.mock.calls).toEqual([["t1"]])
	})

	it("calls sdkApi.cancelTransfer for an active download-direction transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t2", direction: "download", status: "downloading" })] })

		cancelTransfer("t2")

		expect(sdkCancel.mock.calls).toEqual([["t2"]])
	})

	it("sends a service-worker download's cancel to the worker instead of the page's SDK", () => {
		useTransfersStore.setState({
			transfers: [makeTransfer({ id: "sw1", direction: "download", status: "downloading", browserManaged: true })]
		})
		cancelSwDownload.mockImplementation(id => id === "sw1")

		cancelTransfer("sw1")

		expect(cancelSwDownload).toHaveBeenCalledWith("sw1")
		expect(sdkCancel).not.toHaveBeenCalled()
	})

	it("is a no-op for an id not present in the store", () => {
		cancelTransfer("missing")

		expect(sdkCancel).not.toHaveBeenCalled()
	})

	it("is a no-op for an already-terminal (done) transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t3", direction: "upload", status: "done" })] })

		cancelTransfer("t3")

		expect(sdkCancel).not.toHaveBeenCalled()
	})

	it("is a no-op for an already-terminal (error) transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t4", direction: "download", status: "error" })] })

		cancelTransfer("t4")

		expect(sdkCancel).not.toHaveBeenCalled()
	})
})

describe("setTransferPaused(id, true)", () => {
	it("calls sdkApi.pauseTransfer and sets paused for an active upload-direction transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t1", direction: "upload", status: "uploading" })] })

		setTransferPaused("t1", true)

		expect(sdkPause.mock.calls).toEqual([["t1"]])
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t1")?.paused).toBe(true)
	})

	it("calls sdkApi.pauseTransfer and sets paused for an active download-direction transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t2", direction: "download", status: "downloading" })] })

		setTransferPaused("t2", true)

		expect(sdkPause.mock.calls).toEqual([["t2"]])
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t2")?.paused).toBe(true)
	})

	it("is a no-op for an id not present in the store", () => {
		setTransferPaused("missing", true)

		expect(sdkPause).not.toHaveBeenCalled()
	})

	it("is a no-op for an already-terminal transfer (no worker call, no setPaused)", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t3", direction: "upload", status: "done" })] })

		setTransferPaused("t3", true)

		expect(sdkPause).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t3")?.paused).toBe(false)
	})
})

describe("setTransferPaused(id, false)", () => {
	it("calls sdkApi.resumeTransfer and clears paused for an active upload-direction transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t1", direction: "upload", status: "uploading", paused: true })] })

		setTransferPaused("t1", false)

		expect(sdkResume.mock.calls).toEqual([["t1"]])
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t1")?.paused).toBe(false)
	})

	it("calls sdkApi.resumeTransfer and clears paused for an active download-direction transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t2", direction: "download", status: "downloading", paused: true })] })

		setTransferPaused("t2", false)

		expect(sdkResume.mock.calls).toEqual([["t2"]])
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t2")?.paused).toBe(false)
	})

	it("is a no-op for an id not present in the store", () => {
		setTransferPaused("missing", false)

		expect(sdkResume).not.toHaveBeenCalled()
	})

	it("is a no-op for an already-terminal transfer (no worker call, no setPaused)", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t4", direction: "download", status: "error", paused: true })] })

		setTransferPaused("t4", false)

		expect(sdkResume).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t4")?.paused).toBe(true)
	})
})

describe("copy transfers", () => {
	it("cancels a copy keeping what it already copied", () => {
		useDriveJobsStore.setState({ jobs: { c1: createCopyJob("c1", { uuid: null, name: "Cloud Drive" }, 1) } })
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "c1", direction: "copy", status: "copying" })] })

		cancelTransfer("c1")

		expect(getCopyJob("c1")?.cancelRequest).toBe("keep")
		expect(sdkCancel.mock.calls).toEqual([["c1"]])
	})

	it("pauses and resumes a copy through the copy job", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "c1", direction: "copy", status: "copying" })] })

		setTransferPaused("c1", true)

		expect(sdkPause).toHaveBeenCalledWith("c1")
		expect(useTransfersStore.getState().transfers[0]?.paused).toBe(true)

		setTransferPaused("c1", false)

		expect(sdkResume).toHaveBeenCalledWith("c1")
		expect(useTransfersStore.getState().transfers[0]?.paused).toBe(false)
	})

	it("is a no-op for a finished copy", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "c1", direction: "copy", status: "completedWithErrors" })] })

		cancelTransfer("c1")
		setTransferPaused("c1", true)

		expect(sdkCancel).not.toHaveBeenCalled()
		expect(getCopyJob("c1")?.cancelRequest ?? null).toBeNull()
		expect(sdkPause).not.toHaveBeenCalled()
	})

	// Its row stays active while what it copied moves to the trash, which has no pause.
	it("neither pauses nor resumes a copy whose job already ended", () => {
		useDriveJobsStore.setState({
			jobs: { c1: { ...createCopyJob("c1", { uuid: null, name: "Cloud Drive" }, 1), outcome: { status: "cancelled" } } }
		})
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "c1", direction: "copy", status: "copying" })] })

		setTransferPaused("c1", true)

		expect(sdkPause).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers[0]?.paused).toBe(false)

		useTransfersStore.getState().setPaused("c1", true)
		setTransferPaused("c1", false)

		expect(sdkResume).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers[0]?.paused).toBe(true)
	})
})

describe("archive transfers", () => {
	function seed(paused = false): void {
		useDriveJobsStore.setState({ jobs: { z: compressJob({}, "z"), x: extractJob({}, "x") } })
		useTransfersStore.setState({
			transfers: [
				makeTransfer({ id: "z", direction: "compress", status: "compressing", paused }),
				makeTransfer({ id: "x", direction: "extract", status: "extracting", paused })
			]
		})
	}

	it("records the stop an extract asked for, and always keeps for a compress, which leaves nothing", () => {
		seed()

		requestJobCancel("z", "trash")
		requestJobCancel("x", "trash")

		expect(getDriveJob("z")?.cancelRequest).toBe("keep")
		expect(getDriveJob("x")?.cancelRequest).toBe("trash")
		expect(sdkCancel.mock.calls).toEqual([["z"], ["x"]])
		expect(sdkResume).not.toHaveBeenCalled()
	})

	it("lets the first request stand", () => {
		seed()

		requestJobCancel("x", "trash")
		cancelTransfer("x")

		expect(getDriveJob("x")?.cancelRequest).toBe("trash")
		expect(sdkCancel.mock.calls).toEqual([["x"]])
	})

	it("keeps what each job made when cancelled from Cancel all", () => {
		seed()

		cancelTransfers(["z", "x"])

		expect(getDriveJob("z")?.cancelRequest).toBe("keep")
		expect(getDriveJob("x")?.cancelRequest).toBe("keep")
		expect(sdkCancel.mock.calls).toEqual([["z"], ["x"]])
	})

	// The SDK's pause wait also ends on a stop, so no resume goes first.
	it("cancels a paused archive job without resuming it", () => {
		seed(true)

		requestJobCancel("x", "keep")

		expect(sdkCancel.mock.calls).toEqual([["x"]])
		expect(sdkResume).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers.map(transfer => transfer.paused)).toEqual([true, true])
	})

	it("leaves a paused copy paused when cancelling it", () => {
		useDriveJobsStore.setState({ jobs: { c: createCopyJob("c", DESTINATION, 1) } })
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "c", direction: "copy", status: "copying", paused: true })] })

		requestJobCancel("c", "keep")

		expect(sdkCancel.mock.calls).toEqual([["c"]])
		expect(sdkResume).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers[0]?.paused).toBe(true)
	})

	it("does nothing for a job that already ended or is gone", () => {
		useDriveJobsStore.setState({ jobs: { x: extractJob({ outcome: { status: "cancelled" } }, "x") } })
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "x", direction: "extract", status: "extracting", paused: true })] })

		requestJobCancel("x", "trash")
		requestJobCancel("gone", "keep")

		expect(getDriveJob("x")?.cancelRequest).toBeNull()
		expect(sdkCancel).not.toHaveBeenCalled()
		expect(sdkResume).not.toHaveBeenCalled()
	})

	it("neither pauses nor resumes an archive job whose job already ended", () => {
		useDriveJobsStore.setState({ jobs: { x: extractJob({ outcome: { status: "cancelled" } }, "x"), z: compressJob({}, "z") } })
		useTransfersStore.setState({
			transfers: [
				makeTransfer({ id: "x", direction: "extract", status: "extracting" }),
				makeTransfer({ id: "z", direction: "compress", status: "compressing" })
			]
		})

		setTransfersPaused(["x", "z"], true)

		expect(sdkPause.mock.calls).toEqual([["z"]])
		expect(useTransfersStore.getState().transfers.map(transfer => transfer.paused)).toEqual([false, true])
	})
})

describe("cancelActiveTransfers", () => {
	it("cancels every active transfer of every direction and leaves finished ones alone", () => {
		useTransfersStore.setState({
			transfers: [
				makeTransfer({ id: "u", direction: "upload", status: "uploading" }),
				makeTransfer({ id: "d", direction: "download", status: "downloading", paused: true }),
				makeTransfer({ id: "c", direction: "copy", status: "copying" }),
				makeTransfer({ id: "done", direction: "upload", status: "done" })
			]
		})
		useDriveJobsStore.setState({ jobs: { c: createCopyJob("c", { uuid: null, name: "Cloud Drive" }, 1) } })

		cancelActiveTransfers()

		expect(sdkCancel.mock.calls).toEqual([["u"], ["d"], ["c"]])
		expect(getCopyJob("c")?.cancelRequest).toBe("keep")
	})
})

describe("setTransfersPaused / cancelTransfers", () => {
	function seed(): void {
		useDriveJobsStore.setState({
			jobs: {
				ended: { ...createCopyJob("ended", { uuid: null, name: "Cloud Drive" }, 1), outcome: { status: "cancelled" } },
				c: createCopyJob("c", { uuid: null, name: "Cloud Drive" }, 1)
			}
		})
		useTransfersStore.setState({
			transfers: [
				makeTransfer({ id: "u", direction: "upload", status: "uploading" }),
				makeTransfer({ id: "done", direction: "upload", status: "done" }),
				makeTransfer({ id: "d", direction: "download", status: "downloading" }),
				makeTransfer({ id: "ended", direction: "copy", status: "copying" }),
				makeTransfer({ id: "c", direction: "copy", status: "copying" })
			]
		})
	}

	it("pauses every eligible row in order with one store update, leaving the others as they were", () => {
		seed()

		const listener = vi.fn()
		const unsubscribe = useTransfersStore.subscribe(listener)

		setTransfersPaused(["c", "missing", "done", "ended", "u", "d"], true)
		unsubscribe()

		expect(sdkPause.mock.calls).toEqual([["c"], ["u"], ["d"]])
		expect(listener).toHaveBeenCalledTimes(1)
		expect(useTransfersStore.getState().transfers.map(transfer => [transfer.id, transfer.paused])).toEqual([
			["u", true],
			["done", false],
			["d", true],
			["ended", false],
			["c", true]
		])

		setTransfersPaused(["u", "d"], false)

		expect(sdkResume.mock.calls).toEqual([["u"], ["d"]])
		expect(useTransfersStore.getState().transfers.map(transfer => transfer.paused)).toEqual([false, false, false, false, true])
	})

	it("leaves the store untouched when no row is eligible", () => {
		seed()

		const before = useTransfersStore.getState().transfers
		const listener = vi.fn()
		const unsubscribe = useTransfersStore.subscribe(listener)

		setTransfersPaused(["missing", "done", "ended"], true)
		unsubscribe()

		expect(sdkPause).not.toHaveBeenCalled()
		expect(listener).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers).toBe(before)
	})

	it("cancels every active row in order, a copy keeping what it made", () => {
		seed()

		cancelTransfers(["d", "done", "missing", "c", "u"])

		expect(sdkCancel.mock.calls).toEqual([["d"], ["c"], ["u"]])
		expect(getCopyJob("c")?.cancelRequest).toBe("keep")
		expect(getCopyJob("ended")?.cancelRequest).toBeNull()
	})
})

describe("a browser-managed download", () => {
	it("is never paused: the browser's download manager streams it", () => {
		useTransfersStore.setState({
			transfers: [makeTransfer({ id: "sw1", direction: "download", status: "downloading", browserManaged: true })]
		})

		setTransferPaused("sw1", true)

		expect(sdkPause).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers[0]?.paused).toBe(false)
	})
})

describe("cancelUploadRuns", () => {
	it("marks every running upload run cancelled so nothing more starts, and leaves ended runs alone", () => {
		const { startUploadBatch, endUploadBatch } = useTransfersStore.getState()

		startUploadBatch({ id: "running", parentUuid: null })
		startUploadBatch({ id: "ended", parentUuid: null })
		endUploadBatch("ended")

		cancelUploadRuns()

		const { uploadBatches } = useTransfersStore.getState()

		expect(uploadBatches["running"]?.cancelled).toBe(true)
		expect(uploadBatches["ended"]?.cancelled ?? false).toBe(false)
	})

	it("runs as part of sign-out's cancel", () => {
		useTransfersStore.getState().startUploadBatch({ id: "run", parentUuid: null })

		cancelActiveTransfers()

		expect(useTransfersStore.getState().uploadBatches["run"]?.cancelled).toBe(true)
	})
})

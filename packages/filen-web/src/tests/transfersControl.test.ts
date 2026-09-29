import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Transfer } from "@/features/transfers/store/useTransfersStore"

// Same mock boundary as download.test.ts's own cancel test: the real sdk client module
// touches a Vite `?worker`, unresolvable/unwanted under node vitest.
const { sdkCancel, sdkPause, sdkResume } = vi.hoisted(() => ({ sdkCancel: vi.fn(), sdkPause: vi.fn(), sdkResume: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { cancelTransfer: sdkCancel, pauseTransfer: sdkPause, resumeTransfer: sdkResume }
}))

const { requestCopyCancel } = vi.hoisted(() => ({ requestCopyCancel: vi.fn() }))

vi.mock("@/features/drive/lib/copy", () => ({ requestCopyCancel }))

import { cancelActiveTransfers, cancelTransfer, pauseTransfer, resumeTransfer } from "@/features/transfers/lib/control"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"
import { createCopyJob } from "@/features/drive/lib/copy.logic"

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
	return {
		id: "t1",
		direction: "upload",
		name: "report.pdf",
		size: 1_024,
		bytesTransferred: 0,
		status: "uploading",
		paused: false,
		parentUuid: null,
		startedAt: 0,
		...overrides
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	useTransfersStore.setState({ transfers: [] })
	useCopyJobsStore.setState({ jobs: {} })
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

describe("pauseTransfer", () => {
	it("calls sdkApi.pauseTransfer and sets paused for an active upload-direction transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t1", direction: "upload", status: "uploading" })] })

		pauseTransfer("t1")

		expect(sdkPause.mock.calls).toEqual([["t1"]])
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t1")?.paused).toBe(true)
	})

	it("calls sdkApi.pauseTransfer and sets paused for an active download-direction transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t2", direction: "download", status: "downloading" })] })

		pauseTransfer("t2")

		expect(sdkPause.mock.calls).toEqual([["t2"]])
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t2")?.paused).toBe(true)
	})

	it("is a no-op for an id not present in the store", () => {
		pauseTransfer("missing")

		expect(sdkPause).not.toHaveBeenCalled()
	})

	it("is a no-op for an already-terminal transfer (no worker call, no setPaused)", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t3", direction: "upload", status: "done" })] })

		pauseTransfer("t3")

		expect(sdkPause).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t3")?.paused).toBe(false)
	})
})

describe("resumeTransfer", () => {
	it("calls sdkApi.resumeTransfer and clears paused for an active upload-direction transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t1", direction: "upload", status: "uploading", paused: true })] })

		resumeTransfer("t1")

		expect(sdkResume.mock.calls).toEqual([["t1"]])
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t1")?.paused).toBe(false)
	})

	it("calls sdkApi.resumeTransfer and clears paused for an active download-direction transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t2", direction: "download", status: "downloading", paused: true })] })

		resumeTransfer("t2")

		expect(sdkResume.mock.calls).toEqual([["t2"]])
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t2")?.paused).toBe(false)
	})

	it("is a no-op for an id not present in the store", () => {
		resumeTransfer("missing")

		expect(sdkResume).not.toHaveBeenCalled()
	})

	it("is a no-op for an already-terminal transfer (no worker call, no setPaused)", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t4", direction: "download", status: "error", paused: true })] })

		resumeTransfer("t4")

		expect(sdkResume).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t4")?.paused).toBe(true)
	})
})

describe("copy transfers", () => {
	it("cancels a copy keeping what it already copied", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "c1", direction: "copy", status: "copying" })] })

		cancelTransfer("c1")

		expect(requestCopyCancel).toHaveBeenCalledWith("c1", { trashCopied: false })
		expect(sdkCancel).not.toHaveBeenCalled()
	})

	it("pauses and resumes a copy through the copy job", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "c1", direction: "copy", status: "copying" })] })

		pauseTransfer("c1")

		expect(sdkPause).toHaveBeenCalledWith("c1")
		expect(useTransfersStore.getState().transfers[0]?.paused).toBe(true)

		resumeTransfer("c1")

		expect(sdkResume).toHaveBeenCalledWith("c1")
		expect(useTransfersStore.getState().transfers[0]?.paused).toBe(false)
	})

	it("is a no-op for a finished copy", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "c1", direction: "copy", status: "completedWithErrors" })] })

		cancelTransfer("c1")
		pauseTransfer("c1")

		expect(requestCopyCancel).not.toHaveBeenCalled()
		expect(sdkPause).not.toHaveBeenCalled()
	})

	// Its row stays active while what it copied moves to the trash, which has no pause.
	it("neither pauses nor resumes a copy whose job already ended", () => {
		useCopyJobsStore.setState({
			jobs: { c1: { ...createCopyJob("c1", { uuid: null, name: "Cloud Drive" }, 1), outcome: { status: "cancelled" } } }
		})
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "c1", direction: "copy", status: "copying" })] })

		pauseTransfer("c1")

		expect(sdkPause).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers[0]?.paused).toBe(false)

		useTransfersStore.getState().setPaused("c1", true)
		resumeTransfer("c1")

		expect(sdkResume).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers[0]?.paused).toBe(true)
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

		cancelActiveTransfers()

		expect(sdkCancel.mock.calls).toEqual([["u"], ["d"]])
		expect(requestCopyCancel).toHaveBeenCalledWith("c", { trashCopied: false })
	})
})

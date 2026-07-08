import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Transfer } from "@/stores/transfers"

// Same mock boundary as lib/drive/download.test.ts's own cancel test: the real sdk client module
// touches a Vite `?worker`, unresolvable/unwanted under node vitest.
const { cancelUpload, cancelDownload, pauseUpload, pauseDownload, resumeUpload, resumeDownload } = vi.hoisted(() => ({
	cancelUpload: vi.fn(),
	cancelDownload: vi.fn(),
	pauseUpload: vi.fn(),
	pauseDownload: vi.fn(),
	resumeUpload: vi.fn(),
	resumeDownload: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { cancelUpload, cancelDownload, pauseUpload, pauseDownload, resumeUpload, resumeDownload }
}))

import { cancelTransfer, pauseTransfer, resumeTransfer } from "@/lib/transfers/control"
import { useTransfersStore } from "@/stores/transfers"

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
})

describe("cancelTransfer", () => {
	it("calls sdkApi.cancelUpload for an active upload-direction transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t1", direction: "upload", status: "uploading" })] })

		cancelTransfer("t1")

		expect(cancelUpload).toHaveBeenCalledWith("t1")
		expect(cancelDownload).not.toHaveBeenCalled()
	})

	it("calls sdkApi.cancelDownload for an active download-direction transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t2", direction: "download", status: "downloading" })] })

		cancelTransfer("t2")

		expect(cancelDownload).toHaveBeenCalledWith("t2")
		expect(cancelUpload).not.toHaveBeenCalled()
	})

	it("is a no-op for an id not present in the store", () => {
		cancelTransfer("missing")

		expect(cancelUpload).not.toHaveBeenCalled()
		expect(cancelDownload).not.toHaveBeenCalled()
	})

	it("is a no-op for an already-terminal (done) transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t3", direction: "upload", status: "done" })] })

		cancelTransfer("t3")

		expect(cancelUpload).not.toHaveBeenCalled()
		expect(cancelDownload).not.toHaveBeenCalled()
	})

	it("is a no-op for an already-terminal (error) transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t4", direction: "download", status: "error" })] })

		cancelTransfer("t4")

		expect(cancelUpload).not.toHaveBeenCalled()
		expect(cancelDownload).not.toHaveBeenCalled()
	})
})

describe("pauseTransfer", () => {
	it("calls sdkApi.pauseUpload and sets paused for an active upload-direction transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t1", direction: "upload", status: "uploading" })] })

		pauseTransfer("t1")

		expect(pauseUpload).toHaveBeenCalledWith("t1")
		expect(pauseDownload).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t1")?.paused).toBe(true)
	})

	it("calls sdkApi.pauseDownload and sets paused for an active download-direction transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t2", direction: "download", status: "downloading" })] })

		pauseTransfer("t2")

		expect(pauseDownload).toHaveBeenCalledWith("t2")
		expect(pauseUpload).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t2")?.paused).toBe(true)
	})

	it("is a no-op for an id not present in the store", () => {
		pauseTransfer("missing")

		expect(pauseUpload).not.toHaveBeenCalled()
		expect(pauseDownload).not.toHaveBeenCalled()
	})

	it("is a no-op for an already-terminal transfer (no worker call, no setPaused)", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t3", direction: "upload", status: "done" })] })

		pauseTransfer("t3")

		expect(pauseUpload).not.toHaveBeenCalled()
		expect(pauseDownload).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t3")?.paused).toBe(false)
	})
})

describe("resumeTransfer", () => {
	it("calls sdkApi.resumeUpload and clears paused for an active upload-direction transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t1", direction: "upload", status: "uploading", paused: true })] })

		resumeTransfer("t1")

		expect(resumeUpload).toHaveBeenCalledWith("t1")
		expect(resumeDownload).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t1")?.paused).toBe(false)
	})

	it("calls sdkApi.resumeDownload and clears paused for an active download-direction transfer", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t2", direction: "download", status: "downloading", paused: true })] })

		resumeTransfer("t2")

		expect(resumeDownload).toHaveBeenCalledWith("t2")
		expect(resumeUpload).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t2")?.paused).toBe(false)
	})

	it("is a no-op for an id not present in the store", () => {
		resumeTransfer("missing")

		expect(resumeUpload).not.toHaveBeenCalled()
		expect(resumeDownload).not.toHaveBeenCalled()
	})

	it("is a no-op for an already-terminal transfer (no worker call, no setPaused)", () => {
		useTransfersStore.setState({ transfers: [makeTransfer({ id: "t4", direction: "download", status: "error", paused: true })] })

		resumeTransfer("t4")

		expect(resumeUpload).not.toHaveBeenCalled()
		expect(resumeDownload).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "t4")?.paused).toBe(true)
	})
})

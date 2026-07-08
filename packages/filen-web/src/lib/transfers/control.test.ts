import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Transfer } from "@/stores/transfers"

// Same mock boundary as lib/drive/download.test.ts's own cancel test: the real sdk client module
// touches a Vite `?worker`, unresolvable/unwanted under node vitest.
const { cancelUpload, cancelDownload } = vi.hoisted(() => ({
	cancelUpload: vi.fn(),
	cancelDownload: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { cancelUpload, cancelDownload } }))

import { cancelTransfer } from "@/lib/transfers/control"
import { useTransfersStore } from "@/stores/transfers"

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
	return {
		id: "t1",
		direction: "upload",
		name: "report.pdf",
		size: 1_024,
		bytesTransferred: 0,
		status: "uploading",
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

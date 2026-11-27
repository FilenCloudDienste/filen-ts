// A failed transfer runs again from what its row kept: only the failed rows, each into the directory it went to (or as
// the download it was), its old row replaced by the new run's.
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ExternalToast } from "sonner"
import type { File as SdkFile, UuidStr } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import { plainErrorDTO } from "@/lib/sdk/errors"
import { makeTransfer } from "@/tests/fixtures/transfers"
import "@/lib/i18n"

const { startUploads, startDownloads, startNativeUploads, nativeAvailable, toast } = vi.hoisted(() => ({
	startUploads: vi.fn(() => Promise.resolve()),
	startDownloads: vi.fn(() => Promise.resolve()),
	startNativeUploads: vi.fn(() => Promise.resolve()),
	nativeAvailable: vi.fn(() => false),
	toast: { success: vi.fn(), error: vi.fn<(title: string, options?: ExternalToast) => void>() }
}))

vi.mock("sonner", () => ({ toast }))
vi.mock("@/features/drive/lib/upload", () => ({ startUploads }))
vi.mock("@/features/drive/lib/download", () => ({ startDownloads }))
vi.mock("@/features/drive/queries/drive", () => ({ heicUploadConvertPreferenceCached: () => undefined }))
vi.mock("@/features/transfers/lib/nativeHost", () => ({ nativeTransfersAvailable: nativeAvailable }))
vi.mock("@/features/transfers/lib/nativeTransfers", () => ({ startNativeUploads, pickNativeUpload: vi.fn() }))

import { useTransfersStore, type Transfer } from "@/features/transfers/store/useTransfersStore"
import { canRetry, canUploadAgain, retryFailedRuns } from "@/features/transfers/lib/retry"
import { retryTransfers } from "@/features/transfers/lib/retryActions"
import { settleTransferFailure } from "@/features/transfers/lib/settle"
import { toastSummary } from "@/lib/actions/bulkToast"

const PARENT = "parent-0000-0000-0000-000000000000"
const OTHER = "other-0000-0000-0000-000000000000"
const RUN = { id: "run-a", parentUuid: PARENT }

const ITEM = narrowItem({
	uuid: "item-0000-0000-0000-000000000000" as UuidStr,
	stableUUID: undefined,
	parent: PARENT as UuidStr,
	size: 1n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "a.txt", mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } }
} satisfies SdkFile)

function file(name: string): File {
	return new File(["x"], name)
}

function failedUpload(id: string, parentUuid: string | null, handle: File | undefined, batch = RUN): Transfer {
	return makeTransfer({
		id,
		status: "error",
		parentUuid,
		batch,
		error: plainErrorDTO("nope"),
		...(handle === undefined ? {} : { retry: { kind: "upload", file: handle } })
	})
}

function ids(): string[] {
	return useTransfersStore.getState().transfers.map(transfer => transfer.id)
}

beforeEach(() => {
	vi.clearAllMocks()
	nativeAvailable.mockReturnValue(false)
	useTransfersStore.setState({ transfers: [] })
})

describe("retryTransfers", () => {
	it("re-runs only the failed rows that hold their source, one upload per directory, and drops their rows", () => {
		const a = file("a")
		const b = file("b")
		const c = file("c")
		const rows = [
			failedUpload("a", PARENT, a),
			failedUpload("b", OTHER, b),
			failedUpload("c", PARENT, c),
			failedUpload("gone", PARENT, undefined),
			makeTransfer({ id: "done", status: "done", retry: { kind: "upload", file: file("d") } })
		]
		useTransfersStore.setState({ transfers: rows })

		retryTransfers(rows)

		expect(startUploads.mock.calls).toEqual([
			[[a, c], PARENT],
			[[b], OTHER]
		])
		expect(ids()).toEqual(["gone", "done"])
	})

	it("re-runs a failed download as it was asked for", () => {
		const row = makeTransfer({ id: "dl", direction: "download", status: "error", retry: { kind: "download", items: [ITEM] } })
		useTransfersStore.setState({ transfers: [row] })

		retryTransfers([row])

		expect(startDownloads).toHaveBeenCalledExactlyOnceWith([ITEM])
		expect(startUploads).not.toHaveBeenCalled()
		expect(ids()).toEqual([])
	})

	it("uploads through the desktop app's host where it runs", () => {
		const a = file("a")
		const row = failedUpload("a", PARENT, a)
		nativeAvailable.mockReturnValue(true)
		useTransfersStore.setState({ transfers: [row] })

		retryTransfers([row])

		expect(startNativeUploads).toHaveBeenCalledExactlyOnceWith([a], PARENT)
		expect(startUploads).not.toHaveBeenCalled()
	})
})

describe("retryFailedRuns", () => {
	it("retries the retryable failures of the named runs only, read when clicked", () => {
		const a = file("a")
		useTransfersStore.setState({
			transfers: [
				failedUpload("a", PARENT, a),
				failedUpload("other-run", PARENT, file("x"), { id: "run-b", parentUuid: PARENT }),
				failedUpload("removed", PARENT, file("y"))
			]
		})

		const start = vi.fn()
		const retry = retryFailedRuns(new Set([RUN.id]), start)

		useTransfersStore.getState().remove("removed")
		retry?.()

		expect(start).toHaveBeenCalledExactlyOnceWith([a], PARENT)
		expect(ids()).toEqual(["other-run"])
	})

	it("offers nothing when no failed row can be retried", () => {
		useTransfersStore.setState({ transfers: [failedUpload("gone", PARENT, undefined)] })

		expect(retryFailedRuns(new Set([RUN.id]), vi.fn())).toBeUndefined()
	})
})

describe("what a row offers", () => {
	it("Retry with a source, Upload again for an upload without one, nothing for a directory run's row", () => {
		expect(canRetry(failedUpload("a", PARENT, file("a")))).toBe(true)
		expect(canUploadAgain(failedUpload("a", PARENT, undefined))).toBe(true)
		expect(canUploadAgain(failedUpload("run-a", PARENT, undefined))).toBe(false)
		expect(canRetry(makeTransfer({ status: "done", retry: { kind: "upload", file: file("a") } }))).toBe(false)
	})
})

describe("keeping the source on the failed row", () => {
	it("keeps it on an error, never on a cancel (its row goes) or on a row that did not fail", () => {
		const store = useTransfersStore.getState()
		const handle = file("a")
		store.addMany([makeTransfer({ id: "err" }), makeTransfer({ id: "cancel" }), makeTransfer({ id: "running" })])

		settleTransferFailure(store, "err", plainErrorDTO("nope"), { kind: "upload", file: handle })
		settleTransferFailure(store, "cancel", { ...plainErrorDTO("stop"), kind: "Cancelled" }, { kind: "upload", file: handle })
		store.setRetry("running", { kind: "upload", file: handle })

		const rows = useTransfersStore.getState().transfers

		expect(rows.find(row => row.id === "err")?.retry).toEqual({ kind: "upload", file: handle })
		expect(rows.find(row => row.id === "cancel")).toBeUndefined()
		expect(rows.find(row => row.id === "running")?.retry).toBeUndefined()
	})

	it("keeps a directory run's failed file on the row its failure adds", () => {
		const store = useTransfersStore.getState()
		const handle = file("a")
		store.startUploadBatch({ id: "dir-run", parentUuid: PARENT, directoryName: "dir" }, { files: 1, bytes: 1 })
		store.startRunFile({ id: "f", batchId: "dir-run", size: 1 })
		store.settleRunFile("f", "error", plainErrorDTO("nope"), { name: "dir/a", parentUuid: OTHER, file: handle })

		const row = useTransfersStore.getState().transfers.find(transfer => transfer.id === "f")

		expect(row).toMatchObject({ parentUuid: OTHER, retry: { kind: "upload", file: handle } })
	})
})

describe("the summary toast", () => {
	it("offers Retry failed alongside a failure only", () => {
		const retry = vi.fn()
		const keys = {
			complete: "transfers:transfersUploadSummaryComplete",
			withFailures: "transfers:transfersUploadSummaryCompleteWithFailures"
		} as const

		toastSummary(3, 2, keys, { retry })

		const options = toast.error.mock.lastCall?.[1]

		expect(toast.error.mock.lastCall?.[0]).toBe("3 files uploaded, 2 failed")
		expect(options?.action).toMatchObject({ label: "Retry failed" })

		toastSummary(3, 0, keys, { retry })

		expect(toast.success).toHaveBeenCalledExactlyOnceWith("3 files uploaded")
	})
})

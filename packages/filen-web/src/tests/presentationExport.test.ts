// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { ByteSink } from "@filen/office/core/opc"
import type { ZipDelivery } from "@/features/drive/lib/downloadAsZip"

// The page side of a deck's exports: what the export toast tells the user when an export ends early (nothing for a
// cancel, the password message for a protected deck the job cannot make, the generic one otherwise, the loading toast
// gone either way), the Blob sink keeping every byte in order across its part flushes, and the images-to-zip flow
// (a cancelled save picker is no error, a failed job ends its delivery and says so, a saved one closes the toast).

const mocks = vi.hoisted(() => ({
	toast: Object.assign(vi.fn(), { loading: vi.fn(), dismiss: vi.fn(), error: vi.fn(), warning: vi.fn(), success: vi.fn() }),
	runPresentationJob: vi.fn<(kind: string, request: unknown, session: unknown, sink: ByteSink, options: unknown) => Promise<unknown>>(),
	zipDelivery: vi.fn<() => Promise<ZipDelivery>>(),
	downloadBlob: vi.fn(),
	logError: vi.fn()
}))

vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("@/lib/log", () => ({ log: { error: mocks.logError, warn: vi.fn(), info: vi.fn() } }))
vi.mock("@/lib/downloadBlob", () => ({ downloadBlob: mocks.downloadBlob }))
vi.mock("@/features/preview/lib/accessMode", () => ({ usePreviewDownloadable: () => true }))
vi.mock("@/features/drive/lib/downloadAsZip", () => ({ zipDelivery: mocks.zipDelivery }))
vi.mock("@/features/presentation/lib/presentationJobs", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/presentation/lib/presentationJobs")>()

	return { ...actual, runPresentationJob: mocks.runPresentationJob }
})

const { exportToast } = await import("@/features/presentation/hooks/usePresentationPdfExport")
const { usePresentationImageExport } = await import("@/features/presentation/hooks/usePresentationImageExport")
const { blobSink, PresentationJobRefused } = await import("@/features/presentation/lib/presentationJobs")
const { i18n } = await import("@/lib/i18n")

const MIB = 1024 * 1024

function loadingId(): string {
	const call = mocks.toast.loading.mock.calls[0] as [string, { id: string }] | undefined

	if (call === undefined) throw new Error("no loading toast")

	return call[1].id
}

function settle(): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, 0)
	})
}

beforeEach(() => {
	mocks.runPresentationJob.mockReset()
	mocks.zipDelivery.mockReset()
})

describe("exportToast().fail", () => {
	it("shows nothing after the user cancelled", () => {
		const run = exportToast("previewPptxExportPdfProgress")

		run.controller.abort()
		run.fail(new Error("cancelled"))

		expect(mocks.toast.dismiss).toHaveBeenCalledWith(run.id)
		expect(mocks.toast.error).not.toHaveBeenCalled()
	})

	it("shows nothing for a job refused as aborted", () => {
		const run = exportToast("previewPptxExportPdfProgress")

		run.fail(new PresentationJobRefused({ kind: "refused", reason: "aborted" }))

		expect(mocks.toast.dismiss).toHaveBeenCalledWith(run.id)
		expect(mocks.toast.error).not.toHaveBeenCalled()
	})

	it("says a protected deck cannot be exported where the job refused it for its password", () => {
		const run = exportToast("previewPptxExportPdfProgress")

		run.fail(new PresentationJobRefused({ kind: "refused", reason: "passwordUnsupported" }))

		expect(mocks.toast.dismiss).toHaveBeenCalledWith(run.id)
		expect(mocks.toast.error).toHaveBeenCalledExactlyOnceWith(i18n.t("preview:previewPptxExportPasswordUnsupported"))
	})

	it("shows the generic failure for any other error and dismisses the loading toast", () => {
		const run = exportToast("previewPptxExportPdfProgress")

		// The detail is log text only: one naming the password picks no message.
		run.fail(new PresentationJobRefused({ kind: "refused", reason: "unsupported", detail: "password protection" }))
		run.fail(new PresentationJobRefused({ kind: "refused", reason: "failed" }))
		run.fail(new Error("worker crashed"))

		expect(mocks.toast.dismiss).toHaveBeenCalledWith(run.id)
		expect(mocks.toast.error).toHaveBeenCalledTimes(3)
		expect(mocks.toast.error).toHaveBeenNthCalledWith(1, i18n.t("preview:previewPptxExportFailed"))
		expect(mocks.toast.error).toHaveBeenNthCalledWith(2, i18n.t("preview:previewPptxExportFailed"))
		expect(mocks.toast.error).toHaveBeenNthCalledWith(3, i18n.t("preview:previewPptxExportFailed"))
		// A refusal for a typed reason is the user's to read; a failure and an unknown error are logged.
		expect(mocks.logError).toHaveBeenCalledTimes(2)
	})
})

describe("blobSink", () => {
	// Three 3 MiB chunks (crossing the 8 MiB part boundary) and a small tail, each filled with its own byte.
	const chunks = [3 * MIB, 3 * MIB, 3 * MIB, 17].map((size, index) => new Uint8Array(size).fill(index + 1))
	const expected = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))

	chunks.reduce((offset, chunk) => {
		expected.set(chunk, offset)

		return offset + chunk.length
	}, 0)

	it.each([true, false])("returns every byte in order with its type (closed: %s)", async closed => {
		const output = blobSink("image/png")

		for (const chunk of chunks) await output.sink.write(chunk)

		if (closed) await output.sink.close()

		const blob = output.blob()

		expect(blob.type).toBe("image/png")
		expect(blob.size).toBe(expected.length)
		// Compared as one Buffer: element-wise equality over 9 MiB is far too slow.
		expect(Buffer.from(await blob.arrayBuffer()).equals(Buffer.from(expected))).toBe(true)
	})
})

describe("exporting every slide as images", () => {
	const target = { session: {} as never, fileName: "Deck.pptx", encrypted: false, current: undefined }
	const choice = { format: "png", widthPx: 1920, scope: "all" } as const

	function delivery(): ZipDelivery {
		return {
			sink: { write: () => Promise.resolve(), close: () => Promise.resolve() },
			saved: vi.fn(() => Promise.resolve()),
			ready: () => Promise.resolve(),
			fail: vi.fn(() => Promise.resolve())
		}
	}

	function exportAll(): void {
		const start = renderHook(() => usePresentationImageExport(target)).result.current

		if (start === undefined) throw new Error("export not offered")

		start(choice)
	}

	it("dismisses without an error when the save picker is cancelled", async () => {
		mocks.zipDelivery.mockRejectedValue(new DOMException("The user aborted a request.", "AbortError"))

		exportAll()
		await settle()

		expect(mocks.runPresentationJob).not.toHaveBeenCalled()
		expect(mocks.toast.dismiss).toHaveBeenCalledWith(loadingId())
		expect(mocks.toast.error).not.toHaveBeenCalled()
	})

	it("ends the delivery and shows the error when the job fails", async () => {
		const zip = delivery()
		const error = new Error("worker crashed")

		mocks.zipDelivery.mockResolvedValue(zip)
		mocks.runPresentationJob.mockRejectedValue(error)

		exportAll()
		await settle()

		expect(zip.fail).toHaveBeenCalledExactlyOnceWith(error)
		expect(zip.saved).not.toHaveBeenCalled()
		expect(mocks.toast.dismiss).toHaveBeenCalledWith(loadingId())
		expect(mocks.toast.error).toHaveBeenCalledExactlyOnceWith(i18n.t("preview:previewPptxExportFailed"))
	})

	it("saves the archive and dismisses the toast when the job succeeds", async () => {
		const zip = delivery()

		mocks.zipDelivery.mockResolvedValue(zip)
		mocks.runPresentationJob.mockResolvedValue({ kind: "done" })

		exportAll()
		await settle()

		expect(mocks.runPresentationJob).toHaveBeenCalledWith(
			"raster",
			{ format: "png", widthPx: 1920, zip: true },
			target.session,
			zip.sink,
			expect.anything()
		)
		expect(zip.saved).toHaveBeenCalledOnce()
		expect(zip.fail).not.toHaveBeenCalled()
		expect(mocks.toast.dismiss).toHaveBeenCalledWith(loadingId())
		expect(mocks.toast.error).not.toHaveBeenCalled()
	})
})

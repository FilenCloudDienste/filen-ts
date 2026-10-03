import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type Transfer } from "@/features/transfers/store/useTransfersStore"
import {
	transferProgress,
	activeStatusLabelKey,
	finishedStatusLabelKey,
	jobDetailsLabelKey,
	transferIconKey,
	steadyEtaSeconds,
	transferRate,
	runningPercentFraction
} from "@/features/transfers/components/transferRow.logic"

function transfer(overrides: Partial<Transfer> = {}): Transfer {
	return {
		id: "t1",
		direction: "upload",
		name: "file.txt",
		size: 100,
		bytesTransferred: 0,
		status: "uploading",
		paused: false,
		parentUuid: null,
		startedAt: 0,
		...overrides
	}
}

describe("transferProgress", () => {
	it("uploading: scales bytesTransferred/size to 0-100", () => {
		expect(transferProgress(transfer({ status: "uploading", bytesTransferred: 25, size: 100 }))).toBe(25)
	})

	it("uploading: zero size never divides by zero — reads 0", () => {
		expect(transferProgress(transfer({ status: "uploading", bytesTransferred: 0, size: 0 }))).toBe(0)
	})

	it("uploading: clamps above 100 in case bytesTransferred ever overshoots size", () => {
		expect(transferProgress(transfer({ status: "uploading", bytesTransferred: 150, size: 100 }))).toBe(100)
	})

	it("done: always 100, even when bytesTransferred trails size (settle/setProgress race)", () => {
		expect(transferProgress(transfer({ status: "done", bytesTransferred: 40, size: 100 }))).toBe(100)
	})

	it("done: still 100 for a zero-byte file", () => {
		expect(transferProgress(transfer({ status: "done", bytesTransferred: 0, size: 0 }))).toBe(100)
	})

	it("error: reads the last-known ratio, same formula as uploading — no reset to 0", () => {
		expect(transferProgress(transfer({ status: "error", bytesTransferred: 60, size: 100 }))).toBe(60)
	})

	it("error: zero size never divides by zero — reads 0", () => {
		expect(transferProgress(transfer({ status: "error", bytesTransferred: 0, size: 0 }))).toBe(0)
	})
})

describe("activeStatusLabelKey", () => {
	it("upload direction reads the uploading key", () => {
		expect(activeStatusLabelKey("upload")).toBe("transfersStatusUploading")
	})

	it("download direction reads the downloading key", () => {
		expect(activeStatusLabelKey("download")).toBe("transfersStatusDownloading")
	})

	it("each drive job direction reads its own key", () => {
		expect(activeStatusLabelKey("copy")).toBe("transfersStatusCopying")
		expect(activeStatusLabelKey("compress")).toBe("transfersStatusCompressing")
		expect(activeStatusLabelKey("extract")).toBe("transfersStatusExtracting")
	})

	it("paused overrides direction, regardless of which direction", () => {
		expect(activeStatusLabelKey("upload", true)).toBe("transfersStatusPaused")
		expect(activeStatusLabelKey("download", true)).toBe("transfersStatusPaused")
		expect(activeStatusLabelKey("copy", true)).toBe("transfersStatusPaused")
		expect(activeStatusLabelKey("extract", true, true)).toBe("transfersStatusPaused")
	})

	it("a job queued for the archive slot reads as waiting", () => {
		expect(activeStatusLabelKey("compress", false, true)).toBe("transfersStatusWaitingForSlot")
		expect(activeStatusLabelKey("extract", false, true)).toBe("transfersStatusWaitingForSlot")
		expect(activeStatusLabelKey("extract", false, false)).toBe("transfersStatusExtracting")
	})

	it("unpaused (explicit false) behaves the same as the default", () => {
		expect(activeStatusLabelKey("upload", false)).toBe("transfersStatusUploading")
	})
})

describe("finishedStatusLabelKey", () => {
	it("says what a finished transfer did, in its direction", () => {
		expect(finishedStatusLabelKey("done", "upload")).toBe("transfersStatusUploaded")
		expect(finishedStatusLabelKey("done", "download")).toBe("transfersStatusDownloaded")
		expect(finishedStatusLabelKey("done", "copy")).toBe("transfersStatusCopied")
		expect(finishedStatusLabelKey("done", "compress")).toBe("transfersStatusCompressed")
		expect(finishedStatusLabelKey("done", "extract")).toBe("transfersStatusExtracted")
	})

	it("tells a partly failed job apart from a failed transfer", () => {
		expect(finishedStatusLabelKey("completedWithErrors", "copy")).toBe("transfersStatusCompletedWithErrors")
		expect(finishedStatusLabelKey("completedWithErrors", "extract")).toBe("transfersStatusCompletedWithErrors")
		expect(finishedStatusLabelKey("error", "upload")).toBe("transfersStatusError")
		expect(finishedStatusLabelKey("error", "compress")).toBe("transfersStatusError")
	})
})

describe("jobDetailsLabelKey", () => {
	it("names the progress card the row reopens by its kind", () => {
		expect(jobDetailsLabelKey("copy")).toBe("transfersRowCopyDetails")
		expect(jobDetailsLabelKey("compress")).toBe("transfersRowCompressDetails")
		expect(jobDetailsLabelKey("extract")).toBe("transfersRowExtractDetails")
	})
})

describe("transferRate", () => {
	const NOW = 1_000_000

	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	// 400 bytes over 2s: 200 B/s, and 600 bytes of 1000 left is 3s.
	const samples = [
		{ timestamp: NOW - 2000, totalBytes: 0 },
		{ timestamp: NOW, totalBytes: 400 }
	]

	it("reads the transfer's own speed off its window and the time left at that speed", () => {
		expect(transferRate(transfer({ size: 1000, bytesTransferred: 400 }), samples)).toEqual({ bytesPerSecond: 200, etaSeconds: 3 })
	})

	it("has no time left for a transfer of unknown size", () => {
		expect(transferRate(transfer({ size: 0, bytesTransferred: 400 }), samples)).toEqual({ bytesPerSecond: 200, etaSeconds: null })
	})

	it("is null while paused, once finished, or before the window holds two samples", () => {
		expect(transferRate(transfer({ size: 1000, paused: true }), samples)).toBeNull()
		expect(transferRate(transfer({ size: 1000, status: "done" }), samples)).toBeNull()
		expect(transferRate(transfer({ size: 1000 }), samples.slice(1))).toBeNull()
	})
})

describe("transferIconKey", () => {
	it("routes an image upload to the image glyph", () => {
		expect(transferIconKey(transfer({ name: "photo.png", direction: "upload" }))).toBe("image")
	})

	it("routes a pdf download to the pdf glyph, same as an upload of the identical name", () => {
		expect(transferIconKey(transfer({ name: "invoice.pdf", direction: "download" }))).toBe("pdf")
	})

	it("routes a zip (a multi-item/directory download's own suggested name) to the archive glyph", () => {
		expect(transferIconKey(transfer({ name: "Filen.zip", direction: "download" }))).toBe("archive")
	})

	it("falls back to the generic glyph for an unrecognized extension", () => {
		expect(transferIconKey(transfer({ name: "data.xyz123" }))).toBe("other")
	})

	it("is direction-agnostic — only the file name decides the icon", () => {
		const upload = transferIconKey(transfer({ name: "clip.mp4", direction: "upload" }))
		const download = transferIconKey(transfer({ name: "clip.mp4", direction: "download" }))

		expect(upload).toBe("video")
		expect(download).toBe("video")
	})
})

describe("runningPercentFraction", () => {
	it("floors, so a transfer never reads 100% before it is done", () => {
		expect(runningPercentFraction(99.5)).toBe(0.99)
		expect(runningPercentFraction(99.99)).toBe(0.99)
		expect(runningPercentFraction(100)).toBe(1)
		expect(runningPercentFraction(0)).toBe(0)
	})

	it("does not floor a whole percent a step down on float error", () => {
		expect(runningPercentFraction((29 / 100) * 100)).toBe(0.29)
	})
})

describe("steadyEtaSeconds", () => {
	it("keeps seconds under a minute", () => {
		expect(steadyEtaSeconds(42.2)).toBe(43)
	})

	it("rounds a longer wait up to a coarser step, so a steady speed reads steadily", () => {
		expect(steadyEtaSeconds(61)).toBe(65)
		expect(steadyEtaSeconds(64)).toBe(65)
		expect(steadyEtaSeconds(601)).toBe(630)
		expect(steadyEtaSeconds(3_601)).toBe(3_660)
	})
})

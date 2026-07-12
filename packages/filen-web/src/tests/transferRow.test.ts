import { describe, expect, it } from "vitest"
import { type Transfer } from "@/features/transfers/store/useTransfersStore"
import { transferProgress, activeStatusLabelKey, transferIconKey } from "@/features/transfers/components/transferRow.logic"

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

	it("paused overrides direction, regardless of which direction", () => {
		expect(activeStatusLabelKey("upload", true)).toBe("transfersStatusPaused")
		expect(activeStatusLabelKey("download", true)).toBe("transfersStatusPaused")
	})

	it("unpaused (explicit false) behaves the same as the default", () => {
		expect(activeStatusLabelKey("upload", false)).toBe("transfersStatusUploading")
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

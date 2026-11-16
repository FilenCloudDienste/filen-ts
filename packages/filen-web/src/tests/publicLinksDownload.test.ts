// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import { PREVIEW_MAX_BYTES } from "@/features/drive/lib/preview.logic"
import {
	chooseDownloadStrategy,
	anonPreviewability,
	createCollectingSink,
	PUBLIC_BUFFERED_DOWNLOAD_MAX_BYTES
} from "@/features/publicLinks/lib/download.logic"
import { linkedFileItem } from "@/tests/fixtures/sdk"

describe("chooseDownloadStrategy", () => {
	it("streams via FSA whenever available, regardless of size", () => {
		expect(
			chooseDownloadStrategy({ fsaAvailable: true, streamAvailable: false, size: PUBLIC_BUFFERED_DOWNLOAD_MAX_BYTES + 1n })
		).toEqual({ kind: "fsa" })
	})

	it("buffers a small file when FSA is unavailable", () => {
		expect(chooseDownloadStrategy({ fsaAvailable: false, streamAvailable: false, size: 1024n })).toEqual({ kind: "buffered" })
	})

	it("refuses a file over the buffered cap when FSA is unavailable", () => {
		expect(
			chooseDownloadStrategy({ fsaAvailable: false, streamAvailable: false, size: PUBLIC_BUFFERED_DOWNLOAD_MAX_BYTES + 1n })
		).toEqual({
			kind: "too-large"
		})
	})

	it("streams through the service worker without FSA, regardless of size", () => {
		expect(
			chooseDownloadStrategy({ fsaAvailable: false, streamAvailable: true, size: PUBLIC_BUFFERED_DOWNLOAD_MAX_BYTES + 1n })
		).toEqual({ kind: "stream" })
	})

	it("honors an explicit cap override", () => {
		expect(chooseDownloadStrategy({ fsaAvailable: false, streamAvailable: false, size: 2048n, cap: 1024n })).toEqual({
			kind: "too-large"
		})
	})
})

describe("anonPreviewability", () => {
	it("marks a small previewable file previewable", () => {
		expect(anonPreviewability(linkedFileItem("photo.jpg", { size: 1024n }))).toBe("previewable")
	})

	it("never caps video or audio — both stream through MediaSource", () => {
		expect(anonPreviewability(linkedFileItem("movie.mp4", { size: PREVIEW_MAX_BYTES + 1n }))).toBe("previewable")
		expect(anonPreviewability(linkedFileItem("movie.mkv", { size: PREVIEW_MAX_BYTES + 1n }))).toBe("previewable")
		expect(anonPreviewability(linkedFileItem("track.flac", { size: PREVIEW_MAX_BYTES + 1n }))).toBe("previewable")
	})

	it("caps a large image — anon images are buffered", () => {
		expect(anonPreviewability(linkedFileItem("photo.png", { size: PREVIEW_MAX_BYTES + 1n }))).toBe("too-large")
	})

	it("never caps a camera RAW — its preview is the SDK-extracted embedded JPEG, not the file's bytes", () => {
		expect(anonPreviewability(linkedFileItem("shot.NEF", { size: PREVIEW_MAX_BYTES + 1n }))).toBe("previewable")
	})

	it("reads a PDF and a deck in ranges above the buffer cap, a PDF up to the device's ranged ceiling", () => {
		expect(anonPreviewability(linkedFileItem("doc.pdf", { size: PREVIEW_MAX_BYTES + 1n }))).toBe("previewable")
		expect(anonPreviewability(linkedFileItem("deck.pptx", { size: PREVIEW_MAX_BYTES + 1n }))).toBe("previewable")
		expect(anonPreviewability(linkedFileItem("doc.pdf", { size: 8n * 1024n * 1024n * 1024n + 1n }))).toBe("too-large")
	})

	it("caps a whole-buffer document", () => {
		expect(anonPreviewability(linkedFileItem("report.docx", { size: PREVIEW_MAX_BYTES + 1n }))).toBe("too-large")
	})

	it("marks an unknown-category file unpreviewable", () => {
		expect(anonPreviewability(linkedFileItem("setup.exe", { size: 1024n }))).toBe("unpreviewable")
	})

	// Never an inline preview: a signed-in visitor browses it on request, at any size.
	it("marks an archive an archive, small or large, before any cap", () => {
		expect(anonPreviewability(linkedFileItem("photos.zip", { size: 1024n }))).toBe("archive")
		expect(anonPreviewability(linkedFileItem("backup.tar.gz", { size: PREVIEW_MAX_BYTES + 1n }))).toBe("archive")
	})
})

describe("createCollectingSink", () => {
	it("assembles written chunks into one blob", async () => {
		const sink = createCollectingSink()
		const writer = sink.writable.getWriter()

		await writer.write(new Uint8Array([1, 2, 3]))
		await writer.write(new Uint8Array([4, 5]))
		await writer.close()

		const blob = await sink.done

		expect(blob.size).toBe(5)
	})

	it("errors the stream once the incremental cap is exceeded", async () => {
		const sink = createCollectingSink(4n)
		const writer = sink.writable.getWriter()

		await writer.write(new Uint8Array([1, 2, 3]))

		await expect(writer.write(new Uint8Array([4, 5, 6]))).rejects.toThrow()
		await expect(sink.done).rejects.toThrow()
	})
})

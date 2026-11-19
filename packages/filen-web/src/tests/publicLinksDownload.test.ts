// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import { PREVIEW_MAX_BYTES } from "@/features/drive/lib/preview.logic"
import {
	chooseDownloadStrategy,
	anonPreviewability,
	createCollectingSink,
	PUBLIC_BUFFERED_DOWNLOAD_MAX_BYTES,
	publicBufferedDownloadCap
} from "@/features/publicLinks/lib/download.logic"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import { deviceProfile } from "@/lib/deviceProfile"

const MOBILE = { ...deviceProfile(), mobile: true }
const DESKTOP = { ...deviceProfile(), mobile: false }
const MIB_300 = 300n * 1_048_576n

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

	it("refuses a 300 MiB buffered file on a mobile device", () => {
		expect(chooseDownloadStrategy({ fsaAvailable: false, streamAvailable: false, size: MIB_300, profile: MOBILE })).toEqual({
			kind: "too-large"
		})
	})

	it("keeps the 1 GiB buffered ceiling on desktop", () => {
		expect(publicBufferedDownloadCap(DESKTOP)).toBe(PUBLIC_BUFFERED_DOWNLOAD_MAX_BYTES)
		expect(chooseDownloadStrategy({ fsaAvailable: false, streamAvailable: false, size: MIB_300, profile: DESKTOP })).toEqual({
			kind: "buffered"
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

	it("streams a large image the inline route can serve, and caps one it cannot (held whole)", () => {
		expect(anonPreviewability(linkedFileItem("photo.png", { size: PREVIEW_MAX_BYTES + 1n }))).toBe("previewable")
		expect(anonPreviewability(linkedFileItem("photo.jpg", { size: PREVIEW_MAX_BYTES + 1n, mime: { Decrypted: "image/jpeg" } }))).toBe(
			"previewable"
		)
		// SVG is never served under a type its name implies, and HEIC streams only where the browser decodes it.
		expect(anonPreviewability(linkedFileItem("logo.svg", { size: PREVIEW_MAX_BYTES + 1n }))).toBe("too-large")
		expect(anonPreviewability(linkedFileItem("photo.heic", { size: PREVIEW_MAX_BYTES + 1n }))).toBe("too-large")
		expect(anonPreviewability(linkedFileItem("logo.svg", { size: PREVIEW_MAX_BYTES }))).toBe("previewable")
	})

	it("reads the profile it is given, so a viewer subscribed to a probe gets its answer", () => {
		const heic = linkedFileItem("photo.heic", { size: PREVIEW_MAX_BYTES + 1n, mime: { Decrypted: "image/jpeg" } })

		expect(anonPreviewability(heic, { ...deviceProfile(), heicNative: "no" })).toBe("too-large")
		expect(anonPreviewability(heic, { ...deviceProfile(), heicNative: "yes" })).toBe("previewable")
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
		expect(anonPreviewability(linkedFileItem("setup.msi", { size: 1024n }))).toBe("unpreviewable")
	})

	// Never an inline preview: a signed-in visitor browses it on request, at any size.
	it("marks an archive an archive, small or large, before any cap", () => {
		expect(anonPreviewability(linkedFileItem("photos.zip", { size: 1024n }))).toBe("archive")
		expect(anonPreviewability(linkedFileItem("backup.tar.gz", { size: PREVIEW_MAX_BYTES + 1n }))).toBe("archive")
	})

	// Read page by page through the public-link client's reader, by any visitor, at any size.
	it("marks a comic book a comic, small or large", () => {
		for (const name of ["issue.cbz", "issue.cbr", "issue.cb7", "issue.cbt"]) {
			expect(anonPreviewability(linkedFileItem(name, { size: 1024n })), name).toBe("comic")
			expect(anonPreviewability(linkedFileItem(name, { size: PREVIEW_MAX_BYTES * 8n })), name).toBe("comic")
		}
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

	it("refuses a zip past the mobile cap", async () => {
		const cap = publicBufferedDownloadCap(MOBILE)

		expect(cap).toBe(PREVIEW_MAX_BYTES)

		const sink = createCollectingSink(cap)
		const writer = sink.writable.getWriter()

		await expect(writer.write(new Uint8Array(Number(cap) + 1))).rejects.toThrow()
		await expect(sink.done).rejects.toThrow()
		expect(sink.capExceeded()).toBe(true)
	})
})

// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import type { LinkedFile } from "@filen/sdk-rs"
import { linkedFileIntoDriveItem } from "@/features/drive/lib/item"
import {
	chooseDownloadStrategy,
	anonPreviewability,
	createCollectingSink,
	PUBLIC_BUFFERED_DOWNLOAD_MAX_BYTES
} from "@/features/publicLinks/lib/download.logic"

function makeLinkedFile(name: string, size: bigint): LinkedFile {
	return {
		uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		name: { Decrypted: name },
		mime: { Decrypted: "application/octet-stream" },
		size,
		chunks: 1n,
		region: "",
		bucket: "",
		version: 2,
		timestamp: 0n,
		fileKey: "k",
		linkedTag: true
	}
}

describe("chooseDownloadStrategy", () => {
	it("streams via FSA whenever available, regardless of size", () => {
		expect(chooseDownloadStrategy({ fsaAvailable: true, size: PUBLIC_BUFFERED_DOWNLOAD_MAX_BYTES + 1n })).toEqual({ kind: "fsa" })
	})

	it("buffers a small file when FSA is unavailable", () => {
		expect(chooseDownloadStrategy({ fsaAvailable: false, size: 1024n })).toEqual({ kind: "buffered" })
	})

	it("refuses a file over the buffered cap when FSA is unavailable", () => {
		expect(chooseDownloadStrategy({ fsaAvailable: false, size: PUBLIC_BUFFERED_DOWNLOAD_MAX_BYTES + 1n })).toEqual({
			kind: "too-large"
		})
	})

	it("honors an explicit cap override", () => {
		expect(chooseDownloadStrategy({ fsaAvailable: false, size: 2048n, cap: 1024n })).toEqual({ kind: "too-large" })
	})
})

describe("anonPreviewability", () => {
	it("marks a small previewable file previewable", () => {
		expect(anonPreviewability(linkedFileIntoDriveItem(makeLinkedFile("photo.jpg", 1024n)))).toBe("previewable")
	})

	it("caps a large media file — anon has no streaming, so it must buffer under the cap", () => {
		expect(anonPreviewability(linkedFileIntoDriveItem(makeLinkedFile("movie.mp4", 8_000_000n)), 1_000_000n)).toBe("too-large")
	})

	it("marks an unknown-category file unpreviewable", () => {
		expect(anonPreviewability(linkedFileIntoDriveItem(makeLinkedFile("archive.zip", 1024n)))).toBe("unpreviewable")
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

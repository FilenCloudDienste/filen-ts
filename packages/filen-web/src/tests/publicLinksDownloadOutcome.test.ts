// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyFile, AnyLinkedDirWithContext } from "@filen/sdk-rs"
import { linkedFileItem } from "@/tests/fixtures/sdk"

// What a public link's buffered (non-FSA) download reports: a directory's zip that outgrows the
// in-memory cap is "too large", not a bare failure; a failed zip leaves no rejection unhandled; a
// buffered file shows no share of progress it cannot know.

const { downloadLinkedDirToZipAnon, downloadLinkedFileBytesAnon, createObjectURL } = vi.hoisted(() => ({
	downloadLinkedDirToZipAnon:
		vi.fn<(dir: AnyLinkedDirWithContext, id: string, writable: WritableStream<Uint8Array>, progress: unknown) => Promise<void>>(),
	downloadLinkedFileBytesAnon: vi.fn<(file: AnyFile, id: string) => Promise<Uint8Array>>(),
	createObjectURL: vi.fn<(object: Blob | MediaSource) => string>(() => "blob:test")
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { downloadLinkedDirToZipAnon, downloadLinkedFileBytesAnon } }))
vi.mock("@/features/drive/lib/saveDownload", () => ({
	isFsaAvailable: () => false,
	isPickerCancelled: () => false,
	pickFsaTarget: vi.fn()
}))
// A 4-byte cap, so a 6-byte zip outgrows it.
vi.mock("@/features/publicLinks/lib/download.logic", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/publicLinks/lib/download.logic")>()

	return { ...actual, createCollectingSink: () => actual.createCollectingSink(4n) }
})

const { startAnonDirZipDownload, startAnonFileDownload } = await import("@/features/publicLinks/lib/download")
const { narrowToAnyFile } = await import("@/features/drive/lib/download")
const { clearPreviewCache } = await import("@/features/preview/lib/previewCache")

const dir = {} as AnyLinkedDirWithContext

async function writeZip(writable: WritableStream<Uint8Array>, chunks: number[]): Promise<void> {
	const writer = writable.getWriter()

	for (const length of chunks) {
		await writer.write(new Uint8Array(length))
	}

	await writer.close()
}

beforeEach(() => {
	vi.clearAllMocks()
	clearPreviewCache()
	URL.createObjectURL = createObjectURL
	URL.revokeObjectURL = vi.fn()
	// jsdom can't follow the save anchor.
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("startAnonDirZipDownload without FSA", () => {
	it("reports a zip that outgrows the in-memory cap as too large", async () => {
		downloadLinkedDirToZipAnon.mockImplementation((_dir, _id, writable) => writeZip(writable, [3, 3]))

		const outcome = await startAnonDirZipDownload({ dir, name: "Photos", onProgress: vi.fn() })

		expect(outcome).toEqual({ status: "too-large" })
	})

	it("saves a zip within the cap", async () => {
		downloadLinkedDirToZipAnon.mockImplementation((_dir, _id, writable) => writeZip(writable, [2, 2]))

		const outcome = await startAnonDirZipDownload({ dir, name: "Photos", onProgress: vi.fn() })

		expect(outcome).toEqual({ status: "success" })
		expect(createObjectURL).toHaveBeenCalledTimes(1)
	})

	// The collecting sink's rejection is never awaited on a failed pipe; unhandled, it fails this run.
	it("reports a worker failure as an error, leaving nothing unhandled", async () => {
		downloadLinkedDirToZipAnon.mockRejectedValue({ species: "sdk", kind: "Network", message: "offline", label: "offline" })

		const outcome = await startAnonDirZipDownload({ dir, name: "Photos", onProgress: vi.fn() })

		expect(outcome.status).toBe("error")

		await new Promise(resolve => setTimeout(resolve, 0))
	})
})

describe("startAnonFileDownload without FSA", () => {
	it("reports no share of progress until the buffered bytes are in", async () => {
		const file = narrowToAnyFile(linkedFileItem("movie.mp4", { mime: { Decrypted: "video/mp4" } }))
		const onProgress = vi.fn()

		downloadLinkedFileBytesAnon.mockResolvedValue(new Uint8Array(10))

		const outcome = await startAnonFileDownload({
			file,
			name: "movie.mp4",
			size: 10n,
			linkScope: "scope",
			onProgress
		})

		expect(outcome).toEqual({ status: "success" })
		expect(onProgress.mock.calls).toEqual([[10, 10]])
	})
})

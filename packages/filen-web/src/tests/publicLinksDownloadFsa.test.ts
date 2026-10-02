// @vitest-environment jsdom

// A public link's download into a picked file (File System Access): picking already created the file, so
// a download that fails or is cancelled deletes it instead of leaving it empty on disk.
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyLinkedDirWithContext } from "@filen/sdk-rs"
import { linkedFileItem } from "@/tests/fixtures/sdk"

const { downloadLinkedDirToZipAnon, downloadLinkedFileToWriterAnon, pickFsaTarget } = vi.hoisted(() => ({
	downloadLinkedDirToZipAnon: vi.fn<(dir: AnyLinkedDirWithContext, id: string, writable: WritableStream<Uint8Array>) => Promise<void>>(),
	downloadLinkedFileToWriterAnon: vi.fn<(file: unknown, id: string, writable: WritableStream<Uint8Array>) => Promise<void>>(),
	pickFsaTarget: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { downloadLinkedDirToZipAnon, downloadLinkedFileToWriterAnon } }))
vi.mock("@/features/drive/lib/saveDownload", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/saveDownload")>()),
	isFsaAvailable: () => true,
	pickFsaTarget
}))

const { startAnonDirZipDownload, startAnonFileDownload } = await import("@/features/publicLinks/lib/download")
const { narrowToAnyFile } = await import("@/features/drive/lib/download")
const { clearPreviewCache } = await import("@/features/preview/lib/previewCache")

const dir = {} as AnyLinkedDirWithContext
const failure = { species: "sdk", kind: "Network", message: "offline", label: "offline" }

function pick(): { remove: ReturnType<typeof vi.fn> } {
	const remove = vi.fn(() => Promise.resolve())
	const writable = Object.assign(new WritableStream<Uint8Array>(), {
		write: () => Promise.resolve(),
		seek: () => Promise.resolve(),
		truncate: () => Promise.resolve()
	})

	pickFsaTarget.mockResolvedValue({ kind: "fsa", handle: { kind: "file", name: "picked", createWritable: vi.fn(), remove }, writable })

	return { remove }
}

beforeEach(() => {
	vi.clearAllMocks()
	clearPreviewCache()
})

describe("public link downloads into a picked file", () => {
	it("deletes the picked file when the zip fails", async () => {
		const { remove } = pick()
		downloadLinkedDirToZipAnon.mockRejectedValue(failure)

		const outcome = await startAnonDirZipDownload({ dir, name: "Photos", onProgress: vi.fn() })

		expect(outcome.status).toBe("error")
		expect(remove).toHaveBeenCalledTimes(1)
	})

	it("deletes the picked file when the file download is cancelled", async () => {
		const { remove } = pick()
		downloadLinkedFileToWriterAnon.mockRejectedValue({ ...failure, kind: "Cancelled" })

		const outcome = await startAnonFileDownload({
			file: narrowToAnyFile(linkedFileItem("a.txt")),
			name: "a.txt",
			size: 4n,
			linkScope: "link",
			onProgress: vi.fn()
		})

		expect(outcome).toEqual({ status: "cancelled" })
		expect(remove).toHaveBeenCalledTimes(1)
	})

	it("keeps the file of a zip that finished", async () => {
		const { remove } = pick()
		downloadLinkedDirToZipAnon.mockImplementation(async (_dir, _id, writable) => {
			await writable.getWriter().close()
		})

		const outcome = await startAnonDirZipDownload({ dir, name: "Photos", onProgress: vi.fn() })

		expect(outcome).toEqual({ status: "success" })
		expect(remove).not.toHaveBeenCalled()
	})
})

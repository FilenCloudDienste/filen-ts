import { beforeEach, describe, expect, it, vi } from "vitest"
import { BLOCK_BYTES } from "@filen/shared/videos"
import type { AnyFile } from "@filen/sdk-rs"
import { mockLinkedFile } from "@/tests/fixtures/sdk"
import { bytesOrigin, type ByteOrigin, type OriginAccess } from "@/lib/sdk/byteOrigin"
import type { ByteReader } from "@/features/preview/lib/origin/byteReader"

// The gate's reads go through the byte layer only: a file of at most one block is loaded whole into the preview cache
// (the buffered viewer opening next reads nothing more), a larger one has a single block read. Counted here over the
// worker's whole-buffer call and a reader fake.

const downloadOriginBytes = vi.fn((origin: ByteOrigin, _access: OriginAccess, _cap: number, _token: string) =>
	Promise.resolve(new Uint8Array(origin.kind === "file" ? Number(origin.file.size) : 0).fill(7))
)
const cancelPreviewDownload = vi.fn()

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { downloadOriginBytes, cancelPreviewDownload },
	threadCount: () => 1
}))

const readerReads: { offset: number; length: number }[] = []
const closeReader = vi.fn()
const openByteReader = vi.fn(
	(origin: ByteOrigin, _token: string, _options: { access: OriginAccess; blocks?: number }): Promise<ByteReader> =>
		Promise.resolve({
			size: origin.kind === "file" ? Number(origin.file.size) : 0,
			read: (offset: number, length: number) => {
				readerReads.push({ offset, length })

				return Promise.resolve(new Uint8Array(length).fill(1))
			},
			close: closeReader
		})
)

vi.mock("@/features/preview/lib/origin/byteReader", () => ({ openByteReader }))

const probe = vi.hoisted(() => ({
	probeTransportStream: vi.fn<(file: AnyFile, access: "authed" | "anon", signal: AbortSignal) => Promise<boolean | null>>()
}))

vi.mock("@/features/preview/lib/transportStreamProbe", () => probe)

// A head read stands in for the template reads, which run in their viewers.
const decide = vi.fn((head: Uint8Array, _size: number) => (head[0] === 7 ? "wordBinary" : "notWordBinary"))

vi.mock("@/features/preview/lib/contentSniff.logic", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/preview/lib/contentSniff.logic")>()

	return { ...actual, SNIFFERS: { ...actual.SNIFFERS, wordTemplate: { mode: "head", headBytes: 512, decide } } }
})

const { runContentSniff } = await import("@/features/preview/lib/contentSniff")
const { loadOriginBytes } = await import("@/features/preview/lib/origin/loadBytes")
const { clearPreviewCache, getPreviewBytes } = await import("@/features/preview/lib/previewCache")

function fileOrigin(size: number): ByteOrigin {
	return {
		kind: "file",
		file: mockLinkedFile({ uuid: "d1000000-0000-0000-0000-000000000000", size: BigInt(size) }) as unknown as AnyFile
	}
}

function options() {
	return { access: "authed" as const, scope: "authed", signal: new AbortController().signal }
}

beforeEach(() => {
	clearPreviewCache()
	readerReads.length = 0
	vi.clearAllMocks()
})

describe("runContentSniff, head reads", () => {
	it("loads a file of at most one block whole into the preview cache, so the viewer reads nothing more", async () => {
		const origin = fileOrigin(BLOCK_BYTES)

		await expect(runContentSniff("wordTemplate", origin, "t1", options())).resolves.toBe("wordBinary")
		expect(downloadOriginBytes).toHaveBeenCalledOnce()
		expect(downloadOriginBytes).toHaveBeenCalledWith(origin, "authed", BLOCK_BYTES, "t1")
		expect(openByteReader).not.toHaveBeenCalled()
		expect(decide.mock.calls[0]?.[0]).toHaveLength(512)
		expect(getPreviewBytes("authed", "d1000000-0000-0000-0000-000000000000")).toHaveLength(BLOCK_BYTES)

		// The buffered viewer's own load.
		await loadOriginBytes(origin, "t2", { access: "authed", cap: BLOCK_BYTES, scope: "authed" })

		expect(downloadOriginBytes).toHaveBeenCalledOnce()
	})

	it("reads a single block of a larger file and closes the reader", async () => {
		const origin = fileOrigin(BLOCK_BYTES + 1)

		await expect(runContentSniff("wordTemplate", origin, "t1", options())).resolves.toBe("notWordBinary")
		expect(downloadOriginBytes).not.toHaveBeenCalled()
		expect(openByteReader).toHaveBeenCalledWith(origin, "t1", { access: "authed", blocks: 1 })
		expect(readerReads).toEqual([{ offset: 0, length: 512 }])
		expect(decide).toHaveBeenCalledWith(expect.any(Uint8Array), BLOCK_BYTES + 1)

		expect(closeReader).toHaveBeenCalledOnce()
	})

	it("reads bytes the page holds from their Blob, never through the worker", async () => {
		const origin = bytesOrigin(new Blob([new Uint8Array([7, 1, 2])]), "parent/part")

		await expect(runContentSniff("wordTemplate", origin, "t1", options())).resolves.toBe("wordBinary")
		expect(downloadOriginBytes).not.toHaveBeenCalled()
	})

	it("cancels its download under its token when called off", async () => {
		const abort = new AbortController()
		const download = Promise.withResolvers<Uint8Array<ArrayBuffer>>()

		downloadOriginBytes.mockImplementationOnce(() => download.promise)
		// The worker fails a download its token cancelled.
		cancelPreviewDownload.mockImplementationOnce(() => {
			download.reject(new Error("cancelled"))
		})

		const sniffed = runContentSniff("wordTemplate", fileOrigin(10), "t9", { access: "authed", scope: "authed", signal: abort.signal })

		abort.abort()

		await expect(sniffed).rejects.toThrow()
		expect(cancelPreviewDownload).toHaveBeenCalledWith("t9")
	})
})

describe("runContentSniff, other reads", () => {
	it("asks a .ts's probe, the player's own, of a drive or link file", async () => {
		probe.probeTransportStream.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(null)

		await expect(runContentSniff("transportStream", fileOrigin(BLOCK_BYTES * 4), "t1", options())).resolves.toBe("transportStream")
		await expect(
			runContentSniff("transportStream", { kind: "linkedFile", file: mockLinkedFile() as unknown as AnyFile }, "t2", options())
		).resolves.toBe("notTransportStream")
		await expect(runContentSniff("transportStream", fileOrigin(BLOCK_BYTES * 4), "t3", options())).rejects.toThrow()
		expect(probe.probeTransportStream.mock.calls.map(call => call[1])).toEqual(["authed", "anon", "authed"])
		expect(downloadOriginBytes).not.toHaveBeenCalled()
		expect(openByteReader).not.toHaveBeenCalled()
	})

	it("never runs a viewer's read, nor a probe on an archive's entry", async () => {
		await expect(runContentSniff("presentationTemplate", fileOrigin(10), "t1", options())).rejects.toThrow()
		await expect(runContentSniff("transportStream", bytesOrigin(new Blob([]), "a/b"), "t1", options())).rejects.toThrow()
		expect(probe.probeTransportStream).not.toHaveBeenCalled()
	})
})

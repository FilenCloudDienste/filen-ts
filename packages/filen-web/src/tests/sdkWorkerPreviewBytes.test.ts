import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Remote } from "comlink"
import type { AnyFile, StringifiedClient } from "@filen/sdk-rs"
import type { SdkWorkerApi } from "@/workers/sdk.worker"
import type { RangePortApi } from "@/lib/media/rangePort"
import { FTYP, audioEntry, box, concat, esds, hdlr, mdhd, mvhd, text, tkhd, trak, u32, zeros } from "@/tests/support/containerBytes"

// Whole-buffer preview reads stream through downloadFileToWriter into a JS buffer (never the SDK's
// downloadFile, whose whole-file Vec grows the shared wasm heap for good).
interface WriterParams {
	writer: WritableStream<Uint8Array>
	start: bigint
	end: bigint
	managedFuture: { abortSignal: AbortSignal }
}

const { exposed, fakeClient, fakeUnauth } = vi.hoisted(() => {
	const fakeUnauth = {
		downloadFileToWriter: vi.fn<(params: WriterParams) => Promise<void>>(),
		makeThumbnailFromStream: vi.fn<(params: { reader: ReadableStream<Uint8Array>; knownSize: number }) => Promise<unknown>>(),
		downloadFile: vi.fn(),
		free: vi.fn()
	}

	return {
		exposed: new Map<"api", unknown>(),
		fakeUnauth,
		fakeClient: {
			root: () => ({ uuid: "root" }),
			getUnauthed: () => fakeUnauth,
			downloadFileToWriter: vi.fn<(params: WriterParams) => Promise<void>>(),
			downloadFile: vi.fn(),
			makeThumbnailFromStream: vi.fn<(params: { reader: ReadableStream<Uint8Array>; knownSize: number }) => Promise<unknown>>(),
			free: vi.fn()
		}
	}
})

vi.mock("@filen/sdk-rs", () => ({
	default: vi.fn(),
	initThreadPool: vi.fn(),
	UnauthClient: { from_config: () => ({ free: vi.fn(), fromStringified: () => fakeClient }) }
}))

vi.mock("comlink", () => ({
	expose: (api: unknown) => {
		exposed.set("api", api)
	},
	proxy: (value: unknown) => value,
	transfer: (value: unknown) => value
}))

await import("@/workers/sdk.worker")

const api = exposed.get("api") as Remote<SdkWorkerApi>

function fileOf(size: number): AnyFile {
	return { size: BigInt(size) } as unknown as AnyFile
}

// What the SDK does: the decrypted range in small frames into the JS writer.
async function writeFrames(params: WriterParams, frames: number[][]): Promise<void> {
	const w = params.writer.getWriter()

	for (const frame of frames) {
		await w.write(new Uint8Array(frame))
	}

	await w.close()
}

beforeEach(async () => {
	await api.injectClient("session" as unknown as StringifiedClient)
})

describe("sdk worker whole-buffer preview reads", () => {
	it("streams the whole file range into one buffer", async () => {
		fakeClient.downloadFileToWriter.mockImplementation(params => writeFrames(params, [[1, 2], [3, 4], [5]]))

		const bytes = await api.downloadFileBytes(fileOf(5), "p1")

		expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5])
		expect(fakeClient.downloadFileToWriter).toHaveBeenCalledTimes(1)
		expect(fakeClient.downloadFileToWriter.mock.calls[0]?.[0]).toMatchObject({ start: 0n, end: 5n })
		expect(fakeClient.downloadFile).not.toHaveBeenCalled()
	})

	it("returns an empty buffer for a 0-byte file", async () => {
		fakeClient.downloadFileToWriter.mockImplementation(params => writeFrames(params, []))

		const bytes = await api.downloadFileBytes(fileOf(0), "p2")

		expect(bytes.length).toBe(0)
	})

	it("aborts the in-flight read through its preview token", async () => {
		let signal: AbortSignal | undefined

		fakeClient.downloadFileToWriter.mockImplementation(params => {
			signal = params.managedFuture.abortSignal

			return new Promise<void>((_resolve, reject) => {
				params.managedFuture.abortSignal.addEventListener("abort", () => {
					reject(new Error("Cancelled"))
				})
			})
		})

		const pending = api.downloadFileBytes(fileOf(3), "p3")

		await api.cancelPreviewDownload("p3")

		await expect(pending).rejects.toThrow("Cancelled")
		expect(signal?.aborted).toBe(true)
	})

	it("streams the anon read through the linked unauth client and frees it", async () => {
		fakeUnauth.downloadFileToWriter.mockImplementation(params => writeFrames(params, [[9, 8, 7]]))

		const bytes = await api.downloadLinkedFileBytesAnon(fileOf(3), "p4")

		expect(Array.from(bytes)).toEqual([9, 8, 7])
		expect(fakeUnauth.downloadFileToWriter.mock.calls[0]?.[0]).toMatchObject({ start: 0n, end: 3n })
		expect(fakeUnauth.downloadFile).not.toHaveBeenCalled()
		expect(fakeUnauth.free).toHaveBeenCalledTimes(1)
	})

	it("reads an anon byte range through the linked unauth client and frees it", async () => {
		fakeUnauth.downloadFileToWriter.mockClear()
		fakeUnauth.free.mockClear()
		fakeUnauth.downloadFileToWriter.mockImplementation(params => writeFrames(params, [[4, 5]]))

		const bytes = await api.readLinkedFileBytesRangeAnon(fileOf(10), 3, 5, "p5")

		expect(Array.from(bytes)).toEqual([4, 5])
		expect(fakeUnauth.downloadFileToWriter.mock.calls[0]?.[0]).toMatchObject({ start: 3n, end: 5n })
		expect(fakeUnauth.free).toHaveBeenCalledTimes(1)
	})

	it("aborts an anon byte range through its preview token", async () => {
		let signal: AbortSignal | undefined

		fakeUnauth.downloadFileToWriter.mockImplementation(params => {
			signal = params.managedFuture.abortSignal

			return new Promise<void>((_resolve, reject) => {
				params.managedFuture.abortSignal.addEventListener("abort", () => {
					reject(new Error("Cancelled"))
				})
			})
		})

		const pending = api.readLinkedFileBytesRangeAnon(fileOf(10), 0, 4, "p6")

		await vi.waitFor(() => {
			expect(signal).toBeDefined()
		})
		await api.cancelPreviewDownload("p6")

		await expect(pending).rejects.toThrow("Cancelled")
		expect(signal?.aborted).toBe(true)
	})

	it("finishes an anon whole read past the commit fraction, as the session's does", async () => {
		let signal: AbortSignal | undefined
		const done = Promise.withResolvers<undefined>()

		fakeUnauth.downloadFileToWriter.mockImplementation(async params => {
			signal = params.managedFuture.abortSignal

			const w = params.writer.getWriter()

			await w.write(new Uint8Array([1, 2, 3]))
			await done.promise
			await w.write(new Uint8Array([4]))
			await w.close()
		})

		const pending = api.downloadLinkedFileBytesAnon(fileOf(4), "p7")

		await vi.waitFor(() => {
			expect(signal).toBeDefined()
		})
		await api.cancelPreviewDownloadIfEarly("p7", 0.5)
		done.resolve(undefined)

		expect(Array.from(await pending)).toEqual([1, 2, 3, 4])
		expect(signal?.aborted).toBe(false)
	})

	it("decodes bytes in hand through the linked unauth client", async () => {
		fakeUnauth.makeThumbnailFromStream.mockResolvedValue({ type: "unsupported" })

		await expect(api.makeLinkedSdkThumbnailFromFileAnon(new File([new Uint8Array(3)], "a.jpg"), 1, 1, 1)).resolves.toEqual({
			type: "unsupported"
		})
		expect(fakeUnauth.makeThumbnailFromStream.mock.calls[0]?.[0]).toMatchObject({ knownSize: 3 })
		expect(fakeClient.makeThumbnailFromStream).not.toHaveBeenCalled()
	})

	it("refuses to store a public link thumbnail outside a tab's directory", async () => {
		await expect(api.storeLinkedThumbnail("../thumbnails", "u1", new Uint8Array(1))).rejects.toThrow()
	})
})

describe("sdk worker video probe", () => {
	const mp4 = concat(
		FTYP,
		box(
			"moov",
			mvhd({ duration: 2000 }),
			trak(tkhd({ id: 1 }), [mdhd({}), hdlr("soun")], audioEntry("mp4a", {}, esds(0x40, [0x11, 0x90])))
		),
		box("mdat", zeros(64))
	)

	it("reads the probe by range through the SDK and hands back only the record", async () => {
		fakeClient.downloadFileToWriter.mockImplementation(params =>
			writeFrames(params, [Array.from(mp4.subarray(Number(params.start), Number(params.end)))])
		)

		const probe = await api.readVideoProbe(fileOf(mp4.length), "uuid", "card", "v1")

		expect(probe).toMatchObject({ container: "mp4", durationSec: 2, audio: [{ codecString: "mp4a.40.2", ch: 2, rate: 48000 }] })
		expect(fakeClient.downloadFileToWriter.mock.calls[0]?.[0]).toMatchObject({ start: 0n, end: BigInt(mp4.length) })
	})

	it("resolves null for a container it does not read", async () => {
		const wave = concat(text("RIFF"), u32(100), text("WAVE"), zeros(100))

		fakeClient.downloadFileToWriter.mockImplementation(params =>
			writeFrames(params, [Array.from(wave.subarray(Number(params.start), Number(params.end)))])
		)

		expect(await api.readVideoProbe(fileOf(wave.length), "uuid", "full", "v2")).toBeNull()
	})

	it("aborts its range reads through its preview token", async () => {
		let signal: AbortSignal | undefined

		fakeClient.downloadFileToWriter.mockImplementation(params => {
			signal = params.managedFuture.abortSignal

			return new Promise<void>((_resolve, reject) => {
				params.managedFuture.abortSignal.addEventListener("abort", () => {
					reject(new Error("Cancelled"))
				})
			})
		})

		const pending = api.readVideoProbe(fileOf(mp4.length), "uuid", "full", "v3")

		await api.cancelPreviewDownload("v3")

		await expect(pending).rejects.toThrow("block read failed")
		expect(signal?.aborted).toBe(true)
	})
})

// A download that hangs until its managed future aborts.
function hangingDownload(signals: AbortSignal[]): (params: WriterParams) => Promise<void> {
	return params => {
		signals.push(params.managedFuture.abortSignal)

		return new Promise<void>((_resolve, reject) => {
			if (params.managedFuture.abortSignal.aborted) {
				reject(new Error("Cancelled"))

				return
			}

			params.managedFuture.abortSignal.addEventListener("abort", () => {
				reject(new Error("Cancelled"))
			})
		})
	}
}

describe("sdk worker preview cancels", () => {
	it("starts a read aborted when its token was cancelled before the read registered", async () => {
		const signals: AbortSignal[] = []

		fakeClient.downloadFileToWriter.mockImplementation(hangingDownload(signals))

		await api.cancelPreviewDownload("early")

		await expect(api.downloadFileBytes(fileOf(3), "early")).rejects.toThrow("Cancelled")
		expect(signals[0]?.aborted).toBe(true)
	})

	it("cancels a probe unless it is within the given blocks of its current budget", async () => {
		const signals: AbortSignal[] = []

		fakeClient.downloadFileToWriter.mockImplementation(hangingDownload(signals))

		// Nothing read yet out of a card's four blocks.
		const kept = api.readVideoProbe(fileOf(10_000_000), "uuid", "card", "keep")

		await vi.waitFor(() => {
			expect(signals).toHaveLength(1)
		})
		await api.cancelPreviewDownloadUnlessFinishing("keep", 4)
		expect(signals[0]?.aborted).toBe(false)

		await api.cancelPreviewDownloadUnlessFinishing("keep", 1)
		expect(signals[0]?.aborted).toBe(true)
		await expect(kept).rejects.toThrow()
	})

	it.each([
		{ written: 1, aborted: true },
		{ written: 5, aborted: false },
		{ written: 6, aborted: false }
	])("cancels a whole-buffer read that has $written of 10 bytes unless it is past half", async ({ written, aborted }) => {
		const signals: AbortSignal[] = []
		const hang = hangingDownload(signals)

		// The bytes reach the writer (and so the read's progress) before the download hangs.
		fakeClient.downloadFileToWriter.mockImplementation(async params => {
			await params.writer.getWriter().write(new Uint8Array(written))

			return hang(params)
		})

		const read = api.downloadFileBytes(fileOf(10), "thumb")

		await vi.waitFor(() => {
			expect(signals).toHaveLength(1)
		})
		await api.cancelPreviewDownloadIfEarly("thumb", 0.5)

		expect(signals[0]?.aborted).toBe(aborted)

		await api.cancelPreviewDownload("thumb")
		await expect(read).rejects.toThrow("Cancelled")
	})

	it("cancels a read under an unknown token whatever the fraction", async () => {
		const signals: AbortSignal[] = []

		fakeClient.downloadFileToWriter.mockImplementation(hangingDownload(signals))

		await api.cancelPreviewDownloadIfEarly("unknown", 0)

		await expect(api.downloadFileBytes(fileOf(10), "unknown")).rejects.toThrow("Cancelled")
		expect(signals[0]?.aborted).toBe(true)
	})
})

describe("sdk worker artwork from a byte range", () => {
	it("streams only the range into the decoder", async () => {
		const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1]
		const received: number[] = []

		fakeClient.downloadFileToWriter.mockImplementation(params => writeFrames(params, [jpeg.slice(0, 5), jpeg.slice(5)]))
		fakeClient.makeThumbnailFromStream.mockImplementation(async params => {
			const reader = params.reader.getReader()

			for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
				received.push(...chunk.value)
			}

			return { type: "thumbnail", thumbnail: { webpData: new Uint8Array([7]), width: 2, height: 3, fromEmbeddedPreview: false } }
		})

		const made = await api.makeArtFromRange(
			fileOf(1000),
			{ offset: 100, size: jpeg.length },
			{ maxWidth: 342, maxHeight: 513, lossyQuality: 80 },
			"art1"
		)

		expect(made).toMatchObject({ type: "thumbnail", width: 2, height: 3 })
		expect(received).toEqual(jpeg)
		expect(fakeClient.downloadFileToWriter.mock.calls[0]?.[0]).toMatchObject({ start: 100n, end: BigInt(100 + jpeg.length) })
	})

	it("answers notImage for bytes that are no image", async () => {
		fakeClient.downloadFileToWriter.mockImplementation(params => writeFrames(params, [Array.from(text("<html>not a picture</html>"))]))
		fakeClient.makeThumbnailFromStream.mockImplementation(async params => {
			const reader = params.reader.getReader()

			for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
				// Drains until the sniff errors the stream.
			}

			return { type: "unsupported" }
		})

		expect(
			await api.makeArtFromRange(fileOf(1000), { offset: 0, size: 26 }, { maxWidth: 342, maxHeight: 513, lossyQuality: 80 }, "art2")
		).toEqual({ type: "notImage" })
	})
})

// Comlink.expose (mocked above) records whatever it last exposed: after opening a range port, that is the
// port's own API.
function exposedRangePort(): RangePortApi {
	return exposed.get("api") as RangePortApi
}

function settle(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0))
}

describe("sdk worker public-link streaming", () => {
	it("serves a linked file's ranges through the unauthenticated client and frees it once the port shuts", async () => {
		const { port1 } = new MessageChannel()

		fakeUnauth.downloadFileToWriter.mockImplementation(params => writeFrames(params, [[1, 2, 3]]))
		await api.openLinkedRangePortAnon(port1, fileOf(10), "anon-port")

		const range = exposedRangePort()
		const bytes = await range.read(2, 5, 1)

		expect(Array.from(bytes)).toEqual([1, 2, 3])
		expect(fakeUnauth.downloadFileToWriter.mock.calls[0]?.[0]).toMatchObject({ start: 2n, end: 5n })
		expect(fakeClient.downloadFileToWriter).not.toHaveBeenCalled()
		expect(fakeUnauth.downloadFile).not.toHaveBeenCalled()
		expect(fakeUnauth.free).not.toHaveBeenCalled()

		range.close()
		await settle()
		await settle()

		expect(fakeUnauth.free).toHaveBeenCalledTimes(1)

		// A read that reaches the port after its shutdown never touches the freed client.
		await expect(range.read(0, 2, 2)).rejects.toThrow()
		expect(fakeUnauth.downloadFileToWriter).toHaveBeenCalledTimes(1)
		expect(fakeUnauth.free).toHaveBeenCalledTimes(1)
	})

	it("frees the client only after a read cancelled with the token has settled", async () => {
		const { port1 } = new MessageChannel()
		const signals: AbortSignal[] = []
		const release = Promise.withResolvers<undefined>()

		fakeUnauth.downloadFileToWriter.mockImplementation(async params => {
			signals.push(params.managedFuture.abortSignal)
			await release.promise
			throw new Error("Cancelled")
		})
		await api.openLinkedRangePortAnon(port1, fileOf(10), "anon-cancel")

		const pending = exposedRangePort().read(0, 4, 1)

		await vi.waitFor(() => {
			expect(signals).toHaveLength(1)
		})
		await api.cancelPreviewDownload("anon-cancel")

		expect(signals[0]?.aborted).toBe(true)
		expect(fakeUnauth.free).not.toHaveBeenCalled()

		release.resolve(undefined)
		await expect(pending).rejects.toThrow("Cancelled")
		await settle()

		expect(fakeUnauth.free).toHaveBeenCalledTimes(1)
	})

	it("probes a linked video through the unauthenticated client", async () => {
		const mp4 = concat(
			FTYP,
			box(
				"moov",
				mvhd({ duration: 2000 }),
				trak(tkhd({ id: 1 }), [mdhd({}), hdlr("soun")], audioEntry("mp4a", {}, esds(0x40, [0x11, 0x90])))
			),
			box("mdat", zeros(64))
		)

		fakeUnauth.downloadFileToWriter.mockImplementation(params =>
			writeFrames(params, [Array.from(mp4.subarray(Number(params.start), Number(params.end)))])
		)

		const probe = await api.readLinkedVideoProbeAnon(fileOf(mp4.length), "full", "anon-probe")

		expect(probe).toMatchObject({ container: "mp4", durationSec: 2 })
		expect(fakeClient.downloadFileToWriter).not.toHaveBeenCalled()
		expect(fakeUnauth.free).toHaveBeenCalledTimes(1)
	})
})

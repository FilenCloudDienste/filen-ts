import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Remote } from "comlink"
import type { AnyFile, StringifiedClient } from "@filen/sdk-rs"
import type { SdkWorkerApi } from "@/workers/sdk.worker"

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

afterEach(() => {
	vi.clearAllMocks()
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
})

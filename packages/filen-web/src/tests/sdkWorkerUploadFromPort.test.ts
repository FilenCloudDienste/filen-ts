import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Remote } from "comlink"
import type { StringifiedClient } from "@filen/sdk-rs"
import { savePortWriter } from "@filen/shared/savePort"
import type { SdkWorkerApi } from "@/workers/sdk.worker"

// The port upload against a stand-in client: a writer that fails or is cancelled mid-stream aborts the upload's
// managed future BEFORE the stream errors, so an SDK that takes an errored stream for its end never finalizes a
// truncated file. With a transfer id it is a transfer row: progress through the page's sink, and cancel/pause reach it.

interface UploadParams {
	reader: ReadableStream<Uint8Array>
	managedFuture: { abortSignal?: AbortSignal; pauseSignal?: { paused: boolean } }
	progress?: (bytes: bigint) => void
}

const { exposed, fakeClient } = vi.hoisted(() => ({
	exposed: new Map<"api", unknown>(),
	fakeClient: {
		root: () => ({ uuid: "root" }),
		uploadFileFromReader: vi.fn<(params: UploadParams) => Promise<unknown>>(),
		free: vi.fn()
	}
}))

vi.mock("@filen/sdk-rs", () => {
	class PauseSignal {
		public paused = false

		pause(): void {
			this.paused = true
		}

		resume(): void {
			this.paused = false
		}

		free(): void {
			// nothing to release in the stand-in
		}
	}

	return {
		default: vi.fn(),
		initThreadPool: vi.fn(),
		PauseSignal,
		UnauthClient: { from_config: () => ({ free: vi.fn(), fromStringified: () => fakeClient }) }
	}
})

vi.mock("comlink", () => ({
	expose: (api: unknown) => {
		exposed.set("api", api)
	},
	proxy: (value: unknown) => value,
	transfer: (value: unknown) => value
}))

await import("@/workers/sdk.worker")

const api = exposed.get("api") as Remote<SdkWorkerApi>
const channels: MessageChannel[] = []

function channel(): MessageChannel {
	const made = new MessageChannel()

	channels.push(made)

	return made
}

// Reads as the SDK does (BYOB, 64 KiB), noting whether its abort signal had fired when the stream failed.
function sdkRead(params: UploadParams, seen: { abortedWhenErrored?: boolean; bytes: number }): Promise<unknown> {
	return (async () => {
		const reader = params.reader.getReader({ mode: "byob" })

		for (;;) {
			let result: ReadableStreamReadResult<Uint8Array>

			try {
				result = await reader.read(new Uint8Array(64 * 1024))
			} catch (error) {
				seen.abortedWhenErrored = params.managedFuture.abortSignal?.aborted === true

				throw error
			}

			if (result.done) {
				return { uuid: "made" }
			}

			seen.bytes += result.value.length
		}
	})()
}

beforeEach(async () => {
	await api.injectClient("session" as unknown as StringifiedClient)
})

afterEach(() => {
	for (const made of channels.splice(0)) {
		made.port1.close()
		made.port2.close()
	}

	vi.clearAllMocks()
})

describe("uploadFileFromPort", () => {
	it("aborts the managed future before the stream errors when the writer is cancelled mid-stream", async () => {
		const { port1, port2 } = channel()
		const writer = savePortWriter(port1)
		const seen: { abortedWhenErrored?: boolean; bytes: number } = { bytes: 0 }

		fakeClient.uploadFileFromReader.mockImplementation(params => sdkRead(params, seen))

		const upload = api.uploadFileFromPort(null, "clip.mp4", "video/mp4", port2)

		await writer.write(new Uint8Array(2 * 1024 * 1024 + 10))
		await vi.waitFor(() => {
			expect(seen.bytes).toBeGreaterThan(0)
		})
		writer.abort("cancelled")

		await expect(upload).rejects.toMatchObject({ message: "save stream aborted: cancelled" })
		expect(seen.abortedWhenErrored).toBe(true)
		expect(await writer.uploaded).toBe(false)
	})

	it("never reports a file the SDK finished on an errored stream", async () => {
		const { port1, port2 } = channel()
		const writer = savePortWriter(port1)

		// The SDK bug: an errored stream read as its end, the truncated file finalized.
		fakeClient.uploadFileFromReader.mockImplementation(async params => {
			const reader = params.reader.getReader()

			try {
				for (;;) {
					if ((await reader.read()).done) break
				}
			} catch {
				// taken for EOF
			}

			return { uuid: "truncated" }
		})

		const upload = api.uploadFileFromPort(null, "clip.mp4", "video/mp4", port2)

		await writer.write(new Uint8Array(1024 * 1024))
		writer.abort("failed")

		await expect(upload).rejects.toMatchObject({ message: "save stream aborted: failed" })
	})

	it("uploads a committed stream as before", async () => {
		const { port1, port2 } = channel()
		const writer = savePortWriter(port1)
		const seen = { bytes: 0 }

		fakeClient.uploadFileFromReader.mockImplementation(params => sdkRead(params, seen))

		const upload = api.uploadFileFromPort(null, "clip.mp4", "video/mp4", port2)

		await writer.write(new Uint8Array(3 * 1024 * 1024 + 5))
		await writer.close()
		writer.commit()

		await expect(upload).resolves.toEqual({ uuid: "made" })
		expect(seen.bytes).toBe(3 * 1024 * 1024 + 5)
		expect(await writer.uploaded).toBe(true)
	})
})

describe("uploadFileFromPort as a transfer", () => {
	const sink = vi.fn<(bytesById: Record<string, number>) => Promise<void>>()

	beforeEach(async () => {
		sink.mockReset()
		sink.mockResolvedValue(undefined)
		await api.setProgressSink(sink)
	})

	it("reports its bytes under the transfer id before it settles, and pause reaches the SDK", async () => {
		const { port1, port2 } = channel()
		const writer = savePortWriter(port1)
		let paused: boolean | undefined

		fakeClient.uploadFileFromReader.mockImplementation(async params => {
			const reader = params.reader.getReader()
			let bytes = 0

			for (;;) {
				const { done, value } = await reader.read()

				if (done) break

				bytes += value.length
				params.progress?.(BigInt(bytes))

				if (paused === undefined) {
					await api.pauseTransfer("export-1")
					paused = params.managedFuture.pauseSignal?.paused
					await api.resumeTransfer("export-1")
				}
			}

			return { uuid: "made" }
		})

		const upload = api.uploadFileFromPort(null, "clip.mp4", "video/mp4", port2, { transferId: "export-1" })

		await writer.write(new Uint8Array(2 * 1024 * 1024))
		await writer.close()
		writer.commit()

		await expect(upload).resolves.toEqual({ uuid: "made" })
		expect(paused).toBe(true)
		expect(sink).toHaveBeenLastCalledWith({ "export-1": 2 * 1024 * 1024 })
	})

	it("is cancelled by cancelTransfer: the managed future aborts and the upload rejects", async () => {
		const { port1, port2 } = channel()
		const writer = savePortWriter(port1)
		let signal: AbortSignal | undefined

		fakeClient.uploadFileFromReader.mockImplementation(params => {
			signal = params.managedFuture.abortSignal

			return new Promise((_, reject) => {
				signal?.addEventListener("abort", () => {
					void params.reader.cancel()
					reject(new Error("cancelled"))
				})
			})
		})

		const upload = api.uploadFileFromPort(null, "clip.mp4", "video/mp4", port2, { transferId: "export-2" })

		await vi.waitFor(() => {
			expect(signal).toBeDefined()
		})
		await api.cancelTransfer("export-2")

		await expect(upload).rejects.toMatchObject({ message: "cancelled" })
		expect(signal?.aborted).toBe(true)
		expect(await writer.aborted).toBe("upload")
	})

	it("aborts the transfer's managed future too when the writer fails mid-stream", async () => {
		const { port1, port2 } = channel()
		const writer = savePortWriter(port1)
		const seen: { abortedWhenErrored?: boolean; bytes: number } = { bytes: 0 }

		fakeClient.uploadFileFromReader.mockImplementation(params => sdkRead(params, seen))

		const upload = api.uploadFileFromPort(null, "clip.mp4", "video/mp4", port2, { transferId: "export-3" })

		await writer.write(new Uint8Array(2 * 1024 * 1024 + 10))
		await vi.waitFor(() => {
			expect(seen.bytes).toBeGreaterThan(0)
		})
		writer.abort("failed")

		await expect(upload).rejects.toMatchObject({ message: "save stream aborted: failed" })
		expect(seen.abortedWhenErrored).toBe(true)
	})
})

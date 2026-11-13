import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Remote } from "comlink"
import type { StringifiedClient } from "@filen/sdk-rs"
import { savePortWriter } from "@filen/shared/savePort"
import type { SdkWorkerApi } from "@/workers/sdk.worker"

// The port upload against a stand-in client: a writer that fails or is cancelled mid-stream aborts the upload's
// managed future BEFORE the stream errors, so an SDK that takes an errored stream for its end never finalizes a
// truncated file.

interface UploadParams {
	reader: ReadableStream<Uint8Array>
	managedFuture: { abortSignal?: AbortSignal }
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

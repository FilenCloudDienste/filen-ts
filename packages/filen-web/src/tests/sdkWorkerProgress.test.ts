import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Remote } from "comlink"
import type { AnyFile, AnyItemWithContext, AnyLinkedDirWithContext, StringifiedClient } from "@filen/sdk-rs"
import type { SdkWorkerApi } from "@/workers/sdk.worker"

// The worker's byte-progress bridge against a stand-in client: only the wasm module and Comlink's
// expose are replaced, so the throttling and the op lifecycle are the real ones.
type BytesProgress = (bytes: bigint) => void
type ZipProgress = (bytesWritten: bigint, totalBytes: bigint, itemsProcessed: bigint, totalItems: bigint) => void

const { exposed, fakeClient, fakeUnauth } = vi.hoisted(() => {
	const fakeUnauth = {
		downloadFileToWriter: vi.fn<(params: { progress: BytesProgress }) => Promise<void>>(),
		downloadLinkedDirToZip: vi.fn<(dir: unknown, writer: unknown, progress: ZipProgress, managedFuture: unknown) => Promise<void>>(),
		free: vi.fn()
	}

	return {
		exposed: new Map<"api", unknown>(),
		fakeUnauth,
		fakeClient: {
			root: () => ({ uuid: "root" }),
			getUnauthed: () => fakeUnauth,
			uploadFileFromReader: vi.fn<(params: { progress: BytesProgress; knownSize: number | undefined }) => Promise<unknown>>(),
			downloadFileToWriter: vi.fn<(params: { progress: BytesProgress }) => Promise<void>>(),
			downloadItemsToZip: vi.fn<(items: unknown, writer: unknown, progress: ZipProgress, managedFuture: unknown) => Promise<void>>(),
			free: vi.fn()
		}
	}
})

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
const FILE = {} as AnyFile
const WRITER = {} as WritableStream<Uint8Array>

// What the SDK does: one call per 64 KiB chunk, all inside one window.
function chunks(progress: BytesProgress, count: number): void {
	for (let i = 1; i <= count; i++) {
		progress(BigInt(i))
	}
}

beforeEach(async () => {
	await api.injectClient("session" as unknown as StringifiedClient)
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
	vi.clearAllMocks()
})

describe("sdk worker byte progress", () => {
	it("posts the first and the last value of a burst, the last before the download returns", async () => {
		const onProgress = vi.fn<BytesProgress>()
		let callsAtReturn: unknown[][] = []

		fakeClient.downloadFileToWriter.mockImplementation(params => {
			chunks(params.progress, 50)

			return Promise.resolve()
		})

		await api.downloadFileToWriter(FILE, "t1", WRITER, onProgress).then(() => {
			callsAtReturn = [...onProgress.mock.calls]
		})

		expect(callsAtReturn).toEqual([[1n], [50n]])

		vi.advanceTimersByTime(1000)

		expect(onProgress).toHaveBeenCalledTimes(2)
	})

	it("keeps posting at the throttle cadence while the op runs", async () => {
		const onProgress = vi.fn<BytesProgress>()

		fakeClient.uploadFileFromReader.mockImplementation(params => {
			params.progress(1n)
			params.progress(2n)
			vi.advanceTimersByTime(100)
			params.progress(3n)

			return Promise.resolve({ uuid: "uploaded" })
		})

		const file = { name: "a.txt", size: 3, type: "", stream: () => new ReadableStream() } as unknown as File

		await expect(api.uploadFile(null, "t2", file, onProgress)).resolves.toEqual({ uuid: "uploaded" })
		expect(onProgress.mock.calls).toEqual([[1n], [2n], [3n]])
	})

	it("leaves an empty file's size unknown, so the SDK reads it to EOF rather than into an empty buffer", async () => {
		fakeClient.uploadFileFromReader.mockResolvedValue({ uuid: "uploaded" })

		const empty = { name: "empty.txt", size: 0, type: "", stream: () => new ReadableStream() } as unknown as File
		const sized = { name: "a.txt", size: 3, type: "", stream: () => new ReadableStream() } as unknown as File

		await api.uploadFile(null, "t-empty", empty, vi.fn())
		await api.uploadFile(null, "t-sized", sized, vi.fn())

		expect(fakeClient.uploadFileFromReader.mock.calls.map(([params]) => params.knownSize)).toEqual([undefined, 3])
	})

	it("posts the last value before a failed op rejects", async () => {
		const onProgress = vi.fn<BytesProgress>()

		fakeUnauth.downloadFileToWriter.mockImplementation(params => {
			chunks(params.progress, 5)

			return Promise.reject(new Error("network"))
		})

		await expect(api.downloadLinkedFileToWriterAnon(FILE, "t3", WRITER, onProgress)).rejects.toThrow("network")
		expect(onProgress.mock.calls).toEqual([[1n], [5n]])
	})

	// Zip progress rides the SDK's own channel and can land after the op resolved.
	it("passes a zip tick that lands after the op straight through", async () => {
		const onProgress = vi.fn<ZipProgress>()
		let late: ZipProgress | undefined

		fakeClient.downloadItemsToZip.mockImplementation((_items, _writer, progress) => {
			progress(1n, 10n, 0n, 2n)
			progress(5n, 10n, 1n, 2n)
			late = progress

			return Promise.resolve()
		})

		await api.downloadItemsToZip([] as AnyItemWithContext[], "t4", WRITER, onProgress)

		expect(onProgress.mock.calls).toEqual([
			[1n, 10n, 0n, 2n],
			[5n, 10n, 1n, 2n]
		])

		late?.(10n, 10n, 2n, 2n)

		expect(onProgress).toHaveBeenLastCalledWith(10n, 10n, 2n, 2n)
	})

	it("throttles an anon directory zip the same way", async () => {
		const onProgress = vi.fn<ZipProgress>()

		fakeUnauth.downloadLinkedDirToZip.mockImplementation((_dir, _writer, progress) => {
			for (let i = 1n; i <= 20n; i++) {
				progress(i, 20n, i, 20n)
			}

			return Promise.resolve()
		})

		await api.downloadLinkedDirToZipAnon({} as AnyLinkedDirWithContext, "t5", WRITER, onProgress)

		expect(onProgress.mock.calls).toEqual([
			[1n, 20n, 1n, 20n],
			[20n, 20n, 20n, 20n]
		])
	})
})

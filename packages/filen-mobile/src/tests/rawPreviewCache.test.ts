import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockWriteEmbeddedPreviewToPath, mockWriteEmbeddedPreviewFromPath, mockOfflineGetLocalFile, mockManagedFutureNew } = vi.hoisted(
	() => ({
		mockWriteEmbeddedPreviewToPath: vi.fn(),
		mockWriteEmbeddedPreviewFromPath: vi.fn(),
		mockOfflineGetLocalFile: vi.fn().mockResolvedValue(null),
		// A distinct handle per call: the SDK-call assertions compare by identity, which a shared
		// return value would make blind to a second ManagedFuture being built and threaded instead.
		mockManagedFutureNew: vi.fn((args: unknown) => ({ managedFuture: args }))
	})
)

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/sdk-rs", () => ({
	AnyFile: {
		File: class {
			tag = "File"
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		},
		Shared: class {
			tag = "Shared"
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		}
	},
	ManagedFuture: {
		new: mockManagedFutureNew
	},
	EmbeddedPreviewResult_Tags: {
		Preview: "Preview",
		NoPreview: "NoPreview"
	}
}))

// rawPreviewCache → thumbnailsHelpers → previewType reads EXPO_AUDIO_SUPPORTED_EXTENSIONS, which the
// shared constants mock lacks — spread it in (the shared file stays untouched).
vi.mock("@/constants", async () => ({
	...(await import("@/tests/mocks/constants")),
	EXPO_AUDIO_SUPPORTED_EXTENSIONS: new Set([".mp3", ".m4a", ".wav"])
}))

vi.mock("@filen/shared", async () => {
	const sharedMock = await import("@/tests/mocks/filenShared")

	// A faithful blocking mutex so the per-uuid serialization is real, as in fileCache.test.ts.
	class Semaphore {
		private counter = 0
		private readonly waiting: Array<() => void> = []
		private readonly maxCount: number

		public constructor(max = 1) {
			this.maxCount = max
		}

		public acquire(): Promise<void> {
			if (this.counter < this.maxCount) {
				this.counter++

				return Promise.resolve()
			}

			return new Promise<void>(resolve => {
				this.waiting.push(resolve)
			})
		}

		public release(): void {
			if (this.counter <= 0) {
				return
			}

			this.counter--

			const next = this.waiting.shift()

			if (next) {
				this.counter++

				next()
			}
		}
	}

	// previewType.ts (reached via thumbnailsHelpers) builds its code-extension set from this at
	// module load — pull the real one through so that import does not throw.
	const actual = await vi.importActual<typeof import("@filen/shared")>("@filen/shared")

	return {
		...sharedMock,
		Semaphore,
		CODE_FILE_EXTENSIONS: actual.CODE_FILE_EXTENSIONS,
		// gc() exercises the real eviction planner against the tiny RAW_PREVIEW_CACHE_MAX_SIZE_BYTES
		// override below, so pull it through unmocked (a stub would silently skip the size-cap pass
		// under test).
		planSizeCapEviction: actual.planSizeCapEviction
	}
})

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: vi.fn().mockResolvedValue({
			authedSdkClient: {
				writeEmbeddedPreviewToPath: mockWriteEmbeddedPreviewToPath,
				writeEmbeddedPreviewFromPath: mockWriteEmbeddedPreviewFromPath
			}
		})
	}
}))

// ForSdk strips the scheme AND percent-DECODES every segment — the form the SDK opens verbatim. The
// stub decodes for real, or a `%20` would slip past the path assertions unnoticed.
vi.mock("@/lib/paths", () => ({
	normalizeFilePathForSdk: (p: string) =>
		p
			.trim()
			.replace(/^file:\/+/, "/")
			.split("/")
			.map(segment => {
				try {
					return decodeURIComponent(segment)
				} catch {
					return segment
				}
			})
			.join("/"),
	normalizeFilePathForExpo: (p: string) => (p.startsWith("file://") ? p : `file://${p}`)
}))

// The real wrapAbortSignalForSdk returns a NEW ManagedAbortSignal (a uniffi handle), never its
// argument — so the stub must return something distinguishable from the DOM signal, or every
// assertion below naming the wrapped handle would also pass on the raw one. Same shape as
// thumbnailsSdk.test.ts.
vi.mock("@/lib/signals", () => ({
	wrapAbortSignalForSdk: vi.fn((signal: AbortSignal) => ({ wrapped: signal })),
	disposeSdkAbortSignal: vi.fn(),
	toSignalOpts: (signal?: AbortSignal) => (signal ? { signal } : undefined)
}))

// A tiny cap so the size-cap pass is exercised with ~60-byte previews instead of 3 × 64 MiB buffers.
vi.mock("@/lib/cacheEviction", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/cacheEviction")>()),
	RAW_PREVIEW_CACHE_MAX_SIZE_BYTES: 100
}))

vi.mock("@/features/offline/offline", () => ({
	default: {
		getLocalFile: mockOfflineGetLocalFile
	}
}))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

import { fs, setMtime, clearMtimes, File as MockFile } from "@/tests/mocks/expoFileSystem"
import { wrapAbortSignalForSdk, disposeSdkAbortSignal } from "@/lib/signals"
import { type DriveItemFileExtracted } from "@/types"

const DIR = "file:///shared/group.io.filen.app/rawPreviews/v1"

function makeItem(uuid: string, name = "shot.cr2", type: "file" | "sharedFile" | "sharedRootFile" = "file"): DriveItemFileExtracted {
	return {
		type,
		data: {
			uuid,
			size: 24_000_000n,
			canMakeThumbnail: true,
			undecryptable: false,
			decryptedMeta: { name, mime: "image/x-canon-cr2", modified: 1000, created: 900 }
		}
	} as unknown as DriveItemFileExtracted
}

function writePreview(uuid: string, bytes: Uint8Array = new Uint8Array([0xff, 0xd8, 0xff])): void {
	fs.set(DIR, "dir")
	fs.set(`${DIR}/${uuid}.jpg`, bytes)
}

function previewWriter(bytes: number[] = [0xff, 0xd8, 0xff, 0xe1]) {
	return async (_file: unknown, sdkPath: string) => {
		fs.set(`file://${sdkPath}`, new Uint8Array(bytes))

		return { tag: "Preview", inner: { width: 6000, height: 4000, orientation: 1, bytes: BigInt(bytes.length) } }
	}
}

// Same shape as previewWriter, for the from-path signature: (sourcePath, previewPath, ...).
function localPreviewWriter(bytes: number[] = [0xff, 0xd8, 0xff, 0xe1]) {
	return async (_sourcePath: string, previewPath: string) => {
		fs.set(`file://${previewPath}`, new Uint8Array(bytes))

		return { tag: "Preview", inner: { width: 6000, height: 4000, orientation: 1, bytes: BigInt(bytes.length) } }
	}
}

function stagingLeftovers(): string[] {
	return [...fs.keys()].filter(k => k.startsWith("file:///cache/filen-tmp/") && fs.get(k) !== "dir")
}

async function createCache(): Promise<InstanceType<typeof import("@/lib/rawPreviewCache").RawPreviewCache>> {
	const mod = await import("@/lib/rawPreviewCache")

	return new mod.RawPreviewCache()
}

beforeEach(() => {
	fs.clear()
	clearMtimes()
	vi.clearAllMocks()
	mockWriteEmbeddedPreviewToPath.mockReset().mockResolvedValue({ tag: "NoPreview" })
	mockWriteEmbeddedPreviewFromPath.mockReset().mockResolvedValue({ tag: "NoPreview" })
	mockOfflineGetLocalFile.mockReset().mockResolvedValue(null)
})

describe("RawPreviewCache", () => {
	it("creates its directory on construction", async () => {
		const cache = await createCache()

		expect(cache).toBeDefined()
		expect(fs.get(DIR)).toBe("dir")
	})

	describe("has", () => {
		it("is false on a miss and true once <uuid>.jpg exists with bytes", async () => {
			const cache = await createCache()

			expect(cache.has(makeItem("u1"))).toBe(false)

			writePreview("u1")

			expect(cache.has(makeItem("u1"))).toBe(true)
		})

		it("treats a 0-byte leftover as a miss", async () => {
			const cache = await createCache()

			writePreview("u1", new Uint8Array(0))

			expect(cache.has(makeItem("u1"))).toBe(false)
		})
	})

	describe("get", () => {
		it("returns the cached uri on a hit without calling the SDK", async () => {
			const cache = await createCache()

			writePreview("u1")

			await expect(cache.get({ item: makeItem("u1") })).resolves.toEqual({ kind: "uri", uri: `${DIR}/u1.jpg` })
			expect(mockWriteEmbeddedPreviewToPath).not.toHaveBeenCalled()
		})

		it("fills a miss: extracts into filen-tmp (plain SDK path, AnyFile.File, ManagedFuture), moves into <uuid>.jpg, keeps it", async () => {
			const cache = await createCache()
			const item = makeItem("u1")

			mockWriteEmbeddedPreviewToPath.mockImplementationOnce(previewWriter())

			const result = await cache.get({ item })

			expect(result).toEqual({ kind: "uri", uri: `${DIR}/u1.jpg` })
			// The destination survives the deferred staging cleanup (moveSync rebinds the staging
			// handle to the destination — cleanup must go by the captured staging URI, not the handle).
			expect(Array.from(fs.get(`${DIR}/u1.jpg`) as Uint8Array)).toEqual([0xff, 0xd8, 0xff, 0xe1])
			expect(cache.has(item)).toBe(true)

			const [anyFile, sdkPath, managedFuture, asyncOpts] = mockWriteEmbeddedPreviewToPath.mock.calls[0] as [
				{ tag: string; inner: unknown[] },
				string,
				unknown,
				unknown
			]

			expect(anyFile.tag).toBe("File")
			expect(anyFile.inner[0]).toBe(item.data)
			expect(sdkPath.startsWith("/cache/filen-tmp/")).toBe(true)
			expect(sdkPath.startsWith("file://")).toBe(false)
			expect(mockManagedFutureNew).toHaveBeenCalledTimes(1)
			expect(managedFuture).toBe(mockManagedFutureNew.mock.results[0]?.value)
			// No caller signal: nothing to wrap, so no uniffi handle is allocated for this call.
			expect(wrapAbortSignalForSdk).not.toHaveBeenCalled()
			expect(asyncOpts).toBeUndefined()
			expect(stagingLeftovers()).toEqual([])
		})

		it("is a hit afterwards without another SDK call", async () => {
			const cache = await createCache()
			const item = makeItem("u1")

			mockWriteEmbeddedPreviewToPath.mockImplementationOnce(previewWriter())

			await cache.get({ item })
			await cache.get({ item })

			expect(mockWriteEmbeddedPreviewToPath).toHaveBeenCalledTimes(1)
		})

		it("returns noPreview on NoPreview and caches nothing (re-probed on the next open)", async () => {
			const cache = await createCache()
			const item = makeItem("u1")

			await expect(cache.get({ item })).resolves.toEqual({ kind: "noPreview" })
			expect(fs.has(`${DIR}/u1.jpg`)).toBe(false)
			expect(cache.has(item)).toBe(false)
			expect(stagingLeftovers()).toEqual([])

			await cache.get({ item })

			expect(mockWriteEmbeddedPreviewToPath).toHaveBeenCalledTimes(2)
		})

		it("uses AnyFile.Shared for a sharedRootFile", async () => {
			const cache = await createCache()
			const item = makeItem("u2", "shot.nef", "sharedRootFile")

			mockWriteEmbeddedPreviewToPath.mockImplementationOnce(previewWriter())

			await cache.get({ item })

			const [anyFile] = mockWriteEmbeddedPreviewToPath.mock.calls[0] as [{ tag: string; inner: unknown[] }]

			expect(anyFile.tag).toBe("Shared")
			expect(anyFile.inner[0]).toBe(item.data)
		})

		it("uses AnyFile.Shared for a sharedFile too (driveItemToAnyFile maps both shared types to Shared, like fileCache)", async () => {
			const cache = await createCache()
			const item = makeItem("u3", "shot.arw", "sharedFile")

			mockWriteEmbeddedPreviewToPath.mockImplementationOnce(previewWriter())

			await cache.get({ item })

			const [anyFile] = mockWriteEmbeddedPreviewToPath.mock.calls[0] as [{ tag: string; inner: unknown[] }]

			expect(anyFile.tag).toBe("Shared")
			expect(anyFile.inner[0]).toBe(item.data)
		})

		it("threads the abort signal through wrapAbortSignalForSdk into the ManagedFuture and asyncOpts, and disposes it", async () => {
			const cache = await createCache()
			const controller = new AbortController()

			mockWriteEmbeddedPreviewToPath.mockImplementationOnce(previewWriter())

			await cache.get({ item: makeItem("u1"), signal: controller.signal })

			const wrapped = vi.mocked(wrapAbortSignalForSdk).mock.results[0]?.value
			const [futureArgs] = mockManagedFutureNew.mock.calls[0] as [{ pauseSignal: unknown; abortSignal: unknown }]
			const asyncOpts = mockWriteEmbeddedPreviewToPath.mock.calls[0]?.[3] as { signal: AbortSignal } | undefined

			expect(wrapAbortSignalForSdk).toHaveBeenCalledTimes(1)
			expect(wrapAbortSignalForSdk).toHaveBeenCalledWith(controller.signal)
			expect(mockManagedFutureNew).toHaveBeenCalledTimes(1)
			expect(futureArgs.pauseSignal).toBeUndefined()
			// Identity throughout: the SDK must get the WRAPPED uniffi handle, not the DOM signal it
			// was made from — lowering a DOM AbortSignal into the bindings has no pointer to lower.
			expect(futureArgs.abortSignal).toBe(wrapped)
			expect(mockWriteEmbeddedPreviewToPath.mock.calls[0]?.[2]).toBe(mockManagedFutureNew.mock.results[0]?.value)
			// asyncOpts carries the RAW signal: it is the JS-side cancellation, not the SDK's.
			expect(asyncOpts?.signal).toBe(controller.signal)
			expect(disposeSdkAbortSignal).toHaveBeenCalledTimes(1)
			expect(disposeSdkAbortSignal).toHaveBeenCalledWith(wrapped)
		})

		it("rethrows a transport error and leaves no staging file behind", async () => {
			const cache = await createCache()

			mockWriteEmbeddedPreviewToPath.mockImplementationOnce(async (_file: unknown, sdkPath: string) => {
				fs.set(`file://${sdkPath}`, new Uint8Array([1]))

				throw new Error("network")
			})

			await expect(cache.get({ item: makeItem("u1") })).rejects.toThrow("network")
			expect(stagingLeftovers()).toEqual([])
			expect(fs.has(`${DIR}/u1.jpg`)).toBe(false)
		})

		it("serializes concurrent gets for the same uuid (one extraction)", async () => {
			const cache = await createCache()
			const item = makeItem("u1")

			mockWriteEmbeddedPreviewToPath.mockImplementationOnce(previewWriter())

			const [a, b] = await Promise.all([cache.get({ item }), cache.get({ item })])

			expect(a).toEqual(b)
			expect(mockWriteEmbeddedPreviewToPath).toHaveBeenCalledTimes(1)
		})
	})

	// A stored-offline RAW already holds its embedded JPEG on disk; pulling the container back over the
	// ranged reader to extract it would be pointless, and impossible while offline.
	describe("get — local copy first", () => {
		function offlineCopy(uri = "file:///document/offline/v2/files/u1.cr2"): string {
			fs.set(uri, new Uint8Array([1, 2, 3]))
			mockOfflineGetLocalFile.mockResolvedValueOnce(new MockFile(uri))

			return uri
		}

		it("extracts from the offline copy and never touches the remote call", async () => {
			const cache = await createCache()
			const item = makeItem("u1")

			offlineCopy()
			mockWriteEmbeddedPreviewFromPath.mockImplementationOnce(localPreviewWriter())

			await expect(cache.get({ item })).resolves.toEqual({ kind: "uri", uri: `${DIR}/u1.jpg` })

			expect(mockWriteEmbeddedPreviewToPath).not.toHaveBeenCalled()
			expect(mockWriteEmbeddedPreviewFromPath).toHaveBeenCalledTimes(1)
			expect(Array.from(fs.get(`${DIR}/u1.jpg`) as Uint8Array)).toEqual([0xff, 0xd8, 0xff, 0xe1])
			expect(stagingLeftovers()).toEqual([])
		})

		// The SDK opens both paths verbatim — a percent-encoded URI is an ENOENT, not a preview.
		it("passes DECODED plain paths for both the source and the destination", async () => {
			const cache = await createCache()

			offlineCopy("file:///document/offline/v2/files/IMG%201234.cr2")
			mockWriteEmbeddedPreviewFromPath.mockImplementationOnce(localPreviewWriter())

			await cache.get({ item: makeItem("u1") })

			const [sourcePath, previewPath] = mockWriteEmbeddedPreviewFromPath.mock.calls[0] as [string, string]

			expect(sourcePath).toBe("/document/offline/v2/files/IMG 1234.cr2")
			expect(previewPath.startsWith("/cache/filen-tmp/")).toBe(true)
			expect(previewPath.startsWith("file://")).toBe(false)
		})

		it("threads the same ManagedFuture and asyncOpts through the local call, and disposes the signal", async () => {
			const cache = await createCache()
			const controller = new AbortController()

			offlineCopy()
			mockWriteEmbeddedPreviewFromPath.mockImplementationOnce(localPreviewWriter())

			await cache.get({ item: makeItem("u1"), signal: controller.signal })

			const wrapped = vi.mocked(wrapAbortSignalForSdk).mock.results[0]?.value
			const [futureArgs] = mockManagedFutureNew.mock.calls[0] as [{ pauseSignal: unknown; abortSignal: unknown }]
			const asyncOpts = mockWriteEmbeddedPreviewFromPath.mock.calls[0]?.[3] as { signal: AbortSignal } | undefined

			expect(wrapAbortSignalForSdk).toHaveBeenCalledTimes(1)
			expect(wrapAbortSignalForSdk).toHaveBeenCalledWith(controller.signal)
			expect(mockManagedFutureNew).toHaveBeenCalledTimes(1)
			expect(futureArgs.pauseSignal).toBeUndefined()
			expect(futureArgs.abortSignal).toBe(wrapped)
			expect(mockWriteEmbeddedPreviewFromPath.mock.calls[0]?.[2]).toBe(mockManagedFutureNew.mock.results[0]?.value)
			expect(asyncOpts?.signal).toBe(controller.signal)
			expect(disposeSdkAbortSignal).toHaveBeenCalledTimes(1)
			expect(disposeSdkAbortSignal).toHaveBeenCalledWith(wrapped)
		})

		it("answers noPreview from the local copy without falling back to the network", async () => {
			const cache = await createCache()

			offlineCopy()

			await expect(cache.get({ item: makeItem("u1") })).resolves.toEqual({ kind: "noPreview" })
			expect(mockWriteEmbeddedPreviewToPath).not.toHaveBeenCalled()
		})

		it("uses the remote call when the offline entry has no bytes on disk", async () => {
			const cache = await createCache()

			// The index still names the file but its data is gone — `exists` is the only trusted check.
			mockOfflineGetLocalFile.mockResolvedValueOnce(new MockFile("file:///document/offline/v2/files/u1.cr2"))
			mockWriteEmbeddedPreviewToPath.mockImplementationOnce(previewWriter())

			await expect(cache.get({ item: makeItem("u1") })).resolves.toEqual({ kind: "uri", uri: `${DIR}/u1.jpg` })
			expect(mockWriteEmbeddedPreviewFromPath).not.toHaveBeenCalled()
		})

		it("rethrows a local extraction error and leaves no staging file behind", async () => {
			const cache = await createCache()

			offlineCopy()
			mockWriteEmbeddedPreviewFromPath.mockImplementationOnce(async (_source: unknown, previewPath: string) => {
				fs.set(`file://${previewPath}`, new Uint8Array([1]))

				throw new Error("decode failed")
			})

			await expect(cache.get({ item: makeItem("u1") })).rejects.toThrow("decode failed")
			expect(stagingLeftovers()).toEqual([])
			expect(fs.has(`${DIR}/u1.jpg`)).toBe(false)
		})
	})

	describe("gc", () => {
		it("ages previews out after 24h by lastModified and keeps fresh ones", async () => {
			const cache = await createCache()

			writePreview("old")
			writePreview("fresh")
			setMtime(`${DIR}/old.jpg`, Date.now() - 25 * 60 * 60 * 1000)
			setMtime(`${DIR}/fresh.jpg`, Date.now())

			await cache.gc()

			expect(fs.has(`${DIR}/old.jpg`)).toBe(false)
			expect(fs.has(`${DIR}/fresh.jpg`)).toBe(true)
		})

		it("evicts the oldest previews past RAW_PREVIEW_CACHE_MAX_SIZE_BYTES (mocked to 100), never the newest", async () => {
			const cache = await createCache()
			const sixtyBytes = new Uint8Array(60)

			writePreview("oldest", sixtyBytes)
			writePreview("middle", sixtyBytes)
			writePreview("newest", sixtyBytes)
			setMtime(`${DIR}/oldest.jpg`, Date.now() - 3000)
			setMtime(`${DIR}/middle.jpg`, Date.now() - 2000)
			setMtime(`${DIR}/newest.jpg`, Date.now() - 1000)

			await cache.gc()

			// 180 B > 100 B: oldest goes (120 B), middle goes (60 B ≤ 100 B), newest is never touched.
			expect(fs.has(`${DIR}/oldest.jpg`)).toBe(false)
			expect(fs.has(`${DIR}/middle.jpg`)).toBe(false)
			expect(fs.has(`${DIR}/newest.jpg`)).toBe(true)
		})

		it("removes stray non-jpg files and 0-byte leftovers", async () => {
			const cache = await createCache()

			writePreview("empty", new Uint8Array(0))
			fs.set(`${DIR}/stray.tmp`, new Uint8Array([1]))

			await cache.gc()

			expect(fs.has(`${DIR}/empty.jpg`)).toBe(false)
			expect(fs.has(`${DIR}/stray.tmp`)).toBe(false)
		})

		it("keeps an entry a concurrent get() refilled between the two passes", async () => {
			const cache = await createCache()
			const item = makeItem("u1")
			let finishExtraction!: () => void

			mockWriteEmbeddedPreviewToPath.mockImplementationOnce(
				(_file: unknown, sdkPath: string) =>
					new Promise(resolve => {
						finishExtraction = () => {
							fs.set(`file://${sdkPath}`, new Uint8Array([0xff, 0xd8, 0xff, 0xe1]))

							// The move stamps the destination — the refill is now the newest entry.
							setMtime(`${DIR}/u1.jpg`, Date.now())

							resolve({ tag: "Preview", inner: { width: 1, height: 1, orientation: 1, bytes: 4n } })
						}
					})
			)

			// get() holds the u1 mutex across the extraction, so gc's pass 2 queues behind the refill.
			const getPromise = cache.get({ item })

			await new Promise(resolve => setTimeout(resolve, 0))

			// What gc's mutex-less pass 1 sees on disk: long expired, so u1.jpg is selected for deletion.
			writePreview("u1", new Uint8Array(60))
			setMtime(`${DIR}/u1.jpg`, Date.now() - 25 * 60 * 60 * 1000)

			const gcPromise = cache.gc()

			await new Promise(resolve => setTimeout(resolve, 0))

			finishExtraction()

			await expect(getPromise).resolves.toEqual({ kind: "uri", uri: `${DIR}/u1.jpg` })
			await gcPromise

			// Pass 2 re-reads under the mutex: the refilled preview is fresh and non-empty, so the
			// uri get() just handed out still resolves.
			expect(fs.has(`${DIR}/u1.jpg`)).toBe(true)
			expect(Array.from(fs.get(`${DIR}/u1.jpg`) as Uint8Array)).toEqual([0xff, 0xd8, 0xff, 0xe1])
		})

		it("returns immediately when the directory does not exist", async () => {
			const cache = await createCache()

			fs.delete(DIR)

			await expect(cache.gc()).resolves.toBeUndefined()
		})
	})

	describe("clear / size", () => {
		it("clear() wipes and recreates the directory; size() sums the previews", async () => {
			const cache = await createCache()

			writePreview("a", new Uint8Array(7))
			writePreview("b", new Uint8Array(13))

			expect(cache.size()).toBe(20)

			await cache.clear()

			expect(fs.get(DIR)).toBe("dir")
			expect(cache.size()).toBe(0)
			expect(cache.has(makeItem("a"))).toBe(false)
		})

		it("clear() waits for an in-flight get() (ClearBarrier)", async () => {
			const cache = await createCache()
			let finishExtraction!: () => void

			mockWriteEmbeddedPreviewToPath.mockImplementationOnce(
				(_file: unknown, sdkPath: string) =>
					new Promise(resolve => {
						finishExtraction = () => {
							fs.set(`file://${sdkPath}`, new Uint8Array([1]))
							resolve({ tag: "Preview", inner: { width: 1, height: 1, orientation: 1, bytes: 1n } })
						}
					})
			)

			const getPromise = cache.get({ item: makeItem("u1") })

			await new Promise(resolve => setTimeout(resolve, 0))

			let cleared = false
			const clearPromise = cache.clear().then(() => {
				cleared = true
			})

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(cleared).toBe(false)

			finishExtraction()

			await getPromise
			await clearPromise

			expect(cleared).toBe(true)
		})
	})
})

import { vi, describe, it, expect, beforeEach } from "vitest"

const {
	mockSaveAsync,
	mockRenderAsync,
	mockResize,
	mockRotate,
	mockManipulate,
	mockRelease,
	mockGetThumbnailAsync,
	mockMakeThumbnailInMemory,
	mockMakeThumbnailFromPath,
	mockManagedFutureNew,
	mockWrapAbortSignalForSdk,
	mockDisposeSdkAbortSignal,
	mockGetSdkClients,
	mockGetFileUrl,
	mockHttpStoreState,
	mockHttpStoreSubscribers,
	mockIsOnline,
	mockOnlineSubscribers,
	mockSweepStaleThumbnailVersions,
	mockEnsureDirectory
} = vi.hoisted(() => {
	const mockRelease = vi.fn()
	const mockSaveAsync = vi.fn().mockResolvedValue({ uri: "file:///cache/manipulated.jpg" })
	const mockRenderAsync = vi.fn().mockResolvedValue({ saveAsync: mockSaveAsync, release: mockRelease })
	const mockResize = vi.fn().mockReturnValue({ renderAsync: mockRenderAsync, release: mockRelease })
	const mockRotate = vi.fn()
	const mockManipulate = vi.fn().mockReturnValue({
		resize: mockResize,
		rotate: mockRotate,
		renderAsync: mockRenderAsync,
		release: mockRelease
	})

	const mockGetThumbnailAsync = vi.fn().mockResolvedValue({ uri: "file:///cache/vidframe.jpg", width: 1920, height: 1080 })

	const mockMakeThumbnailInMemory = vi.fn()
	const mockMakeThumbnailFromPath = vi.fn()
	const mockGetSdkClients = vi.fn().mockResolvedValue({
		authedSdkClient: {
			makeThumbnailInMemory: mockMakeThumbnailInMemory,
			makeThumbnailFromPath: mockMakeThumbnailFromPath
		}
	})

	const mockManagedFutureNew = vi.fn((args: unknown) => ({ managedFuture: args }))
	const mockWrapAbortSignalForSdk = vi.fn((signal: AbortSignal) => ({ wrapped: signal }))
	const mockDisposeSdkAbortSignal = vi.fn()

	const mockGetFileUrl = vi.fn(
		(file: { inner?: [{ uuid?: string }] }) => `http://localhost:8080/file/${file.inner?.[0]?.uuid ?? "unknown"}`
	)

	const mockHttpStoreState: {
		port: number | null
		getFileUrl: typeof mockGetFileUrl | null
	} = {
		port: 8080,
		getFileUrl: mockGetFileUrl
	}

	const mockHttpStoreSubscribers = new Set<(state: any) => void>()

	const mockIsOnline = vi.fn(() => true)
	const mockOnlineSubscribers = new Set<(online: boolean) => void>()

	const mockSweepStaleThumbnailVersions = vi.fn()
	const mockEnsureDirectory = vi.fn()

	return {
		mockSaveAsync,
		mockRenderAsync,
		mockResize,
		mockRotate,
		mockManipulate,
		mockRelease,
		mockGetThumbnailAsync,
		mockMakeThumbnailInMemory,
		mockMakeThumbnailFromPath,
		mockManagedFutureNew,
		mockWrapAbortSignalForSdk,
		mockDisposeSdkAbortSignal,
		mockGetSdkClients,
		mockGetFileUrl,
		mockHttpStoreState,
		mockHttpStoreSubscribers,
		mockIsOnline,
		mockOnlineSubscribers,
		mockSweepStaleThumbnailVersions,
		mockEnsureDirectory
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("expo-image-manipulator", () => ({
	ImageManipulator: {
		manipulate: mockManipulate
	},
	SaveFormat: {
		JPEG: "jpeg",
		PNG: "png",
		WEBP: "webp"
	}
}))

vi.mock("expo-video-thumbnails", () => ({
	getThumbnailAsync: mockGetThumbnailAsync
}))

// Mirrors the generated bindings: AnyFile variants are classes with `tag` + `inner`, the result
// enum's tags are string-valued (filen_sdk_rs.ts:12241-12246).
vi.mock("@filen/sdk-rs", () => {
	class TaggedUnion {
		tag: string
		inner: unknown[]
		constructor(tag: string, value: unknown) {
			this.tag = tag
			this.inner = [value]
		}
	}

	return {
		AnyFile: {
			File: class extends TaggedUnion {
				constructor(file: unknown) {
					super("File", file)
				}
			},
			Shared: class extends TaggedUnion {
				constructor(file: unknown) {
					super("Shared", file)
				}
			}
		},
		MakeThumbnailInMemoryResult_Tags: {
			Thumbnail: "Thumbnail",
			Unsupported: "Unsupported",
			OverBudget: "OverBudget",
			Corrupt: "Corrupt"
		},
		// A plain record, not a uniffi handle — nothing to dispose.
		ManagedFuture: {
			new: mockManagedFutureNew
		}
	}
})

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@/stores/useHttp.store", () => ({
	default: {
		getState: () => mockHttpStoreState,
		subscribe: (...args: unknown[]) => {
			if (typeof args[1] === "function") {
				const selector = args[0] as (state: typeof mockHttpStoreState) => unknown
				const listener = args[1] as (value: unknown, prevValue: unknown) => void
				let prevValue = selector(mockHttpStoreState)

				const wrappedListener = (state: typeof mockHttpStoreState) => {
					const nextValue = selector(state)
					const prev = prevValue

					prevValue = nextValue

					listener(nextValue, prev)
				}

				mockHttpStoreSubscribers.add(wrappedListener)

				return () => {
					mockHttpStoreSubscribers.delete(wrappedListener)
				}
			}

			const listener = args[0] as (state: typeof mockHttpStoreState) => void

			mockHttpStoreSubscribers.add(listener)

			return () => {
				mockHttpStoreSubscribers.delete(listener)
			}
		}
	}
}))

vi.mock("@/lib/utils", () => ({}))

// Faithful on the one axis these tests assert: ForSdk strips the scheme AND percent-DECODES every
// segment, which is the form the SDK opens verbatim. A stub that only stripped "file://" would let a
// `%20` through unnoticed — the exact silent-ENOENT this pipeline has to avoid. ForExpo is the same
// decode followed by an encode, NOT an encode alone: an encoded URI is its fixed point, while a
// decoded path carrying a literal `%20` decodes a second time. A stub that only added the scheme
// could not express that, so it could not catch it either.
vi.mock("@/lib/paths", () => {
	const forSdk = (path: string) =>
		path
			.replace(/^file:\/+/, "/")
			.split("/")
			.map(segment => {
				try {
					return decodeURIComponent(segment)
				} catch {
					return segment
				}
			})
			.join("/")

	return {
		normalizeFilePathForExpo: vi.fn(
			(path: string) =>
				`file://${forSdk(path)
					.split("/")
					.map(segment => (segment.length > 0 ? encodeURIComponent(segment) : segment))
					.join("/")}`
		),
		normalizeFilePathForSdk: vi.fn(forSdk)
	}
})

vi.mock("@/lib/signals", () => ({
	toSignalOpts: (signal?: AbortSignal) => (signal ? { signal } : undefined),
	wrapAbortSignalForSdk: mockWrapAbortSignalForSdk,
	disposeSdkAbortSignal: mockDisposeSdkAbortSignal
}))

vi.mock("@/features/offline/offline", () => ({
	default: {
		getLocalFile: vi.fn().mockResolvedValue(null)
	}
}))

vi.mock("@/lib/fileCache", () => ({
	default: {
		has: vi.fn().mockResolvedValue(false),
		get: vi.fn().mockResolvedValue(null)
	}
}))

// Partial on purpose: every other helper stays the real one (the error classes keep their identity,
// so `instanceof` still holds), and ensureDirectory keeps creating the directory — the spy exists
// only to observe WHEN restore() reaches it relative to the version sweep.
vi.mock("@/lib/thumbnailsHelpers", async importOriginal => {
	const actual = await importOriginal<typeof import("@/lib/thumbnailsHelpers")>()

	mockEnsureDirectory.mockImplementation(actual.ensureDirectory)

	return {
		...actual,
		ensureDirectory: mockEnsureDirectory
	}
})

// The real sweep carries its own once-per-process flag, which would make it unobservable after the
// first test in any file that imports it.
vi.mock("@/lib/thumbnailsVersionSweep", () => ({
	sweepStaleThumbnailVersions: mockSweepStaleThumbnailVersions
}))

// The shared mock (untouched) lacks the audio set that previewType.ts now reaches through
// thumbnailsHelpers.getThumbnailKind — spread it in here rather than widening the shared file.
vi.mock("@/constants", async () => ({
	...(await import("@/tests/mocks/constants")),
	EXPO_AUDIO_SUPPORTED_EXTENSIONS: new Set([".mp3", ".m4a", ".wav"])
}))

vi.mock("@tanstack/react-query", () => ({
	onlineManager: {
		isOnline: mockIsOnline,
		subscribe: (listener: (online: boolean) => void) => {
			mockOnlineSubscribers.add(listener)

			return () => {
				mockOnlineSubscribers.delete(listener)
			}
		}
	}
}))

import thumbnails, { DEFAULT_WIDTH, DEFAULT_QUALITY, VERSION } from "@/lib/thumbnails"
import { THUMBNAIL_MAX_WIDTH, THUMBNAIL_MAX_HEIGHT, THUMBNAIL_LOSSY_QUALITY } from "@/lib/thumbnailsSdk"
import { fs, Directory, Paths } from "@/tests/mocks/expoFileSystem"

const THUMBNAILS_DIR = `file:///shared/group.io.filen.app/thumbnails/v${VERSION}`

// A lossless-WebP payload stands in for whatever the SDK encoded; only the bytes' identity matters here.
const WEBP_BYTES = [0x52, 0x49, 0x46, 0x46, 0x57, 0x45, 0x42, 0x50]

function thumbnailVerdict(bytes: number[] = WEBP_BYTES) {
	return {
		tag: "Thumbnail",
		inner: {
			thumbnail: {
				webpData: new Uint8Array(bytes).buffer,
				width: 256,
				height: 192,
				fromEmbeddedPreview: false
			}
		}
	}
}

const UNSUPPORTED_VERDICT = { tag: "Unsupported" }
const OVER_BUDGET_VERDICT = { tag: "OverBudget" }
const CORRUPT_VERDICT = { tag: "Corrupt", inner: { message: "bad huffman table" } }

// What the uniffi bindings reject with when the signal aborts the Rust future (errors.ts:104-108).
function uniffiAbortError(): { name: string; message: string } {
	return { name: "AbortError", message: "A Rust future was aborted" }
}

// canMakeThumbnail defaults to true: the SDK's gate is open unless a test closes it on purpose.
function makeFileItem(uuid: string, name: string, canMakeThumbnail: boolean = true): any {
	return {
		type: "file" as const,
		data: {
			uuid,
			size: 1024n,
			canMakeThumbnail,
			decryptedMeta: { name }
		}
	}
}

function makeSharedFileItem(uuid: string, name: string, canMakeThumbnail: boolean = true): any {
	return {
		type: "sharedFile" as const,
		data: {
			uuid,
			size: 1024n,
			canMakeThumbnail,
			decryptedMeta: { name }
		}
	}
}

function makeSharedRootFileItem(uuid: string, name: string, canMakeThumbnail: boolean = true): any {
	return {
		type: "sharedRootFile" as const,
		data: {
			uuid,
			size: 1024n,
			canMakeThumbnail,
			decryptedMeta: { name }
		}
	}
}

function makeDirItem(uuid: string, name: string): any {
	return {
		type: "directory" as const,
		data: {
			uuid,
			size: 0n,
			decryptedMeta: { name }
		}
	}
}

type ThumbnailsInternals = {
	restored: boolean
	available: Set<string>
	unavailable: Set<string>
	semaphore: { acquire: () => Promise<void>; release: () => void }
}

const internals = thumbnails as unknown as ThumbnailsInternals

describe("Thumbnails", () => {
	// Tripwire for the on-disk format invariant (see thumbnails.ts): what the cached `<uuid>.webp`
	// holds is versioned by THUMBNAILS_VERSION, because readExistingThumbnail serves any non-zero file
	// unconditionally — an install whose directory is not repointed keeps its old output forever. Bump
	// THUMBNAILS_VERSION in storageRoots.ts on ANY output change, then update this fingerprint.
	// (128→256 once shipped without the bump, leaving installs on stale 128px thumbnails; v4 is the
	// move of every image thumbnail from the manipulator to the SDK's lossless contain box, after
	// which DEFAULT_WIDTH/DEFAULT_QUALITY describe the video frame alone; v5 grew the SDK box to
	// 384×768 and made its encode lossy.)
	it("keeps the thumbnail format fingerprint in sync with THUMBNAILS_VERSION", () => {
		expect(`w${DEFAULT_WIDTH}:q${DEFAULT_QUALITY}:v${VERSION}`).toBe("w384:q0.8:v5")
		expect(`${THUMBNAIL_MAX_WIDTH}x${THUMBNAIL_MAX_HEIGHT}@q${THUMBNAIL_LOSSY_QUALITY}`).toBe("384x768@q80")
	})

	beforeEach(() => {
		fs.clear()
		vi.clearAllMocks()
		mockHttpStoreSubscribers.clear()

		// The Thumbnails singleton persists across tests — reset its Sets and the once-per-process
		// restore flag so each test starts from a clean slate.
		internals.restored = false
		internals.available.clear()
		internals.unavailable.clear()

		mockSaveAsync.mockImplementation(async () => {
			const uri = "file:///cache/manipulated.jpg"
			fs.set(uri, new Uint8Array([0xff, 0xd8]))
			return { uri }
		})

		mockRenderAsync.mockResolvedValue({ saveAsync: mockSaveAsync, release: mockRelease })
		mockResize.mockReturnValue({ renderAsync: mockRenderAsync, release: mockRelease })

		const manipulatorResult = {
			resize: mockResize,
			rotate: mockRotate,
			renderAsync: mockRenderAsync,
			release: mockRelease
		}

		mockRotate.mockReturnValue(manipulatorResult)
		mockManipulate.mockReturnValue(manipulatorResult)

		mockMakeThumbnailInMemory.mockResolvedValue(thumbnailVerdict())
		mockMakeThumbnailFromPath.mockResolvedValue(thumbnailVerdict())

		mockGetThumbnailAsync.mockResolvedValue({ uri: "file:///cache/vidframe.jpg", width: 1920, height: 1080 })

		mockHttpStoreState.port = 8080
		mockHttpStoreState.getFileUrl = mockGetFileUrl

		mockIsOnline.mockReturnValue(true)
	})

	describe("generate — SDK image thumbnails (no local bytes)", () => {
		it("asks the SDK with the AnyFile and writes the WebP; the manipulator is never involved", async () => {
			const item = makeFileItem("test-uuid", "photo.jpg")
			const result = await thumbnails.generate({ item })

			expect(mockMakeThumbnailInMemory).toHaveBeenCalledTimes(1)
			expect(mockMakeThumbnailInMemory).toHaveBeenCalledWith(
				{
					file: expect.objectContaining({ tag: "File", inner: [item.data] }),
					maxWidth: 384,
					maxHeight: 768,
					lossyQuality: 80
				},
				undefined
			)

			expect(result).toBe(`${THUMBNAILS_DIR}/test-uuid.webp`)
			expect(Array.from(fs.get(`${THUMBNAILS_DIR}/test-uuid.webp`) as Uint8Array)).toEqual(WEBP_BYTES)
			expect(fs.has(`${THUMBNAILS_DIR}/test-uuid.webp.tmp`)).toBe(false)
			expect(thumbnails.hasThumbnail("test-uuid")).toBe(true)
			expect(mockManipulate).not.toHaveBeenCalled()
		})

		it("passes the JS AbortSignal straight into asyncOpts", async () => {
			const controller = new AbortController()

			await thumbnails.generate({ item: makeFileItem("signal-uuid", "photo.jpg"), signal: controller.signal })

			expect(mockMakeThumbnailInMemory).toHaveBeenCalledWith(expect.objectContaining({ maxWidth: 384 }), {
				signal: controller.signal
			})
		})

		it("returns the cached path when the thumbnail already exists on disk", async () => {
			const outputPath = `${THUMBNAILS_DIR}/cached-uuid.webp`
			fs.set(outputPath, new Uint8Array([0xff, 0xd8]))

			await expect(thumbnails.generate({ item: makeFileItem("cached-uuid", "photo.jpg") })).resolves.toBe(outputPath)
			expect(mockMakeThumbnailInMemory).not.toHaveBeenCalled()
		})

		it("sends RAW and every displayable raster (avif included) through the SDK", async () => {
			await thumbnails.generate({ item: makeFileItem("raw-uuid", "shot.cr2") })
			await thumbnails.generate({ item: makeFileItem("avif-uuid", "shot.avif") })

			expect(mockMakeThumbnailInMemory).toHaveBeenCalledTimes(2)
			expect(thumbnails.hasThumbnail("raw-uuid")).toBe(true)
			expect(thumbnails.hasThumbnail("avif-uuid")).toBe(true)
		})

		it("honours the SDK's veto: canMakeThumbnail === false throws 'Unsupported file type' without any SDK call", async () => {
			await expect(thumbnails.generate({ item: makeFileItem("veto-uuid", "photo.jpg", false) })).rejects.toThrow(
				"Unsupported file type"
			)
			await expect(thumbnails.generate({ item: makeFileItem("veto-raw-uuid", "shot.cr2", false) })).rejects.toThrow(
				"Unsupported file type"
			)

			expect(mockMakeThumbnailInMemory).not.toHaveBeenCalled()
			expect(thumbnails.canGenerate(makeFileItem("veto-uuid", "photo.jpg", false))).toBe(false)
		})

		it("throws 'Unsupported file type' for svg, non-previewable files, directories and undecrypted names without calling the SDK", async () => {
			await expect(thumbnails.generate({ item: makeFileItem("svg-uuid", "logo.svg") })).rejects.toThrow("Unsupported file type")
			await expect(thumbnails.generate({ item: makeFileItem("pdf-uuid", "document.pdf") })).rejects.toThrow("Unsupported file type")
			await expect(thumbnails.generate({ item: makeDirItem("dir-uuid", "my-folder") })).rejects.toThrow("Unsupported file type")
			await expect(
				thumbnails.generate({
					item: {
						type: "file",
						data: { uuid: "no-meta-uuid", size: 1024n, canMakeThumbnail: true, decryptedMeta: { name: undefined } }
					} as any
				})
			).rejects.toThrow("Unsupported file type")

			expect(mockMakeThumbnailInMemory).not.toHaveBeenCalled()
		})

		it("throws when the SDK call fails (transport error stays retryable) and leaves nothing behind", async () => {
			mockMakeThumbnailInMemory.mockRejectedValueOnce(new Error("network error"))

			await expect(thumbnails.generate({ item: makeFileItem("fail-uuid", "photo.jpg") })).rejects.toThrow("network error")
			expect(fs.has(`${THUMBNAILS_DIR}/fail-uuid.webp`)).toBe(false)
			expect(thumbnails.hasThumbnail("fail-uuid")).toBe(false)
		})

		it("throws OfflineAbortError without counting a failure when offline and no local bytes exist", async () => {
			mockIsOnline.mockReturnValue(false)

			const item = makeFileItem("offline-img-uuid", "photo.jpg")

			await expect(thumbnails.generate({ item })).rejects.toThrow("Offline")
			expect(mockMakeThumbnailInMemory).not.toHaveBeenCalled()

			mockIsOnline.mockReturnValue(true)

			await expect(thumbnails.generate({ item })).resolves.toBe(`${THUMBNAILS_DIR}/offline-img-uuid.webp`)
			expect(mockMakeThumbnailInMemory).toHaveBeenCalledTimes(1)
		})

		it("regenerates when the existing thumbnail is 0 bytes", async () => {
			const outputPath = `${THUMBNAILS_DIR}/zero-byte-img-uuid.webp`
			fs.set(outputPath, new Uint8Array(0))

			await expect(thumbnails.generate({ item: makeFileItem("zero-byte-img-uuid", "photo.jpg") })).resolves.toBe(outputPath)
			expect(mockMakeThumbnailInMemory).toHaveBeenCalledTimes(1)
			expect((fs.get(outputPath) as Uint8Array).length).toBeGreaterThan(0)
		})

		it("does NOT take the JS semaphore for the SDK path (the client owns decode concurrency), but does for video", async () => {
			const acquireSpy = vi.spyOn(internals.semaphore, "acquire")

			await thumbnails.generate({ item: makeFileItem("no-sem-uuid", "photo.jpg") })

			expect(acquireSpy).not.toHaveBeenCalled()

			await thumbnails.generate({ item: makeFileItem("sem-vid-uuid", "clip.mp4") })

			expect(acquireSpy).toHaveBeenCalledTimes(1)

			acquireSpy.mockRestore()
		})
	})

	describe("generate — local bytes first (SDK from path, zero network)", () => {
		it("decodes the offline copy from its path and never reaches the network, even offline", async () => {
			const { File } = await import("@/tests/mocks/expoFileSystem")
			const offlineMod = await import("@/features/offline/offline")

			mockIsOnline.mockReturnValue(false)

			const offlineFileUri = "file:///offline/photo.jpg"

			fs.set(offlineFileUri, new Uint8Array([1, 2, 3]))
			vi.mocked(offlineMod.default.getLocalFile).mockResolvedValueOnce(new File(offlineFileUri) as never)

			const result = await thumbnails.generate({ item: makeFileItem("offline-hit-uuid", "photo.jpg") })

			expect(mockMakeThumbnailInMemory).not.toHaveBeenCalled()
			expect(mockManipulate).not.toHaveBeenCalled()
			expect(mockMakeThumbnailFromPath).toHaveBeenCalledWith(
				"/offline/photo.jpg",
				THUMBNAIL_MAX_WIDTH,
				THUMBNAIL_MAX_HEIGHT,
				expect.anything(),
				THUMBNAIL_LOSSY_QUALITY,
				undefined
			)
			expect(result).toBe(`${THUMBNAILS_DIR}/offline-hit-uuid.webp`)
		})

		// The SDK opens the path verbatim, so a percent-encoded URI ENOENTs on any name with a space or
		// a non-ASCII character — a silent "no thumbnail" for a whole class of camera-roll names.
		it("hands the SDK a DECODED path, never the percent-encoded expo URI", async () => {
			const { File } = await import("@/tests/mocks/expoFileSystem")
			const offlineMod = await import("@/features/offline/offline")

			const offlineFileUri = "file:///offline/IMG%201234%20(1).jpg"

			fs.set(offlineFileUri, new Uint8Array([1, 2, 3]))
			vi.mocked(offlineMod.default.getLocalFile).mockResolvedValueOnce(new File(offlineFileUri) as never)

			await thumbnails.generate({ item: makeFileItem("encoded-name-uuid", "IMG 1234 (1).jpg") })

			expect(mockMakeThumbnailFromPath).toHaveBeenCalledWith(
				"/offline/IMG 1234 (1).jpg",
				THUMBNAIL_MAX_WIDTH,
				THUMBNAIL_MAX_HEIGHT,
				expect.anything(),
				THUMBNAIL_LOSSY_QUALITY,
				undefined
			)
		})

		// Both keys are required by the bindings, and a thumbnail extraction is not user-pausable.
		it("builds the ManagedFuture with the wrapped abort signal and no pause signal, and disposes it once", async () => {
			const { File } = await import("@/tests/mocks/expoFileSystem")
			const offlineMod = await import("@/features/offline/offline")
			const controller = new AbortController()

			fs.set("file:///offline/photo.jpg", new Uint8Array([1]))
			vi.mocked(offlineMod.default.getLocalFile).mockResolvedValueOnce(new File("file:///offline/photo.jpg") as never)

			await thumbnails.generate({ item: makeFileItem("managed-future-uuid", "photo.jpg"), signal: controller.signal })

			const wrapped = mockWrapAbortSignalForSdk.mock.results[0]?.value

			expect(mockWrapAbortSignalForSdk).toHaveBeenCalledWith(controller.signal)
			expect(mockManagedFutureNew).toHaveBeenCalledWith({ pauseSignal: undefined, abortSignal: wrapped })
			expect(mockMakeThumbnailFromPath).toHaveBeenCalledWith(
				"/offline/photo.jpg",
				THUMBNAIL_MAX_WIDTH,
				THUMBNAIL_MAX_HEIGHT,
				mockManagedFutureNew.mock.results[0]?.value,
				THUMBNAIL_LOSSY_QUALITY,
				{ signal: controller.signal }
			)
			expect(mockDisposeSdkAbortSignal).toHaveBeenCalledTimes(1)
			expect(mockDisposeSdkAbortSignal).toHaveBeenCalledWith(wrapped)
		})

		// The two Arc-backed handles wrapAbortSignalForSdk allocates have no GC: every exit has to free
		// them, or a camera-upload backfill leaks two per file.
		it("disposes the wrapped signal exactly once after a settled verdict", async () => {
			const { File } = await import("@/tests/mocks/expoFileSystem")
			const offlineMod = await import("@/features/offline/offline")

			fs.set("file:///offline/photo.jpg", new Uint8Array([1]))
			vi.mocked(offlineMod.default.getLocalFile).mockResolvedValueOnce(new File("file:///offline/photo.jpg") as never)
			mockMakeThumbnailFromPath.mockResolvedValueOnce(UNSUPPORTED_VERDICT)

			await expect(
				thumbnails.generate({ item: makeFileItem("dispose-settled-uuid", "photo.jpg"), signal: new AbortController().signal })
			).resolves.toBeNull()

			expect(mockDisposeSdkAbortSignal).toHaveBeenCalledTimes(1)
		})

		it("disposes the wrapped signal exactly once after a thrown transport error", async () => {
			const { File } = await import("@/tests/mocks/expoFileSystem")
			const offlineMod = await import("@/features/offline/offline")

			fs.set("file:///offline/photo.jpg", new Uint8Array([1]))
			vi.mocked(offlineMod.default.getLocalFile).mockResolvedValueOnce(new File("file:///offline/photo.jpg") as never)
			mockMakeThumbnailFromPath.mockRejectedValueOnce(new Error("io"))

			await expect(
				thumbnails.generate({ item: makeFileItem("dispose-throw-uuid", "photo.jpg"), signal: new AbortController().signal })
			).rejects.toThrow("io")

			expect(mockDisposeSdkAbortSignal).toHaveBeenCalledTimes(1)
		})

		it("disposes the wrapped signal exactly once when the call is aborted mid-flight", async () => {
			const { File } = await import("@/tests/mocks/expoFileSystem")
			const offlineMod = await import("@/features/offline/offline")
			const controller = new AbortController()

			fs.set("file:///offline/photo.jpg", new Uint8Array([1]))
			vi.mocked(offlineMod.default.getLocalFile).mockResolvedValueOnce(new File("file:///offline/photo.jpg") as never)

			mockMakeThumbnailFromPath.mockImplementationOnce(async () => {
				controller.abort()

				return thumbnailVerdict()
			})

			await expect(
				thumbnails.generate({ item: makeFileItem("abort-dispose-uuid", "photo.jpg"), signal: controller.signal })
			).rejects.toThrow()

			expect(mockDisposeSdkAbortSignal).toHaveBeenCalledTimes(1)
			expect(fs.has(`${THUMBNAILS_DIR}/abort-dispose-uuid.webp`)).toBe(false)
		})

		it("decodes a file-cache hit from its path and never reaches the network", async () => {
			const { File } = await import("@/tests/mocks/expoFileSystem")
			const fileCacheMod = await import("@/lib/fileCache")

			const cachedFileUri = "file:///fileCache/photo.jpg"

			fs.set(cachedFileUri, new Uint8Array([1, 2, 3]))
			vi.mocked(fileCacheMod.default.has).mockResolvedValueOnce(true)
			vi.mocked(fileCacheMod.default.get).mockResolvedValueOnce(new File(cachedFileUri) as never)

			const result = await thumbnails.generate({ item: makeFileItem("filecache-hit-uuid", "photo.jpg") })

			expect(mockMakeThumbnailInMemory).not.toHaveBeenCalled()
			expect(mockMakeThumbnailFromPath).toHaveBeenCalledWith(
				"/fileCache/photo.jpg",
				THUMBNAIL_MAX_WIDTH,
				THUMBNAIL_MAX_HEIGHT,
				expect.anything(),
				THUMBNAIL_LOSSY_QUALITY,
				undefined
			)
			expect(result).toBe(`${THUMBNAILS_DIR}/filecache-hit-uuid.webp`)
		})

		it("ignores a caller-supplied width and quality — the SDK owns its request box", async () => {
			const { File } = await import("@/tests/mocks/expoFileSystem")
			const offlineMod = await import("@/features/offline/offline")

			fs.set("file:///offline/photo.jpg", new Uint8Array([1]))
			vi.mocked(offlineMod.default.getLocalFile).mockResolvedValueOnce(new File("file:///offline/photo.jpg") as never)

			await thumbnails.generate({ item: makeFileItem("custom-size-uuid", "photo.jpg"), width: 512, quality: 0.5 })

			expect(mockResize).not.toHaveBeenCalled()
			expect(mockMakeThumbnailFromPath).toHaveBeenCalledWith(
				"/offline/photo.jpg",
				THUMBNAIL_MAX_WIDTH,
				THUMBNAIL_MAX_HEIGHT,
				expect.anything(),
				THUMBNAIL_LOSSY_QUALITY,
				undefined
			)
		})

		it("does NOT take the JS semaphore for the local path either (same decode gate as the remote call)", async () => {
			const { File } = await import("@/tests/mocks/expoFileSystem")
			const offlineMod = await import("@/features/offline/offline")
			const acquireSpy = vi.spyOn(internals.semaphore, "acquire")

			fs.set("file:///offline/photo.jpg", new Uint8Array([1]))
			vi.mocked(offlineMod.default.getLocalFile).mockResolvedValueOnce(new File("file:///offline/photo.jpg") as never)

			await thumbnails.generate({ item: makeFileItem("local-sem-uuid", "photo.jpg") })

			expect(acquireSpy).not.toHaveBeenCalled()

			acquireSpy.mockRestore()
		})

		// The manipulator could not read RAW, so its offline copy used to be skipped and the tile pulled
		// the whole container back over the network. The SDK reads it, so the local copy now wins.
		it("uses a local RAW copy instead of the network (no format list gates the lookup any more)", async () => {
			const { File } = await import("@/tests/mocks/expoFileSystem")
			const offlineMod = await import("@/features/offline/offline")

			mockIsOnline.mockReturnValue(false)
			fs.set("file:///offline/shot.cr2", new Uint8Array([1]))
			vi.mocked(offlineMod.default.getLocalFile).mockResolvedValueOnce(new File("file:///offline/shot.cr2") as never)

			await expect(thumbnails.generate({ item: makeFileItem("raw-local-uuid", "shot.cr2") })).resolves.toBe(
				`${THUMBNAILS_DIR}/raw-local-uuid.webp`
			)

			expect(mockManipulate).not.toHaveBeenCalled()
			expect(mockMakeThumbnailInMemory).not.toHaveBeenCalled()
			expect(mockMakeThumbnailFromPath).toHaveBeenCalledTimes(1)
		})

		// No local-copy stub here on purpose: the veto is checked before resolveLocalSourcePath runs, so
		// a queued mockResolvedValueOnce would go unconsumed and leak into the next test.
		it("the SDK veto applies to the local path too (canMakeThumbnail false shows an icon)", async () => {
			const offlineMod = await import("@/features/offline/offline")

			await expect(thumbnails.generate({ item: makeFileItem("veto-local-uuid", "icon.png", false) })).rejects.toThrow(
				"Unsupported file type"
			)
			expect(offlineMod.default.getLocalFile).not.toHaveBeenCalled()
			expect(mockMakeThumbnailFromPath).not.toHaveBeenCalled()
			expect(mockMakeThumbnailInMemory).not.toHaveBeenCalled()
		})

		it("a settled verdict from the local path settles the uuid without counting a failure", async () => {
			const { File } = await import("@/tests/mocks/expoFileSystem")
			const offlineMod = await import("@/features/offline/offline")

			fs.set("file:///offline/photo.jpg", new Uint8Array([1]))
			vi.mocked(offlineMod.default.getLocalFile).mockResolvedValueOnce(new File("file:///offline/photo.jpg") as never)
			mockMakeThumbnailFromPath.mockResolvedValueOnce(CORRUPT_VERDICT)

			await expect(thumbnails.generate({ item: makeFileItem("local-settled-uuid", "photo.jpg") })).resolves.toBeNull()

			expect(thumbnails.isUnavailable("local-settled-uuid")).toBe(true)
			expect(fs.has(`${THUMBNAILS_DIR}/local-settled-uuid.webp`)).toBe(false)
		})
	})

	describe("generate — session verdicts (no marker files)", () => {
		it.each([
			["Unsupported", UNSUPPORTED_VERDICT],
			["OverBudget", OVER_BUDGET_VERDICT],
			["Corrupt", CORRUPT_VERDICT]
		])("%s resolves null, writes nothing to disk, and is not asked again this session", async (tag, verdict) => {
			mockMakeThumbnailInMemory.mockResolvedValueOnce(verdict)

			const item = makeFileItem(`settled-${tag}`, "photo.jpg")

			await expect(thumbnails.generate({ item })).resolves.toBeNull()

			expect(fs.has(`${THUMBNAILS_DIR}/settled-${tag}.webp`)).toBe(false)
			expect(fs.has(`${THUMBNAILS_DIR}/settled-${tag}.none`)).toBe(false)
			expect([...fs.keys()].filter(k => k.startsWith(THUMBNAILS_DIR) && k !== THUMBNAILS_DIR)).toEqual([])
			expect(thumbnails.hasThumbnail(`settled-${tag}`)).toBe(false)
			expect(thumbnails.isUnavailable(`settled-${tag}`)).toBe(true)

			await expect(thumbnails.generate({ item })).resolves.toBeNull()
			expect(mockMakeThumbnailInMemory).toHaveBeenCalledTimes(1)
		})

		it.each([
			["Unsupported", UNSUPPORTED_VERDICT],
			["OverBudget", OVER_BUDGET_VERDICT],
			["Corrupt", CORRUPT_VERDICT]
		])("%s is forgotten on the online flip and the file is asked again", async (tag, verdict) => {
			mockMakeThumbnailInMemory.mockResolvedValueOnce(verdict)

			const item = makeFileItem(`flip-${tag}`, "photo.jpg")

			await expect(thumbnails.generate({ item })).resolves.toBeNull()

			for (const listener of mockOnlineSubscribers) {
				listener(true)
			}

			expect(thumbnails.isUnavailable(`flip-${tag}`)).toBe(false)

			await expect(thumbnails.generate({ item })).resolves.toBe(`${THUMBNAILS_DIR}/flip-${tag}.webp`)
			expect(mockMakeThumbnailInMemory).toHaveBeenCalledTimes(2)
		})

		it("a settled verdict is not a failure (the ledger stays untouched)", async () => {
			mockMakeThumbnailInMemory.mockResolvedValueOnce(CORRUPT_VERDICT)

			const item = makeFileItem("settled-not-failure", "photo.jpg")

			await expect(thumbnails.generate({ item })).resolves.toBeNull()

			for (const listener of mockOnlineSubscribers) {
				listener(true)
			}

			mockMakeThumbnailInMemory
				.mockRejectedValueOnce(new Error("io"))
				.mockRejectedValueOnce(new Error("io"))
				.mockRejectedValueOnce(new Error("io"))

			for (let i = 0; i < 3; i++) {
				await expect(thumbnails.generate({ item })).rejects.toThrow("io")
			}

			// Exactly three real failures reached the cap — the earlier verdict did not count as one.
			await expect(thumbnails.generate({ item })).rejects.toThrow("Max thumbnail generation failures reached")
		})

		it("a verdict does not survive a restart (nothing on disk to seed it from)", async () => {
			mockMakeThumbnailInMemory.mockResolvedValueOnce(UNSUPPORTED_VERDICT)

			await thumbnails.generate({ item: makeFileItem("restart-uuid", "photo.jpg") })

			expect(thumbnails.isUnavailable("restart-uuid")).toBe(true)

			// Simulate a fresh process: the Sets are empty and restore() finds only .webp files.
			internals.unavailable.clear()
			internals.restored = false

			thumbnails.restore()

			expect(thumbnails.isUnavailable("restart-uuid")).toBe(false)
		})

		it("serves an on-disk thumbnail even for a settled or vetoed uuid (disk wins, and repairs the availability Set)", async () => {
			mockMakeThumbnailInMemory.mockResolvedValueOnce(UNSUPPORTED_VERDICT)

			const item = makeFileItem("disk-first-uuid", "photo.jpg")

			await expect(thumbnails.generate({ item })).resolves.toBeNull()

			// A thumbnail lands on disk for the uuid behind the verdict.
			const outputPath = `${THUMBNAILS_DIR}/disk-first-uuid.webp`
			fs.set(outputPath, new Uint8Array([0xff, 0xd8]))

			await expect(thumbnails.generate({ item })).resolves.toBe(outputPath)
			expect(thumbnails.hasThumbnail("disk-first-uuid")).toBe(true)
			expect(thumbnails.isUnavailable("disk-first-uuid")).toBe(false)

			// The veto is checked after the disk too.
			const vetoed = makeFileItem("disk-first-uuid", "photo.jpg", false)

			await expect(thumbnails.generate({ item: vetoed })).resolves.toBe(outputPath)
			expect(mockMakeThumbnailInMemory).toHaveBeenCalledTimes(1)
		})
	})

	describe("isUnavailable", () => {
		it("is false for an unknown uuid and true after a settle", async () => {
			expect(thumbnails.isUnavailable("nobody")).toBe(false)

			mockMakeThumbnailInMemory.mockResolvedValueOnce(OVER_BUDGET_VERDICT)

			await thumbnails.generate({ item: makeFileItem("session", "b.jpg") })

			expect(thumbnails.isUnavailable("session")).toBe(true)
		})

		it("invalidateFile leaves the settled Set alone", async () => {
			mockMakeThumbnailInMemory.mockResolvedValueOnce(UNSUPPORTED_VERDICT)

			const item = makeFileItem("inv-settled", "a.jpg")

			await thumbnails.generate({ item })

			thumbnails.invalidateFile(item)

			expect(thumbnails.isUnavailable("inv-settled")).toBe(true)
		})

		it("a later local-file generation clears the verdict (fresh bytes on disk outrank it)", async () => {
			mockMakeThumbnailInMemory.mockResolvedValueOnce(UNSUPPORTED_VERDICT)

			await expect(thumbnails.generate({ item: makeFileItem("settled-then-local", "photo.jpg") })).resolves.toBeNull()
			expect(thumbnails.isUnavailable("settled-then-local")).toBe(true)

			fs.set(THUMBNAILS_DIR, "dir")
			fs.set("file:///local/photo.jpg", new Uint8Array([1, 2, 3]))

			await expect(
				thumbnails.generateFromLocalFile({
					localUri: "file:///local/photo.jpg",
					uuid: "settled-then-local",
					name: "photo.jpg",
					canMakeThumbnail: true
				})
			).resolves.toBe(`${THUMBNAILS_DIR}/settled-then-local.webp`)

			expect(thumbnails.isUnavailable("settled-then-local")).toBe(false)
			expect(thumbnails.hasThumbnail("settled-then-local")).toBe(true)
		})
	})

	describe("generate — shared files", () => {
		it("hands a sharedFile to the SDK as AnyFile.Shared (driveItemToAnyFile maps both shared types to Shared, like fileCache)", async () => {
			const item = makeSharedFileItem("shared-uuid", "shared-photo.jpg")

			await expect(thumbnails.generate({ item })).resolves.toBe(`${THUMBNAILS_DIR}/shared-uuid.webp`)
			expect(mockMakeThumbnailInMemory).toHaveBeenCalledWith(
				expect.objectContaining({ file: expect.objectContaining({ tag: "Shared", inner: [item.data] }) }),
				undefined
			)
		})

		it("hands a sharedRootFile to the SDK as AnyFile.Shared — no adapter", async () => {
			const item = makeSharedRootFileItem("shared-root-uuid", "shared-root.jpg")

			await expect(thumbnails.generate({ item })).resolves.toBe(`${THUMBNAILS_DIR}/shared-root-uuid.webp`)
			expect(mockMakeThumbnailInMemory).toHaveBeenCalledWith(
				expect.objectContaining({ file: expect.objectContaining({ tag: "Shared", inner: [item.data] }) }),
				undefined
			)
		})

		it("honours the veto on a shared record too", async () => {
			await expect(thumbnails.generate({ item: makeSharedRootFileItem("shared-veto", "photo.jpg", false) })).rejects.toThrow(
				"Unsupported file type"
			)
			expect(mockMakeThumbnailInMemory).not.toHaveBeenCalled()
		})
	})

	describe("generate — deduplication", () => {
		it("returns the same result for concurrent calls with the same UUID and calls the SDK once", async () => {
			let resolveSdk!: () => void
			const sdkStarted = new Promise<void>(started => {
				mockMakeThumbnailInMemory.mockImplementationOnce(
					() =>
						new Promise(resolve => {
							resolveSdk = () => resolve(thumbnailVerdict())

							started()
						})
				)
			})

			const item = makeFileItem("dedup-uuid", "photo.jpg")

			const promise1 = thumbnails.generate({ item })
			const promise2 = thumbnails.generate({ item })

			await sdkStarted

			resolveSdk()

			const [result1, result2] = await Promise.all([promise1, promise2])

			expect(result1).toBe(result2)
			expect(mockMakeThumbnailInMemory).toHaveBeenCalledTimes(1)
		})
	})

	describe("generate — video thumbnails", () => {
		it("generates thumbnail for a .mp4 file", async () => {
			const item = makeFileItem("video-uuid", "clip.mp4")
			const result = await thumbnails.generate({ item })

			expect(mockGetThumbnailAsync).toHaveBeenCalledTimes(1)
			expect(mockGetThumbnailAsync).toHaveBeenCalledWith(expect.stringContaining("http://localhost:8080/file/video-uuid"), {
				time: 1000,
				quality: 1
			})
			expect(mockManipulate).toHaveBeenCalledTimes(1)
			expect(mockResize).toHaveBeenCalledWith({ width: DEFAULT_WIDTH })
			expect(mockRenderAsync).toHaveBeenCalledTimes(1)

			expect(result).toBe(`${THUMBNAILS_DIR}/video-uuid.webp`)
		})

		it("uses custom video timestamp when specified (seconds → ms)", async () => {
			const item = makeFileItem("vid-custom-ts", "clip.mp4")
			await thumbnails.generate({
				item,
				videoTimestamp: 5.0
			})

			expect(mockGetThumbnailAsync).toHaveBeenCalledWith(expect.any(String), {
				time: 5000,
				quality: 1
			})
		})

		it("waits for HTTP provider when not immediately available", async () => {
			mockHttpStoreState.port = null
			mockHttpStoreState.getFileUrl = null

			const item = makeFileItem("wait-http-uuid", "clip.mp4")

			let resolved = false
			const promise = thumbnails.generate({ item }).then(result => {
				resolved = true

				return result
			})

			// Not yet resolved — waiting for provider
			await Promise.resolve()
			expect(resolved).toBe(false)
			expect(mockGetThumbnailAsync).not.toHaveBeenCalled()

			// Simulate provider becoming available
			mockHttpStoreState.port = 8080
			mockHttpStoreState.getFileUrl = mockGetFileUrl

			for (const listener of mockHttpStoreSubscribers) {
				listener(mockHttpStoreState)
			}

			const result = await promise

			expect(resolved).toBe(true)
			expect(mockGetThumbnailAsync).toHaveBeenCalledTimes(1)
			expect(result).toBe(`${THUMBNAILS_DIR}/wait-http-uuid.webp`)
		})

		it("aborts while waiting for HTTP provider", async () => {
			mockHttpStoreState.port = null
			mockHttpStoreState.getFileUrl = null

			const controller = new AbortController()
			const item = makeFileItem("abort-wait-uuid", "clip.mp4")

			const promise = thumbnails.generate({
				item,
				signal: controller.signal
			})

			// Abort while waiting
			controller.abort()

			// Must throw the abort-flavoured error specifically — not a network/timeout error.
			// DOMException("This operation was aborted") is returned by abortError() when
			// signal.reason instanceof Error (the default Node.js reason).
			await expect(promise).rejects.toThrow("This operation was aborted")
			await expect(promise).rejects.toBeInstanceOf(Error)
			expect(mockGetThumbnailAsync).not.toHaveBeenCalled()
			expect(mockHttpStoreSubscribers.size).toBe(0)
		})

		it("throws when frame extraction fails, wrapping the message with timestamp context", async () => {
			mockGetThumbnailAsync.mockRejectedValueOnce(new Error("thumbnail generation failed"))

			const item = makeFileItem("gen-fail-uuid", "clip.mp4")

			// Source wraps the error: "Video thumbnail extraction failed at 1s: <original message>"
			// Assert the full wrapped format — a substring match on the original alone would pass
			// even if the wrapping were removed, giving no signal about the wrapping contract.
			await expect(thumbnails.generate({ item })).rejects.toThrow(
				"Video thumbnail extraction failed at 1s: thumbnail generation failed"
			)
		})
	})

	describe("generate — abort signal", () => {
		it("video: throws when signal is already aborted before generation", async () => {
			const controller = new AbortController()
			controller.abort()

			const item = makeFileItem("abort-vid-uuid", "clip.mp4")

			await expect(
				thumbnails.generate({
					item,
					signal: controller.signal
				})
			).rejects.toThrow()

			expect(mockGetThumbnailAsync).not.toHaveBeenCalled()
		})

		it("throws immediately when signal is already aborted before semaphore releases", async () => {
			const controller = new AbortController()
			controller.abort()

			const item = makeFileItem("abort-pre-gen-uuid", "photo.jpg")

			await expect(
				thumbnails.generate({
					item,
					signal: controller.signal
				})
			).rejects.toThrow()

			expect(mockMakeThumbnailInMemory).not.toHaveBeenCalled()
			expect(mockGetThumbnailAsync).not.toHaveBeenCalled()
		})

		it("always throws an Error instance even when signal.reason is undefined", async () => {
			const controller = new AbortController()

			// Simulate abort with undefined reason (possible in some polyfills)
			Object.defineProperty(controller.signal, "reason", { value: undefined })
			controller.abort()

			const item = makeFileItem("abort-undef-reason-uuid", "photo.jpg")

			const result = thumbnails.generate({
				item,
				signal: controller.signal
			})

			await expect(result).rejects.toThrow("Aborted")
			await expect(result).rejects.toBeInstanceOf(Error)
		})
	})

	describe("generate — failure tracking", () => {
		it("throws after MAX_FAILURES (3) consecutive failures for the same item", async () => {
			mockMakeThumbnailInMemory.mockRejectedValue(new Error("corrupt file"))

			const item = makeFileItem("fail-track-uuid", "photo.jpg")

			// Fail 3 times (each throws)
			for (let i = 0; i < 3; i++) {
				await expect(thumbnails.generate({ item })).rejects.toThrow("corrupt file")
			}

			expect(mockMakeThumbnailInMemory).toHaveBeenCalledTimes(3)

			// 4th attempt should be skipped entirely — throws without trying
			mockMakeThumbnailInMemory.mockClear()

			await expect(thumbnails.generate({ item })).rejects.toThrow("Max thumbnail generation failures reached")
			expect(mockMakeThumbnailInMemory).not.toHaveBeenCalled()
		})

		it("does not affect other items when one item hits the failure limit", async () => {
			mockMakeThumbnailInMemory.mockRejectedValue(new Error("corrupt"))

			const failItem = makeFileItem("fail-item-uuid", "bad.jpg")

			for (let i = 0; i < 3; i++) {
				await expect(thumbnails.generate({ item: failItem })).rejects.toThrow()
			}

			// Restore normal behavior for the good item
			mockMakeThumbnailInMemory.mockResolvedValue(thumbnailVerdict())

			const goodItem = makeFileItem("good-item-uuid", "good.jpg")
			const result = await thumbnails.generate({ item: goodItem })

			expect(result).toBe(`${THUMBNAILS_DIR}/good-item-uuid.webp`)
		})

		it("resets failure count when clear() is called", async () => {
			mockMakeThumbnailInMemory.mockRejectedValue(new Error("corrupt"))

			const item = makeFileItem("reset-fail-uuid", "photo.jpg")

			for (let i = 0; i < 3; i++) {
				await expect(thumbnails.generate({ item })).rejects.toThrow()
			}

			// Confirm it's blocked
			mockMakeThumbnailInMemory.mockClear()
			await expect(thumbnails.generate({ item })).rejects.toThrow("Max thumbnail generation failures reached")
			expect(mockMakeThumbnailInMemory).not.toHaveBeenCalled()

			// Clear resets failures
			await thumbnails.clear()

			// Restore working download
			mockMakeThumbnailInMemory.mockResolvedValue(thumbnailVerdict())

			const result = await thumbnails.generate({ item })
			expect(mockMakeThumbnailInMemory).toHaveBeenCalledTimes(1)
			expect(result).toBe(`${THUMBNAILS_DIR}/reset-fail-uuid.webp`)
		})

		it("does not count the bindings' AbortError toward the failure limit (detected by name, with the signal aborted)", async () => {
			const item = makeFileItem("abort-no-fail-uuid", "photo.jpg")

			for (let i = 0; i < 3; i++) {
				const controller = new AbortController()

				mockMakeThumbnailInMemory.mockImplementationOnce(async () => {
					controller.abort()

					throw uniffiAbortError()
				})

				await expect(
					thumbnails.generate({
						item,
						signal: controller.signal
					})
				).rejects.toThrow()
			}

			mockMakeThumbnailInMemory.mockResolvedValue(thumbnailVerdict())

			await expect(thumbnails.generate({ item })).resolves.toBe(`${THUMBNAILS_DIR}/abort-no-fail-uuid.webp`)
		})

		it("does not count an AbortError toward the failure limit even when no JS signal was involved", async () => {
			const item = makeFileItem("abort-name-only-uuid", "photo.jpg")

			for (let i = 0; i < 3; i++) {
				mockMakeThumbnailInMemory.mockRejectedValueOnce(uniffiAbortError())

				await expect(thumbnails.generate({ item })).rejects.toMatchObject({ name: "AbortError" })
			}

			mockMakeThumbnailInMemory.mockResolvedValue(thumbnailVerdict())

			await expect(thumbnails.generate({ item })).resolves.toBe(`${THUMBNAILS_DIR}/abort-name-only-uuid.webp`)
		})

		it("does not count video aborts toward the failure limit", async () => {
			const item = makeFileItem("abort-vid-no-fail-uuid", "clip.mp4")

			// Abort 3 times during HTTP provider wait
			for (let i = 0; i < 3; i++) {
				mockHttpStoreState.port = null
				mockHttpStoreState.getFileUrl = null

				const controller = new AbortController()

				const promise = thumbnails.generate({
					item,
					signal: controller.signal
				})

				controller.abort()

				await expect(promise).rejects.toThrow()

				mockHttpStoreState.port = 8080
				mockHttpStoreState.getFileUrl = mockGetFileUrl
			}

			// Should still be able to generate
			const result = await thumbnails.generate({ item })
			expect(result).toBe(`${THUMBNAILS_DIR}/abort-vid-no-fail-uuid.webp`)
		})

		it("allows retries up to the limit", async () => {
			// Fail twice, succeed on third
			mockMakeThumbnailInMemory
				.mockRejectedValueOnce(new Error("fail 1"))
				.mockRejectedValueOnce(new Error("fail 2"))
				.mockResolvedValueOnce(thumbnailVerdict())

			const item = makeFileItem("retry-uuid", "photo.jpg")

			await expect(thumbnails.generate({ item })).rejects.toThrow("fail 1")
			await expect(thumbnails.generate({ item })).rejects.toThrow("fail 2")

			const result = await thumbnails.generate({ item })
			expect(result).toBe(`${THUMBNAILS_DIR}/retry-uuid.webp`)
		})
	})

	describe("canGenerate", () => {
		it("is true for every displayable raster format and for RAW when the SDK gate is open", () => {
			expect(thumbnails.canGenerate(makeFileItem("uuid", "photo.jpg"))).toBe(true)
			expect(thumbnails.canGenerate(makeFileItem("uuid", "photo.png"))).toBe(true)
			expect(thumbnails.canGenerate(makeFileItem("uuid", "photo.gif"))).toBe(true)
			expect(thumbnails.canGenerate(makeFileItem("uuid", "photo.avif"))).toBe(true)
			expect(thumbnails.canGenerate(makeFileItem("uuid", "shot.cr2"))).toBe(true)
			expect(thumbnails.canGenerate(makeFileItem("uuid", "shot.raf"))).toBe(true)
		})

		it("is false when the SDK says canMakeThumbnail is false (its own gate is trusted)", () => {
			expect(thumbnails.canGenerate(makeFileItem("uuid", "photo.jpg", false))).toBe(false)
			expect(thumbnails.canGenerate(makeFileItem("uuid", "favicon.ico", false))).toBe(false)
			expect(thumbnails.canGenerate(makeSharedRootFileItem("uuid", "shot.cr2", false))).toBe(false)
		})

		it("is true for supported video extensions regardless of the SDK flag", () => {
			expect(thumbnails.canGenerate(makeFileItem("uuid", "clip.mp4", false))).toBe(true)
			expect(thumbnails.canGenerate(makeFileItem("uuid", "clip.mov"))).toBe(true)
			expect(thumbnails.canGenerate(makeFileItem("uuid", "clip.mkv"))).toBe(true)
		})

		it("is false for svg (previewable, deliberately not thumbnailed)", () => {
			expect(thumbnails.canGenerate(makeFileItem("uuid", "logo.svg"))).toBe(false)
		})

		it("is false for non-previewable extensions", () => {
			expect(thumbnails.canGenerate(makeFileItem("uuid", "document.pdf"))).toBe(false)
			expect(thumbnails.canGenerate(makeFileItem("uuid", "archive.zip"))).toBe(false)
			expect(thumbnails.canGenerate(makeFileItem("uuid", "notes.txt"))).toBe(false)
		})

		it("is false for directory items and items without a decrypted name", () => {
			expect(thumbnails.canGenerate(makeDirItem("uuid", "folder"))).toBe(false)
			expect(
				thumbnails.canGenerate({
					type: "file",
					data: { uuid: "uuid", size: 1024n, canMakeThumbnail: true, decryptedMeta: { name: undefined } }
				} as any)
			).toBe(false)
		})
	})

	describe("clear", () => {
		it("deletes entire thumbnails directory", async () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set(`${THUMBNAILS_DIR}/a.jpg`, new Uint8Array([1]))
			fs.set(`${THUMBNAILS_DIR}/b.jpg`, new Uint8Array([2]))

			await thumbnails.clear()

			expect(fs.has(`${THUMBNAILS_DIR}/a.jpg`)).toBe(false)
			expect(fs.has(`${THUMBNAILS_DIR}/b.jpg`)).toBe(false)
		})

		it("recreates directory after deletion", async () => {
			fs.set(THUMBNAILS_DIR, "dir")

			await thumbnails.clear()

			expect(fs.get(THUMBNAILS_DIR)).toBe("dir")
		})

		// clear() wipes the directory AND the availability Set unconditionally. The Set is a plain Set
		// (its clear cannot throw), so there is no try/catch that could make the directory wipe skippable.
		it("wipes the directory AND the availability Set unconditionally", async () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set(`${THUMBNAILS_DIR}/a.webp`, new Uint8Array([1]))

			thumbnails.restore()

			expect(thumbnails.hasThumbnail("a")).toBe(true)

			await thumbnails.clear()

			expect(fs.has(`${THUMBNAILS_DIR}/a.webp`)).toBe(false)
			expect(fs.get(THUMBNAILS_DIR)).toBe("dir")
			expect(thumbnails.hasThumbnail("a")).toBe(false)
		})

		it("wipes the settled Set with the directory", async () => {
			mockMakeThumbnailInMemory.mockResolvedValueOnce(CORRUPT_VERDICT)

			await thumbnails.generate({ item: makeFileItem("session", "b.jpg") })

			expect(thumbnails.isUnavailable("session")).toBe(true)

			await thumbnails.clear()

			expect(thumbnails.isUnavailable("session")).toBe(false)
		})
	})

	describe("size", () => {
		it("returns 0 when the thumbnails directory is empty", () => {
			fs.set(THUMBNAILS_DIR, "dir")

			expect(thumbnails.size()).toBe(0)
		})

		it("returns 0 when the thumbnails directory does not exist", () => {
			fs.delete(THUMBNAILS_DIR)

			expect(thumbnails.size()).toBe(0)
		})

		it("sums all .webp file sizes", () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set(`${THUMBNAILS_DIR}/a.webp`, new Uint8Array(new Array(7).fill(0)))
			fs.set(`${THUMBNAILS_DIR}/b.webp`, new Uint8Array(new Array(13).fill(0)))

			expect(thumbnails.size()).toBe(7 + 13)
		})

		it("ignores stray subdirectories", () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set(`${THUMBNAILS_DIR}/a.webp`, new Uint8Array([1, 2]))
			fs.set(`${THUMBNAILS_DIR}/nested`, "dir")
			fs.set(`${THUMBNAILS_DIR}/nested/x.webp`, new Uint8Array([3, 4, 5]))

			expect(thumbnails.size()).toBe(2)
		})
	})

	describe("generateFromLocalFile", () => {
		it("generates thumbnail from a local image path through the SDK, never the manipulator", async () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set("file:///local/photo.jpg", new Uint8Array([1, 2, 3]))

			const result = await thumbnails.generateFromLocalFile({
				localUri: "file:///local/photo.jpg",
				uuid: "local-img-uuid",
				name: "photo.jpg",
				canMakeThumbnail: true
			})

			expect(result).toBe(`${THUMBNAILS_DIR}/local-img-uuid.webp`)
			expect(mockMakeThumbnailFromPath).toHaveBeenCalledWith(
				"/local/photo.jpg",
				THUMBNAIL_MAX_WIDTH,
				THUMBNAIL_MAX_HEIGHT,
				expect.anything(),
				THUMBNAIL_LOSSY_QUALITY,
				undefined
			)
			expect(mockManipulate).not.toHaveBeenCalled()
			expect(mockMakeThumbnailInMemory).not.toHaveBeenCalled()
		})

		// Both ManagedFuture keys are required by the bindings; a post-upload thumbnail is not a
		// user-pausable transfer, so only the abort channel is wired.
		it("builds the ManagedFuture with the wrapped abort signal and no pause signal, and disposes it once", async () => {
			fs.set(THUMBNAILS_DIR, "dir")

			const controller = new AbortController()

			await thumbnails.generateFromLocalFile({
				localUri: "file:///local/photo.jpg",
				uuid: "local-managed-future-uuid",
				name: "photo.jpg",
				canMakeThumbnail: true,
				signal: controller.signal
			})

			const wrapped = mockWrapAbortSignalForSdk.mock.results[0]?.value

			expect(mockManagedFutureNew).toHaveBeenCalledWith({ pauseSignal: undefined, abortSignal: wrapped })
			expect(mockDisposeSdkAbortSignal).toHaveBeenCalledTimes(1)
			expect(mockDisposeSdkAbortSignal).toHaveBeenCalledWith(wrapped)
		})

		// A .dng is deliberately absent from the manipulator list (developing a RAW in the background
		// task risks an OOM kill), so an iPhone ProRAW shot used to upload with no thumbnail at all.
		it("thumbnails a freshly uploaded .dng, which the manipulator gate excluded", async () => {
			fs.set(THUMBNAILS_DIR, "dir")

			const result = await thumbnails.generateFromLocalFile({
				localUri: "file:///local/IMG_0001.dng",
				uuid: "dng-uuid",
				name: "IMG_0001.dng",
				canMakeThumbnail: true
			})

			expect(result).toBe(`${THUMBNAILS_DIR}/dng-uuid.webp`)
			expect(mockMakeThumbnailFromPath).toHaveBeenCalledTimes(1)
		})

		it("generates thumbnail from a local video path", async () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set("file:///local/video.mp4", new Uint8Array([1, 2, 3]))

			const result = await thumbnails.generateFromLocalFile({
				localUri: "file:///local/video.mp4",
				uuid: "local-vid-uuid",
				name: "video.mp4",
				canMakeThumbnail: false
			})

			expect(result).toBe(`${THUMBNAILS_DIR}/local-vid-uuid.webp`)
			// The URI reaches the extractor as handed in — generateVideo re-normalizing it is a no-op.
			expect(mockGetThumbnailAsync).toHaveBeenCalledWith("file:///local/video.mp4", {
				time: 1000,
				quality: 1
			})
			expect(mockMakeThumbnailFromPath).not.toHaveBeenCalled()
		})

		// The extractor is fed through normalizeFilePathForExpo, which DECODES before it encodes. Hand
		// it a path that was already decoded and a name's literal `%20` decodes a second time, so the
		// frame is pulled from `/local/clip one.mov` — a file that does not exist. It ENOENTs, and the
		// failure lands on the ledger as if the video were broken.
		it("keeps a name's literal percent-escape intact on the way to the frame extractor", async () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set("file:///local/clip%2520one.mov", new Uint8Array([1, 2, 3]))

			const result = await thumbnails.generateFromLocalFile({
				localUri: "file:///local/clip%2520one.mov",
				uuid: "escaped-vid-uuid",
				name: "clip%20one.mov",
				canMakeThumbnail: false
			})

			expect(result).toBe(`${THUMBNAILS_DIR}/escaped-vid-uuid.webp`)

			const passedUri = mockGetThumbnailAsync.mock.calls[0]?.[0] as string

			// Decoded ONCE, the URI has to name the file that was uploaded.
			expect(decodeURIComponent(passedUri.replace(/^file:\/\//, ""))).toBe("/local/clip%20one.mov")
		})

		// Mirror image: the SDK opens the path verbatim, so this branch owes it exactly one decode.
		it("hands the SDK the once-decoded path for a name carrying a literal percent-escape", async () => {
			fs.set(THUMBNAILS_DIR, "dir")

			await thumbnails.generateFromLocalFile({
				localUri: "file:///local/IMG%2520001.jpg",
				uuid: "escaped-img-uuid",
				name: "IMG%20001.jpg",
				canMakeThumbnail: true
			})

			expect(mockMakeThumbnailFromPath).toHaveBeenCalledWith(
				"/local/IMG%20001.jpg",
				THUMBNAIL_MAX_WIDTH,
				THUMBNAIL_MAX_HEIGHT,
				expect.anything(),
				THUMBNAIL_LOSSY_QUALITY,
				undefined
			)
		})

		// The SDK thumbnails SVG on native, but resvg draws <text> and raster <image> as nothing, so the
		// app refuses it at every other entry point. On the flag alone, uploading one wrote a transparent
		// tile that only the uploading device ever saw.
		it("makes no thumbnail for an uploaded .svg the SDK says it can decode", async () => {
			fs.set(THUMBNAILS_DIR, "dir")

			const result = await thumbnails.generateFromLocalFile({
				localUri: "file:///local/logo.svg",
				uuid: "svg-uuid",
				name: "logo.svg",
				canMakeThumbnail: true
			})

			expect(result).toBeNull()
			expect(mockMakeThumbnailFromPath).not.toHaveBeenCalled()
			expect(thumbnails.hasThumbnail("svg-uuid")).toBe(false)
		})

		// Same divergence, blunter: the Rust table admits formats this app never displays (.qoi, .jfif,
		// the RAW tail). Thumbnailing them only on the uploading device is the inconsistency.
		it("makes no thumbnail for a format the SDK admits but the app cannot display", async () => {
			fs.set(THUMBNAILS_DIR, "dir")

			const result = await thumbnails.generateFromLocalFile({
				localUri: "file:///local/sprite.qoi",
				uuid: "qoi-uuid",
				name: "sprite.qoi",
				canMakeThumbnail: true
			})

			expect(result).toBeNull()
			expect(mockMakeThumbnailFromPath).not.toHaveBeenCalled()
		})

		it("makes no SDK call at all when the uploaded record says canMakeThumbnail is false", async () => {
			fs.set(THUMBNAILS_DIR, "dir")

			const result = await thumbnails.generateFromLocalFile({
				localUri: "file:///local/icon.ico",
				uuid: "ico-uuid",
				name: "icon.ico",
				canMakeThumbnail: false
			})

			expect(result).toBeNull()
			expect(mockMakeThumbnailFromPath).not.toHaveBeenCalled()
			expect(mockManipulate).not.toHaveBeenCalled()
		})

		it("returns null for a non-image, non-video upload", async () => {
			const result = await thumbnails.generateFromLocalFile({
				localUri: "file:///local/doc.pdf",
				uuid: "pdf-uuid",
				name: "doc.pdf",
				canMakeThumbnail: false
			})

			expect(result).toBeNull()
			expect(mockMakeThumbnailFromPath).not.toHaveBeenCalled()
		})

		it("returns null for files without extension whose SDK gate is closed", async () => {
			const result = await thumbnails.generateFromLocalFile({
				localUri: "file:///local/noext",
				uuid: "noext-uuid",
				name: "noext",
				canMakeThumbnail: false
			})

			expect(result).toBeNull()
		})

		it("returns cached path when thumbnail already exists", async () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set(`${THUMBNAILS_DIR}/existing-uuid.webp`, new Uint8Array([0xff]))

			const result = await thumbnails.generateFromLocalFile({
				localUri: "file:///local/photo.jpg",
				uuid: "existing-uuid",
				name: "photo.jpg",
				canMakeThumbnail: true
			})

			expect(result).toBe(`${THUMBNAILS_DIR}/existing-uuid.webp`)
			expect(mockMakeThumbnailFromPath).not.toHaveBeenCalled()
		})

		it("returns null on generation failure instead of throwing", async () => {
			fs.set(THUMBNAILS_DIR, "dir")
			mockMakeThumbnailFromPath.mockRejectedValueOnce(new Error("decoder crashed"))

			const result = await thumbnails.generateFromLocalFile({
				localUri: "file:///local/photo.jpg",
				uuid: "fail-uuid",
				name: "photo.jpg",
				canMakeThumbnail: true
			})

			expect(result).toBeNull()
		})

		it("increments failure count on error", async () => {
			fs.set(THUMBNAILS_DIR, "dir")
			mockMakeThumbnailFromPath.mockRejectedValue(new Error("fail"))

			for (let i = 0; i < 4; i++) {
				await thumbnails.generateFromLocalFile({
					localUri: "file:///local/photo.jpg",
					uuid: "repeat-fail-uuid",
					name: "photo.jpg",
					canMakeThumbnail: true
				})
			}

			// The fourth call is blacklisted before the SDK is reached.
			expect(mockMakeThumbnailFromPath).toHaveBeenCalledTimes(3)
		})

		// A verdict is the SDK saying "not this file", not a failure — counting it would burn the
		// blacklist on three uploads of the same unsupported format.
		it("a settled verdict feeds the unavailable Set and leaves the failure ledger untouched", async () => {
			fs.set(THUMBNAILS_DIR, "dir")
			mockMakeThumbnailFromPath.mockResolvedValueOnce(UNSUPPORTED_VERDICT)

			await expect(
				thumbnails.generateFromLocalFile({
					localUri: "file:///local/photo.jpg",
					uuid: "local-verdict-uuid",
					name: "photo.jpg",
					canMakeThumbnail: true
				})
			).resolves.toBeNull()

			expect(thumbnails.isUnavailable("local-verdict-uuid")).toBe(true)
			expect(thumbnails.hasThumbnail("local-verdict-uuid")).toBe(false)
			expect(fs.has(`${THUMBNAILS_DIR}/local-verdict-uuid.webp`)).toBe(false)

			// Three REAL failures still fit before the blacklist closes — the verdict was not one of them.
			mockMakeThumbnailFromPath.mockRejectedValue(new Error("io"))

			for (let i = 0; i < 4; i++) {
				await thumbnails.generateFromLocalFile({
					localUri: "file:///local/photo.jpg",
					uuid: "local-verdict-uuid",
					name: "photo.jpg",
					canMakeThumbnail: true
				})
			}

			expect(mockMakeThumbnailFromPath).toHaveBeenCalledTimes(4)
		})

		// The from-path call carries both cancellation channels, so an abort arrives either as the
		// bindings' AbortError or as a FilenSdkError Cancelled — neither is the file's fault.
		it("does not count a failure when an abort surfaces as a FilenSdkError Cancelled", async () => {
			fs.set(THUMBNAILS_DIR, "dir")

			const controller = new AbortController()

			mockMakeThumbnailFromPath.mockImplementation(async () => {
				controller.abort()

				throw new Error("Cancelled")
			})

			for (let i = 0; i < 4; i++) {
				await thumbnails.generateFromLocalFile({
					localUri: "file:///local/photo.jpg",
					uuid: "sdk-cancelled-uuid",
					name: "photo.jpg",
					canMakeThumbnail: true,
					signal: controller.signal
				})
			}

			// Never blacklisted: all four attempts reached the SDK.
			expect(mockMakeThumbnailFromPath).toHaveBeenCalledTimes(4)
		})

		it("does not count a failure when the bindings reject with their own AbortError", async () => {
			fs.set(THUMBNAILS_DIR, "dir")

			const abortError = new Error("The operation was aborted")

			abortError.name = "AbortError"

			mockMakeThumbnailFromPath.mockRejectedValue(abortError)

			for (let i = 0; i < 4; i++) {
				await thumbnails.generateFromLocalFile({
					localUri: "file:///local/photo.jpg",
					uuid: "bindings-abort-uuid",
					name: "photo.jpg",
					canMakeThumbnail: true
				})
			}

			expect(mockMakeThumbnailFromPath).toHaveBeenCalledTimes(4)
		})

		it("does not use HTTP provider for local video", async () => {
			fs.set(THUMBNAILS_DIR, "dir")
			mockHttpStoreState.port = null
			mockHttpStoreState.getFileUrl = null

			const result = await thumbnails.generateFromLocalFile({
				localUri: "file:///local/video.mp4",
				uuid: "local-vid-no-http-uuid",
				name: "video.mp4",
				canMakeThumbnail: false
			})

			expect(result).toBe(`${THUMBNAILS_DIR}/local-vid-no-http-uuid.webp`)
			expect(mockGetFileUrl).not.toHaveBeenCalled()
		})

		it("marks the availability Set on success", async () => {
			fs.set(THUMBNAILS_DIR, "dir")

			await thumbnails.generateFromLocalFile({
				localUri: "file:///local/photo.jpg",
				uuid: "cache-uuid",
				name: "photo.jpg",
				canMakeThumbnail: true
			})

			expect(thumbnails.hasThumbnail("cache-uuid")).toBe(true)
		})
	})

	describe("generate — OfflineAbortError branch", () => {
		it("video: throws without counting as a failure when offline and no offline file", async () => {
			mockIsOnline.mockReturnValue(false)

			const item = makeFileItem("offline-vid-uuid", "clip.mp4")

			await expect(thumbnails.generate({ item })).rejects.toThrow("Offline")

			// Must not have started the HTTP provider wait or frame extraction
			expect(mockGetThumbnailAsync).not.toHaveBeenCalled()

			// Failures map must not be incremented — retry after coming back online works
			mockIsOnline.mockReturnValue(true)

			const result = await thumbnails.generate({ item })

			expect(result).toBe(`${THUMBNAILS_DIR}/offline-vid-uuid.webp`)
			expect(mockGetThumbnailAsync).toHaveBeenCalledTimes(1)
		})
	})

	describe("generate — 0-byte output file integrity check", () => {
		it("generateFromLocalFile: regenerates when existing thumbnail is 0 bytes", async () => {
			const outputPath = `${THUMBNAILS_DIR}/zero-byte-local-uuid.webp`
			fs.set(outputPath, new Uint8Array(0))
			fs.set("file:///local/photo.jpg", new Uint8Array([1, 2, 3]))

			const result = await thumbnails.generateFromLocalFile({
				localUri: "file:///local/photo.jpg",
				uuid: "zero-byte-local-uuid",
				name: "photo.jpg",
				canMakeThumbnail: true
			})

			expect(mockMakeThumbnailFromPath).toHaveBeenCalledTimes(1)
			expect(result).toBe(`${THUMBNAILS_DIR}/zero-byte-local-uuid.webp`)
		})
	})

	describe("generate — savedFile.move() failure path", () => {
		it("video: throws wrapped error and cleans up when move fails", async () => {
			const { File: MockFile } = await import("@/tests/mocks/expoFileSystem")

			mockSaveAsync.mockImplementationOnce(async () => {
				const uri = "file:///cache/manipulated-vid-movefail.jpg"

				fs.set(uri, new Uint8Array([0xff, 0xd8]))

				vi.spyOn(MockFile.prototype, "move").mockImplementationOnce(() => {
					throw new Error("EROFS read-only file system")
				})

				return { uri }
			})

			const item = makeFileItem("move-fail-vid-uuid", "clip.mp4")

			await expect(thumbnails.generate({ item })).rejects.toThrow(
				"Failed to move thumbnail to output path: EROFS read-only file system"
			)
		})
	})

	describe("waitForHttpProvider — 30-second timeout", () => {
		it("rejects with timeout error when HTTP provider never becomes available", async () => {
			vi.useFakeTimers()

			mockHttpStoreState.port = null
			mockHttpStoreState.getFileUrl = null

			const item = makeFileItem("http-timeout-uuid", "clip.mp4")

			// Capture the rejection without letting it escape
			let capturedError: unknown = null
			const promise = thumbnails.generate({ item }).catch(err => {
				capturedError = err instanceof Error ? err : new Error(String(err))
			})

			// Advance past the 30-second timeout; awaiting lets promise microtasks settle
			await vi.advanceTimersByTimeAsync(31_000)
			await promise

			vi.useRealTimers()

			expect(capturedError).not.toBeNull()

			if (capturedError === null) {
				throw new Error("expected capturedError to be set")
			}

			expect((capturedError as Error).message).toBe("HTTP provider unavailable after 30s")
		})
	})

	describe("generate — video offline source", () => {
		it("uses offline-stored file as video URL, bypassing HTTP provider", async () => {
			const { File } = await import("@/tests/mocks/expoFileSystem")
			const offlineMod = await import("@/features/offline/offline")

			const offlineFileUri = "file:///offline/clip.mp4"
			const offlineFile = new File(offlineFileUri)

			fs.set(offlineFileUri, new Uint8Array([1, 2, 3]))
			vi.mocked(offlineMod.default.getLocalFile).mockResolvedValueOnce(
				offlineFile as unknown as Awaited<ReturnType<typeof offlineMod.default.getLocalFile>>
			)

			// HTTP provider is down — should not matter because offline file is used
			mockHttpStoreState.port = null
			mockHttpStoreState.getFileUrl = null

			const item = makeFileItem("vid-offline-uuid", "clip.mp4")
			const result = await thumbnails.generate({ item })

			expect(result).toBe(`${THUMBNAILS_DIR}/vid-offline-uuid.webp`)
			// Frame extraction should have used the offline file path (normalized)
			expect(mockGetThumbnailAsync).toHaveBeenCalledWith(expect.stringContaining("offline/clip.mp4"), {
				time: 1000,
				quality: 1
			})
			expect(mockGetFileUrl).not.toHaveBeenCalled()
		})
	})

	// ---------------------------------------------------------------------------
	// #57 — HTTP-provider-not-ready timeout must NOT be counted as a thumbnail
	// failure (would otherwise permanently blacklist the uuid for the session).
	// ---------------------------------------------------------------------------
	describe("generate — ProviderUnavailableError is non-poisoning (#57)", () => {
		it("video: a 30s provider-unavailable timeout does not increment the failure counter", async () => {
			vi.useFakeTimers()

			const item = makeFileItem("provider-timeout-uuid", "clip.mp4")

			// Drive the provider-unavailable timeout MAX_FAILURES (3) times. If the timeout were
			// counted as a failure, the 4th attempt would throw "Max thumbnail generation failures
			// reached" instead of trying again.
			for (let i = 0; i < 3; i++) {
				mockHttpStoreState.port = null
				mockHttpStoreState.getFileUrl = null

				let captured: unknown = null
				const promise = thumbnails.generate({ item }).catch(err => {
					captured = err
				})

				await vi.advanceTimersByTimeAsync(31_000)
				await promise

				expect((captured as Error | null)?.name).toBe("ProviderUnavailableError")
			}

			vi.useRealTimers()

			// Provider now ready — generation must proceed (NOT blocked by the failure cap),
			// proving the timeouts were never counted.
			mockHttpStoreState.port = 8080
			mockHttpStoreState.getFileUrl = mockGetFileUrl

			const result = await thumbnails.generate({ item })

			expect(result).toBe(`${THUMBNAILS_DIR}/provider-timeout-uuid.webp`)
			expect(mockGetThumbnailAsync).toHaveBeenCalledTimes(1)
		})

		it("clears the failure counter when connectivity returns (onlineManager false→true recovery)", async () => {
			// Drive a genuine content failure to the MAX_FAILURES cap.
			mockMakeThumbnailInMemory.mockRejectedValue(new Error("corrupt file"))

			const item = makeFileItem("recovery-online-uuid", "photo.jpg")

			for (let i = 0; i < 3; i++) {
				await expect(thumbnails.generate({ item })).rejects.toThrow("corrupt file")
			}

			// Confirm it is now blacklisted for the session.
			mockMakeThumbnailInMemory.mockClear()
			await expect(thumbnails.generate({ item })).rejects.toThrow("Max thumbnail generation failures reached")
			expect(mockMakeThumbnailInMemory).not.toHaveBeenCalled()

			// Simulate connectivity returning: the recovery subscription clears this.failures.
			expect(mockOnlineSubscribers.size).toBeGreaterThan(0)

			for (const listener of mockOnlineSubscribers) {
				listener(true)
			}

			// Restore a working download — the item must now generate again (counter was cleared).
			mockMakeThumbnailInMemory.mockResolvedValue(thumbnailVerdict())

			const result = await thumbnails.generate({ item })

			expect(mockMakeThumbnailInMemory).toHaveBeenCalledTimes(1)
			expect(result).toBe(`${THUMBNAILS_DIR}/recovery-online-uuid.webp`)
		})
	})

	// ---------------------------------------------------------------------------
	// #33 — invalidateFile drops the on-disk artifact + availability-Set entry
	// but PRESERVES this.failures, so the consumer's render-error loop stays capped.
	// (Contrast remove(), which clears this.failures — covered above.)
	// ---------------------------------------------------------------------------
	describe("invalidateFile (#33)", () => {
		it("deletes the on-disk thumbnail file", () => {
			const outputPath = `${THUMBNAILS_DIR}/invalidate-uuid.webp`
			fs.set(outputPath, new Uint8Array([0xff, 0xd8]))

			const item = makeFileItem("invalidate-uuid", "photo.jpg")
			thumbnails.invalidateFile(item)

			expect(fs.has(outputPath)).toBe(false)
		})

		it("removes the uuid from the availability Set", () => {
			const item = makeFileItem("invalidate-avail-uuid", "photo.jpg")

			fs.set(THUMBNAILS_DIR, "dir")
			fs.set(`${THUMBNAILS_DIR}/invalidate-avail-uuid.webp`, new Uint8Array([0xff, 0xd8]))

			thumbnails.restore()

			expect(thumbnails.hasThumbnail("invalidate-avail-uuid")).toBe(true)

			thumbnails.invalidateFile(item)

			expect(thumbnails.hasThumbnail("invalidate-avail-uuid")).toBe(false)
		})

		it("does NOT reset the failure counter (unlike remove)", async () => {
			mockMakeThumbnailInMemory.mockRejectedValue(new Error("corrupt"))

			const item = makeFileItem("invalidate-keep-failures-uuid", "photo.jpg")

			// Reach the failure cap.
			for (let i = 0; i < 3; i++) {
				await expect(thumbnails.generate({ item })).rejects.toThrow("corrupt")
			}

			// invalidateFile drops the artifact but must NOT clear this.failures — so the item
			// stays blacklisted. (remove() would have uncapped it; that distinction is the fix.)
			thumbnails.invalidateFile(item)

			mockMakeThumbnailInMemory.mockClear()
			await expect(thumbnails.generate({ item })).rejects.toThrow("Max thumbnail generation failures reached")
			expect(mockMakeThumbnailInMemory).not.toHaveBeenCalled()
		})

		it("no-op when the file does not exist", () => {
			const item = makeFileItem("invalidate-missing-uuid", "photo.jpg")

			expect(() => {
				thumbnails.invalidateFile(item)
			}).not.toThrow()
		})
	})

	// ---------------------------------------------------------------------------
	// The availability Set is disk-derived and module-owned: restore() rebuilds it once at boot from
	// the thumbnails directory listing; every generate/invalidate/remove/clear path keeps it coherent.
	// ---------------------------------------------------------------------------
	describe("restore / availability Set", () => {
		it("indexes only <uuid>.webp basenames into the availability Set, skipping subdirs, .webp.tmp and stray files", () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set(`${THUMBNAILS_DIR}/uuid-a.webp`, new Uint8Array([1]))
			fs.set(`${THUMBNAILS_DIR}/uuid-b.webp`, new Uint8Array([2]))
			fs.set(`${THUMBNAILS_DIR}/uuid-d.webp.tmp`, new Uint8Array([3]))
			fs.set(`${THUMBNAILS_DIR}/thumb_tmp_x`, "dir")
			fs.set(`${THUMBNAILS_DIR}/thumb_tmp_x/source.jpg`, new Uint8Array([3]))
			fs.set(`${THUMBNAILS_DIR}/partial.filendl`, new Uint8Array([4]))

			thumbnails.restore()

			expect(thumbnails.hasThumbnail("uuid-a")).toBe(true)
			expect(thumbnails.hasThumbnail("uuid-b")).toBe(true)
			expect(thumbnails.hasThumbnail("uuid-d")).toBe(false)
			expect(thumbnails.hasThumbnail("uuid-d.webp")).toBe(false)
			expect(thumbnails.hasThumbnail("thumb_tmp_x")).toBe(false)
			expect(thumbnails.hasThumbnail("partial")).toBe(false)
			expect(thumbnails.isUnavailable("uuid-a")).toBe(false)
		})

		it("deletes an orphaned <uuid>.webp.tmp rather than only skipping it", () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set(`${THUMBNAILS_DIR}/x.webp.tmp`, new Uint8Array([1]))

			thumbnails.restore()

			expect(fs.has(`${THUMBNAILS_DIR}/x.webp.tmp`)).toBe(false)
			expect(thumbnails.hasThumbnail("x")).toBe(false)
			expect(thumbnails.hasThumbnail("x.webp")).toBe(false)
		})

		it("hasThumbnail is false before restore and true after", () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set(`${THUMBNAILS_DIR}/seen-uuid.webp`, new Uint8Array([1]))

			expect(thumbnails.hasThumbnail("seen-uuid")).toBe(false)

			thumbnails.restore()

			expect(thumbnails.hasThumbnail("seen-uuid")).toBe(true)
		})

		it("a generate() cache-hit marks the availability Set", async () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set(`${THUMBNAILS_DIR}/hit-uuid.webp`, new Uint8Array([0xff, 0xd8]))

			expect(thumbnails.hasThumbnail("hit-uuid")).toBe(false)

			await thumbnails.generate({ item: makeFileItem("hit-uuid", "photo.jpg") })

			expect(thumbnails.hasThumbnail("hit-uuid")).toBe(true)
		})

		it("generateFromLocalFile marks the availability Set", async () => {
			fs.set(THUMBNAILS_DIR, "dir")

			await thumbnails.generateFromLocalFile({
				localUri: "file:///local/photo.jpg",
				uuid: "local-mark-uuid",
				name: "photo.jpg",
				canMakeThumbnail: true
			})

			expect(thumbnails.hasThumbnail("local-mark-uuid")).toBe(true)
		})

		it("restore() is once-per-process — a second call is a no-op", () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set(`${THUMBNAILS_DIR}/first-uuid.webp`, new Uint8Array([1]))

			thumbnails.restore()

			expect(thumbnails.hasThumbnail("first-uuid")).toBe(true)

			// A file that appears AFTER the first restore must NOT be picked up by a second restore().
			fs.set(`${THUMBNAILS_DIR}/second-uuid.webp`, new Uint8Array([2]))

			thumbnails.restore()

			expect(thumbnails.hasThumbnail("second-uuid")).toBe(false)
		})

		// A THUMBNAILS_VERSION bump strands the whole previous tree: clear() and size() both root at the
		// CURRENT version directory, so nothing on disk reaches those bytes again. restore() is the only
		// caller, and without this the call can be deleted with the rest of the suite still green.
		it("sweeps the stale version directories on the boot path", () => {
			fs.set(THUMBNAILS_DIR, "dir")

			thumbnails.restore()

			expect(mockSweepStaleThumbnailVersions).toHaveBeenCalledTimes(1)
		})

		// Load-bearing order, not incidental: an upgrade must free the previous version's bytes before
		// it starts writing new ones into the current version, not after.
		it("sweeps BEFORE the current version directory is ensured", () => {
			thumbnails.restore()

			const sweepOrder = mockSweepStaleThumbnailVersions.mock.invocationCallOrder[0] ?? Infinity
			const ensureOrder = mockEnsureDirectory.mock.invocationCallOrder[0] ?? -Infinity

			expect(sweepOrder).toBeLessThan(ensureOrder)
		})

		it("does not sweep again on a second restore() — the once-per-process guard covers it", () => {
			fs.set(THUMBNAILS_DIR, "dir")

			thumbnails.restore()
			thumbnails.restore()

			expect(mockSweepStaleThumbnailVersions).toHaveBeenCalledTimes(1)
		})

		it("leaves the Set empty when the directory listing throws (self-heals via per-item generate)", () => {
			fs.set(THUMBNAILS_DIR, "dir")

			const listSpy = vi.spyOn(Directory.prototype, "listAsRecords").mockImplementationOnce(() => {
				throw new Error("readdir failed")
			})

			expect(() => thumbnails.restore()).not.toThrow()
			expect(thumbnails.hasThumbnail("anything")).toBe(false)

			listSpy.mockRestore()
		})

		// restore() takes the last path segment with a plain slice instead of Paths.basename, because
		// that helper routes every entry through Expo's pure-JS `new URL()` polyfill — seconds of
		// SYNCHRONOUS boot time on an account with tens of thousands of thumbnails. The slice is only
		// equivalent while nothing percent-encoded reaches this directory, so the escape hatch has to
		// keep working.
		it("indexes a plain <uuid>.webp entry without needing the URL decoder", () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set(`${THUMBNAILS_DIR}/4d2a7e18-0f3b-4c9a-9d61-8e5f0a1b2c3d.webp`, new Uint8Array([1]))

			thumbnails.restore()

			expect(thumbnails.hasThumbnail("4d2a7e18-0f3b-4c9a-9d61-8e5f0a1b2c3d")).toBe(true)
		})

		it("routes only percent-escaped names through the exact decoder, never the plain ones", () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set(`${THUMBNAILS_DIR}/4d2a7e18-0f3b-4c9a-9d61-8e5f0a1b2c3d.webp`, new Uint8Array([1]))

			const basenameSpy = vi.spyOn(Paths, "basename")

			thumbnails.restore()

			// The whole point of the fast path: a plain name never reaches the URL-parsing helper.
			expect(basenameSpy).not.toHaveBeenCalled()

			const internals = thumbnails as unknown as { restored: boolean; available: Set<string> }

			internals.restored = false
			internals.available.clear()
			fs.set(`${THUMBNAILS_DIR}/a%20b.webp`, new Uint8Array([2]))

			thumbnails.restore()

			// An escaped segment must still be resolved by Paths.basename (the exact decoder in
			// production), not by the slice — otherwise the fast path would silently change behaviour.
			expect(basenameSpy).toHaveBeenCalledWith(`${THUMBNAILS_DIR}/a%20b.webp`)

			basenameSpy.mockRestore()
		})
	})
})

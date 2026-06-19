import { vi, describe, it, expect, beforeEach } from "vitest"

const {
	mockSaveAsync,
	mockRenderAsync,
	mockResize,
	mockRotate,
	mockManipulate,
	mockGetThumbnailAsync,
	mockDownloadFileToPath,
	mockGetSdkClients,
	mockGetFileUrl,
	mockHttpStoreState,
	mockHttpStoreSubscribers,
	mockRandomUUID,
	mockAvailableThumbnails,
	mockIsOnline,
	mockOnlineSubscribers
} = vi.hoisted(() => {
	const mockSaveAsync = vi.fn().mockResolvedValue({ uri: "file:///cache/manipulated.jpg" })
	const mockRenderAsync = vi.fn().mockResolvedValue({ saveAsync: mockSaveAsync })
	const mockResize = vi.fn().mockReturnValue({ renderAsync: mockRenderAsync })
	const mockRotate = vi.fn()
	const mockManipulate = vi.fn().mockReturnValue({
		resize: mockResize,
		rotate: mockRotate,
		renderAsync: mockRenderAsync
	})

	const mockGetThumbnailAsync = vi.fn().mockResolvedValue({ uri: "file:///cache/vidframe.jpg", width: 1920, height: 1080 })

	const mockDownloadFileToPath = vi.fn().mockResolvedValue(undefined)
	const mockGetSdkClients = vi.fn().mockResolvedValue({
		authedSdkClient: {
			downloadFileToPath: mockDownloadFileToPath
		}
	})

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

	const mockRandomUUID = vi.fn(() => "mock-uuid-1234")
	const mockIsOnline = vi.fn(() => true)
	const mockOnlineSubscribers = new Set<(online: boolean) => void>()

	return {
		mockSaveAsync,
		mockRenderAsync,
		mockResize,
		mockRotate,
		mockManipulate,
		mockGetThumbnailAsync,
		mockDownloadFileToPath,
		mockGetSdkClients,
		mockGetFileUrl,
		mockHttpStoreState,
		mockHttpStoreSubscribers,
		mockRandomUUID,
		mockAvailableThumbnails: new Map<string, boolean>(),
		mockIsOnline,
		mockOnlineSubscribers
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
		ManagedFuture: {
			new: vi.fn(() => ({}))
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

vi.mock("@/lib/paths", () => ({
	normalizeFilePathForExpo: vi.fn((path: string) => (path.startsWith("file://") ? path : `file://${path}`)),
	normalizeFilePathForSdk: vi.fn((path: string) => path.replace("file://", ""))
}))

vi.mock("@/lib/signals", () => ({
	wrapAbortSignalForSdk: vi.fn(() => ({}))
}))

vi.mock("@/lib/cache", () => ({
	default: {
		availableThumbnails: mockAvailableThumbnails
	}
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

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

vi.mock("expo-crypto", () => ({
	randomUUID: mockRandomUUID
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

import thumbnails, { DEFAULT_WIDTH } from "@/lib/thumbnails"
import { fs } from "@/tests/mocks/expoFileSystem"

const THUMBNAILS_DIR = "file:///shared/group.io.filen.app/thumbnails/v2"

function makeFileItem(uuid: string, name: string): any {
	return {
		type: "file" as const,
		data: {
			uuid,
			size: 1024n,
			decryptedMeta: { name }
		}
	}
}

function makeSharedFileItem(uuid: string, name: string): any {
	return {
		type: "sharedFile" as const,
		data: {
			uuid,
			size: 1024n,
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

describe("Thumbnails", () => {
	beforeEach(() => {
		fs.clear()
		vi.clearAllMocks()
		mockAvailableThumbnails.clear()
		mockHttpStoreSubscribers.clear()

		mockSaveAsync.mockImplementation(async () => {
			const uri = "file:///cache/manipulated.jpg"
			fs.set(uri, new Uint8Array([0xff, 0xd8]))
			return { uri }
		})

		mockRenderAsync.mockResolvedValue({ saveAsync: mockSaveAsync })
		mockResize.mockReturnValue({ renderAsync: mockRenderAsync })

		const manipulatorResult = {
			resize: mockResize,
			rotate: mockRotate,
			renderAsync: mockRenderAsync
		}

		mockRotate.mockReturnValue(manipulatorResult)
		mockManipulate.mockReturnValue(manipulatorResult)

		mockDownloadFileToPath.mockImplementation(async (_file: unknown, path: string) => {
			fs.set(`file://${path}`, new Uint8Array([1, 2, 3]))
		})

		mockGetThumbnailAsync.mockResolvedValue({ uri: "file:///cache/vidframe.jpg", width: 1920, height: 1080 })

		mockHttpStoreState.port = 8080
		mockHttpStoreState.getFileUrl = mockGetFileUrl

		mockIsOnline.mockReturnValue(true)
	})

	describe("generate — image thumbnails", () => {
		it("generates thumbnail for a .jpg file", async () => {
			const item = makeFileItem("test-uuid", "photo.jpg")
			const result = await thumbnails.generate({ item })

			expect(mockDownloadFileToPath).toHaveBeenCalledTimes(1)
			expect(mockDownloadFileToPath).toHaveBeenCalledWith(
				expect.objectContaining({ tag: "File", inner: [item.data] }),
				expect.stringContaining("source.jpg"),
				undefined,
				expect.any(Object),
				undefined
			)

			expect(mockManipulate).toHaveBeenCalledTimes(1)
			expect(mockResize).toHaveBeenCalledWith({
				width: DEFAULT_WIDTH
			})
			expect(mockRenderAsync).toHaveBeenCalledTimes(1)
			expect(mockSaveAsync).toHaveBeenCalledWith({
				compress: 0.9,
				format: "webp",
				base64: false
			})

			expect(result).toBe(`${THUMBNAILS_DIR}/test-uuid.webp`)
		})

		it("uses custom width/quality when specified", async () => {
			const item = makeFileItem("custom-uuid", "photo.jpg")
			await thumbnails.generate({
				item,
				width: 512,
				quality: 0.5
			})

			expect(mockResize).toHaveBeenCalledWith({
				width: 512
			})
			expect(mockSaveAsync).toHaveBeenCalledWith(
				expect.objectContaining({
					compress: 0.5
				})
			)
		})

		it("returns cached path when thumbnail already exists on disk", async () => {
			const outputPath = `${THUMBNAILS_DIR}/cached-uuid.webp`
			fs.set(outputPath, new Uint8Array([0xff, 0xd8]))

			const item = makeFileItem("cached-uuid", "photo.jpg")
			const result = await thumbnails.generate({ item })

			expect(result).toBe(outputPath)
			expect(mockDownloadFileToPath).not.toHaveBeenCalled()
			expect(mockManipulate).not.toHaveBeenCalled()
		})

		it("uses offline-stored file when available, skipping download", async () => {
			const { File } = await import("@/tests/mocks/expoFileSystem")
			const offlineMod = await import("@/features/offline/offline")

			const offlineFileUri = "file:///offline/photo.jpg"
			const offlineFile = new File(offlineFileUri)

			fs.set(offlineFileUri, new Uint8Array([1, 2, 3]))
			vi.mocked(offlineMod.default.getLocalFile).mockResolvedValueOnce(
				offlineFile as unknown as Awaited<ReturnType<typeof offlineMod.default.getLocalFile>>
			)

			const item = makeFileItem("offline-hit-uuid", "photo.jpg")
			const result = await thumbnails.generate({ item })

			expect(mockDownloadFileToPath).not.toHaveBeenCalled()
			expect(mockManipulate).toHaveBeenCalledWith(offlineFileUri)
			expect(result).toBe(`${THUMBNAILS_DIR}/offline-hit-uuid.webp`)
		})

		it("uses fileCache hit when offline file not available, skipping download", async () => {
			const { File } = await import("@/tests/mocks/expoFileSystem")
			const fileCacheMod = await import("@/lib/fileCache")

			const cachedFileUri = "file:///fileCache/photo.jpg"
			const cachedFile = new File(cachedFileUri)

			fs.set(cachedFileUri, new Uint8Array([1, 2, 3]))
			vi.mocked(fileCacheMod.default.has).mockResolvedValueOnce(true)
			vi.mocked(fileCacheMod.default.get).mockResolvedValueOnce(
				cachedFile as unknown as Awaited<ReturnType<typeof fileCacheMod.default.get>>
			)

			const item = makeFileItem("filecache-hit-uuid", "photo.jpg")
			const result = await thumbnails.generate({ item })

			expect(mockDownloadFileToPath).not.toHaveBeenCalled()
			expect(mockManipulate).toHaveBeenCalledWith(cachedFileUri)
			expect(result).toBe(`${THUMBNAILS_DIR}/filecache-hit-uuid.webp`)
		})

		it("throws for unsupported extensions", async () => {
			const item = makeFileItem("pdf-uuid", "document.pdf")

			await expect(thumbnails.generate({ item })).rejects.toThrow("Unsupported file type")
			expect(mockDownloadFileToPath).not.toHaveBeenCalled()
		})

		it("throws for directory items", async () => {
			const item = makeDirItem("dir-uuid", "my-folder")

			await expect(thumbnails.generate({ item })).rejects.toThrow("File has no extension")
		})

		it("throws for items without decryptedMeta name", async () => {
			const item: any = {
				type: "file" as const,
				data: {
					uuid: "no-meta-uuid",
					size: 1024n,
					decryptedMeta: { name: undefined }
				}
			}

			await expect(thumbnails.generate({ item })).rejects.toThrow("File has no extension")
		})

		it("throws when download fails", async () => {
			mockDownloadFileToPath.mockRejectedValueOnce(new Error("network error"))

			const item = makeFileItem("fail-dl-uuid", "photo.jpg")

			await expect(thumbnails.generate({ item })).rejects.toThrow("network error")
		})

		it("throws when manipulator fails", async () => {
			mockRenderAsync.mockRejectedValueOnce(new Error("manipulator error"))

			const item = makeFileItem("fail-manip-uuid", "photo.jpg")

			await expect(thumbnails.generate({ item })).rejects.toThrow("manipulator error")
		})

		it("cleans up temp directory on success", async () => {
			const item = makeFileItem("cleanup-ok-uuid", "photo.jpg")
			await thumbnails.generate({ item })

			const tempDirUri = `${THUMBNAILS_DIR}/thumb_tmp_mock-uuid-1234`
			expect(fs.has(tempDirUri)).toBe(false)
		})

		it("cleans up temp directory on failure", async () => {
			mockDownloadFileToPath.mockRejectedValueOnce(new Error("fail"))

			const item = makeFileItem("cleanup-fail-uuid", "photo.jpg")

			await expect(thumbnails.generate({ item })).rejects.toThrow("fail")

			const tempDirUri = `${THUMBNAILS_DIR}/thumb_tmp_mock-uuid-1234`
			expect(fs.has(tempDirUri)).toBe(false)
		})
	})

	describe("generate — no manual rotation", () => {
		it("does not call rotate for any image", async () => {
			const item = makeFileItem("norot-uuid", "photo.jpg")
			await thumbnails.generate({ item })

			expect(mockRotate).not.toHaveBeenCalled()
			expect(mockResize).toHaveBeenCalledWith({ width: DEFAULT_WIDTH })
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

	describe("generate — shared files", () => {
		it("generates thumbnail for shared file items", async () => {
			const item = makeSharedFileItem("shared-uuid", "shared-photo.jpg")
			const result = await thumbnails.generate({ item })

			expect(mockDownloadFileToPath).toHaveBeenCalledWith(
				expect.objectContaining({ tag: "Shared", inner: [item.data] }),
				expect.stringContaining("source.jpg"),
				undefined,
				expect.any(Object),
				undefined
			)
			expect(result).toBe(`${THUMBNAILS_DIR}/shared-uuid.webp`)
		})

		it("works with sharedRootFile type", async () => {
			const item = {
				type: "sharedRootFile" as const,
				data: {
					uuid: "shared-root-uuid",
					size: 1024n,
					decryptedMeta: { name: "shared-root.jpg" }
				}
			} as any

			const result = await thumbnails.generate({ item })

			expect(mockDownloadFileToPath).toHaveBeenCalledWith(
				expect.objectContaining({ tag: "Shared", inner: [item.data] }),
				expect.stringContaining("source.jpg"),
				undefined,
				expect.any(Object),
				undefined
			)
			expect(result).toBe(`${THUMBNAILS_DIR}/shared-root-uuid.webp`)
		})
	})

	describe("generate — deduplication", () => {
		it("returns same promise for concurrent calls with same UUID", async () => {
			let resolveDownload!: () => void
			const downloadStarted = new Promise<void>(started => {
				mockDownloadFileToPath.mockImplementationOnce(
					(_file: unknown, path: string) =>
						new Promise<void>(resolve => {
							resolveDownload = () => {
								fs.set(`file://${path}`, new Uint8Array([1, 2, 3]))
								resolve()
							}

							started()
						})
				)
			})

			const item = makeFileItem("dedup-uuid", "photo.jpg")

			const promise1 = thumbnails.generate({ item })
			const promise2 = thumbnails.generate({ item })

			await downloadStarted

			resolveDownload()

			const [result1, result2] = await Promise.all([promise1, promise2])

			expect(result1).toBe(result2)
			expect(mockDownloadFileToPath).toHaveBeenCalledTimes(1)
		})
	})

	describe("generate — abort signal", () => {
		it("image: passes signal through generate() to ManagedFuture", async () => {
			const { ManagedFuture } = await import("@filen/sdk-rs")
			const { wrapAbortSignalForSdk } = await import("@/lib/signals")

			const controller = new AbortController()
			const item = makeFileItem("abort-img-uuid", "photo.jpg")

			await thumbnails.generate({
				item,
				signal: controller.signal
			})

			expect(wrapAbortSignalForSdk).toHaveBeenCalledWith(controller.signal)
			expect(ManagedFuture.new).toHaveBeenCalledWith(
				expect.objectContaining({
					abortSignal: expect.any(Object)
				})
			)
		})

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

		it("does not pass signal when not provided", async () => {
			const { ManagedFuture } = await import("@filen/sdk-rs")

			const item = makeFileItem("no-signal-uuid", "photo.jpg")

			await thumbnails.generate({ item })

			expect(ManagedFuture.new).toHaveBeenCalledWith(
				expect.objectContaining({
					abortSignal: undefined
				})
			)
		})

		it("image: aborts between download and manipulate", async () => {
			const controller = new AbortController()

			mockDownloadFileToPath.mockImplementationOnce(async (_file: unknown, path: string) => {
				fs.set(`file://${path}`, new Uint8Array([1, 2, 3]))

				// Abort after download completes but before manipulate runs
				controller.abort()
			})

			const item = makeFileItem("abort-post-dl-uuid", "photo.jpg")

			await expect(
				thumbnails.generate({
					item,
					signal: controller.signal
				})
			).rejects.toThrow()

			expect(mockManipulate).not.toHaveBeenCalled()
		})

		it("image: aborts between renderAsync and saveAsync", async () => {
			const controller = new AbortController()

			mockRenderAsync.mockImplementationOnce(async () => {
				// Abort after render completes but before save runs
				controller.abort()

				return { saveAsync: mockSaveAsync }
			})

			const item = makeFileItem("abort-post-render-uuid", "photo.jpg")

			await expect(
				thumbnails.generate({
					item,
					signal: controller.signal
				})
			).rejects.toThrow()

			expect(mockSaveAsync).not.toHaveBeenCalled()
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

			expect(mockDownloadFileToPath).not.toHaveBeenCalled()
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
			mockDownloadFileToPath.mockRejectedValue(new Error("corrupt file"))

			const item = makeFileItem("fail-track-uuid", "photo.jpg")

			// Fail 3 times (each throws)
			for (let i = 0; i < 3; i++) {
				await expect(thumbnails.generate({ item })).rejects.toThrow("corrupt file")
			}

			expect(mockDownloadFileToPath).toHaveBeenCalledTimes(3)

			// 4th attempt should be skipped entirely — throws without trying
			mockDownloadFileToPath.mockClear()

			await expect(thumbnails.generate({ item })).rejects.toThrow("Max thumbnail generation failures reached")
			expect(mockDownloadFileToPath).not.toHaveBeenCalled()
		})

		it("does not affect other items when one item hits the failure limit", async () => {
			mockDownloadFileToPath.mockRejectedValue(new Error("corrupt"))

			const failItem = makeFileItem("fail-item-uuid", "bad.jpg")

			for (let i = 0; i < 3; i++) {
				await expect(thumbnails.generate({ item: failItem })).rejects.toThrow()
			}

			// Restore normal behavior for the good item
			mockDownloadFileToPath.mockImplementation(async (_file: unknown, path: string) => {
				fs.set(`file://${path}`, new Uint8Array([1, 2, 3]))
			})

			const goodItem = makeFileItem("good-item-uuid", "good.jpg")
			const result = await thumbnails.generate({ item: goodItem })

			expect(result).toBe(`${THUMBNAILS_DIR}/good-item-uuid.webp`)
		})

		it("resets failure count when clear() is called", async () => {
			mockDownloadFileToPath.mockRejectedValue(new Error("corrupt"))

			const item = makeFileItem("reset-fail-uuid", "photo.jpg")

			for (let i = 0; i < 3; i++) {
				await expect(thumbnails.generate({ item })).rejects.toThrow()
			}

			// Confirm it's blocked
			mockDownloadFileToPath.mockClear()
			await expect(thumbnails.generate({ item })).rejects.toThrow("Max thumbnail generation failures reached")
			expect(mockDownloadFileToPath).not.toHaveBeenCalled()

			// Clear resets failures
			await thumbnails.clear()

			// Restore working download
			mockDownloadFileToPath.mockImplementation(async (_file: unknown, path: string) => {
				fs.set(`file://${path}`, new Uint8Array([1, 2, 3]))
			})

			const result = await thumbnails.generate({ item })
			expect(mockDownloadFileToPath).toHaveBeenCalledTimes(1)
			expect(result).toBe(`${THUMBNAILS_DIR}/reset-fail-uuid.webp`)
		})

		it("does not count aborts toward the failure limit", async () => {
			const item = makeFileItem("abort-no-fail-uuid", "photo.jpg")

			// Abort 3 times — should NOT hit the failure limit
			for (let i = 0; i < 3; i++) {
				const controller = new AbortController()

				mockDownloadFileToPath.mockImplementationOnce(async (_file: unknown, path: string) => {
					fs.set(`file://${path}`, new Uint8Array([1, 2, 3]))

					controller.abort()
				})

				await expect(
					thumbnails.generate({
						item,
						signal: controller.signal
					})
				).rejects.toThrow()
			}

			// Should still be able to generate — aborts didn't count as failures
			mockDownloadFileToPath.mockImplementation(async (_file: unknown, path: string) => {
				fs.set(`file://${path}`, new Uint8Array([1, 2, 3]))
			})

			const result = await thumbnails.generate({ item })
			expect(result).toBe(`${THUMBNAILS_DIR}/abort-no-fail-uuid.webp`)
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
			mockDownloadFileToPath
				.mockRejectedValueOnce(new Error("fail 1"))
				.mockRejectedValueOnce(new Error("fail 2"))
				.mockImplementationOnce(async (_file: unknown, path: string) => {
					fs.set(`file://${path}`, new Uint8Array([1, 2, 3]))
				})

			const item = makeFileItem("retry-uuid", "photo.jpg")

			await expect(thumbnails.generate({ item })).rejects.toThrow("fail 1")
			await expect(thumbnails.generate({ item })).rejects.toThrow("fail 2")

			const result = await thumbnails.generate({ item })
			expect(result).toBe(`${THUMBNAILS_DIR}/retry-uuid.webp`)
		})
	})

	describe("canGenerate", () => {
		it("returns true for supported image extensions", () => {
			expect(thumbnails.canGenerate(makeFileItem("uuid", "photo.jpg"))).toBe(true)
			expect(thumbnails.canGenerate(makeFileItem("uuid", "photo.png"))).toBe(true)
			expect(thumbnails.canGenerate(makeFileItem("uuid", "photo.webp"))).toBe(true)
		})

		it("returns true for supported video extensions", () => {
			expect(thumbnails.canGenerate(makeFileItem("uuid", "clip.mp4"))).toBe(true)
			expect(thumbnails.canGenerate(makeFileItem("uuid", "clip.mov"))).toBe(true)
			expect(thumbnails.canGenerate(makeFileItem("uuid", "clip.mkv"))).toBe(true)
		})

		it("returns false for unsupported extensions", () => {
			expect(thumbnails.canGenerate(makeFileItem("uuid", "document.pdf"))).toBe(false)
			expect(thumbnails.canGenerate(makeFileItem("uuid", "archive.zip"))).toBe(false)
			expect(thumbnails.canGenerate(makeFileItem("uuid", "notes.txt"))).toBe(false)
		})

		it("returns false for directory items", () => {
			expect(thumbnails.canGenerate(makeDirItem("uuid", "folder"))).toBe(false)
		})

		it("returns false for items without decryptedMeta name", () => {
			const item: any = {
				type: "file" as const,
				data: {
					uuid: "uuid",
					size: 1024n,
					decryptedMeta: { name: undefined }
				}
			}

			expect(thumbnails.canGenerate(item)).toBe(false)
		})
	})

	describe("exists", () => {
		it("returns exists: true with path when thumbnail file exists on disk", () => {
			const outputPath = `${THUMBNAILS_DIR}/exists-uuid.webp`
			fs.set(outputPath, new Uint8Array([0xff, 0xd8]))

			const item = makeFileItem("exists-uuid", "photo.jpg")
			const result = thumbnails.exists(item)

			expect(result.exists).toBe(true)

			if (result.exists) {
				expect(result.path).toBe(outputPath)
			}
		})

		it("returns exists: false when thumbnail file does not exist", () => {
			const item = makeFileItem("nonexistent-uuid", "photo.jpg")
			const result = thumbnails.exists(item)

			expect(result.exists).toBe(false)
		})
	})

	describe("remove", () => {
		it("deletes thumbnail file from disk", () => {
			const outputPath = `${THUMBNAILS_DIR}/remove-uuid.webp`
			fs.set(outputPath, new Uint8Array([0xff, 0xd8]))

			const item = makeFileItem("remove-uuid", "photo.jpg")
			thumbnails.remove(item)

			expect(fs.has(outputPath)).toBe(false)
		})

		it("removes uuid from cache.availableThumbnails", () => {
			const item = makeFileItem("avail-rm-uuid", "photo.jpg")
			mockAvailableThumbnails.set("avail-rm-uuid", true)

			thumbnails.remove(item)

			expect(mockAvailableThumbnails.has("avail-rm-uuid")).toBe(false)
		})

		it("no-op when file does not exist", () => {
			const item = makeFileItem("nonexistent-uuid", "photo.jpg")
			expect(() => {
				thumbnails.remove(item)
			}).not.toThrow()
		})

		it("resets failure count for the item", async () => {
			mockDownloadFileToPath.mockRejectedValue(new Error("corrupt"))

			const item = makeFileItem("remove-reset-uuid", "photo.jpg")

			// Fail twice
			for (let i = 0; i < 2; i++) {
				await expect(thumbnails.generate({ item })).rejects.toThrow("corrupt")
			}

			// Remove resets failure count
			thumbnails.remove(item)

			// Fail 3 more times — should work up to limit again (not carry over the 2)
			for (let i = 0; i < 3; i++) {
				await expect(thumbnails.generate({ item })).rejects.toThrow("corrupt")
			}

			// Now should be blocked
			mockDownloadFileToPath.mockClear()
			await expect(thumbnails.generate({ item })).rejects.toThrow("Max thumbnail generation failures reached")
			expect(mockDownloadFileToPath).not.toHaveBeenCalled()
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
		it("generates thumbnail from a local image path", async () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set("file:///local/photo.jpg", new Uint8Array([1, 2, 3]))

			const result = await thumbnails.generateFromLocalFile({
				localPath: "file:///local/photo.jpg",
				uuid: "local-img-uuid",
				name: "photo.jpg"
			})

			expect(result).toBe(`${THUMBNAILS_DIR}/local-img-uuid.webp`)
			expect(mockManipulate).toHaveBeenCalledWith("file:///local/photo.jpg")
			expect(mockDownloadFileToPath).not.toHaveBeenCalled()
		})

		it("generates thumbnail from a local video path", async () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set("file:///local/video.mp4", new Uint8Array([1, 2, 3]))

			const result = await thumbnails.generateFromLocalFile({
				localPath: "file:///local/video.mp4",
				uuid: "local-vid-uuid",
				name: "video.mp4"
			})

			expect(result).toBe(`${THUMBNAILS_DIR}/local-vid-uuid.webp`)
			expect(mockGetThumbnailAsync).toHaveBeenCalledWith("file:///local/video.mp4", {
				time: 1000,
				quality: 1
			})
		})

		it("returns null for unsupported extensions", async () => {
			const result = await thumbnails.generateFromLocalFile({
				localPath: "file:///local/doc.pdf",
				uuid: "pdf-uuid",
				name: "doc.pdf"
			})

			expect(result).toBeNull()
			expect(mockManipulate).not.toHaveBeenCalled()
		})

		it("returns null for files without extension", async () => {
			const result = await thumbnails.generateFromLocalFile({
				localPath: "file:///local/noext",
				uuid: "noext-uuid",
				name: "noext"
			})

			expect(result).toBeNull()
		})

		it("returns cached path when thumbnail already exists", async () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set(`${THUMBNAILS_DIR}/existing-uuid.webp`, new Uint8Array([0xff]))

			const result = await thumbnails.generateFromLocalFile({
				localPath: "file:///local/photo.jpg",
				uuid: "existing-uuid",
				name: "photo.jpg"
			})

			expect(result).toBe(`${THUMBNAILS_DIR}/existing-uuid.webp`)
			expect(mockManipulate).not.toHaveBeenCalled()
		})

		it("returns null on generation failure instead of throwing", async () => {
			fs.set(THUMBNAILS_DIR, "dir")
			mockManipulate.mockImplementationOnce(() => {
				throw new Error("Manipulator crashed")
			})

			const result = await thumbnails.generateFromLocalFile({
				localPath: "file:///local/photo.jpg",
				uuid: "fail-uuid",
				name: "photo.jpg"
			})

			expect(result).toBeNull()
		})

		it("increments failure count on error", async () => {
			fs.set(THUMBNAILS_DIR, "dir")
			mockManipulate.mockImplementation(() => {
				throw new Error("fail")
			})

			for (let i = 0; i < 3; i++) {
				await thumbnails.generateFromLocalFile({
					localPath: "file:///local/photo.jpg",
					uuid: "repeat-fail-uuid",
					name: "photo.jpg"
				})
			}

			const result = await thumbnails.generateFromLocalFile({
				localPath: "file:///local/photo.jpg",
				uuid: "repeat-fail-uuid",
				name: "photo.jpg"
			})

			expect(result).toBeNull()
			expect(mockManipulate).toHaveBeenCalledTimes(3)
		})

		it("does not use HTTP provider for local video", async () => {
			fs.set(THUMBNAILS_DIR, "dir")
			mockHttpStoreState.port = null
			mockHttpStoreState.getFileUrl = null

			const result = await thumbnails.generateFromLocalFile({
				localPath: "file:///local/video.mp4",
				uuid: "local-vid-no-http-uuid",
				name: "video.mp4"
			})

			expect(result).toBe(`${THUMBNAILS_DIR}/local-vid-no-http-uuid.webp`)
			expect(mockGetFileUrl).not.toHaveBeenCalled()
		})

		it("updates cache.availableThumbnails on success", async () => {
			fs.set(THUMBNAILS_DIR, "dir")

			await thumbnails.generateFromLocalFile({
				localPath: "file:///local/photo.jpg",
				uuid: "cache-uuid",
				name: "photo.jpg"
			})

			expect(mockAvailableThumbnails.get("cache-uuid")).toBe(true)
		})
	})

	describe("generate — OfflineAbortError branch", () => {
		it("image: throws without counting as a failure when offline and no local copy", async () => {
			mockIsOnline.mockReturnValue(false)

			const item = makeFileItem("offline-img-uuid", "photo.jpg")

			// Should reject (OfflineAbortError propagates as a real throw) but NOT increment failures
			await expect(thumbnails.generate({ item })).rejects.toThrow("Offline")

			// Because it's an OfflineAbortError the failures map must NOT be incremented —
			// a subsequent call after coming back online must proceed without hitting the limit.
			mockIsOnline.mockReturnValue(true)
			mockDownloadFileToPath.mockImplementationOnce(async (_file: unknown, path: string) => {
				fs.set(`file://${path}`, new Uint8Array([1, 2, 3]))
			})

			const result = await thumbnails.generate({ item })

			expect(result).toBe(`${THUMBNAILS_DIR}/offline-img-uuid.webp`)
			// Download was called once — offline path short-circuited it, online path used it
			expect(mockDownloadFileToPath).toHaveBeenCalledTimes(1)
		})

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

		it("image: offline path is NOT taken when an offline-cached file exists", async () => {
			const { File } = await import("@/tests/mocks/expoFileSystem")
			const offlineMod = await import("@/features/offline/offline")

			mockIsOnline.mockReturnValue(false)

			const offlineFileUri = "file:///offline/photo.jpg"
			const offlineFile = new File(offlineFileUri)

			fs.set(offlineFileUri, new Uint8Array([1, 2, 3]))
			vi.mocked(offlineMod.default.getLocalFile).mockResolvedValueOnce(
				offlineFile as unknown as Awaited<ReturnType<typeof offlineMod.default.getLocalFile>>
			)

			const item = makeFileItem("offline-img-cached-uuid", "photo.jpg")
			const result = await thumbnails.generate({ item })

			// Proceeds without network because the offline copy exists
			expect(mockDownloadFileToPath).not.toHaveBeenCalled()
			expect(result).toBe(`${THUMBNAILS_DIR}/offline-img-cached-uuid.webp`)
		})
	})

	describe("generate — 0-byte output file integrity check", () => {
		it("image: regenerates when existing thumbnail is 0 bytes", async () => {
			const outputPath = `${THUMBNAILS_DIR}/zero-byte-img-uuid.webp`
			// Seed a corrupt 0-byte file
			fs.set(outputPath, new Uint8Array(0))

			const item = makeFileItem("zero-byte-img-uuid", "photo.jpg")
			const result = await thumbnails.generate({ item })

			// Generation must have proceeded (0-byte cache skipped, not returned as hit)
			expect(mockDownloadFileToPath).toHaveBeenCalledTimes(1)
			expect(result).toBe(`${THUMBNAILS_DIR}/zero-byte-img-uuid.webp`)
			// Final output must be non-empty (the mock saveAsync writes [0xff, 0xd8])
			const finalFile = fs.get(outputPath)

			expect(finalFile instanceof Uint8Array && finalFile.length > 0).toBe(true)
		})

		it("generateFromLocalFile: regenerates when existing thumbnail is 0 bytes", async () => {
			const outputPath = `${THUMBNAILS_DIR}/zero-byte-local-uuid.webp`
			fs.set(outputPath, new Uint8Array(0))
			fs.set("file:///local/photo.jpg", new Uint8Array([1, 2, 3]))

			const result = await thumbnails.generateFromLocalFile({
				localPath: "file:///local/photo.jpg",
				uuid: "zero-byte-local-uuid",
				name: "photo.jpg"
			})

			expect(mockManipulate).toHaveBeenCalledTimes(1)
			expect(result).toBe(`${THUMBNAILS_DIR}/zero-byte-local-uuid.webp`)
		})
	})

	describe("generate — savedFile.move() failure path", () => {
		it("image: throws wrapped error and cleans up when move fails", async () => {
			const { File: MockFile } = await import("@/tests/mocks/expoFileSystem")

			// Make saveAsync produce a file whose move() throws
			mockSaveAsync.mockImplementationOnce(async () => {
				const uri = "file:///cache/manipulated-movefail.jpg"

				// Seed both the saved file and its would-be destination
				fs.set(uri, new Uint8Array([0xff, 0xd8]))

				// Patch the File class for this one call: after saveAsync returns, the source
				// savedFile has the right uri but we need move() to throw. We swap in a
				// custom implementation for the one File that gets created for savedFile.
				const OrigFile = MockFile
				const moveSpy = vi.spyOn(OrigFile.prototype, "move").mockImplementationOnce(() => {
					throw new Error("EACCES permission denied")
				})

				// Store spy ref so we can restore later (test teardown handled by vi.clearAllMocks)
				void moveSpy

				return { uri }
			})

			const item = makeFileItem("move-fail-img-uuid", "photo.jpg")

			await expect(thumbnails.generate({ item })).rejects.toThrow("Failed to move thumbnail to output path: EACCES permission denied")
		})

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
			mockDownloadFileToPath.mockRejectedValue(new Error("corrupt file"))

			const item = makeFileItem("recovery-online-uuid", "photo.jpg")

			for (let i = 0; i < 3; i++) {
				await expect(thumbnails.generate({ item })).rejects.toThrow("corrupt file")
			}

			// Confirm it is now blacklisted for the session.
			mockDownloadFileToPath.mockClear()
			await expect(thumbnails.generate({ item })).rejects.toThrow("Max thumbnail generation failures reached")
			expect(mockDownloadFileToPath).not.toHaveBeenCalled()

			// Simulate connectivity returning: the recovery subscription clears this.failures.
			expect(mockOnlineSubscribers.size).toBeGreaterThan(0)

			for (const listener of mockOnlineSubscribers) {
				listener(true)
			}

			// Restore a working download — the item must now generate again (counter was cleared).
			mockDownloadFileToPath.mockImplementation(async (_file: unknown, path: string) => {
				fs.set(`file://${path}`, new Uint8Array([1, 2, 3]))
			})

			const result = await thumbnails.generate({ item })

			expect(mockDownloadFileToPath).toHaveBeenCalledTimes(1)
			expect(result).toBe(`${THUMBNAILS_DIR}/recovery-online-uuid.webp`)
		})
	})

	// ---------------------------------------------------------------------------
	// #33 — invalidateFile drops the on-disk artifact + availableThumbnails entry
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

		it("removes the uuid from cache.availableThumbnails", () => {
			const item = makeFileItem("invalidate-avail-uuid", "photo.jpg")
			mockAvailableThumbnails.set("invalidate-avail-uuid", true)

			thumbnails.invalidateFile(item)

			expect(mockAvailableThumbnails.has("invalidate-avail-uuid")).toBe(false)
		})

		it("does NOT reset the failure counter (unlike remove)", async () => {
			mockDownloadFileToPath.mockRejectedValue(new Error("corrupt"))

			const item = makeFileItem("invalidate-keep-failures-uuid", "photo.jpg")

			// Reach the failure cap.
			for (let i = 0; i < 3; i++) {
				await expect(thumbnails.generate({ item })).rejects.toThrow("corrupt")
			}

			// invalidateFile drops the artifact but must NOT clear this.failures — so the item
			// stays blacklisted. (remove() would have uncapped it; that distinction is the fix.)
			thumbnails.invalidateFile(item)

			mockDownloadFileToPath.mockClear()
			await expect(thumbnails.generate({ item })).rejects.toThrow("Max thumbnail generation failures reached")
			expect(mockDownloadFileToPath).not.toHaveBeenCalled()
		})

		it("no-op when the file does not exist", () => {
			const item = makeFileItem("invalidate-missing-uuid", "photo.jpg")

			expect(() => {
				thumbnails.invalidateFile(item)
			}).not.toThrow()
		})
	})
})

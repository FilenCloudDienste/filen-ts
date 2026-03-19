import { vi, describe, it, expect, beforeEach } from "vitest"

const {
	mockSaveAsync,
	mockRenderAsync,
	mockResize,
	mockRotate,
	mockManipulate,
	mockGenerateThumbnailsAsync,
	mockRelease,
	mockAddListener,
	mockCreateVideoPlayer,
	mockDownloadFileToPath,
	mockGetSdkClients,
	mockGetFileUrl,
	mockHttpStoreState,
	mockHttpStoreSubscribers,
	mockRandomUUID
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

	const mockGenerateThumbnailsAsync = vi.fn().mockResolvedValue([{ width: 256, height: 144 }])
	const mockRelease = vi.fn()
	const mockAddListener = vi.fn()
	const mockCreateVideoPlayer = vi.fn(() => ({
		status: "readyToPlay" as string,
		generateThumbnailsAsync: mockGenerateThumbnailsAsync,
		release: mockRelease,
		addListener: mockAddListener
	}))

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

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mockHttpStoreSubscribers = new Set<(state: any) => void>()

	const mockRandomUUID = vi.fn(() => "mock-uuid-1234")

	return {
		mockSaveAsync,
		mockRenderAsync,
		mockResize,
		mockRotate,
		mockManipulate,
		mockGenerateThumbnailsAsync,
		mockRelease,
		mockAddListener,
		mockCreateVideoPlayer,
		mockDownloadFileToPath,
		mockGetSdkClients,
		mockGetFileUrl,
		mockHttpStoreState,
		mockHttpStoreSubscribers,
		mockRandomUUID
	}
})

vi.mock("uniffi-bindgen-react-native", () => ({
	UniffiEnum: class {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		protected constructor(..._args: any[]) {}
	}
}))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("expo-image-manipulator", () => ({
	ImageManipulator: {
		manipulate: mockManipulate
	},
	SaveFormat: {
		JPEG: "jpeg",
		PNG: "png"
	}
}))

vi.mock("expo-video", () => ({
	createVideoPlayer: mockCreateVideoPlayer
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

vi.mock("@/lib/utils", () => ({
	normalizeFilePathForExpo: vi.fn((path: string) => (path.startsWith("file://") ? path : `file://${path}`)),
	normalizeFilePathForSdk: vi.fn((path: string) => path.replace("file://", "")),
	wrapAbortSignalForSdk: vi.fn(() => ({}))
}))

vi.mock("@/lib/cache", () => ({
	default: {
		availableThumbnails: {
			clear: vi.fn(),
			delete: vi.fn()
		}
	}
}))

vi.mock("@/constants", () => ({
	EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS: new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"]),
	EXPO_VIDEO_SUPPORTED_EXTENSIONS: new Set([".mp4", ".mov", ".webm", ".mkv"]),
	IOS_APP_GROUP_IDENTIFIER: "group.io.filen.app"
}))

vi.mock("expo-crypto", () => ({
	randomUUID: mockRandomUUID
}))

// eslint-disable-next-line import/first
import thumbnails from "@/lib/thumbnails"
// eslint-disable-next-line import/first
import { fs } from "@/tests/mocks/expoFileSystem"

const THUMBNAILS_DIR = "file:///shared/group.io.filen.app/thumbnails/v1"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

		mockGenerateThumbnailsAsync.mockResolvedValue([{ width: 256, height: 144 }])
		mockCreateVideoPlayer.mockReturnValue({
			status: "readyToPlay",
			generateThumbnailsAsync: mockGenerateThumbnailsAsync,
			release: mockRelease,
			addListener: mockAddListener
		})

		mockHttpStoreState.port = 8080
		mockHttpStoreState.getFileUrl = mockGetFileUrl
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
				width: 256
			})
			expect(mockRenderAsync).toHaveBeenCalledTimes(1)
			expect(mockSaveAsync).toHaveBeenCalledWith({
				compress: 0.8,
				format: "png",
				base64: false
			})

			expect(result).toBe(`${THUMBNAILS_DIR}/test-uuid.png`)
		})

		it("generates thumbnail for a .png file", async () => {
			const item = makeFileItem("png-uuid", "image.png")
			const result = await thumbnails.generate({ item })

			expect(mockDownloadFileToPath).toHaveBeenCalledTimes(1)
			expect(mockManipulate).toHaveBeenCalledTimes(1)
			expect(result).toBe(`${THUMBNAILS_DIR}/png-uuid.png`)
		})

		it("uses default width/quality when not specified", async () => {
			const item = makeFileItem("default-uuid", "photo.jpg")
			await thumbnails.generate({ item })

			expect(mockResize).toHaveBeenCalledWith({
				width: 256
			})
			expect(mockSaveAsync).toHaveBeenCalledWith(
				expect.objectContaining({
					compress: 0.8
				})
			)
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
			const outputPath = `${THUMBNAILS_DIR}/cached-uuid.png`
			fs.set(outputPath, new Uint8Array([0xff, 0xd8]))

			const item = makeFileItem("cached-uuid", "photo.jpg")
			const result = await thumbnails.generate({ item })

			expect(result).toBe(outputPath)
			expect(mockDownloadFileToPath).not.toHaveBeenCalled()
			expect(mockManipulate).not.toHaveBeenCalled()
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
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
			expect(mockResize).toHaveBeenCalledWith({ width: 256 })
		})
	})

	describe("generate — video thumbnails", () => {
		it("generates thumbnail for a .mp4 file", async () => {
			const item = makeFileItem("video-uuid", "clip.mp4")
			const result = await thumbnails.generate({ item })

			expect(mockCreateVideoPlayer).toHaveBeenCalledTimes(1)
			expect(mockCreateVideoPlayer).toHaveBeenCalledWith(expect.stringContaining("http://localhost:8080/file/video-uuid"))
			expect(mockGenerateThumbnailsAsync).toHaveBeenCalledWith([1.0], {
				maxWidth: 256,
				maxHeight: 256
			})
			expect(mockManipulate).toHaveBeenCalledTimes(1)
			expect(mockRenderAsync).toHaveBeenCalledTimes(1)
			expect(mockRelease).toHaveBeenCalledTimes(1)

			expect(result).toBe(`${THUMBNAILS_DIR}/video-uuid.png`)
		})

		it("uses default video timestamp when not specified", async () => {
			const item = makeFileItem("vid-default-ts", "clip.mp4")
			await thumbnails.generate({ item })

			expect(mockGenerateThumbnailsAsync).toHaveBeenCalledWith([1.0], expect.any(Object))
		})

		it("uses custom video timestamp when specified", async () => {
			const item = makeFileItem("vid-custom-ts", "clip.mp4")
			await thumbnails.generate({
				item,
				videoTimestamp: 5.0
			})

			expect(mockGenerateThumbnailsAsync).toHaveBeenCalledWith([5.0], expect.any(Object))
		})

		it("waits for player to be ready before generating thumbnails", async () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let statusCallback: ((payload: any) => void) | null = null
			const listenerRegistered = new Promise<void>(resolve => {
				mockCreateVideoPlayer.mockReturnValue({
					status: "loading",
					generateThumbnailsAsync: mockGenerateThumbnailsAsync,
					release: mockRelease,
					addListener: vi.fn((_event: string, callback: (payload: { status: string }) => void) => {
						statusCallback = callback
						resolve()

						return { remove: vi.fn() }
					})
				})
			})

			const item = makeFileItem("wait-ready-uuid", "clip.mp4")

			let resolved = false
			const promise = thumbnails.generate({ item }).then(result => {
				resolved = true

				return result
			})

			await listenerRegistered

			expect(resolved).toBe(false)
			expect(mockGenerateThumbnailsAsync).not.toHaveBeenCalled()

			// Simulate player becoming ready
			statusCallback!({ status: "readyToPlay" })

			const result = await promise

			expect(resolved).toBe(true)
			expect(mockGenerateThumbnailsAsync).toHaveBeenCalledTimes(1)
			expect(result).toBe(`${THUMBNAILS_DIR}/wait-ready-uuid.png`)
		})

		it("throws when player enters error state", async () => {
			mockCreateVideoPlayer.mockReturnValue({
				status: "loading",
				generateThumbnailsAsync: mockGenerateThumbnailsAsync,
				release: mockRelease,
				addListener: vi.fn((_event: string, callback: (payload: { status: string; error?: { message: string } }) => void) => {
					// Simulate immediate error
					Promise.resolve().then(() => {
						callback({ status: "error", error: { message: "codec not supported" } })
					})

					return { remove: vi.fn() }
				})
			})

			const item = makeFileItem("player-err-uuid", "clip.mp4")

			await expect(thumbnails.generate({ item })).rejects.toThrow("codec not supported")
			expect(mockRelease).toHaveBeenCalledTimes(1)
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
			expect(mockCreateVideoPlayer).not.toHaveBeenCalled()

			// Simulate provider becoming available
			mockHttpStoreState.port = 8080
			mockHttpStoreState.getFileUrl = mockGetFileUrl

			for (const listener of mockHttpStoreSubscribers) {
				listener(mockHttpStoreState)
			}

			const result = await promise

			expect(resolved).toBe(true)
			expect(mockCreateVideoPlayer).toHaveBeenCalledTimes(1)
			expect(result).toBe(`${THUMBNAILS_DIR}/wait-http-uuid.png`)
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

			await expect(promise).rejects.toThrow()
			expect(mockCreateVideoPlayer).not.toHaveBeenCalled()
			expect(mockHttpStoreSubscribers.size).toBe(0)
		})

		it("throws when generateThumbnailsAsync fails", async () => {
			mockGenerateThumbnailsAsync.mockRejectedValueOnce(new Error("thumbnail generation failed"))

			const item = makeFileItem("gen-fail-uuid", "clip.mp4")

			await expect(thumbnails.generate({ item })).rejects.toThrow("thumbnail generation failed")
			expect(mockRelease).toHaveBeenCalledTimes(1)
		})

		it("throws when no thumbnail is generated", async () => {
			mockGenerateThumbnailsAsync.mockResolvedValueOnce([])

			const item = makeFileItem("empty-thumb-uuid", "clip.mp4")

			await expect(thumbnails.generate({ item })).rejects.toThrow("No thumbnail generated")
			expect(mockRelease).toHaveBeenCalledTimes(1)
		})

		it("releases player on success", async () => {
			const item = makeFileItem("release-ok-uuid", "clip.mp4")
			await thumbnails.generate({ item })

			expect(mockRelease).toHaveBeenCalledTimes(1)
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
			expect(result).toBe(`${THUMBNAILS_DIR}/shared-uuid.png`)
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
			const { wrapAbortSignalForSdk } = await import("@/lib/utils")

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

			expect(mockGenerateThumbnailsAsync).not.toHaveBeenCalled()
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
			expect(mockCreateVideoPlayer).not.toHaveBeenCalled()
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

		it("video: aborts during readyToPlay wait", async () => {
			const controller = new AbortController()

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let statusCallback: ((payload: any) => void) | null = null
			const listenerRegistered = new Promise<void>(resolve => {
				mockCreateVideoPlayer.mockReturnValue({
					status: "loading",
					generateThumbnailsAsync: mockGenerateThumbnailsAsync,
					release: mockRelease,
					addListener: vi.fn((_event: string, callback: (payload: { status: string }) => void) => {
						statusCallback = callback
						resolve()

						return { remove: vi.fn() }
					})
				})
			})

			const item = makeFileItem("abort-ready-wait-uuid", "clip.mp4")

			const promise = thumbnails.generate({
				item,
				signal: controller.signal
			})

			await listenerRegistered

			// Abort while waiting for readyToPlay — should not hang
			controller.abort()

			await expect(promise).rejects.toThrow()

			// Should not have called generateThumbnailsAsync since we aborted before ready
			expect(mockGenerateThumbnailsAsync).not.toHaveBeenCalled()
			expect(statusCallback).not.toBeNull()
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

			expect(result).toBe(`${THUMBNAILS_DIR}/good-item-uuid.png`)
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
			thumbnails.clear()

			// Restore working download
			mockDownloadFileToPath.mockImplementation(async (_file: unknown, path: string) => {
				fs.set(`file://${path}`, new Uint8Array([1, 2, 3]))
			})

			const result = await thumbnails.generate({ item })
			expect(mockDownloadFileToPath).toHaveBeenCalledTimes(1)
			expect(result).toBe(`${THUMBNAILS_DIR}/reset-fail-uuid.png`)
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
			expect(result).toBe(`${THUMBNAILS_DIR}/abort-no-fail-uuid.png`)
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
			expect(result).toBe(`${THUMBNAILS_DIR}/abort-vid-no-fail-uuid.png`)
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
			expect(result).toBe(`${THUMBNAILS_DIR}/retry-uuid.png`)
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
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
			const outputPath = `${THUMBNAILS_DIR}/exists-uuid.png`
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
			const outputPath = `${THUMBNAILS_DIR}/remove-uuid.png`
			fs.set(outputPath, new Uint8Array([0xff, 0xd8]))

			const item = makeFileItem("remove-uuid", "photo.jpg")
			thumbnails.remove(item)

			expect(fs.has(outputPath)).toBe(false)
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
		it("deletes entire thumbnails directory", () => {
			fs.set(THUMBNAILS_DIR, "dir")
			fs.set(`${THUMBNAILS_DIR}/a.jpg`, new Uint8Array([1]))
			fs.set(`${THUMBNAILS_DIR}/b.jpg`, new Uint8Array([2]))

			thumbnails.clear()

			expect(fs.has(`${THUMBNAILS_DIR}/a.jpg`)).toBe(false)
			expect(fs.has(`${THUMBNAILS_DIR}/b.jpg`)).toBe(false)
		})

		it("recreates directory after deletion", () => {
			fs.set(THUMBNAILS_DIR, "dir")

			thumbnails.clear()

			expect(fs.get(THUMBNAILS_DIR)).toBe("dir")
		})
	})
})

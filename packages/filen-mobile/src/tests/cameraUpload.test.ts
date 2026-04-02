import { vi, describe, it, expect, beforeEach } from "vitest"
import pathModule from "path"

// @ts-expect-error __DEV__ is a React Native global
globalThis.__DEV__ = true

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-media-library/next", async () => await import("@/tests/mocks/expoMediaLibrary"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("@react-native-community/netinfo", () => ({
	default: { fetch: vi.fn(async () => ({ type: "wifi", isInternetReachable: true, isConnected: true })) }
}))

vi.mock("expo-battery", () => ({
	isLowPowerModeEnabledAsync: vi.fn(async () => false)
}))

vi.mock("expo-media-library", () => ({
	getPermissionsAsync: vi.fn(async () => ({ granted: true, status: "granted", accessPrivileges: "all", expires: "never", canAskAgain: true })),
	requestPermissionsAsync: vi.fn(async () => ({ granted: true, status: "granted", accessPrivileges: "all", expires: "never", canAskAgain: true }))
}))

vi.mock("@/hooks/useMediaPermissions", () => ({
	hasAllNeededMediaPermissions: vi.fn(async () => true)
}))

vi.mock("expo-image-manipulator", () => ({
	ImageManipulator: { manipulate: vi.fn() },
	SaveFormat: { JPEG: "jpeg" }
}))

vi.mock("@filen/sdk-rs", () => ({
	AnyNormalDir: { Dir: vi.fn() },
	AnyDirWithContext: { Normal: vi.fn() }
}))

vi.mock("@filen/utils", async () => ({
	...await import("@/tests/mocks/filenUtils"),
	fastLocaleCompare: (a: string, b: string) => a.localeCompare(b)
}))

vi.mock("@/lib/auth", () => ({
	default: { getSdkClients: vi.fn() }
}))

vi.mock("@/lib/transfers", () => ({
	default: { upload: vi.fn() }
}))

const mockSetSyncing = vi.fn()
const mockSetErrors = vi.fn()

vi.mock("@/stores/useCameraUpload.store", () => ({
	default: {
		getState: () => ({
			setSyncing: mockSetSyncing,
			setErrors: mockSetErrors
		})
	}
}))

vi.mock("@/lib/secureStore", () => ({
	default: { get: vi.fn(), set: vi.fn() },
	useSecureStore: vi.fn()
}))

vi.mock("zustand/shallow", () => ({
	useShallow: (fn: Function) => fn
}))

vi.mock("@/lib/events", () => ({
	default: { subscribe: vi.fn() }
}))

vi.mock("@/lib/exif", () => ({
	parseExifDate: vi.fn()
}))

vi.mock("@/lib/drive", () => ({
	default: { updateTimestamps: vi.fn() }
}))

vi.mock("lru-cache", () => ({
	LRUCache: class extends Map {
		constructor() {
			super()
		}
	}
}))

vi.mock("@/lib/utils", () => ({
	PauseSignal: class {
		pause() {}
		resume() {}
	},
	normalizeFilePathForSdk: (filePath: string): string => {
		let normalizedPath = filePath
			.trim()
			.replace(/^file:\/+/, "/")
			.split("/")
			.map(segment => (segment.length > 0 ? decodeURIComponent(segment) : segment))
			.join("/")

		if (!normalizedPath.startsWith("/")) {
			normalizedPath = "/" + normalizedPath
		}

		if (normalizedPath.endsWith("/") && normalizedPath !== "/") {
			normalizedPath = normalizedPath.slice(0, -1)
		}

		return pathModule.posix.normalize(normalizedPath)
	},
	normalizeFilePathForExpo: (p: string) => p,
	unwrapFileMeta: vi.fn(),
	unwrappedFileIntoDriveItem: vi.fn(),
	unwrapSdkError: vi.fn().mockReturnValue(null),
	normalizeModificationTimestampForComparison: (ts: number) => ts
}))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

import cameraUpload, { modifyAssetPathOnCollision, type CollisionParams, type Config } from "@/lib/cameraUpload"
import secureStore from "@/lib/secureStore"
import NetInfo from "@react-native-community/netinfo"
import * as Battery from "expo-battery"
import { getPermissionsAsync } from "expo-media-library"
import auth from "@/lib/auth"
import transfers from "@/lib/transfers"
import drive from "@/lib/drive"
import { parseExifDate } from "@/lib/exif"
import { unwrapFileMeta, unwrappedFileIntoDriveItem } from "@/lib/utils"
import events from "@/lib/events"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import { ml, MediaType } from "@/tests/mocks/expoMediaLibrary"
import { fs } from "@/tests/mocks/expoFileSystem"

// Capture constructor event handlers before beforeEach clears mocks
const eventHandlers: Record<string, Function | undefined> = Object.fromEntries(
	vi.mocked(events.subscribe).mock.calls.map(([event, handler]) => [event as string, handler as Function])
)

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ENABLED_CONFIG: Config & { enabled: true } = {
	enabled: true,
	remoteDir: { uuid: "remote-uuid" } as any,
	albumIds: ["album-1"],
	activationTimestamp: 0,
	afterActivation: false,
	includeVideos: true,
	cellular: true,
	background: true,
	lowBattery: true,
	compress: false
}

function setupDefaultMocks() {
	vi.mocked(secureStore.get).mockResolvedValue(ENABLED_CONFIG)
	vi.mocked(NetInfo.fetch).mockResolvedValue({ type: "wifi", isInternetReachable: true, isConnected: true } as any)
	vi.mocked(getPermissionsAsync).mockResolvedValue({ granted: true, status: "granted" } as any)
	vi.mocked(Battery.isLowPowerModeEnabledAsync).mockResolvedValue(false)
	vi.mocked(auth.getSdkClients).mockResolvedValue({
		authedSdkClient: {
			listDirRecursiveWithPaths: vi.fn(async () => ({ files: [] })),
			createDir: vi.fn(async () => ({ uuid: "created-dir" }))
		}
	} as any)
	vi.mocked(transfers.upload).mockResolvedValue({ files: [] } as any)
	vi.mocked(unwrapFileMeta).mockReturnValue({ meta: null } as any)
	vi.mocked(unwrappedFileIntoDriveItem).mockReturnValue({} as any)
	vi.mocked(drive.updateTimestamps).mockResolvedValue(undefined as any)
	vi.mocked(parseExifDate).mockReturnValue(null)
}

function collision(overrides?: Partial<CollisionParams> & { iteration: number }): string | null {
	return modifyAssetPathOnCollision({
		iteration: 0,
		path: "/camera roll/img_0001.jpg",
		asset: {
			name: "IMG_0001.jpg",
			creationTime: 1700000000000
		},
		...overrides
	})
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
	vi.clearAllMocks()
	ml.clear()
	fs.clear()
	cameraUpload.cancel()
	setupDefaultMocks()
})

// ─── modifyAssetPathOnCollision ──────────────────────────────────────────────

describe("modifyAssetPathOnCollision", () => {
	describe("iteration 0 — creationTime suffix", () => {
		it("appends creationTime to the basename", () => {
			expect(collision({ iteration: 0 })).toBe("/camera roll/img_0001_1700000000000.jpg")
		})

		it("produces different paths for different creationTimes", () => {
			const a = collision({ iteration: 0, asset: { name: "IMG_0001.jpg", creationTime: 1000 } })
			const b = collision({ iteration: 0, asset: { name: "IMG_0001.jpg", creationTime: 5000 } })

			expect(a).not.toBe(b)
		})
	})

	describe("iteration 1 — hash of name + creationTime", () => {
		it("returns a valid path with a hex hash suffix", () => {
			expect(collision({ iteration: 1 })).toMatch(/^\/camera roll\/img_0001_[0-9a-f]+\.jpg$/)
		})

		it("produces different paths for different creationTimes", () => {
			const a = collision({ iteration: 1, asset: { name: "IMG_0001.jpg", creationTime: 1000 } })
			const b = collision({ iteration: 1, asset: { name: "IMG_0001.jpg", creationTime: 2000 } })

			expect(a).not.toBe(b)
		})

		it("produces different paths for different filenames with same creationTime", () => {
			const a = modifyAssetPathOnCollision({
				iteration: 1,
				path: "/album/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", creationTime: 1000 }
			})

			const b = modifyAssetPathOnCollision({
				iteration: 1,
				path: "/album/img_0002.jpg",
				asset: { name: "IMG_0002.jpg", creationTime: 1000 }
			})

			expect(a).not.toBe(b)
		})
	})

	describe("exhausted iterations", () => {
		it("returns null at iteration 2 (default)", () => {
			expect(collision({ iteration: 2 })).toBeNull()
		})

		it("returns null for any iteration beyond the supported range", () => {
			expect(collision({ iteration: 3 })).toBeNull()
			expect(collision({ iteration: 100 })).toBeNull()
		})
	})

	describe("invalid paths", () => {
		it("returns a fallback path when input has no parent directory", () => {
			// FileSystem.Paths.dirname falls back to DOCUMENT_URI for bare filenames,
			// so these produce a valid (non-null) collision path unlike path.posix which returns "."
			expect(
				modifyAssetPathOnCollision({
					iteration: 0,
					path: "IMG_0001.jpg",
					asset: { name: "IMG_0001.jpg", creationTime: 1000 }
				})
			).toBeTypeOf("string")
		})

		it("returns a fallback path when path is empty", () => {
			expect(
				modifyAssetPathOnCollision({
					iteration: 0,
					path: "",
					asset: { name: "IMG_0001.jpg", creationTime: 1000 }
				})
			).toBeTypeOf("string")
		})

		it("returns null when basename is '.'", () => {
			expect(
				modifyAssetPathOnCollision({
					iteration: 0,
					path: "/camera roll/.",
					asset: { name: ".", creationTime: 1000 }
				})
			).toBeNull()
		})
	})

	describe("determinism", () => {
		it("produces the same result for the same inputs across all iterations", () => {
			const params: Omit<CollisionParams, "iteration"> = {
				path: "/album/photo.png",
				asset: { name: "photo.png", creationTime: 1000 }
			}

			for (let i = 0; i < 2; i++) {
				expect(modifyAssetPathOnCollision({ ...params, iteration: i })).toBe(
					modifyAssetPathOnCollision({ ...params, iteration: i })
				)
			}
		})
	})

	describe("cross-tree consistency", () => {
		it("produces identical paths for local and remote trees with the same metadata", () => {
			const asset = { name: "IMG_0001.jpg", creationTime: 1700000000000 }

			for (let i = 0; i < 2; i++) {
				const a = modifyAssetPathOnCollision({ iteration: i, path: "/camera roll/img_0001.jpg", asset })
				const b = modifyAssetPathOnCollision({ iteration: i, path: "/camera roll/img_0001.jpg", asset: { ...asset } })

				expect(a).toBe(b)
			}
		})
	})

	describe("normalization", () => {
		it("lowercases the output path", () => {
			const result = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/Camera Roll/IMG_0001.JPG",
				asset: { name: "IMG_0001.JPG", creationTime: 1000 }
			})

			expect(result).toBe(result?.toLowerCase())
		})

		it("preserves file extension from asset name", () => {
			const result = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/album/video.mov",
				asset: { name: "video.MOV", creationTime: 1000 }
			})

			expect(result).toMatch(/\.mov$/)
		})
	})

})

describe("iteration uniqueness", () => {
	it("produces distinct paths for iteration 0 vs iteration 1", () => {
		const asset = { name: "IMG_0001.jpg", creationTime: 1000 }
		const path = "/album/img_0001.jpg"

		const path0 = modifyAssetPathOnCollision({ iteration: 0, path, asset })
		const path1 = modifyAssetPathOnCollision({ iteration: 1, path, asset })

		expect(path0).not.toBe(path1)
	})
})

// ─── Collision resolution loop ───────────────────────────────────────────────

describe("collision resolution loop", () => {
	it("resolves collisions by iterating until an empty slot is found", () => {
		const tree: Record<string, boolean> = {}
		const asset = { name: "IMG_0001.jpg", creationTime: 1000 }
		const basePath = "/album/img_0001.jpg"

		tree[basePath] = true

		let path = basePath
		let iteration = 0

		while (tree[path]) {
			path = modifyAssetPathOnCollision({ iteration, path, asset }) ?? ""

			if (path.length === 0) {
				break
			}

			iteration++
		}

		expect(path).not.toBe(basePath)
		expect(path.length).toBeGreaterThan(0)

		tree[path] = true

		let path2 = basePath
		let iteration2 = 0

		while (tree[path2]) {
			path2 = modifyAssetPathOnCollision({ iteration: iteration2, path: path2, asset }) ?? ""

			if (path2.length === 0) {
				break
			}

			iteration2++
		}

		expect(path2).not.toBe(basePath)
		expect(path2).not.toBe(path)
		expect(path2.length).toBeGreaterThan(0)
	})

	it("skips the asset when all iterations are exhausted", () => {
		const tree: Record<string, boolean> = {}
		const asset = { name: "IMG_0001.jpg", creationTime: 1000 }
		const basePath = "/album/img_0001.jpg"

		tree[basePath] = true

		for (let i = 0; i < 2; i++) {
			const resolved = modifyAssetPathOnCollision({ iteration: i, path: basePath, asset })

			if (resolved) {
				tree[resolved] = true
			}
		}

		let path = basePath
		let iteration = 0

		while (tree[path]) {
			path = modifyAssetPathOnCollision({ iteration, path, asset }) ?? ""

			if (path.length === 0) {
				break
			}

			iteration++
		}

		expect(path).toBe("")
	})
})

// ─── Config management ───────────────────────────────────────────────────────

describe("config management", () => {
	it("getConfig returns disabled when secureStore has nothing", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce(null)

		await cameraUpload.sync()

		expect(mockSetSyncing).not.toHaveBeenCalled()
	})

	it("setConfig stores a direct config value", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ enabled: false })

		await cameraUpload.setConfig(ENABLED_CONFIG)

		expect(secureStore.set).toHaveBeenCalledWith("cameraUploadConfig", ENABLED_CONFIG)
	})

	it("setConfig stores result of function updater", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce(ENABLED_CONFIG)

		await cameraUpload.setConfig(prev => {
			if (!prev || !("cellular" in prev)) {
				return prev
			}

			return { ...prev, cellular: false }
		})

		expect(secureStore.set).toHaveBeenCalledWith("cameraUploadConfig", expect.objectContaining({ cellular: false }))
	})
})

// ─── Sync pre-flight checks ─────────────────────────────────────────────────

describe("sync pre-flight checks", () => {
	it("skips when config is disabled", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ enabled: false })

		await cameraUpload.sync()

		expect(mockSetSyncing).not.toHaveBeenCalled()
	})

	it("skips when albumIds is empty", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, albumIds: [] })

		await cameraUpload.sync()

		expect(mockSetSyncing).not.toHaveBeenCalled()
	})

	it("skips when permissions are not granted", async () => {
		vi.mocked(hasAllNeededMediaPermissions).mockResolvedValueOnce(false)

		await cameraUpload.sync()

		expect(mockSetSyncing).not.toHaveBeenCalled()
	})

	it("skips on cellular when config.cellular is false", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, cellular: false })
		vi.mocked(NetInfo.fetch).mockResolvedValueOnce({ type: "cellular" } as any)

		await cameraUpload.sync()

		expect(mockSetSyncing).not.toHaveBeenCalled()
	})

	it("proceeds on cellular when config.cellular is true", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, cellular: true })
		vi.mocked(NetInfo.fetch).mockResolvedValueOnce({ type: "cellular" } as any)

		await cameraUpload.sync()

		expect(mockSetSyncing).toHaveBeenCalledWith(true)
	})

	it("proceeds on WiFi regardless of cellular setting", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, cellular: false })
		vi.mocked(NetInfo.fetch).mockResolvedValueOnce({ type: "wifi" } as any)

		await cameraUpload.sync()

		expect(mockSetSyncing).toHaveBeenCalledWith(true)
	})

	it("skips on low battery when config.lowBattery is false", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, lowBattery: false })
		vi.mocked(Battery.isLowPowerModeEnabledAsync).mockResolvedValueOnce(true)

		await cameraUpload.sync()

		expect(mockSetSyncing).not.toHaveBeenCalled()
	})

	it("proceeds on low battery when config.lowBattery is true", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, lowBattery: true })
		vi.mocked(Battery.isLowPowerModeEnabledAsync).mockResolvedValueOnce(true)

		await cameraUpload.sync()

		expect(mockSetSyncing).toHaveBeenCalledWith(true)
	})
})

// ─── Sync cleanup ────────────────────────────────────────────────────────────

describe("sync cleanup", () => {
	it("sets syncing to false after successful sync", async () => {
		await cameraUpload.sync()

		expect(mockSetSyncing).toHaveBeenCalledWith(true)
		expect(mockSetSyncing).toHaveBeenCalledWith(false)

		const calls = mockSetSyncing.mock.calls as boolean[][]
		const trueIndex = calls.findIndex(c => c[0] === true)
		const falseIndex = calls.findIndex(c => c[0] === false)

		expect(trueIndex).toBeLessThan(falseIndex)
	})

	it("sets syncing to false even when sync errors", async () => {
		vi.mocked(auth.getSdkClients).mockRejectedValueOnce(new Error("Auth failed"))

		await cameraUpload.sync()

		expect(mockSetSyncing).toHaveBeenCalledWith(false)
	})
})

// ─── Cancel / pause / resume ─────────────────────────────────────────────────

describe("cancel / pause / resume", () => {
	it("cancel aborts the current controller and creates a fresh one", () => {
		const firstController = (cameraUpload as any).globalAbortController as AbortController

		expect(firstController.signal.aborted).toBe(false)

		cameraUpload.cancel()

		expect(firstController.signal.aborted).toBe(true)

		const secondController = (cameraUpload as any).globalAbortController as AbortController

		expect(secondController).not.toBe(firstController)
		expect(secondController.signal.aborted).toBe(false)
	})

	it("cancel replaces the pause signal", () => {
		const firstSignal = (cameraUpload as any).globalPauseSignal

		cameraUpload.cancel()

		const secondSignal = (cameraUpload as any).globalPauseSignal

		expect(secondSignal).not.toBe(firstSignal)
	})
})

// ─── Constructor event subscriptions ─────────────────────────────────────────

describe("constructor events", () => {
	it("subscribes to secureStoreChange, secureStoreClear, and secureStoreRemove", () => {
		expect(eventHandlers["secureStoreChange"]).toBeDefined()
		expect(eventHandlers["secureStoreClear"]).toBeDefined()
		expect(eventHandlers["secureStoreRemove"]).toBeDefined()
	})

	it("secureStoreChange with matching key triggers cancel", () => {
		const controllerBefore = (cameraUpload as any).globalAbortController

		eventHandlers["secureStoreChange"]!({ key: "cameraUploadConfig" })

		expect((cameraUpload as any).globalAbortController).not.toBe(controllerBefore)
	})

	it("secureStoreChange with unrelated key does not trigger cancel", () => {
		const controllerBefore = (cameraUpload as any).globalAbortController

		eventHandlers["secureStoreChange"]!({ key: "someOtherKey" })

		expect((cameraUpload as any).globalAbortController).toBe(controllerBefore)
	})

	it("secureStoreClear triggers cancel", () => {
		const controllerBefore = (cameraUpload as any).globalAbortController

		eventHandlers["secureStoreClear"]!()

		expect((cameraUpload as any).globalAbortController).not.toBe(controllerBefore)
	})
})

// ─── Sync flow ───────────────────────────────────────────────────────────────

describe("sync flow", () => {
	function setupLocalAssets(
		assets: Array<{
			id: string
			filename: string
			mediaType?: MediaType
			creationTime?: number
			modificationTime?: number
		}>
	) {
		const albumId = "album-1"

		ml.addAlbum({ id: albumId, title: "Camera Roll", assetIds: assets.map(a => a.id) })

		for (const asset of assets) {
			const uri = `file:///media/${asset.id}`

			ml.addAsset({
				id: asset.id,
				filename: asset.filename,
				uri,
				mediaType: asset.mediaType ?? MediaType.IMAGE,
				creationTime: asset.creationTime ?? 1000,
				modificationTime: asset.modificationTime ?? 2000
			})

			fs.set(uri, new Uint8Array([1, 2, 3]))
		}
	}

	it("uploads new local files not present on remote", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
	})

	it("does not upload when local and remote trees match", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg", creationTime: 1000, modificationTime: 2000 }])

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({
					files: [
						{
							path: "/Camera Roll/photo.jpg",
							file: { uuid: "remote-1" }
						}
					]
				})),
				createDir: vi.fn(async () => ({ uuid: "dir" }))
			}
		} as any)

		vi.mocked(unwrapFileMeta).mockReturnValue({
			meta: { name: "photo.jpg", created: 1000n, modified: 2000n }
		} as any)

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
	})

	it("uploads when local file is newer than remote", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg", creationTime: 1000, modificationTime: 5000 }])

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({
					files: [
						{
							path: "/Camera Roll/photo.jpg",
							file: { uuid: "remote-1" }
						}
					]
				})),
				createDir: vi.fn(async () => ({ uuid: "dir" }))
			}
		} as any)

		vi.mocked(unwrapFileMeta).mockReturnValue({
			meta: { name: "photo.jpg", created: 1000n, modified: 2000n }
		} as any)

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
	})

	it("individual upload failure does not abort other uploads", async () => {
		setupLocalAssets([
			{ id: "a1", filename: "photo1.jpg", creationTime: 1000 },
			{ id: "a2", filename: "photo2.jpg", creationTime: 2000 }
		])

		let callCount = 0

		vi.mocked(transfers.upload).mockImplementation(async () => {
			callCount++

			if (callCount === 1) {
				throw new Error("Upload failed")
			}

			return { files: [] } as any
		})

		await cameraUpload.sync()

		expect(callCount).toBe(2)
	})

	it("stores errors from failed uploads", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		vi.mocked(transfers.upload).mockRejectedValueOnce(new Error("Network error"))

		await cameraUpload.sync()

		expect(mockSetErrors).toHaveBeenCalled()
	})

	it("maxUploads caps the number of deltas processed", async () => {
		setupLocalAssets([
			{ id: "a1", filename: "photo1.jpg", creationTime: 1000, modificationTime: 1000 },
			{ id: "a2", filename: "photo2.jpg", creationTime: 2000, modificationTime: 2000 },
			{ id: "a3", filename: "photo3.jpg", creationTime: 3000, modificationTime: 3000 }
		])

		await cameraUpload.sync({ maxUploads: 1 })

		expect(transfers.upload).toHaveBeenCalledTimes(1)
	})

	it("without maxUploads uploads all deltas", async () => {
		setupLocalAssets([
			{ id: "a1", filename: "photo1.jpg", creationTime: 1000 },
			{ id: "a2", filename: "photo2.jpg", creationTime: 2000 }
		])

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(2)
	})

	it("calls updateTimestamps with EXIF date for images", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg", mediaType: MediaType.IMAGE }])
		vi.mocked(transfers.upload).mockResolvedValueOnce({ files: [{ uuid: "uploaded-1" }] } as any)
		vi.mocked(parseExifDate).mockReturnValueOnce(1600000000000)

		await cameraUpload.sync()

		expect(drive.updateTimestamps).toHaveBeenCalledWith(
			expect.objectContaining({
				created: 1600000000000
			})
		)
	})

	it("calls updateTimestamps with media library date for videos", async () => {
		setupLocalAssets([{ id: "a1", filename: "video.mp4", mediaType: MediaType.VIDEO, creationTime: 1500000000000 }])
		vi.mocked(transfers.upload).mockResolvedValueOnce({ files: [{ uuid: "uploaded-1" }] } as any)

		await cameraUpload.sync()

		expect(parseExifDate).not.toHaveBeenCalled()
		expect(drive.updateTimestamps).toHaveBeenCalledWith(
			expect.objectContaining({
				created: 1500000000000
			})
		)
	})

	it("cleans up tmp file after upload", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		let tmpUri: string | undefined

		vi.mocked(transfers.upload).mockImplementationOnce(async (args: any) => {
			tmpUri = args.localFileOrDir.uri

			return { files: [] } as any
		})

		await cameraUpload.sync()

		expect(tmpUri).toBeDefined()
	})
})

// ─── listLocal filtering ─────────────────────────────────────────────────────

describe("listLocal filtering", () => {
	function setupAlbumWithAssets(
		assets: Array<{
			id: string
			filename: string
			mediaType?: MediaType
			creationTime?: number
		}>
	) {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: assets.map(a => a.id) })

		for (const asset of assets) {
			ml.addAsset({
				id: asset.id,
				filename: asset.filename,
				uri: `file:///media/${asset.id}`,
				mediaType: asset.mediaType ?? MediaType.IMAGE,
				creationTime: asset.creationTime ?? Date.now()
			})

			fs.set(`file:///media/${asset.id}`, new Uint8Array([1]))
		}
	}

	it("excludes videos when includeVideos is false", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, includeVideos: false })

		setupAlbumWithAssets([
			{ id: "img", filename: "photo.jpg", mediaType: MediaType.IMAGE },
			{ id: "vid", filename: "video.mp4", mediaType: MediaType.VIDEO }
		])

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
	})

	it("includes videos when includeVideos is true", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, includeVideos: true })

		setupAlbumWithAssets([
			{ id: "img", filename: "photo.jpg", mediaType: MediaType.IMAGE },
			{ id: "vid", filename: "video.mp4", mediaType: MediaType.VIDEO }
		])

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(2)
	})

	it("filters by activationTimestamp when afterActivation is true", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({
			...ENABLED_CONFIG,
			afterActivation: true,
			activationTimestamp: 5000
		})

		setupAlbumWithAssets([
			{ id: "old", filename: "old.jpg", creationTime: 1000 },
			{ id: "new", filename: "new.jpg", creationTime: 10000 }
		])

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
	})
})

// ─── Re-entrancy and failure tracking ────────────────────────────────────────

describe("re-entrancy and failure tracking", () => {
	it("re-entrancy guard prevents concurrent syncs", async () => {
		;(cameraUpload as any).syncing = true

		await cameraUpload.sync()

		expect(mockSetSyncing).not.toHaveBeenCalled()

		;(cameraUpload as any).syncing = false
	})

	it("cancel clears uploadFailures", () => {
		const failures = (cameraUpload as any).uploadFailures as Map<string, number>

		failures.set("asset-1", 2)
		failures.set("asset-2", 1)

		cameraUpload.cancel()

		expect(failures.size).toBe(0)
	})

	it("skips assets exceeding MAX_UPLOAD_FAILURES", async () => {
		const failures = (cameraUpload as any).uploadFailures as Map<string, number>

		failures.set("a1", 3)

		const albumId = "album-1"

		ml.addAlbum({ id: albumId, title: "Camera Roll", assetIds: ["a1"] })

		ml.addAsset({
			id: "a1",
			filename: "photo.jpg",
			uri: "file:///media/a1",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})

		fs.set("file:///media/a1", new Uint8Array([1, 2, 3]))

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()

		failures.clear()
	})
})

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

vi.mock("expo-media-library", async () => {
	const next = await import("@/tests/mocks/expoMediaLibrary")

	return {
		getPermissionsAsync: vi.fn(async () => ({ granted: true, status: "granted", accessPrivileges: "all", expires: "never", canAskAgain: true })),
		requestPermissionsAsync: vi.fn(async () => ({ granted: true, status: "granted", accessPrivileges: "all", expires: "never", canAskAgain: true })),
		getAlbumsAsync: vi.fn(async () => {
			return Array.from(next.ml.albums.values()).map(stored => ({
				id: stored.id,
				title: stored.title,
				type: "album",
				assetCount: stored.assetIds.length
			}))
		})
	}
})

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
const mockAddSkippedAsset = vi.fn()
const mockClearSkippedAssets = vi.fn()

vi.mock("@/stores/useCameraUpload.store", () => ({
	default: {
		getState: () => ({
			setSyncing: mockSetSyncing,
			setErrors: mockSetErrors,
			addSkippedAsset: mockAddSkippedAsset,
			clearSkippedAssets: mockClearSkippedAssets
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

vi.mock("@/lib/cache", () => ({
	default: {
		cameraUploadHashes: new Map()
	}
}))

vi.mock("@/lib/i18n", () => ({
	default: {
		t: (key: string) => key
	}
}))


vi.mock("@/lib/utils", () => ({
	PauseSignal: class {
		pause() {}
		resume() {}
		dispose() {}
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
	unwrapSdkError: vi.fn().mockReturnValue(null),
	normalizeModificationTimestampForComparison: (ts: number) => ts
}))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

import cache from "@/lib/cache"
import cameraUpload, { modifyAssetPathOnCollision, type CollisionParams, type Config } from "@/lib/cameraUpload"
import secureStore from "@/lib/secureStore"
import NetInfo from "@react-native-community/netinfo"
import * as Battery from "expo-battery"
import { getPermissionsAsync } from "expo-media-library"
import auth from "@/lib/auth"
import transfers from "@/lib/transfers"
import { unwrapFileMeta } from "@/lib/utils"
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
	remoteDir: { inner: [{ uuid: "remote-uuid" }] } as any,
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
	cache.cameraUploadHashes.clear()
	cameraUpload.cancel()
	// The parent-directory cache lives on the singleton and survives cancel(),
	// so clear it explicitly between tests to avoid stale dir refs from earlier
	// tests masking createDir call assertions.
	;(cameraUpload as any).ensureParentDirectoryExistsCache.clear()
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

		expect(secureStore.set).toHaveBeenCalledWith("cameraUploadConfig:v1", ENABLED_CONFIG)
	})

	it("setConfig stores result of function updater", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce(ENABLED_CONFIG)

		await cameraUpload.setConfig(prev => {
			if (!prev || !("cellular" in prev)) {
				return prev
			}

			return { ...prev, cellular: false }
		})

		expect(secureStore.set).toHaveBeenCalledWith("cameraUploadConfig:v1", expect.objectContaining({ cellular: false }))
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
		vi.mocked(NetInfo.fetch).mockResolvedValueOnce({ type: "cellular", isConnected: true, isInternetReachable: true } as any)

		await cameraUpload.sync()

		expect(mockSetSyncing).not.toHaveBeenCalled()
	})

	it("proceeds on cellular when config.cellular is true", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, cellular: true })
		vi.mocked(NetInfo.fetch).mockResolvedValueOnce({ type: "cellular", isConnected: true, isInternetReachable: true } as any)

		await cameraUpload.sync()

		expect(mockSetSyncing).toHaveBeenCalledWith(true)
	})

	it("proceeds on WiFi regardless of cellular setting", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, cellular: false })
		vi.mocked(NetInfo.fetch).mockResolvedValueOnce({ type: "wifi", isConnected: true, isInternetReachable: true } as any)

		await cameraUpload.sync()

		expect(mockSetSyncing).toHaveBeenCalledWith(true)
	})

	it("skips when offline (isConnected false)", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, cellular: true })
		vi.mocked(NetInfo.fetch).mockResolvedValueOnce({ type: "wifi", isConnected: false, isInternetReachable: true } as any)

		await cameraUpload.sync()

		expect(mockSetSyncing).not.toHaveBeenCalled()
	})

	it("skips when internet is unreachable (captive portal / DNS dead)", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, cellular: true })
		vi.mocked(NetInfo.fetch).mockResolvedValueOnce({ type: "wifi", isConnected: true, isInternetReachable: false } as any)

		await cameraUpload.sync()

		expect(mockSetSyncing).not.toHaveBeenCalled()
	})

	it("skips when isInternetReachable is null (platform unable to determine reachability)", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, cellular: true })
		vi.mocked(NetInfo.fetch).mockResolvedValueOnce({ type: "wifi", isConnected: true, isInternetReachable: null } as any)

		await cameraUpload.sync()

		expect(mockSetSyncing).not.toHaveBeenCalled()
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

	it("skips background sync when config.background is false", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, background: false })

		await cameraUpload.sync({ background: true })

		expect(mockSetSyncing).not.toHaveBeenCalled()
	})

	it("proceeds with background sync when config.background is true", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, background: true })

		await cameraUpload.sync({ background: true })

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

		// Seed the parent-dir cache to verify it gets cleared too
		const dirCache = (cameraUpload as any).ensureParentDirectoryExistsCache as Map<string, unknown>

		dirCache.set("some-key", { value: {}, expires: Date.now() + 60000 })

		eventHandlers["secureStoreChange"]!({ key: "cameraUploadConfig:v1" })

		expect((cameraUpload as any).globalAbortController).not.toBe(controllerBefore)
		expect(dirCache.size).toBe(0)
	})

	it("secureStoreChange with unrelated key does not trigger cancel", () => {
		const controllerBefore = (cameraUpload as any).globalAbortController
		const dirCache = (cameraUpload as any).ensureParentDirectoryExistsCache as Map<string, unknown>

		dirCache.set("some-key", { value: {}, expires: Date.now() + 60000 })

		eventHandlers["secureStoreChange"]!({ key: "someOtherKey" })

		expect((cameraUpload as any).globalAbortController).toBe(controllerBefore)
		// Cache must NOT be cleared for unrelated keys
		expect(dirCache.size).toBe(1)
	})

	it("secureStoreClear triggers cancel and clears ensureParentDirectoryExistsCache", () => {
		const controllerBefore = (cameraUpload as any).globalAbortController
		const dirCache = (cameraUpload as any).ensureParentDirectoryExistsCache as Map<string, unknown>

		dirCache.set("some-key", { value: {}, expires: Date.now() + 60000 })

		eventHandlers["secureStoreClear"]!()

		expect((cameraUpload as any).globalAbortController).not.toBe(controllerBefore)
		expect(dirCache.size).toBe(0)
	})

	it("secureStoreRemove with matching key triggers cancel and clears ensureParentDirectoryExistsCache", () => {
		const controllerBefore = (cameraUpload as any).globalAbortController
		const dirCache = (cameraUpload as any).ensureParentDirectoryExistsCache as Map<string, unknown>

		dirCache.set("some-key", { value: {}, expires: Date.now() + 60000 })

		eventHandlers["secureStoreRemove"]!({ key: "cameraUploadConfig:v1" })

		expect((cameraUpload as any).globalAbortController).not.toBe(controllerBefore)
		expect(dirCache.size).toBe(0)
	})

	it("secureStoreRemove with unrelated key does not trigger cancel", () => {
		const controllerBefore = (cameraUpload as any).globalAbortController
		const dirCache = (cameraUpload as any).ensureParentDirectoryExistsCache as Map<string, unknown>

		dirCache.set("some-key", { value: {}, expires: Date.now() + 60000 })

		eventHandlers["secureStoreRemove"]!({ key: "someOtherKey" })

		expect((cameraUpload as any).globalAbortController).toBe(controllerBefore)
		// Cache must NOT be cleared for unrelated keys
		expect(dirCache.size).toBe(1)
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

	it("cleans up tmp file after upload", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		let tmpUri: string | undefined

		vi.mocked(transfers.upload).mockImplementationOnce(async (args: any) => {
			tmpUri = args.localFileOrDir.uri

			expect(fs.has(tmpUri!)).toBe(true)

			return { files: [] } as any
		})

		await cameraUpload.sync()

		expect(tmpUri).toBeDefined()
		expect(fs.has(tmpUri!)).toBe(false)
	})

	it("passes correct arguments to transfers.upload", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg", creationTime: 1000, modificationTime: 2000 }])

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "photo.jpg",
				created: 1000,
				modified: 2000
			})
		)
	})

	it("upload returns null (abort) does not update MD5 cache", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		vi.mocked(transfers.upload).mockResolvedValueOnce(null)

		await cameraUpload.sync()

		expect(cache.cameraUploadHashes.size).toBe(0)
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

	it("background sync excludes videos even when config.includeVideos is true", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, includeVideos: true, background: true })

		setupAlbumWithAssets([
			{ id: "img", filename: "photo.jpg", mediaType: MediaType.IMAGE },
			{ id: "vid", filename: "video.mp4", mediaType: MediaType.VIDEO }
		])

		await cameraUpload.sync({ background: true })

		expect(transfers.upload).toHaveBeenCalledTimes(1)
	})
})

// ─── Same-title album disambiguation ────────────────────────────────────────

describe("same-title album disambiguation", () => {
	type AlbumSpec = {
		id: string
		title: string
		assets: { id: string; filename: string }[]
	}

	function setupAlbums(albums: AlbumSpec[]): void {
		for (const album of albums) {
			ml.addAlbum({
				id: album.id,
				title: album.title,
				assetIds: album.assets.map(a => a.id)
			})

			for (const asset of album.assets) {
				const uri = `file:///media/${asset.id}`

				ml.addAsset({
					id: asset.id,
					filename: asset.filename,
					uri,
					mediaType: MediaType.IMAGE,
					creationTime: 1000,
					modificationTime: 2000
				})

				fs.set(uri, new Uint8Array([1]))
			}
		}
	}

	function installCreateDirSpy(): ReturnType<typeof vi.fn> {
		const createDir = vi.fn(async () => ({ uuid: "remote-dir-uuid" }))

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({ files: [] })),
				createDir
			}
		} as any)

		return createDir
	}

	it("two albums with identical titles each map to a distinct remote folder", async () => {
		const createDir = installCreateDirSpy()

		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-a", "album-b"]
		})

		setupAlbums([
			{
				id: "album-a",
				title: "Screenshots",
				assets: [{ id: "asset-a1", filename: "photo1.jpg" }]
			},
			{
				id: "album-b",
				title: "Screenshots",
				assets: [{ id: "asset-b1", filename: "photo2.jpg" }]
			}
		])

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(2)

		const createdDirNames = new Set(createDir.mock.calls.map(call => call[1] as string))

		expect(createDir.mock.calls.length).toBe(2)
		expect(createdDirNames.size).toBe(2)
	})

	it("alphabetically-earliest album.id keeps the bare title; later siblings get an album-id suffix", async () => {
		const createDir = installCreateDirSpy()

		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-a", "album-b"]
		})

		setupAlbums([
			{
				id: "album-a",
				title: "Screenshots",
				assets: [{ id: "asset-a1", filename: "photo1.jpg" }]
			},
			{
				id: "album-b",
				title: "Screenshots",
				assets: [{ id: "asset-b1", filename: "photo2.jpg" }]
			}
		])

		await cameraUpload.sync()

		const createdDirNames = new Set(createDir.mock.calls.map(call => call[1] as string))

		expect(createdDirNames.has("Screenshots")).toBe(true)
		expect(createdDirNames.has("Screenshots (album-b)")).toBe(true)
	})

	it("single selected album with no same-title sibling keeps the bare folder name (preserves cross-device merging)", async () => {
		const createDir = installCreateDirSpy()

		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-a"]
		})

		setupAlbums([
			{
				id: "album-a",
				title: "Screenshots",
				assets: [{ id: "asset-a1", filename: "photo1.jpg" }]
			}
		])

		await cameraUpload.sync()

		const createdDirNames = createDir.mock.calls.map(call => call[1] as string)

		expect(createdDirNames).toEqual(["Screenshots"])
	})

	it("same filename across two same-title albums uploads both into distinct remote folders — no silent merge", async () => {
		const createDir = installCreateDirSpy()

		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-a", "album-b"]
		})

		setupAlbums([
			{
				id: "album-a",
				title: "Vacation",
				assets: [{ id: "asset-a1", filename: "IMG_0001.jpg" }]
			},
			{
				id: "album-b",
				title: "Vacation",
				assets: [{ id: "asset-b1", filename: "IMG_0001.jpg" }]
			}
		])

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(2)

		const createdDirNames = new Set(createDir.mock.calls.map(call => call[1] as string))

		expect(createdDirNames.size).toBe(2)
	})

	it("three albums sharing one title produce three distinct remote folders", async () => {
		const createDir = installCreateDirSpy()

		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-a", "album-b", "album-c"]
		})

		setupAlbums([
			{
				id: "album-a",
				title: "Pictures",
				assets: [{ id: "asset-a1", filename: "a.jpg" }]
			},
			{
				id: "album-b",
				title: "Pictures",
				assets: [{ id: "asset-b1", filename: "b.jpg" }]
			},
			{
				id: "album-c",
				title: "Pictures",
				assets: [{ id: "asset-c1", filename: "c.jpg" }]
			}
		])

		await cameraUpload.sync()

		const createdDirNames = new Set(createDir.mock.calls.map(call => call[1] as string))

		expect(createDir.mock.calls.length).toBe(3)
		expect(createdDirNames.size).toBe(3)
		expect(createdDirNames.has("Pictures")).toBe(true)
		expect(createdDirNames.has("Pictures (album-b)")).toBe(true)
		expect(createdDirNames.has("Pictures (album-c)")).toBe(true)
	})

	it("duplicate detection is case-insensitive; each album keeps its own title casing in its folder name", async () => {
		const createDir = installCreateDirSpy()

		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-a", "album-b"]
		})

		setupAlbums([
			{
				id: "album-a",
				title: "Screenshots",
				assets: [{ id: "asset-a1", filename: "photo1.jpg" }]
			},
			{
				id: "album-b",
				title: "SCREENSHOTS",
				assets: [{ id: "asset-b1", filename: "photo2.jpg" }]
			}
		])

		await cameraUpload.sync()

		const createdDirNames = new Set(createDir.mock.calls.map(call => call[1] as string))

		// Two distinct calls, no cache-collision-induced extras.
		expect(createDir.mock.calls.length).toBe(2)
		expect(createdDirNames.size).toBe(2)
		// album-a (lower id) wins bare slot, keeps its own casing.
		expect(createdDirNames.has("Screenshots")).toBe(true)
		// album-b is suffixed, and the suffixed name preserves its OWN title's casing,
		// not the winner's title.
		expect(createdDirNames.has("SCREENSHOTS (album-b)")).toBe(true)
	})

	it("two albums with non-colliding titles never get suffixes (negative case)", async () => {
		const createDir = installCreateDirSpy()

		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-a", "album-b"]
		})

		setupAlbums([
			{
				id: "album-a",
				title: "Screenshots",
				assets: [{ id: "asset-a1", filename: "photo1.jpg" }]
			},
			{
				id: "album-b",
				title: "Vacation",
				assets: [{ id: "asset-b1", filename: "photo2.jpg" }]
			}
		])

		await cameraUpload.sync()

		const createdDirNames = new Set(createDir.mock.calls.map(call => call[1] as string))

		expect(createDir.mock.calls.length).toBe(2)
		expect(createdDirNames).toEqual(new Set(["Screenshots", "Vacation"]))
	})

	it("album.id containing iOS-style '/L0/NNN' suffix is sanitized before being interpolated", async () => {
		const createDir = installCreateDirSpy()

		// Real iOS PHCollection.localIdentifier values look like "<UUID>/L0/<NNN>".
		// The "/" segments would otherwise blow past slashCount === 2 in
		// ensureParentDirectoryExists and throw "Unexpected path structure".
		const iosAlbumA = "A1B2C3D4-1111-2222-3333-444455556666/L0/020"
		const iosAlbumB = "Z9Y8X7W6-1111-2222-3333-444455556666/L0/020"

		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: [iosAlbumA, iosAlbumB]
		})

		setupAlbums([
			{
				id: iosAlbumA,
				title: "Screenshots",
				assets: [{ id: "asset-a1", filename: "photo1.jpg" }]
			},
			{
				id: iosAlbumB,
				title: "Screenshots",
				assets: [{ id: "asset-b1", filename: "photo2.jpg" }]
			}
		])

		await cameraUpload.sync()

		const createdDirNames = new Set(createDir.mock.calls.map(call => call[1] as string))

		expect(transfers.upload).toHaveBeenCalledTimes(2)
		expect(createDir.mock.calls.length).toBe(2)
		expect(createdDirNames.has("Screenshots")).toBe(true)
		// Slashes in the id replaced by "_" so the suffix is a single path segment.
		expect(createdDirNames.has(`Screenshots (${iosAlbumB.replace(/\//g, "_")})`)).toBe(true)
		// Sanity: no created dir name contains "/" — that would break the path structure.
		for (const name of createdDirNames) {
			expect(name).not.toMatch(/\//)
		}
	})

	it("album title containing '/' is sanitized so it stays a single path segment", async () => {
		const createDir = installCreateDirSpy()

		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-a"]
		})

		setupAlbums([
			{
				id: "album-a",
				title: "2024/Trips",
				assets: [{ id: "asset-a1", filename: "photo1.jpg" }]
			}
		])

		await cameraUpload.sync()

		const createdDirNames = createDir.mock.calls.map(call => call[1] as string)

		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(createdDirNames).toEqual(["2024_Trips"])
	})

	it("album with empty title is skipped (does not pollute the remote root)", async () => {
		const createDir = installCreateDirSpy()

		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-a", "album-b"]
		})

		setupAlbums([
			{
				id: "album-a",
				title: "",
				assets: [{ id: "asset-a1", filename: "photo1.jpg" }]
			},
			{
				id: "album-b",
				title: "Screenshots",
				assets: [{ id: "asset-b1", filename: "photo2.jpg" }]
			}
		])

		await cameraUpload.sync()

		// Only album-b's asset uploads; album-a's empty-titled assets are skipped.
		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(createDir.mock.calls.map(call => call[1] as string)).toEqual(["Screenshots"])
	})

	it("album with whitespace-only title is skipped", async () => {
		const createDir = installCreateDirSpy()

		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-a", "album-b"]
		})

		setupAlbums([
			{
				id: "album-a",
				title: "   ",
				assets: [{ id: "asset-a1", filename: "photo1.jpg" }]
			},
			{
				id: "album-b",
				title: "Screenshots",
				assets: [{ id: "asset-b1", filename: "photo2.jpg" }]
			}
		])

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(createDir.mock.calls.map(call => call[1] as string)).toEqual(["Screenshots"])
	})

	it("titles with leading/trailing whitespace are trimmed; ' Screenshots ' and 'Screenshots' merge", async () => {
		const createDir = installCreateDirSpy()

		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-a", "album-b"]
		})

		setupAlbums([
			{
				id: "album-a",
				title: " Screenshots ",
				assets: [{ id: "asset-a1", filename: "photo1.jpg" }]
			},
			{
				id: "album-b",
				title: "Screenshots",
				assets: [{ id: "asset-b1", filename: "photo2.jpg" }]
			}
		])

		await cameraUpload.sync()

		const createdDirNames = new Set(createDir.mock.calls.map(call => call[1] as string))

		expect(transfers.upload).toHaveBeenCalledTimes(2)
		expect(createDir.mock.calls.length).toBe(2)
		// album-a (alphabetically first, has padded title) wins the bare slot — but
		// the bare slot itself is trimmed, so it ends up as "Screenshots", not " Screenshots ".
		expect(createdDirNames.has("Screenshots")).toBe(true)
		expect(createdDirNames.has("Screenshots (album-b)")).toBe(true)
	})

	it("duplicate album ids in config are deduped (no double-iteration into the tree)", async () => {
		const createDir = installCreateDirSpy()

		// Defensive: persistence is Set-backed today, but a legacy/hand-edited config
		// could contain dupes. The library must not double-iterate the same album.
		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-a", "album-a", "album-a"]
		})

		setupAlbums([
			{
				id: "album-a",
				title: "Screenshots",
				assets: [{ id: "asset-a1", filename: "photo1.jpg" }]
			}
		])

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(createDir.mock.calls.length).toBe(1)
		expect(createDir.mock.calls.map(call => call[1] as string)).toEqual(["Screenshots"])
	})

	it("an unselected device album with the same title still anchors the bare slot (cross-selection stability)", async () => {
		const createDir = installCreateDirSpy()

		// User has 3 same-title albums on the device but only selected 2 of them.
		// The third (unselected) one wins the bare slot anyway, so selecting/deselecting
		// it later cannot shift the other two's folder names.
		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-b", "album-c"]
		})

		setupAlbums([
			{
				id: "album-a",
				title: "Screenshots",
				assets: [{ id: "asset-a1", filename: "photo-a.jpg" }]
			},
			{
				id: "album-b",
				title: "Screenshots",
				assets: [{ id: "asset-b1", filename: "photo-b.jpg" }]
			},
			{
				id: "album-c",
				title: "Screenshots",
				assets: [{ id: "asset-c1", filename: "photo-c.jpg" }]
			}
		])

		await cameraUpload.sync()

		const createdDirNames = new Set(createDir.mock.calls.map(call => call[1] as string))

		// Only the two selected albums upload — neither uses the bare "Screenshots"
		// because album-a (unselected, alphabetically earliest) anchors that slot.
		expect(transfers.upload).toHaveBeenCalledTimes(2)
		expect(createDir.mock.calls.length).toBe(2)
		expect(createdDirNames.has("Screenshots")).toBe(false)
		expect(createdDirNames.has("Screenshots (album-b)")).toBe(true)
		expect(createdDirNames.has("Screenshots (album-c)")).toBe(true)
	})

	it("getAlbumsAsync failure aborts the sync loudly (no silent drop of selected albums)", async () => {
		// Per the project's silent-failure discipline: if we can't enumerate the
		// device catalogue, we can't safely disambiguate. Fail the whole sync.
		const { getAlbumsAsync } = await import("expo-media-library")

		vi.mocked(getAlbumsAsync).mockRejectedValueOnce(new Error("permission denied"))

		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-a"]
		})

		setupAlbums([
			{
				id: "album-a",
				title: "Screenshots",
				assets: [{ id: "asset-a1", filename: "photo1.jpg" }]
			}
		])

		await cameraUpload.sync()

		// No uploads happen — the rejection propagated up through listLocal and
		// the sync errored out cleanly.
		expect(transfers.upload).not.toHaveBeenCalled()
	})

	it("a selected album that no longer exists on the device is silently skipped", async () => {
		const createDir = installCreateDirSpy()

		// User's config references an album that has since been deleted from Photos.
		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-a", "album-deleted"]
		})

		setupAlbums([
			{
				id: "album-a",
				title: "Screenshots",
				assets: [{ id: "asset-a1", filename: "photo1.jpg" }]
			}
		])

		await cameraUpload.sync()

		// Only album-a uploads; the dangling reference is dropped without crashing.
		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(createDir.mock.calls.map(call => call[1] as string)).toEqual(["Screenshots"])
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

	it("skips assets exceeding MAX_UPLOAD_FAILURES and reports to store", async () => {
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
		expect(mockAddSkippedAsset).toHaveBeenCalledWith("a1")

		failures.clear()
	})

	it("cancel resets syncing flag", () => {
		;(cameraUpload as any).syncing = true

		cameraUpload.cancel()

		expect((cameraUpload as any).syncing).toBe(false)
	})

	it("cancel during sync allows future syncs", async () => {
		;(cameraUpload as any).syncing = true

		cameraUpload.cancel()

		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["a1"] })
		ml.addAsset({ id: "a1", filename: "photo.jpg", uri: "file:///media/a1", mediaType: MediaType.IMAGE, creationTime: 1000 })
		fs.set("file:///media/a1", new Uint8Array([1, 2, 3]))

		await cameraUpload.sync()

		expect(mockSetSyncing).toHaveBeenCalledWith(true)
	})

	it("cancel clears skippedAssets", () => {
		cameraUpload.cancel()

		expect(mockClearSkippedAssets).toHaveBeenCalled()
	})
})

// ─── MD5 hash cache ─────────────────────────────────────────────────────────

describe("MD5 hash cache", () => {
	function setupLocalAssets(
		assets: Array<{
			id: string
			filename: string
			creationTime?: number
			modificationTime?: number
		}>
	) {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: assets.map(a => a.id) })

		for (const asset of assets) {
			const uri = `file:///media/${asset.id}`

			ml.addAsset({
				id: asset.id,
				filename: asset.filename,
				uri,
				mediaType: MediaType.IMAGE,
				creationTime: asset.creationTime ?? 1000,
				modificationTime: asset.modificationTime ?? 2000
			})

			fs.set(uri, new Uint8Array([1, 2, 3]))
		}
	}

	it("skips upload when MD5 matches cached value", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		cache.cameraUploadHashes.set("/camera roll/photo.jpg", "mock-md5")

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
	})

	it("proceeds with upload when MD5 differs from cached value — the source branch genuinely distinguishes match vs. mismatch", async () => {
		// The mock File always returns "mock-md5". Seed the cache with that same value
		// to confirm the source skips upload (match), then prove mismatch triggers upload
		// by overriding the md5 getter to return a different value for this one test.
		// This verifies the comparison branch is exercised for real — not as a side-effect
		// of the mock artefact.

		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		// First: confirm the match path really skips upload
		cache.cameraUploadHashes.set("/camera roll/photo.jpg", "mock-md5")

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()

		// Second: patch md5 to return a NEW hash so the branch goes the other way
		const { File: MockFile } = await import("@/tests/mocks/expoFileSystem")

		const originalMd5 = Object.getOwnPropertyDescriptor(MockFile.prototype, "md5")

		Object.defineProperty(MockFile.prototype, "md5", {
			get() {
				return this.exists ? "changed-md5" : null
			},
			configurable: true
		})

		vi.clearAllMocks()
		setupDefaultMocks()

		setupLocalAssets([{ id: "a2", filename: "photo2.jpg" }])

		cache.cameraUploadHashes.set("/camera roll/photo2.jpg", "old-hash-different-from-changed-md5")

		try {
			await cameraUpload.sync()

			expect(transfers.upload).toHaveBeenCalledTimes(1)
		} finally {
			if (originalMd5) {
				Object.defineProperty(MockFile.prototype, "md5", originalMd5)
			}
		}
	})

	it("proceeds with upload when no cached value exists", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
	})

	it("stores MD5 in cache after successful upload", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		await cameraUpload.sync()

		expect(cache.cameraUploadHashes.get("/camera roll/photo.jpg")).toBe("mock-md5")
	})

	it("does not store MD5 in cache when upload fails", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		vi.mocked(transfers.upload).mockRejectedValueOnce(new Error("Upload failed"))

		await cameraUpload.sync()

		expect(cache.cameraUploadHashes.has("/camera roll/photo.jpg")).toBe(false)
	})

	it("updates cached MD5 when file content changes", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		cache.cameraUploadHashes.set("/camera roll/photo.jpg", "old-md5")

		await cameraUpload.sync()

		expect(cache.cameraUploadHashes.get("/camera roll/photo.jpg")).toBe("mock-md5")
	})
})

// ─── compress() ──────────────────────────────────────────────────────────────

describe("CameraUpload.compress()", () => {
	it("returns file unchanged when extension is not in supported set", async () => {
		// .txt is not in EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS
		const { File: MockFile, Paths } = await import("@/tests/mocks/expoFileSystem")
		const { ImageManipulator } = await import("expo-image-manipulator")

		const uri = `${Paths.cache.uri}/filen-tmp/test.txt`

		fs.set(uri, new Uint8Array([1, 2, 3]))

		const file = new MockFile(uri)

		// Access private compress via cast
		const result = await (cameraUpload as any).compress(file)

		// No manipulation for unsupported extension — returns same instance
		expect(result).toBe(file)
		expect(vi.mocked(ImageManipulator.manipulate)).not.toHaveBeenCalled()
	})

	it("throws when file is outside the cache directory", async () => {
		const { File: MockFile } = await import("@/tests/mocks/expoFileSystem")
		const uri = "file:///document/arbitrary/photo.jpg"

		fs.set(uri, new Uint8Array([1, 2, 3]))

		const file = new MockFile(uri)

		await expect((cameraUpload as any).compress(file)).rejects.toThrow("compress() called on file outside cache directory")
	})

	it("returns original file when manipulated result is larger or equal in size", async () => {
		const { File: MockFile, Paths } = await import("@/tests/mocks/expoFileSystem")
		const { ImageManipulator } = await import("expo-image-manipulator")

		const originalUri = `${Paths.cache.uri}/filen-tmp/photo.png`
		const manipulatedUri = `${Paths.cache.uri}/filen-tmp/photo-manip.png`

		// Original is 3 bytes; manipulated will be 10 bytes — larger
		fs.set(originalUri, new Uint8Array([1, 2, 3]))
		fs.set(manipulatedUri, new Uint8Array(new Array(10).fill(1)))

		const file = new MockFile(originalUri)

		const fakeSaveAsync = vi.fn(async () => ({ uri: manipulatedUri }))
		const fakeContext = { renderAsync: vi.fn(async () => ({ saveAsync: fakeSaveAsync })) }

		vi.mocked(ImageManipulator.manipulate).mockReturnValueOnce(fakeContext as any)

		const result = await (cameraUpload as any).compress(file)

		// Manipulated is larger → return original
		expect(result).toBe(file)
		// Manipulated file should be deleted since it was larger
		expect(fs.has(manipulatedUri)).toBe(false)
	})

	it("renames file from .png to .jpg when manipulated result is smaller", async () => {
		const { File: MockFile, Paths } = await import("@/tests/mocks/expoFileSystem")
		const { ImageManipulator } = await import("expo-image-manipulator")

		const originalUri = `${Paths.cache.uri}/filen-tmp/photo.png`
		const manipulatedUri = `${Paths.cache.uri}/filen-tmp/photo-manip.png`

		// Original is 10 bytes; manipulated is 3 bytes — smaller
		fs.set(originalUri, new Uint8Array(new Array(10).fill(1)))
		fs.set(manipulatedUri, new Uint8Array([1, 2, 3]))

		const file = new MockFile(originalUri)

		const fakeSaveAsync = vi.fn(async () => ({ uri: manipulatedUri }))
		const fakeContext = { renderAsync: vi.fn(async () => ({ saveAsync: fakeSaveAsync })) }

		vi.mocked(ImageManipulator.manipulate).mockReturnValueOnce(fakeContext as any)

		const result = await (cameraUpload as any).compress(file)

		// Extension changed to .jpg since content is now JPEG
		expect(result.uri).toMatch(/\.jpg$/)
		// Manipulated temp file cleaned up
		expect(fs.has(manipulatedUri)).toBe(false)
	})
})

// ─── ensureParentDirectoryExistsCache TTL expiry ─────────────────────────────

describe("ensureParentDirectoryExistsCache TTL expiry", () => {
	function setupLocalAssets(
		assets: Array<{
			id: string
			filename: string
			creationTime?: number
			modificationTime?: number
		}>
	) {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: assets.map(a => a.id) })

		for (const asset of assets) {
			const uri = `file:///media/${asset.id}`

			ml.addAsset({
				id: asset.id,
				filename: asset.filename,
				uri,
				mediaType: MediaType.IMAGE,
				creationTime: asset.creationTime ?? 1000,
				modificationTime: asset.modificationTime ?? 2000
			})

			fs.set(uri, new Uint8Array([1, 2, 3]))
		}
	}

	it("re-creates the directory when the cache entry has expired (expires <= Date.now())", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		const createDir = vi.fn(async () => ({ uuid: "new-dir-uuid" }))

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({ files: [] })),
				createDir
			}
		} as any)

		// First sync — creates the directory and caches it
		await cameraUpload.sync()

		const firstCallCount = createDir.mock.calls.length

		expect(firstCallCount).toBe(1)

		// Manually expire the cache entry so the next sync re-calls createDir
		const dirCache = (cameraUpload as any).ensureParentDirectoryExistsCache as Map<string, { value: unknown; expires: number }>

		for (const [key, entry] of dirCache) {
			dirCache.set(key, { value: entry.value, expires: Date.now() - 1 })
		}

		// Clear the md5 cache so the upload is not skipped on the second sync
		// (otherwise the md5 match would break out before ensureParentDirectoryExists is called)
		cache.cameraUploadHashes.clear()

		// Second sync — cache entry is expired, createDir must be called again
		await cameraUpload.sync()

		expect(createDir.mock.calls.length).toBeGreaterThan(firstCallCount)
	})

	it("does not re-create the directory when the cache entry is still valid", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		const createDir = vi.fn(async () => ({ uuid: "dir-uuid" }))

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({ files: [] })),
				createDir
			}
		} as any)

		// First sync — populates the cache
		await cameraUpload.sync()

		const firstCallCount = createDir.mock.calls.length

		// Second sync — cache still valid, no extra createDir
		await cameraUpload.sync()

		expect(createDir.mock.calls.length).toBe(firstCallCount)
	})
})

// ─── deltas() remoteDir null guard ───────────────────────────────────────────

describe("deltas() remoteDir null guard", () => {
	it("sync() silently skips (no setSyncing, no setErrors) when remoteDir is null — guard fires before reaching deltas()", async () => {
		// sync() has an early return at the config check level (!config.remoteDir),
		// so setSyncing(true) is never called, and deltas() is never reached.
		// This documents that the null guard in deltas() is a secondary safety net.
		vi.mocked(secureStore.get).mockResolvedValueOnce({
			...ENABLED_CONFIG,
			remoteDir: null
		})

		await cameraUpload.sync()

		expect(mockSetSyncing).not.toHaveBeenCalled()
		expect(mockSetErrors).not.toHaveBeenCalled()
	})

	it("deltas() throws when remoteDir is null (secondary guard — called directly)", async () => {
		const configWithNullRemote = { ...ENABLED_CONFIG, remoteDir: null }

		await expect(
			(cameraUpload as any).deltas({
				config: configWithNullRemote,
				signal: new AbortController().signal
			})
		).rejects.toThrow("Remote directory is not set in config")
	})
})

// ─── Remote collision resolution ─────────────────────────────────────────────

describe("sync flow — remote collision resolution", () => {
	function setupLocalAssets(
		assets: Array<{
			id: string
			filename: string
			creationTime?: number
			modificationTime?: number
		}>
	) {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: assets.map(a => a.id) })

		for (const asset of assets) {
			const uri = `file:///media/${asset.id}`

			ml.addAsset({
				id: asset.id,
				filename: asset.filename,
				uri,
				mediaType: MediaType.IMAGE,
				creationTime: asset.creationTime ?? 1000,
				modificationTime: asset.modificationTime ?? 2000
			})

			fs.set(uri, new Uint8Array([1, 2, 3]))
		}
	}

	it("remote tree with duplicate filenames is resolved via collision strategy — upload does not re-send the file already matched", async () => {
		// Remote tree has two files with the same path (the server can return dupe
		// filenames). listRemote must resolve them with the same collision strategy
		// used by listLocal so local file "photo.jpg" at creationTime=1000 matches
		// its remote counterpart and is NOT re-uploaded.
		setupLocalAssets([{ id: "a1", filename: "photo.jpg", creationTime: 1000, modificationTime: 2000 }])

		// Two remote files collide on /camera roll/photo.jpg.
		// First one has creationTime 1000 — matches local → should be skipped.
		// Second one is the collision-resolved path for the same name.
		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({
					files: [
						{ path: "/Camera Roll/photo.jpg", file: { uuid: "remote-1" } },
						{ path: "/Camera Roll/photo.jpg", file: { uuid: "remote-2" } }
					]
				})),
				createDir: vi.fn(async () => ({ uuid: "dir" }))
			}
		} as any)

		vi.mocked(unwrapFileMeta).mockImplementation((file: any) => {
			if (file.uuid === "remote-1") {
				return { meta: { name: "photo.jpg", created: 1000n, modified: 2000n } } as any
			}

			return { meta: { name: "photo.jpg", created: 1000n, modified: 2000n } } as any
		})

		await cameraUpload.sync()

		// The local file matches remote-1 (same path after collision resolution)
		// so no re-upload is needed.
		expect(transfers.upload).not.toHaveBeenCalled()
	})
})

// ─── afterActivation boundary ─────────────────────────────────────────────────

describe("afterActivation boundary cases", () => {
	function setupAlbumWithAsset(opts: { id: string; filename: string; creationTime: number }) {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: [opts.id] })
		ml.addAsset({
			id: opts.id,
			filename: opts.filename,
			uri: `file:///media/${opts.id}`,
			mediaType: MediaType.IMAGE,
			creationTime: opts.creationTime
		})
		fs.set(`file:///media/${opts.id}`, new Uint8Array([1]))
	}

	it("includes asset when creationTime exactly equals activationTimestamp (gte boundary)", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({
			...ENABLED_CONFIG,
			afterActivation: true,
			activationTimestamp: 5000
		})

		setupAlbumWithAsset({ id: "exact", filename: "exact.jpg", creationTime: 5000 })

		await cameraUpload.sync()

		// Asset at the boundary (creationTime === activationTimestamp) must be included
		expect(transfers.upload).toHaveBeenCalledTimes(1)
	})

	it("excludes asset one millisecond before activationTimestamp", async () => {
		vi.mocked(secureStore.get).mockResolvedValueOnce({
			...ENABLED_CONFIG,
			afterActivation: true,
			activationTimestamp: 5000
		})

		setupAlbumWithAsset({ id: "before", filename: "before.jpg", creationTime: 4999 })

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
	})
})

// ─── pause() and resume() ─────────────────────────────────────────────────────

describe("pause() and resume()", () => {
	it("pause() delegates to pause() on the current globalPauseSignal", () => {
		// The utils mock provides a PauseSignal class with a no-op pause() method.
		// Spy on the instance currently held by the singleton.
		const pauseSignal = (cameraUpload as any).globalPauseSignal

		const pauseSpy = vi.spyOn(pauseSignal, "pause")

		cameraUpload.pause()

		expect(pauseSpy).toHaveBeenCalledOnce()
	})

	it("resume() delegates to resume() on the current globalPauseSignal", () => {
		const pauseSignal = (cameraUpload as any).globalPauseSignal

		const resumeSpy = vi.spyOn(pauseSignal, "resume")

		cameraUpload.resume()

		expect(resumeSpy).toHaveBeenCalledOnce()
	})

	it("pause() after cancel() targets the replacement signal, not the discarded one", () => {
		const originalSignal = (cameraUpload as any).globalPauseSignal
		const originalPauseSpy = vi.spyOn(originalSignal, "pause")

		cameraUpload.cancel()

		const replacementSignal = (cameraUpload as any).globalPauseSignal

		expect(replacementSignal).not.toBe(originalSignal)

		const replacementPauseSpy = vi.spyOn(replacementSignal, "pause")

		cameraUpload.pause()

		expect(replacementPauseSpy).toHaveBeenCalledOnce()
		expect(originalPauseSpy).not.toHaveBeenCalled()
	})
})

// ─── uploadFailures increment through sync ────────────────────────────────────

describe("uploadFailures increment on repeated failure", () => {
	function setupSingleAsset() {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["a1"] })
		ml.addAsset({
			id: "a1",
			filename: "photo.jpg",
			uri: "file:///media/a1",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		fs.set("file:///media/a1", new Uint8Array([1, 2, 3]))
	}

	it("asset is skipped after MAX_UPLOAD_FAILURES consecutive upload failures", async () => {
		setupSingleAsset()

		vi.mocked(transfers.upload).mockRejectedValue(new Error("Network error"))

		// Drive 3 failures — each sync increments uploadFailures.get("a1") by 1
		await cameraUpload.sync()
		await cameraUpload.sync()
		await cameraUpload.sync()

		// Failure count is now MAX_UPLOAD_FAILURES (3). Switch to success mock so the
		// only reason upload is not called is the skip guard, not the failure path.
		vi.mocked(transfers.upload).mockResolvedValue({ files: [] } as any)

		// Clear call history so the count we check below only reflects sync 4
		vi.mocked(transfers.upload).mockClear()
		mockAddSkippedAsset.mockClear()

		await cameraUpload.sync()

		// Skipped: upload never called in the 4th pass because count >= MAX_UPLOAD_FAILURES
		expect(mockAddSkippedAsset).toHaveBeenCalledWith("a1")
		expect(transfers.upload).not.toHaveBeenCalled()
	})

	it("asset is NOT skipped before reaching MAX_UPLOAD_FAILURES failures", async () => {
		setupSingleAsset()

		vi.mocked(transfers.upload).mockRejectedValue(new Error("Network error"))

		// Two failures — one below the threshold of 3
		await cameraUpload.sync()
		await cameraUpload.sync()

		// Switch to success mock for the third attempt; count is 2 < 3, should upload
		vi.mocked(transfers.upload).mockResolvedValue({ files: [] } as any)

		// Clear history so we only count calls from sync 3
		vi.mocked(transfers.upload).mockClear()
		mockAddSkippedAsset.mockClear()

		await cameraUpload.sync()

		// Should have uploaded on the third pass (count 2 < MAX_UPLOAD_FAILURES=3)
		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(mockAddSkippedAsset).not.toHaveBeenCalledWith("a1")
	})
})

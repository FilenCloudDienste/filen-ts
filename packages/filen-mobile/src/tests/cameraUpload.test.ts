import { vi, describe, it, expect, beforeEach, beforeAll, afterEach } from "vitest"
import pathModule from "path"

// @ts-expect-error __DEV__ is a React Native global
globalThis.__DEV__ = true

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-media-library/next", async () => await import("@/tests/mocks/expoMediaLibrary"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("react-native-blob-util", async () => await import("@/tests/mocks/reactNativeBlobUtil"))
vi.mock("@preeternal/react-native-file-hash", async () => await import("@/tests/mocks/reactNativeFileHash"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("@react-native-community/netinfo", () => ({
	default: { fetch: vi.fn(async () => ({ type: "wifi", isInternetReachable: true, isConnected: true })) }
}))

vi.mock("expo-battery", () => ({
	isLowPowerModeEnabledAsync: vi.fn(async () => false)
}))

vi.mock("expo-media-library/legacy", async () => {
	const next = await import("@/tests/mocks/expoMediaLibrary")

	return {
		getPermissionsAsync: vi.fn(async () => ({
			granted: true,
			status: "granted",
			accessPrivileges: "all",
			expires: "never",
			canAskAgain: true
		})),
		requestPermissionsAsync: vi.fn(async () => ({
			granted: true,
			status: "granted",
			accessPrivileges: "all",
			expires: "never",
			canAskAgain: true
		})),
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

const { mockManipulate } = vi.hoisted(() => ({ mockManipulate: vi.fn() }))

vi.mock("expo-image-manipulator", () => ({
	ImageManipulator: { manipulate: mockManipulate },
	SaveFormat: { JPEG: "jpeg" }
}))

// parseName/encodeName stubs mirror the filen-rs name.rs contract shape: parseName throws on
// names the validator rejects and passes accepted names through byte-identical (NFC is a
// no-op for the ASCII fixtures); encodeName deterministically maps rejected names into a
// valid form (":" → "：", other forbidden → "＿") and throws only on empty/over-length.
const { mockParseName, mockEncodeName } = vi.hoisted(() => {
	const FORBIDDEN = /[\u0000-\u001f\u007f/\\:*?"<>|]/

	const mockParseName = vi.fn((name: string) => {
		if (name.length === 0 || name.length > 255 || FORBIDDEN.test(name) || name.startsWith(" ") || /[. ]$/.test(name)) {
			throw new Error(`invalid name: ${name}`)
		}

		return name
	})

	const mockEncodeName = vi.fn((name: string) => {
		if (name.length === 0 || name.length > 255) {
			throw new Error(`unencodable name: ${name}`)
		}

		return name
			.replace(/[\u0000-\u001f\u007f/\\*?"<>|]/g, "＿")
			.replace(/:/g, "：")
			.replace(/^ +/, "␠")
			.replace(/[. ]+$/, "．")
	})

	return { mockParseName, mockEncodeName }
})

vi.mock("@filen/sdk-rs", () => ({
	AnyNormalDir: { Dir: vi.fn() },
	AnyNormalDir_Tags: { Dir: "Dir", Root: "Root" },
	AnyDirWithContext: { Normal: vi.fn() },
	parseName: mockParseName,
	encodeName: mockEncodeName
}))

vi.mock("@filen/utils", async () => {
	const sharedMock = await import("@/tests/mocks/filenUtils")

	// The shared mock's Semaphore is a no-op. The staging-bound tests (#B5) need real
	// acquire/release semantics, so this file substitutes a functional semaphore that
	// mirrors @filen/utils' Semaphore (counter + FIFO waiter queue).
	class FunctionalSemaphore {
		private counter = 0
		private readonly waiting: (() => void)[] = []
		private readonly maxCount: number

		public constructor(max: number = 1) {
			this.maxCount = max
		}

		public async acquire(): Promise<void> {
			if (this.counter < this.maxCount) {
				this.counter++

				return
			}

			await new Promise<void>(resolve => {
				this.waiting.push(resolve)
			})
		}

		public release(): void {
			if (this.counter <= 0) {
				return
			}

			this.counter--

			while (this.waiting.length > 0 && this.counter < this.maxCount) {
				this.counter++

				const next = this.waiting.shift()

				if (next) {
					next()
				}
			}
		}
	}

	return {
		...sharedMock,
		Semaphore: FunctionalSemaphore,
		fastLocaleCompare: (a: string, b: string) => a.localeCompare(b)
	}
})

vi.mock("@/lib/auth", () => ({
	default: { getSdkClients: vi.fn() }
}))

vi.mock("@/features/transfers/transfers", () => ({
	default: { upload: vi.fn() }
}))

const mockSetSyncing = vi.fn()
const mockSetErrors = vi.fn()
const mockAddSkippedAsset = vi.fn()
const mockRemoveSkippedAsset = vi.fn()
const mockClearSkippedAssets = vi.fn()

vi.mock("@/features/cameraUpload/store/useCameraUpload.store", () => ({
	default: {
		getState: () => ({
			setSyncing: mockSetSyncing,
			setErrors: mockSetErrors,
			addSkippedAsset: mockAddSkippedAsset,
			removeSkippedAsset: mockRemoveSkippedAsset,
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

// cameraUpload.ts still uses cache for cacheNewNormalDir (listRemote mirrors dirs into the cache);
// the ledger moved to cameraUploadState (mocked below).
vi.mock("@/lib/cache", () => ({
	default: {
		cacheNewNormalDir: vi.fn()
	}
}))

// Faithful passthrough over the store contract: plain Maps + fns that read/write them, so the
// existing behavioral pins (seed via .hashes/.aborts, assert via getHashSync/setHash/applyHashBatch)
// keep meaning. loadHashes/loadAborts/getHash are resolved passthroughs.
vi.mock("@/features/cameraUpload/cameraUploadState", () => {
	const hashes = new Map<string, unknown>()
	const destination: { current: string | null } = { current: null }
	const aborts = new Map<string, number>()

	return {
		default: {
			hashes,
			aborts,
			loadHashes: async () => {},
			loadAborts: async () => {},
			getHashSync: (key: string) => hashes.get(key),
			// Destination pairing: the shield is scoped to one remote directory, so the fake tracks it
			// the same way — a bare stub would make every pass look like "never recorded".
			destination,
			getSyncedDestination: async () => destination.current,
			setSyncedDestination: async (uuid: string) => {
				destination.current = uuid
			},
			clearHashes: vi.fn(async () => {
				hashes.clear()
			}),
			getHashMany: async (keys: string[]) => {
				const found = new Map<string, unknown>()

				for (const key of keys) {
					const value = hashes.get(key)

					if (value !== undefined) {
						found.set(key, value)
					}
				}

				return found
			},
			getHash: async (key: string) => hashes.get(key),
			hashKeys: () => [...hashes.keys()],
			setHash: async (key: string, entry: unknown) => {
				hashes.set(key, entry)
			},
			deleteHash: async (key: string) => {
				hashes.delete(key)
			},
			getAbort: (id: string) => aborts.get(id),
			setAbort: async (id: string, count: number) => {
				aborts.set(id, count)
			},
			deleteAbort: async (id: string) => {
				aborts.delete(id)
			},
			applyHashBatch: async ({ upserts, deletes }: { upserts?: [string, unknown][]; deletes?: string[] }) => {
				for (const [key, value] of upserts ?? []) {
					hashes.set(key, value)
				}

				for (const key of deletes ?? []) {
					hashes.delete(key)
				}
			}
		}
	}
})

vi.mock("@/lib/i18n", () => ({
	default: {
		t: (key: string) => key
	}
}))

vi.mock("@/lib/utils", () => ({
	unwrapSdkError: vi.fn().mockReturnValue(null),
	normalizeModificationTimestampForComparison: (ts: number) => ts
}))

vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapFileMeta: vi.fn(),
	// isDirUsable (real, via cameraUploadHelpers) delegates the trash check here.
	isTrashParent: (parent: { tag?: string } | null | undefined) => parent?.tag === "Trash"
}))

vi.mock("@/lib/paths", () => ({
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
	normalizeFilePathForExpo: (p: string) => p
}))

vi.mock("@/lib/signals", () => ({
	// Faithful to src/lib/signals.ts: pause()/resume() flip state, isPaused() reads it
	// (sync's B5 background gate calls isPaused() — a mock without it throws into the
	// run() wrapper and silently kills every background sync).
	PauseSignal: class {
		private paused = false

		pause() {
			this.paused = true
		}

		resume() {
			this.paused = false
		}

		isPaused() {
			return this.paused
		}

		dispose() {}
	}
}))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

import cameraUploadState from "@/features/cameraUpload/cameraUploadState"
import cameraUpload, { type Config, canonicalRemoteName } from "@/features/cameraUpload/cameraUpload"
import {
	modifyAssetPathOnCollision,
	effectiveCreationTimestamp,
	CAMERA_UPLOAD_REUPLOAD_DELETED_SECURE_STORE_KEY,
	type CollisionParams
} from "@/features/cameraUpload/cameraUploadHelpers"
import secureStore from "@/lib/secureStore"
import { CONVERT_HEIC_TO_JPG_ENABLED_SECURE_STORE_KEY } from "@/lib/imageConversion"
import NetInfo from "@react-native-community/netinfo"
import * as Battery from "expo-battery"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import { getPermissionsAsync } from "expo-media-library/legacy"
import auth from "@/lib/auth"
import transfers from "@/features/transfers/transfers"
import { unwrapFileMeta } from "@/lib/sdkUnwrap"
import events from "@/lib/events"
import { ml, MediaType } from "@/tests/mocks/expoMediaLibrary"
import { fs, File } from "@/tests/mocks/expoFileSystem"
import { mockFileHash, blake3BytesForContent, fileHashImplementation } from "@/tests/mocks/reactNativeFileHash"
import * as FileSystem from "expo-file-system"

// #103 — capture constructor-registered handlers in beforeAll (after module
// evaluation is complete) so the snapshot is not empty when mock-hoisting or
// lazy-initialisation order changes.
let eventHandlers: Record<string, Function | undefined> = {}

beforeAll(() => {
	eventHandlers = Object.fromEntries(
		vi.mocked(events.subscribe).mock.calls.map(([event, handler]) => [event as string, handler as Function])
	)
})

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
			createDir: vi.fn(async () => ({ uuid: "created-dir" })),
			// Destination-existence gate default: a usable dir (real Uuid parent) so the sync
			// proceeds. Individual tests override this to model a deleted / trashed destination.
			getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
		}
	} as any)
	uploadedPayloads.length = 0

	// Captured AT CALL TIME: the staged file is deleted by the pipeline's own LIFO defer as soon as
	// the upload resolves, so reading the bytes afterwards always finds nothing.
	vi.mocked(transfers.upload).mockImplementation(async (params: any) => {
		const entry = fs.get(params?.localFileOrDir?.uri)

		uploadedPayloads.push({
			name: params?.name,
			bytes: entry instanceof Uint8Array ? new Uint8Array(entry) : undefined
		})

		return { files: [] } as any
	})

	vi.mocked(unwrapFileMeta).mockReturnValue({ meta: null } as any)

	// Functional by default. The previous bare vi.fn() returned undefined, so renderAsync() threw,
	// convertHeicToJpg's fail-open catch returned the ORIGINAL file, and the conversion step was
	// invisible: deleting it entirely kept the whole suite green. This writes a distinct payload so
	// a test can tell converted bytes from original ones.
	manipulatedCount = 0

	// Restored per test: clearAllMocks resets calls but not implementations, so one test overriding
	// the hasher would otherwise govern every test after it.
	mockFileHash.mockImplementation(fileHashImplementation)

	mockManipulate.mockImplementation(() => ({
		renderAsync: async () => ({
			saveAsync: async ({ format }: { format: string }) => {
				const uri = `file:///manipulated/${manipulatedCount++}.${format}`

				fs.set(uri, MANIPULATED_BYTES)

				return { uri }
			},
			release: vi.fn()
		}),
		release: vi.fn()
	}))
}

// Distinguishable from the [1,2,3] every fixture asset is seeded with, so "did the upload carry the
// transformed bytes or the original?" is answerable rather than assumed — and deliberately SHORTER,
// because compress() keeps the original whenever its output is not smaller.
const MANIPULATED_BYTES = new Uint8Array([9, 9])
let manipulatedCount = 0

/** What each upload actually carried, recorded as it happened. */
const uploadedPayloads: Array<{ name?: string; bytes?: Uint8Array }> = []

/** The bytes that actually went out — the assertion the conversion/compression paths lacked. */
function uploadedBytes(call: number = 0): Uint8Array | undefined {
	return uploadedPayloads[call]?.bytes
}

function collision(overrides?: Partial<CollisionParams> & { iteration: number }): string | null {
	return modifyAssetPathOnCollision({
		iteration: 0,
		path: "/camera roll/img_0001.jpg",
		asset: {
			name: "IMG_0001.jpg",
			contentHash: "abc123hash"
		},
		...overrides
	})
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
	vi.clearAllMocks()
	ml.clear()
	fs.clear()
	cameraUploadState.hashes.clear()
	cameraUploadState.aborts.clear()
	// Leaks across tests otherwise: a test that repoints the destination leaves it recorded, and the
	// next test's unchanged config then reads as a change and wipes its shield.
	;(cameraUploadState as unknown as { destination: { current: string | null } }).destination.current = null
	cameraUpload.cancel()
	// The parent-directory cache lives on the singleton and survives cancel(),
	// so clear it explicitly between tests to avoid stale dir refs from earlier
	// tests masking createDir call assertions. Same for the in-flight dedupe map
	// (its entries self-remove on settle, but clear defensively).
	;(cameraUpload as any).ensureParentDirectoryExistsCache.clear()
	;(cameraUpload as any).ensureParentDirectoryExistsInFlight.clear()
	setupDefaultMocks()
})

// BG-05: cameraUpload.sync() coalesces back-to-back AUTO triggers within AUTO_SYNC_MIN_INTERVAL_MS.
// Tests that drive several passes in one test model SEPARATE trigger occasions (a retry on a later
// reconnect/foreground, ≥60s apart), so they clear the min-interval stamp before each subsequent pass.
function resetSyncInterval(): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	;(cameraUpload as any).lastCompletedAt = 0
}

// ─── modifyAssetPathOnCollision ──────────────────────────────────────────────

describe("modifyAssetPathOnCollision", () => {
	describe("iteration 0 — contentHash suffix", () => {
		it("appends contentHash to the basename", () => {
			expect(collision({ iteration: 0 })).toBe("/camera roll/img_0001_abc123hash.jpg")
		})

		it("produces different paths for different contentHashes", () => {
			const a = collision({ iteration: 0, asset: { name: "IMG_0001.jpg", contentHash: "hash-a" } })
			const b = collision({ iteration: 0, asset: { name: "IMG_0001.jpg", contentHash: "hash-b" } })

			expect(a).not.toBe(b)
		})
	})

	describe("iteration 1 — hash of name + contentHash", () => {
		it("returns a valid path with a hex hash suffix", () => {
			expect(collision({ iteration: 1 })).toMatch(/^\/camera roll\/img_0001_[0-9a-f]+\.jpg$/)
		})

		it("produces different paths for different contentHashes", () => {
			const a = collision({ iteration: 1, asset: { name: "IMG_0001.jpg", contentHash: "hash-a" } })
			const b = collision({ iteration: 1, asset: { name: "IMG_0001.jpg", contentHash: "hash-b" } })

			expect(a).not.toBe(b)
		})

		it("produces different paths for different filenames with same contentHash", () => {
			const a = modifyAssetPathOnCollision({
				iteration: 1,
				path: "/album/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: "same-hash" }
			})

			const b = modifyAssetPathOnCollision({
				iteration: 1,
				path: "/album/img_0002.jpg",
				asset: { name: "IMG_0002.jpg", contentHash: "same-hash" }
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
		it("returns null when input has no parent directory", () => {
			// #E2: the parent is extracted with plain string ops — a bare filename can
			// never be a valid tree key (keys are always "/<album>/<name>"), so this is
			// deterministically null (matching production posix dirname semantics, which
			// the old mock-dependent fallback masked).
			expect(
				modifyAssetPathOnCollision({
					iteration: 0,
					path: "IMG_0001.jpg",
					asset: { name: "IMG_0001.jpg", contentHash: "hash1" }
				})
			).toBeNull()
		})

		it("returns null when path is empty", () => {
			expect(
				modifyAssetPathOnCollision({
					iteration: 0,
					path: "",
					asset: { name: "IMG_0001.jpg", contentHash: "hash1" }
				})
			).toBeNull()
		})

		it("returns null when basename is '.'", () => {
			expect(
				modifyAssetPathOnCollision({
					iteration: 0,
					path: "/camera roll/.",
					asset: { name: ".", contentHash: "hash1" }
				})
			).toBeNull()
		})
	})

	describe("determinism", () => {
		it("produces the same result for the same inputs across all iterations", () => {
			const params: Omit<CollisionParams, "iteration"> = {
				path: "/album/photo.png",
				asset: { name: "photo.png", contentHash: "hash1" }
			}

			for (let i = 0; i < 2; i++) {
				expect(modifyAssetPathOnCollision({ ...params, iteration: i })).toBe(
					modifyAssetPathOnCollision({ ...params, iteration: i })
				)
			}
		})
	})

	describe("cross-tree consistency", () => {
		it("produces identical paths for local and remote trees with the same contentHash", () => {
			const asset = { name: "IMG_0001.jpg", contentHash: "stable-md5-or-timestamp" }

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
				asset: { name: "IMG_0001.JPG", contentHash: "SomeUpperHash" }
			})

			expect(result).toBe(result?.toLowerCase())
		})

		it("preserves file extension from asset name", () => {
			const result = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/album/video.mov",
				asset: { name: "video.MOV", contentHash: "hash1" }
			})

			expect(result).toMatch(/\.mov$/)
		})
	})
})

describe("iteration uniqueness", () => {
	it("produces distinct paths for iteration 0 vs iteration 1", () => {
		const asset = { name: "IMG_0001.jpg", contentHash: "hash-abc" }
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
		const asset = { name: "IMG_0001.jpg", contentHash: "hash-a" }
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
		const asset2 = { name: "IMG_0001.jpg", contentHash: "hash-b" }

		while (tree[path2]) {
			path2 = modifyAssetPathOnCollision({ iteration: iteration2, path: path2, asset: asset2 }) ?? ""

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
		const asset = { name: "IMG_0001.jpg", contentHash: "hash-a" }
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

	// The md5 moved off the JS thread (expo's File.md5 is a synchronous whole-file read) onto a
	// native streaming hasher. These pin the argument shape, which is where that swap can go wrong
	// in a way no simulator run would reveal.
	describe("asset hashing", () => {
		it("passes an encoded file:// uri, not a bare path", async () => {
			// Not cosmetic. Handed a BARE path the iOS native takes its fallback branch and applies
			// `removingPercentEncoding` — a second decode on top of ours. A `file://` uri takes
			// `URL(string:).path` instead, which decodes exactly once, as does Android's
			// `Uri.getPath()`. The previous hasher decoded on neither platform, so the bare path that
			// was correct for it is a permanent-failure bug for this one.
			setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

			await cameraUpload.sync()

			expect(mockFileHash).toHaveBeenCalledWith("file:///media/a1", expect.objectContaining({ algorithm: "MD5" }))
		})

		it("hashes an asset whose real filename contains a literal percent escape", async () => {
			// The regression the encoded uri prevents: a file genuinely NAMED "holiday%20photo.jpg"
			// double-decodes to "holiday photo.jpg" under a bare path, ENOENTs on every pass, and the
			// asset is skipped for good after MAX_UPLOAD_FAILURES. The mock reproduces that trap, so
			// this fails if the call site ever goes back to a bare path.
			const uri = "file:///media/holiday%2520photo.jpg"

			ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["a1"] })
			ml.addAsset({
				id: "a1",
				filename: "holiday%20photo.jpg",
				uri,
				mediaType: MediaType.IMAGE,
				creationTime: 1000,
				modificationTime: 2000
			})

			fs.set(uri, new Uint8Array([1, 2, 3]))

			await cameraUpload.sync()

			expect(transfers.upload).toHaveBeenCalledTimes(1)
			expect(mockSetErrors).not.toHaveBeenCalled()
		})

		it("hashes an asset whose name needs encoding", async () => {
			const uri = "file:///media/holiday%20photo.jpg"

			ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["a1"] })
			ml.addAsset({
				id: "a1",
				filename: "holiday photo.jpg",
				uri,
				mediaType: MediaType.IMAGE,
				creationTime: 1000,
				modificationTime: 2000
			})

			fs.set(uri, new Uint8Array([1, 2, 3]))

			await cameraUpload.sync()

			expect(transfers.upload).toHaveBeenCalledTimes(1)
			expect(mockSetErrors).not.toHaveBeenCalled()
		})

		it("stores the returned hash verbatim, so existing ledger entries keep shielding", async () => {
			// Every implementation this has passed through emits lowercase hex, so a value written by
			// an older one must still match what the current one returns — otherwise every asset
			// re-uploads once on update. This is why the swap kept MD5 rather than moving the ledger
			// to BLAKE3.
			setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

			mockFileHash.mockResolvedValueOnce("9e107d9d372bb6826bd81d3542a419d6")

			await cameraUpload.sync()

			expect(cameraUploadState.hashes.get("a1")).toMatchObject({
				md5: "9e107d9d372bb6826bd81d3542a419d6"
			})
		})

		it("hands the pass's abort signal to the hasher", async () => {
			// blob-util could not be cancelled: aborting a sync still waited out a multi-gigabyte
			// video mid-hash before anything noticed.
			setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

			await cameraUpload.sync()

			const request = mockFileHash.mock.calls[0]?.[1]

			expect(request?.signal).toBeDefined()

			// Presence alone passes for any unrelated AbortController. What matters is that cancelling
			// the pass aborts THIS signal.
			cameraUpload.cancel()

			expect(request?.signal?.aborted).toBe(true)
		})
	})

	/**
	 * Content that already exists remotely cancels the upload outright — but only in the folder it is
	 * being uploaded TO. The metadata hash is optional (nothing uploaded before the Rust SDK carries
	 * one), so every case here also has to hold when it is absent.
	 */
	describe("remote content dedup", () => {
		// Fixture assets are seeded with 3 bytes, so a remote candidate has to declare the same size to
		// survive the prefilter — matching production, where the SDK records size and hash over the
		// same plaintext stream.
		function setupRemote(files: Array<{ path: string; uuid: string; hash?: ArrayBuffer; size?: number }>) {
			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					listDirRecursiveWithPaths: vi.fn(async () => ({
						files: files.map(file => ({
							path: file.path,
							file: { uuid: file.uuid }
						}))
					})),
					createDir: vi.fn(async () => ({ uuid: "dir" })),
					getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
				}
			} as any)

			const byUuid = new Map(files.map(file => [file.uuid, file]))

			vi.mocked(unwrapFileMeta).mockImplementation((file: any) => {
				const remote = byUuid.get(file?.uuid)

				return {
					meta: remote
						? {
								name: remote.path.slice(remote.path.lastIndexOf("/") + 1),
								created: 1000n,
								modified: 2000n,
								size: BigInt(remote.size ?? 3),
								hash: remote.hash
							}
						: null
				} as any
			})
		}

		it("skips the upload when the same content already sits in the destination folder", async () => {
			// A rename, or a dedup-suffix change, leaves the content backed up under a name the tree
			// diff cannot match — so the path diff produces a delta and only the hash can tell that the
			// bytes are already there.
			setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])
			setupRemote([{ path: "/Camera Roll/renamed.jpg", uuid: "remote-1", hash: blake3BytesForContent("mock-md5") }])

			await cameraUpload.sync()

			expect(transfers.upload).not.toHaveBeenCalled()
		})

		it("records the shield entry it would have written, so the next pass never re-hashes", async () => {
			// Skipping without recording would re-hash this asset on every single pass forever.
			setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])
			setupRemote([{ path: "/Camera Roll/renamed.jpg", uuid: "remote-1", hash: blake3BytesForContent("mock-md5") }])

			await cameraUpload.sync()

			// `paths` is asserted explicitly: an entry recorded with the wrong path (or none) satisfies
			// toMatchObject yet fails shieldCoversModification on every later pass — the eternal re-hash
			// this test is named for.
			expect(cameraUploadState.hashes.get("a1")).toMatchObject({
				md5: "mock-md5",
				verifiedModificationTime: 2000,
				paths: ["/camera roll/photo.jpg"]
			})
		})

		it("still uploads to a folder without the content when another folder has it", async () => {
			// One asset can belong to several selected albums and must reach EVERY album folder. A
			// match scoped to the whole account instead of the destination directory would silently
			// leave the second album missing the photo.
			setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])
			setupRemote([{ path: "/Other Album/photo.jpg", uuid: "remote-1", hash: blake3BytesForContent("mock-md5") }])

			await cameraUpload.sync()

			expect(transfers.upload).toHaveBeenCalled()
		})

		it("uploads when the remote file predates metadata hashes", async () => {
			// Anything uploaded before the SDK recorded hashes carries none. Absent must mean "cannot
			// tell", never "no match" — the only safe direction, since the alternative silently drops
			// a backup.
			setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])
			setupRemote([{ path: "/Camera Roll/renamed.jpg", uuid: "remote-1" }])

			await cameraUpload.sync()

			expect(transfers.upload).toHaveBeenCalled()
		})

		it("uploads when the remote content differs", async () => {
			setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])
			setupRemote([{ path: "/Camera Roll/renamed.jpg", uuid: "remote-1", hash: blake3BytesForContent("some-other-content") }])

			await cameraUpload.sync()

			expect(transfers.upload).toHaveBeenCalled()
		})

		it("hashes nothing at all when the mtime shield answers the delta", async () => {
			// The load-bearing perf property: hashing stays LAZY. A steady-state pass must not read a
			// single file, which also means it never builds the remote hash index.
			setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])
			setupRemote([{ path: "/Camera Roll/renamed.jpg", uuid: "remote-1", hash: blake3BytesForContent("mock-md5") }])

			cameraUploadState.hashes.set("a1", {
				md5: "mock-md5",
				verifiedModificationTime: 2000
			})

			await cameraUpload.sync()

			expect(mockFileHash).not.toHaveBeenCalled()
		})

		it("computes one MD5 and one BLAKE3 when the destination holds content of the same size", async () => {
			// BLAKE3 is additive, not a second pass: it is paid once, on the branch that was about to
			// push the whole file over the network anyway — and only when a match is possible.
			setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])
			setupRemote([{ path: "/Camera Roll/other.jpg", uuid: "remote-1", hash: blake3BytesForContent("different") }])

			await cameraUpload.sync()

			expect(mockFileHash.mock.calls.map(call => call[1]?.algorithm)).toEqual(["MD5", "BLAKE3"])
		})

		it("does not hash BLAKE3 at all when nothing in the destination has the same size", async () => {
			// Equal hashes imply equal length, so a destination with no candidate of this size cannot
			// produce a match — reading the whole file to learn that is pure waste. This is the entire
			// cost of a first sync, where the destination is empty.
			setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])
			setupRemote([{ path: "/Camera Roll/other.jpg", uuid: "remote-1", hash: blake3BytesForContent("different"), size: 999 }])

			await cameraUpload.sync()

			expect(mockFileHash.mock.calls.map(call => call[1]?.algorithm)).toEqual(["MD5"])
		})

		it("uploads anyway when the content check's own hash fails", async () => {
			// The check is an optimisation, so its failure has to fall through to the upload. BLAKE3 runs
			// through a different native path than MD5, so an engine-specific read failure would
			// otherwise error this asset on every pass instead of merely skipping a shortcut.
			setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])
			setupRemote([{ path: "/Camera Roll/other.jpg", uuid: "remote-1", hash: blake3BytesForContent("different") }])

			mockFileHash.mockImplementation(async (_path: string, request?: { algorithm?: string }) => {
				if (request?.algorithm === "BLAKE3") {
					throw new Error("E_IO: engine failure")
				}

				return "mock-md5"
			})

			await cameraUpload.sync()

			expect(transfers.upload).toHaveBeenCalledTimes(1)
			expect(mockSetErrors).not.toHaveBeenCalled()
		})

		it("does not hash BLAKE3 when the destination is empty", async () => {
			setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])
			setupRemote([])

			await cameraUpload.sync()

			expect(mockFileHash.mock.calls.map(call => call[1]?.algorithm)).toEqual(["MD5"])
		})

		it("does not hash for content the md5 shield already cleared", async () => {
			// Unchanged content (an iOS view-touched mtime bump) stops at the md5 comparison — the
			// upload is not happening, so there is nothing for BLAKE3 to cancel.
			//
			// The destination deliberately holds a same-size, hash-bearing candidate: with an EMPTY one
			// the size prefilter skips BLAKE3 anyway and this passes whether or not the md5 branch
			// short-circuits, which is what it is here to prove.
			setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])
			setupRemote([{ path: "/Camera Roll/other.jpg", uuid: "remote-1", hash: blake3BytesForContent("different") }])

			cameraUploadState.hashes.set("a1", {
				md5: "mock-md5",
				verifiedModificationTime: 1
			})

			await cameraUpload.sync()

			expect(mockFileHash.mock.calls.map(call => call[1]?.algorithm)).toEqual(["MD5"])
			expect(transfers.upload).not.toHaveBeenCalled()
		})
	})

	/**
	 * With a transform enabled the bytes that go to the server are NOT the asset's bytes, so the
	 * content check has to hash the transformed payload. Both directions matter, and the second is the
	 * one that loses data.
	 */
	describe("remote content dedup with a transform enabled", () => {
		let md5Spy: { mockRestore: () => void } | null = null

		afterEach(() => {
			md5Spy?.mockRestore()
			md5Spy = null
		})

		function setupTransformed(remoteHashSeed: string, remoteSize: bigint) {
			// Content-derived digests: the shared mock returns one constant for every file, which cannot
			// tell the asset's bytes from the compressed output.
			md5Spy = vi.spyOn(File.prototype, "md5", "get").mockImplementation(function (this: { uri: string }) {
				const entry = fs.get(this.uri)

				return entry instanceof Uint8Array ? `md5-${entry.join("-")}` : null
			}) as unknown as { mockRestore: () => void }

			setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

			vi.mocked(secureStore.get).mockResolvedValue({ ...ENABLED_CONFIG, compress: true } as any)

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					listDirRecursiveWithPaths: vi.fn(async () => ({
						files: [{ path: "/Camera Roll/other.jpg", file: { uuid: "remote-1" } }]
					})),
					createDir: vi.fn(async () => ({ uuid: "dir" })),
					getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
				}
			} as any)

			vi.mocked(unwrapFileMeta).mockReturnValue({
				meta: {
					name: "other.jpg",
					created: 1000n,
					modified: 2000n,
					size: remoteSize,
					hash: blake3BytesForContent(remoteHashSeed)
				}
			} as any)
		}

		it("cancels the upload when the TRANSFORMED bytes are already in the destination", async () => {
			// The compressed output is what the previous upload stored, so that is what has to match.
			// The compressed payload: 2 bytes, matching what the previous upload would have stored.
			setupTransformed("md5-9-9", 2n)

			await cameraUpload.sync()

			expect(transfers.upload).not.toHaveBeenCalled()
		})

		it("still uploads when only the ORIGINAL bytes match, because those are not what gets sent", async () => {
			// The data-loss direction. Hashing the asset instead of the payload would cancel this
			// upload on the strength of content that matches the file on disk — while the COMPRESSED
			// bytes, the ones the server would have received, were never stored anywhere.
			// The asset's own bytes and size — what a check pointed at the wrong file would match.
			setupTransformed("md5-1-2-3", 3n)

			await cameraUpload.sync()

			expect(transfers.upload).toHaveBeenCalledTimes(1)
			expect(uploadedBytes()).toEqual(new Uint8Array([9, 9]))
		})
	})

	/**
	 * A viewed photo bumps PHAsset.modificationDate on iOS, and the new time is never written back to
	 * the remote file — so without a gate the asset re-enters the delta set on every pass forever.
	 * These cover the gate AND the cases it must not touch.
	 */
	describe("view-touched assets", () => {
		function setupViewTouched({ verified }: { verified: number | null }) {
			// Local mtime 9999 (just viewed) against a remote uploaded at 2000: permanently local-newer.
			setupLocalAssets([{ id: "a1", filename: "photo.jpg", creationTime: 1000, modificationTime: 9999 }])

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					listDirRecursiveWithPaths: vi.fn(async () => ({
						files: [{ path: "/Camera Roll/photo.jpg", file: { uuid: "remote-1" } }]
					})),
					createDir: vi.fn(async () => ({ uuid: "dir" })),
					getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
				}
			} as any)

			vi.mocked(unwrapFileMeta).mockReturnValue({ meta: { name: "photo.jpg", created: 1000n, modified: 2000n } } as any)

			if (verified !== null) {
				cameraUploadState.hashes.set("a1", {
					md5: "mock-md5",
					verifiedModificationTime: verified
				})
			}
		}

		it("performs no work at all for a photo whose modification time is already verified", async () => {
			// End-to-end property: no getUri (which re-downloads iCloud-offloaded originals) and no
			// hash, on every pass for the rest of that photo's life.
			//
			// Note this holds with or WITHOUT the delta gate — the upload gate alone produces the same
			// outcome, which is why it survives removing the gate. What the gate changes that is
			// externally visible is the bounded background pick; the budget test below is the one that
			// pins it.
			setupViewTouched({ verified: 9999 })

			await cameraUpload.sync()

			expect(mockFileHash).not.toHaveBeenCalled()
			expect(transfers.upload).not.toHaveBeenCalled()
		})

		it("still reads the asset when the modification time is one the shield has not verified", async () => {
			// A genuine edit moves the mtime too, so an unverified time must reach the content check
			// rather than being suppressed. It does NOT upload here: the content is unchanged, so the
			// md5 comparison clears it one step later — the correct outcome, and the reason this asserts
			// hashing rather than uploading.
			setupViewTouched({ verified: 5000 })

			await cameraUpload.sync()

			expect(mockFileHash).toHaveBeenCalled()
			expect(transfers.upload).not.toHaveBeenCalled()
			expect(cameraUploadState.hashes.get("a1")).toMatchObject({ verifiedModificationTime: 9999 })
		})

		it("uploads when there is no shield entry at all", async () => {
			setupViewTouched({ verified: null })

			await cameraUpload.sync()

			expect(mockFileHash).toHaveBeenCalled()
			expect(transfers.upload).toHaveBeenCalledTimes(1)
		})

		it("never suppresses a delta for a file missing from the remote listing", async () => {
			// THE no-regression case. A remotely-deleted photo is shielded on purpose at the UPLOAD
			// gate; mirror mode is the opt-out, and it works by dropping the shield entry so the
			// already-produced delta re-uploads. If the delta gate reached this branch there would be
			// no delta left for it to act on.
			//
			// Mirror mode is what makes this discriminating: WITHOUT it, the delta gate and the upload
			// gate produce the same observable outcome (no upload either way, since the upload gate
			// skips before getUri), so the test would pass under the regression it is named for.
			setupLocalAssets([{ id: "a1", filename: "photo.jpg", creationTime: 1000, modificationTime: 9999 }])

			vi.mocked(secureStore.get).mockImplementation(async (key: string) =>
				key === CAMERA_UPLOAD_REUPLOAD_DELETED_SECURE_STORE_KEY ? (true as any) : (ENABLED_CONFIG as any)
			)

			cameraUploadState.hashes.set("a1", {
				md5: "mock-md5",
				verifiedModificationTime: 9999
			})

			// Remote listing is EMPTY — nothing at the asset's tree path.
			await cameraUpload.sync()

			expect(transfers.upload).toHaveBeenCalledTimes(1)
		})

		it("does not suppress the delta for an album the entry does not cover", async () => {
			// One asset in two selected albums has ONE entry and two destinations. Suppressing on a
			// match for the first would leave the second album permanently missing the photo.
			setupLocalAssets([{ id: "a1", filename: "photo.jpg", creationTime: 1000, modificationTime: 9999 }])
			ml.addAlbum({ id: "album-2", title: "Second", assetIds: ["a1"] })

			vi.mocked(secureStore.get).mockResolvedValue({ ...ENABLED_CONFIG, albumIds: ["album-1", "album-2"] } as any)

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					listDirRecursiveWithPaths: vi.fn(async () => ({
						files: [
							{ path: "/Camera Roll/photo.jpg", file: { uuid: "remote-1" } },
							{ path: "/Second/photo.jpg", file: { uuid: "remote-2" } }
						]
					})),
					createDir: vi.fn(async () => ({ uuid: "dir" })),
					getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
				}
			} as any)

			vi.mocked(unwrapFileMeta).mockReturnValue({ meta: { name: "photo.jpg", created: 1000n, modified: 2000n } } as any)

			// Verified for the first album only.
			cameraUploadState.hashes.set("a1", {
				md5: "mock-md5",
				verifiedModificationTime: 9999,
				paths: ["/camera roll/photo.jpg"]
			})

			await cameraUpload.sync()

			// The uncovered album still gets its delta, so the asset is still processed.
			expect(mockFileHash).toHaveBeenCalled()
		})

		it("does not let view-touched assets consume a background run's upload budget", async () => {
			// The reason this gate is a correctness fix and not just an optimisation. A background pass
			// sorts deltas by modificationTime DESCENDING and slices to maxUploads, and a just-viewed
			// photo carries the newest mtime of all — so phantoms sort to the FRONT, take every slot,
			// then get skipped, and the real backlog makes zero progress run after run.
			setupLocalAssets([
				{ id: "viewed", filename: "viewed.jpg", creationTime: 1000, modificationTime: 9999 },
				{ id: "new1", filename: "new1.jpg", creationTime: 1000, modificationTime: 3000 },
				{ id: "new2", filename: "new2.jpg", creationTime: 1000, modificationTime: 2500 }
			])

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					listDirRecursiveWithPaths: vi.fn(async () => ({
						files: [{ path: "/Camera Roll/viewed.jpg", file: { uuid: "remote-1" } }]
					})),
					createDir: vi.fn(async () => ({ uuid: "dir" })),
					getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
				}
			} as any)

			vi.mocked(unwrapFileMeta).mockReturnValue({ meta: { name: "viewed.jpg", created: 1000n, modified: 2000n } } as any)

			cameraUploadState.hashes.set("viewed", {
				md5: "mock-md5",
				verifiedModificationTime: 9999
			})

			// One slot. The viewed photo would win the sort; the backlog must get it instead.
			await cameraUpload.sync({ background: true, maxUploads: 1 })

			expect(transfers.upload).toHaveBeenCalledTimes(1)
			expect(vi.mocked(transfers.upload).mock.calls[0]?.[0]?.name).toBe("new1.jpg")
		})
	})

	/**
	 * A shield entry means "this content is already at its destination", but the tree paths it carries
	 * are relative to the camera-upload root — so they keep matching after the user repoints camera
	 * upload, and a brand new empty folder reads as "everything was deleted remotely", which is
	 * deliberately not re-uploaded. Pairing the shield with the destination it was built against is
	 * what makes those two situations distinguishable.
	 */
	describe("remote destination changes", () => {
		function shieldedAsset() {
			setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

			cameraUploadState.hashes.set("a1", {
				md5: "mock-md5",
				verifiedModificationTime: 2000,
				paths: ["/camera roll/photo.jpg"]
			})
		}

		it("re-uploads the library when the backup folder changed", async () => {
			// Without this the sync completes successfully while the new folder stays empty — the worst
			// shape for a backup app, because nothing looks wrong.
			shieldedAsset()

			await cameraUpload.sync({ manual: true })

			expect(transfers.upload).not.toHaveBeenCalled()

			vi.mocked(secureStore.get).mockResolvedValue({
				...ENABLED_CONFIG,
				remoteDir: { inner: [{ uuid: "a-different-folder" }] }
			} as any)

			await cameraUpload.sync({ manual: true })

			expect(transfers.upload).toHaveBeenCalled()
		})

		it("drops the shield entries rather than working around them", async () => {
			shieldedAsset()

			await cameraUpload.sync({ manual: true })

			vi.mocked(secureStore.get).mockResolvedValue({
				...ENABLED_CONFIG,
				remoteDir: { inner: [{ uuid: "a-different-folder" }] }
			} as any)

			await cameraUpload.sync({ manual: true })

			// The entry alone proves nothing here — it is content-identical before and after, so it is
			// present whether or not the wipe happened. The wipe itself is the claim.
			expect(vi.mocked(cameraUploadState.clearHashes)).toHaveBeenCalled()

			// Re-verified against the NEW destination, so the entry is rewritten rather than absent.
			expect(cameraUploadState.hashes.get("a1")).toBeDefined()
		})

		it("adopts the destination without clearing when none was ever recorded", async () => {
			// THE upgrade guard. Every existing install has a populated shield and no recorded
			// destination; treating "unknown" as "changed" would re-upload every user's entire library
			// the first time they open the updated app.
			shieldedAsset()

			await cameraUpload.sync({ manual: true })

			expect(transfers.upload).not.toHaveBeenCalled()
			expect(cameraUploadState.hashes.get("a1")).toBeDefined()
			expect(vi.mocked(cameraUploadState.clearHashes)).not.toHaveBeenCalled()

			// Adopted, so the NEXT pass compares against it rather than adopting again.
			expect((cameraUploadState as unknown as { destination: { current: string | null } }).destination.current).toBe("remote-uuid")
		})

		it("does not re-upload when the destination is unchanged across passes", async () => {
			shieldedAsset()

			await cameraUpload.sync({ manual: true })
			await cameraUpload.sync({ manual: true })
			await cameraUpload.sync({ manual: true })

			expect(transfers.upload).not.toHaveBeenCalled()
		})

		it("detects the change on a background pass too", async () => {
			// The first fire after a change may well be a background one; uploading against a shield
			// built for somewhere else would silently skip the new folder until a foreground sync.
			//
			// The prior destination is seeded rather than produced by a foreground sync: a completed
			// foreground pass arms the auto-sync throttle, and a background pass is not `manual`, so it
			// would bail before reaching any of this.
			shieldedAsset()
			;(cameraUploadState as unknown as { destination: { current: string | null } }).destination.current = "remote-uuid"

			vi.mocked(secureStore.get).mockResolvedValue({
				...ENABLED_CONFIG,
				remoteDir: { inner: [{ uuid: "a-different-folder" }] }
			} as any)

			await cameraUpload.sync({ background: true, maxUploads: 3 })

			expect(transfers.upload).toHaveBeenCalled()
		})

		it("does not record the new destination when the wipe failed", async () => {
			// Order matters only on failure: remembering a clear that never happened would leave a
			// shield built for the OLD folder in place forever, and no later pass would retry.
			shieldedAsset()
			;(cameraUploadState as unknown as { destination: { current: string | null } }).destination.current = "remote-uuid"

			vi.mocked(secureStore.get).mockResolvedValue({
				...ENABLED_CONFIG,
				remoteDir: { inner: [{ uuid: "a-different-folder" }] }
			} as any)

			vi.mocked(cameraUploadState.clearHashes).mockRejectedValueOnce(new Error("kv unavailable"))

			await cameraUpload.sync({ manual: true })

			expect(transfers.upload).not.toHaveBeenCalled()

			// The next pass still sees a change and retries the wipe, so the library reaches the new
			// folder rather than being stranded by one transient failure.
			await cameraUpload.sync({ manual: true })

			expect(transfers.upload).toHaveBeenCalled()
		})

		it("does not clear the shield when the destination is unusable", async () => {
			// A deleted or trashed folder must not be mistaken for a change of folder — the
			// existence gate runs first precisely so a server-side deletion cannot wipe the shield.
			shieldedAsset()

			await cameraUpload.sync({ manual: true })

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					listDirRecursiveWithPaths: vi.fn(async () => ({ files: [] })),
					createDir: vi.fn(async () => ({ uuid: "dir" })),
					// Undefined = the directory is gone.
					getDirOptional: vi.fn(async () => undefined)
				}
			} as any)

			vi.mocked(secureStore.get).mockResolvedValue({
				...ENABLED_CONFIG,
				remoteDir: { inner: [{ uuid: "a-different-folder" }], tag: "Normal" }
			} as any)

			await cameraUpload.sync({ manual: true })

			expect(cameraUploadState.hashes.get("a1")).toBeDefined()
			expect(transfers.upload).not.toHaveBeenCalled()
		})
	})

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
				createDir: vi.fn(async () => ({ uuid: "dir" })),
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
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
				createDir: vi.fn(async () => ({ uuid: "dir" })),
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
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
		// Tighten: verify the updater function actually appends an Error to the list
		const updater = vi.mocked(mockSetErrors).mock.calls[0]?.[0] as (prev: unknown[]) => unknown[]
		const result = updater([])
		expect(result).toHaveLength(1)
		expect((result[0] as any).error).toBeInstanceOf(Error)
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

	it("passes background: false to transfers.upload on a foreground sync", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg", creationTime: 1000, modificationTime: 2000 }])

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledWith(expect.objectContaining({ background: false }))
	})

	it("passes background: true to transfers.upload on a background sync", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg", creationTime: 1000, modificationTime: 2000 }])

		await cameraUpload.sync({ background: true })

		expect(transfers.upload).toHaveBeenCalledWith(expect.objectContaining({ background: true }))
	})

	// ─── Audit B4 (2026-06-11): persisted background-abort counter ────────────────
	// A budget/expiration abort never reaches the in-memory failure counter (cancel()
	// clears it, and each background run may be a fresh process) — without persistence,
	// an asset that can never finish inside the OS window is re-picked every run forever.

	it("B4: a background run skips an asset with >= 2 persisted budget-aborts and picks the next delta", async () => {
		setupLocalAssets([
			{ id: "a1", filename: "photo1.jpg", modificationTime: 5000 },
			{ id: "a2", filename: "photo2.jpg", modificationTime: 4000 }
		])

		// a1 is newest (would win the maxUploads sort) but burned the budget twice already.
		cameraUploadState.aborts.set("a1", 2)

		await cameraUpload.sync({ background: true, maxUploads: 1 })

		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(transfers.upload).toHaveBeenCalledWith(expect.objectContaining({ name: "photo2.jpg" }))
	})

	it("B4: a deadline abort during a background upload increments the persisted counter (null-return abort surface)", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		vi.mocked(transfers.upload).mockImplementationOnce(async () => {
			// The run-budget deadline fires cancelBackgroundWork() -> cameraUpload.cancel()
			// while the upload is in flight; the aborted upload resolves null.
			cameraUpload.cancel()

			return null as any
		})

		await cameraUpload.sync({ background: true, maxUploads: 1 })

		expect(cameraUploadState.aborts.get("a1")).toBe(1)
	})

	it("B4: a thrown abort during a background upload increments the persisted counter (throw abort surface)", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		vi.mocked(transfers.upload).mockImplementationOnce(async () => {
			cameraUpload.cancel()

			throw new Error("aborted mid-staging")
		})

		await cameraUpload.sync({ background: true, maxUploads: 1 })

		expect(cameraUploadState.aborts.get("a1")).toBe(1)
	})

	it("B4: a foreground abort never touches the persisted counter", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		vi.mocked(transfers.upload).mockImplementationOnce(async () => {
			cameraUpload.cancel()

			return null as any
		})

		await cameraUpload.sync()

		expect(cameraUploadState.aborts.get("a1")).toBeUndefined()
	})

	it("B4: a successful upload clears the asset's persisted counter", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		cameraUploadState.aborts.set("a1", 1)

		await cameraUpload.sync()

		expect(cameraUploadState.aborts.get("a1")).toBeUndefined()
	})

	// ─── Audit B5 (2026-06-11): foreground pause must not bleed into background ───
	// sync() captures the live globalPauseSignal; a pause left armed in the foreground
	// would park the background upload until the deadline — a whole OS window wasted,
	// reported as Success. Respect the user's pause: skip the run, don't auto-resume.

	it("B5: a background sync is skipped (before any work starts) while the global pause signal is paused", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		cameraUpload.pause()

		await cameraUpload.sync({ background: true, maxUploads: 1 })

		expect(transfers.upload).not.toHaveBeenCalled()
		expect(mockSetSyncing).not.toHaveBeenCalled()
	})

	it("B5: resume() re-enables background sync", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		cameraUpload.pause()
		cameraUpload.resume()

		await cameraUpload.sync({ background: true, maxUploads: 1 })

		expect(transfers.upload).toHaveBeenCalledTimes(1)
	})

	it("upload returns null (abort) does not update MD5 cache", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		vi.mocked(transfers.upload).mockResolvedValueOnce(null)

		await cameraUpload.sync()

		expect(cameraUploadState.hashes.size).toBe(0)
	})
})

// ─── Destination-existence gate ──────────────────────────────────────────────
// Before any listing/uploading, sync() resolves the configured remote dir via getDirOptional.
// A DEFINITIVE deleted (undefined) or trashed (Trash-parented Dir) verdict exits silently — no
// setSyncing(true), no upload. A TRANSIENT lookup failure must NOT bail (the normal pipeline
// already tolerates a degraded remote listing). The account root never needs the lookup.

describe("destination-existence gate", () => {
	function setupOneLocalAsset(): void {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["a1"] })

		const uri = "file:///media/a1"

		ml.addAsset({
			id: "a1",
			filename: "photo.jpg",
			uri,
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})

		fs.set(uri, new Uint8Array([1, 2, 3]))
	}

	// Replace the SDK client while keeping an empty remote listing (so the one local asset is a
	// delta) and a configurable getDirOptional implementation for the gate.
	function installClient(getDirOptional: ReturnType<typeof vi.fn>): void {
		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({ files: [] })),
				createDir: vi.fn(async () => ({ uuid: "created-dir" })),
				getDirOptional
			}
		} as any)
	}

	it("exits silently when the destination was deleted (getDirOptional → undefined)", async () => {
		setupOneLocalAsset()
		installClient(vi.fn(async () => undefined))

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
		expect(mockSetSyncing).not.toHaveBeenCalled()
	})

	it("exits silently when the destination is trashed (getDirOptional → Dir with parent Trash)", async () => {
		setupOneLocalAsset()
		installClient(vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Trash" } })))

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
		expect(mockSetSyncing).not.toHaveBeenCalled()
	})

	it("proceeds when the destination is usable (getDirOptional → Dir with a Uuid parent)", async () => {
		setupOneLocalAsset()
		installClient(vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } })))

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
	})

	it("proceeds (does not bail) when getDirOptional fails transiently", async () => {
		setupOneLocalAsset()
		installClient(vi.fn(async () => Promise.reject(new Error("network"))))

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
	})

	it("does not call getDirOptional for a Root destination (it can never be deleted/trashed)", async () => {
		setupOneLocalAsset()

		const getDirOptional = vi.fn(async () => undefined)

		installClient(getDirOptional)
		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			remoteDir: { tag: "Root", inner: [{ uuid: "root-uuid" }] } as any
		})

		await cameraUpload.sync()

		expect(getDirOptional).not.toHaveBeenCalled()
		expect(transfers.upload).toHaveBeenCalledTimes(1)
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

describe("same-title album naming (merge scheme)", () => {
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
				createDir,
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
			}
		} as any)

		return createDir
	}

	it("two albums with identical titles MERGE into one shared remote folder (no id suffix)", async () => {
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

		// Both albums' (distinctly-named) assets land in the single "Screenshots" folder,
		// matching the legacy app — no "(album-id)" suffix, one unique folder name.
		expect(transfers.upload).toHaveBeenCalledTimes(2)

		const createdDirNames = new Set(createDir.mock.calls.map(call => call[1] as string))

		expect(createdDirNames).toEqual(new Set(["Screenshots"]))
	})

	it("the album id is never part of the folder name (no id-based disambiguation)", async () => {
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

		for (const call of createDir.mock.calls) {
			const name = call[1] as string

			expect(name).toBe("Screenshots")
			expect(name).not.toMatch(/album-[ab]/)
		}
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

	it("same filename across two merged same-title albums: one folder, per-file collision keeps both", async () => {
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

		// Albums merge into one "Vacation" folder; the two identically-named files are
		// kept apart by the per-file collision suffix, so neither is lost (only 4+
		// identical name+second files in one folder would exhaust the resolver — rare).
		expect(transfers.upload).toHaveBeenCalledTimes(2)

		const createdDirNames = new Set(createDir.mock.calls.map(call => call[1] as string))

		expect(createdDirNames).toEqual(new Set(["Vacation"]))
	})

	it("three albums sharing one title all merge into a single remote folder", async () => {
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

		expect(transfers.upload).toHaveBeenCalledTimes(3)

		const createdDirNames = new Set(createDir.mock.calls.map(call => call[1] as string))

		expect(createdDirNames).toEqual(new Set(["Pictures"]))
	})

	it("titles differing only by case merge into one folder (case-insensitive remote)", async () => {
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

		// albumFolderTitle preserves casing, but the remote is case-insensitive (and the
		// parent-dir cache is lowercased to match), so the two casings resolve to a single
		// folder — both assets upload into it. (Same effective result as the legacy app.)
		expect(transfers.upload).toHaveBeenCalledTimes(2)

		const createdDirNames = new Set(createDir.mock.calls.map(call => call[1] as string))

		expect(createdDirNames.size).toBe(1)
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

	it("an iOS-style album id containing '/' never leaks into the folder name", async () => {
		const createDir = installCreateDirSpy()

		// Real iOS PHCollection.localIdentifier values look like "<UUID>/L0/<NNN>".
		// They used to be sanitized INTO the folder name as a disambiguation suffix;
		// under the merge scheme the id is never part of the name at all, so same-title
		// albums simply merge regardless of how exotic their ids are.
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

		expect(transfers.upload).toHaveBeenCalledTimes(2)

		const createdDirNames = new Set(createDir.mock.calls.map(call => call[1] as string))

		// Merged into one "Screenshots" folder; no id, and no "/" in any created name.
		expect(createdDirNames).toEqual(new Set(["Screenshots"]))

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

		// Both titles trim to "Screenshots" → one shared folder, no suffix.
		expect(transfers.upload).toHaveBeenCalledTimes(2)
		expect(createdDirNames).toEqual(new Set(["Screenshots"]))
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

	it("unselected device albums never affect naming; selected same-title albums merge", async () => {
		const createDir = installCreateDirSpy()

		// album-a is on the device but NOT selected. Under the merge scheme the folder
		// name depends only on the selected album's title — never the wider device
		// catalogue — so album-a is irrelevant and the two selected albums just share
		// the bare "Screenshots" folder.
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

		// Only the two selected albums upload, both into the bare "Screenshots" folder.
		expect(transfers.upload).toHaveBeenCalledTimes(2)
		expect(createdDirNames).toEqual(new Set(["Screenshots"]))
	})

	it("getAlbumsAsync failure aborts the sync loudly (no silent drop of selected albums)", async () => {
		// Per the project's silent-failure discipline: if we can't enumerate the
		// device catalogue, we can't safely disambiguate. Fail the whole sync.
		const { getAlbumsAsync } = await import("expo-media-library/legacy")

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

// ─── Multi-album asset coverage (per-path shield) ───────────────────────────

describe("multi-album asset coverage (per-path shield)", () => {
	function setupSharedAssetAlbums(): void {
		const uri = "file:///media/shared-1"

		ml.addAsset({
			id: "shared-1",
			filename: "photo.jpg",
			uri,
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})

		fs.set(uri, new Uint8Array([1]))

		ml.addAlbum({
			id: "album-trip",
			title: "Trip",
			assetIds: ["shared-1"]
		})
		ml.addAlbum({
			id: "album-recents",
			title: "Recents",
			assetIds: ["shared-1"]
		})
	}

	function installCreateDirSpy(): ReturnType<typeof vi.fn> {
		const createDir = vi.fn(async () => ({ uuid: "remote-dir-uuid" }))

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({ files: [] })),
				createDir,
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
			}
		} as any)

		return createDir
	}

	it("an asset in two selected albums reaches BOTH album folders (id-keyed shield must not starve the second)", async () => {
		installCreateDirSpy()
		setupSharedAssetAlbums()

		// Sync 1: only "Trip" selected — the asset uploads there and records a paths-carrying
		// shield entry.
		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-trip"]
		})

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)

		const entryAfterFirst = cameraUploadState.getHashSync("shared-1") as { paths?: string[] } | undefined

		expect(entryAfterFirst?.paths).toHaveLength(1)

		// Sync 2: both albums selected. The remote listing is empty every sync, so the Trip
		// path is guarded purely by the shield (covered → skipped) while the Recents path is
		// NOT covered and must upload — pre-fix the id-keyed skip starved it forever.
		vi.mocked(transfers.upload).mockClear()
		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-trip", "album-recents"]
		})

		// manual: bypass the BG-05 auto-sync coalescing gate — this is a back-to-back re-sync.
		await cameraUpload.sync({ manual: true })

		expect(transfers.upload).toHaveBeenCalledTimes(1)

		const entryAfterSecond = cameraUploadState.getHashSync("shared-1") as { paths?: string[] } | undefined

		expect(entryAfterSecond?.paths).toHaveLength(2)

		// Sync 3: both paths covered — nothing further uploads (steady-state skip intact).
		vi.mocked(transfers.upload).mockClear()

		await cameraUpload.sync({ manual: true })

		expect(transfers.upload).not.toHaveBeenCalled()
	})

	it("a legacy entry (no paths) still covers every path — pre-paths skip semantics preserved", async () => {
		installCreateDirSpy()
		setupSharedAssetAlbums()

		// Seed a legacy-shaped entry: verified at the asset's mtime, no paths field.
		cameraUploadState.hashes.set("shared-1", {
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})

		vi.mocked(secureStore.get).mockResolvedValue({
			...ENABLED_CONFIG,
			albumIds: ["album-trip", "album-recents"]
		})

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
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
		expect(mockAddSkippedAsset).toHaveBeenCalledWith({ id: "a1", name: "photo.jpg" })

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

	it("retrySkippedAsset resets the asset's failure count, removes it from the store, and kicks a manual sync (CU-09)", () => {
		const failures = (cameraUpload as any).uploadFailures as Map<string, number>

		failures.set("a1", 3)
		failures.set("a2", 1)

		// Stub sync so the fire-and-forget retry kick is observable + deterministic (no real pass runs).
		const syncSpy = vi.spyOn(cameraUpload, "sync").mockResolvedValue({ success: true })

		cameraUpload.retrySkippedAsset("a1")

		// Only the retried asset's count is cleared; siblings are untouched.
		expect(failures.has("a1")).toBe(false)
		expect(failures.get("a2")).toBe(1)
		expect(mockRemoveSkippedAsset).toHaveBeenCalledWith("a1")
		expect(syncSpy).toHaveBeenCalledWith({ manual: true })

		syncSpy.mockRestore()
	})

	it("retryAllSkippedAssets clears all failure counts, clears the store list, and kicks a manual sync (CU-09)", () => {
		const failures = (cameraUpload as any).uploadFailures as Map<string, number>

		failures.set("a1", 3)
		failures.set("a2", 3)
		failures.set("a3", 2)

		const syncSpy = vi.spyOn(cameraUpload, "sync").mockResolvedValue({ success: true })

		cameraUpload.retryAllSkippedAssets()

		expect(failures.size).toBe(0)
		expect(mockClearSkippedAssets).toHaveBeenCalled()
		expect(syncSpy).toHaveBeenCalledWith({ manual: true })

		syncSpy.mockRestore()
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

	it("skips upload when MD5 matches cached value (legacy string entry) and migrates it to the verified-mtime shape", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		// Legacy persisted shape: bare md5 string. It must still shield the upload
		// (treated as verifiedModificationTime: -1 → one hash, md5 matches → skip)
		// and be upgraded in place to the object shape carrying the verified mtime.
		cameraUploadState.hashes.set("/camera roll/photo.jpg", "mock-md5")

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
		// Upgraded in place AND re-keyed from the legacy tree path to the stable asset id.
		expect(cameraUploadState.hashes.get("a1")).toEqual({
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})
		expect(cameraUploadState.hashes.has("/camera roll/photo.jpg")).toBe(false)
	})

	it("legacy string entry is hashed ONCE, then the following pass takes the verified-mtime fast path (no getUri)", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		cameraUploadState.hashes.set("/camera roll/photo.jpg", "mock-md5")

		const { Asset } = await import("@/tests/mocks/expoMediaLibrary")
		const getUriSpy = vi.spyOn(Asset.prototype, "getUri")

		try {
			// Pass 1: -1 sentinel never matches → hash once → md5 matches → upgrade.
			await cameraUpload.sync()

			expect(getUriSpy).toHaveBeenCalledTimes(1)
			expect(transfers.upload).not.toHaveBeenCalled()

			getUriSpy.mockClear()

			// Pass 2: mtime matches the recorded verified value → immediate skip.
			await cameraUpload.sync()

			expect(getUriSpy).not.toHaveBeenCalled()
			expect(transfers.upload).not.toHaveBeenCalled()
		} finally {
			getUriSpy.mockRestore()
		}
	})

	it("proceeds with upload when MD5 differs from cached value — the source branch genuinely distinguishes match vs. mismatch", async () => {
		// The mock File always returns "mock-md5". Seed the cache with that same value
		// to confirm the source skips upload (match), then prove mismatch triggers upload
		// by overriding the md5 getter to return a different value for this one test.
		// This verifies the comparison branch is exercised for real — not as a side-effect
		// of the mock artefact.

		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		// First: confirm the match path really skips upload
		cameraUploadState.hashes.set("/camera roll/photo.jpg", "mock-md5")

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

		cameraUploadState.hashes.set("/camera roll/photo2.jpg", "old-hash-different-from-changed-md5")

		resetSyncInterval()

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

	it("stores MD5 + verified mtime in cache after successful upload, keyed by the asset id", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		await cameraUpload.sync()

		// Keyed by the stable asset id — tree paths are rewritten by the compress/
		// convertHeic toggles, so path keys orphaned the shield on every toggle.
		expect(cameraUploadState.hashes.get("a1")).toMatchObject({
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})
	})

	it("does not store MD5 in cache when upload fails", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		vi.mocked(transfers.upload).mockRejectedValueOnce(new Error("Upload failed"))

		await cameraUpload.sync()

		expect(cameraUploadState.hashes.has("a1")).toBe(false)
	})

	it("updates cached MD5 + verified mtime when file content changes (upload fires)", async () => {
		setupLocalAssets([{ id: "a1", filename: "photo.jpg" }])

		// Stale verified mtime + different md5 → hash, mismatch → upload + fresh entry.
		cameraUploadState.hashes.set("/camera roll/photo.jpg", {
			md5: "old-md5",
			verifiedModificationTime: 999
		})

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(cameraUploadState.hashes.get("a1")).toMatchObject({
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})
	})
})

// ─── B6: verified-mtime gate ─────────────────────────────────────────────────
// iOS bumps asset modificationTime on mere VIEWING, so the delta fires every sync
// for view-touched photos. The verified-mtime entry lets those skip WITHOUT
// getUri() (which re-downloads iCloud-offloaded originals) and without hashing.

describe("B6 — verified-mtime gate", () => {
	function setupAsset(modificationTime: number) {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["a1"] })
		ml.addAsset({
			id: "a1",
			filename: "photo.jpg",
			uri: "file:///media/a1",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime
		})
		fs.set("file:///media/a1", new Uint8Array([1, 2, 3]))
	}

	it("matching verified mtime skips IMMEDIATELY — no getUri, no md5 read, no upload", async () => {
		setupAsset(2000)

		cameraUploadState.hashes.set("/camera roll/photo.jpg", {
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})

		const { Asset } = await import("@/tests/mocks/expoMediaLibrary")
		const { File: MockFile } = await import("@/tests/mocks/expoFileSystem")
		const getUriSpy = vi.spyOn(Asset.prototype, "getUri")
		const md5Spy = vi.spyOn(MockFile.prototype, "md5", "get")

		try {
			await cameraUpload.sync()

			expect(getUriSpy).not.toHaveBeenCalled()
			expect(md5Spy).not.toHaveBeenCalled()
			expect(transfers.upload).not.toHaveBeenCalled()
			// The entry value is untouched (only re-keyed from the legacy path to the asset id).
			expect(cameraUploadState.hashes.get("a1")).toEqual({
				md5: "mock-md5",
				verifiedModificationTime: 2000
			})
		} finally {
			getUriSpy.mockRestore()
			md5Spy.mockRestore()
		}
	})

	it("touched-but-unchanged: one hash on the first pass, quiet (no getUri) on the next", async () => {
		// mtime bumped (view-touch) but content identical → hash once, md5 matches,
		// verified mtime advances; the following pass takes the fast path.
		setupAsset(3000)

		cameraUploadState.hashes.set("/camera roll/photo.jpg", {
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})

		const { Asset } = await import("@/tests/mocks/expoMediaLibrary")
		const getUriSpy = vi.spyOn(Asset.prototype, "getUri")

		try {
			await cameraUpload.sync()

			expect(getUriSpy).toHaveBeenCalledTimes(1)
			expect(transfers.upload).not.toHaveBeenCalled()
			expect(cameraUploadState.hashes.get("a1")).toEqual({
				md5: "mock-md5",
				verifiedModificationTime: 3000
			})

			getUriSpy.mockClear()

			await cameraUpload.sync()

			expect(getUriSpy).not.toHaveBeenCalled()
			expect(transfers.upload).not.toHaveBeenCalled()
		} finally {
			getUriSpy.mockRestore()
		}
	})

	it("changed content uploads and records the new md5 + verified mtime", async () => {
		setupAsset(3000)

		cameraUploadState.hashes.set("/camera roll/photo.jpg", {
			md5: "different-md5",
			verifiedModificationTime: 2000
		})

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(cameraUploadState.hashes.get("a1")).toMatchObject({
			md5: "mock-md5",
			verifiedModificationTime: 3000
		})
	})

	it("the -1 sentinel never fast-skips, even for a (pathological) -1 mtime", async () => {
		setupAsset(-1)

		cameraUploadState.hashes.set("/camera roll/photo.jpg", {
			md5: "mock-md5",
			verifiedModificationTime: -1
		})

		const { Asset } = await import("@/tests/mocks/expoMediaLibrary")
		const getUriSpy = vi.spyOn(Asset.prototype, "getUri")

		try {
			await cameraUpload.sync()

			// Sentinel forces the hash path (md5 then matches → skip upload).
			expect(getUriSpy).toHaveBeenCalledTimes(1)
			expect(transfers.upload).not.toHaveBeenCalled()
		} finally {
			getUriSpy.mockRestore()
		}
	})

	it("null modificationTime stores the -1 sentinel after upload (always re-verifies next pass)", async () => {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["a1"] })
		ml.addAsset({
			id: "a1",
			filename: "photo.jpg",
			uri: "file:///media/a1",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: null
		})
		fs.set("file:///media/a1", new Uint8Array([1, 2, 3]))

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(cameraUploadState.hashes.get("a1")).toMatchObject({
			md5: "mock-md5",
			verifiedModificationTime: -1
		})
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
		const fakeContext = { renderAsync: vi.fn(async () => ({ saveAsync: fakeSaveAsync, release: vi.fn() })), release: vi.fn() }

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
		const fakeContext = { renderAsync: vi.fn(async () => ({ saveAsync: fakeSaveAsync, release: vi.fn() })), release: vi.fn() }

		vi.mocked(ImageManipulator.manipulate).mockReturnValueOnce(fakeContext as any)

		const result = await (cameraUpload as any).compress(file)

		// Extension changed to .jpg since content is now JPEG
		expect(result.uri).toMatch(/\.jpg$/)
		// Manipulated temp file cleaned up
		expect(fs.has(manipulatedUri)).toBe(false)
	})

	it("transplants the source's metadata into the compressed output BEFORE overwriting the source", async () => {
		const { File: MockFile, Paths } = await import("@/tests/mocks/expoFileSystem")
		const { ImageManipulator } = await import("expo-image-manipulator")
		const { transplantMetadata } = await import("@/modules/filen-exif")

		vi.mocked(transplantMetadata).mockClear()

		const originalUri = `${Paths.cache.uri}/filen-tmp/photo.jpg`
		const manipulatedUri = `${Paths.cache.uri}/filen-tmp/photo-manip.jpg`

		fs.set(originalUri, new Uint8Array(new Array(10).fill(1)))
		fs.set(manipulatedUri, new Uint8Array([1, 2, 3]))

		const file = new MockFile(originalUri)
		const fakeContext = {
			renderAsync: vi.fn(async () => ({ saveAsync: vi.fn(async () => ({ uri: manipulatedUri })), release: vi.fn() })),
			release: vi.fn()
		}

		vi.mocked(ImageManipulator.manipulate).mockReturnValueOnce(fakeContext as any)

		await (cameraUpload as any).compress(file)

		// source = the ORIGINAL staged file, target = the compressed manipulator output.
		expect(vi.mocked(transplantMetadata)).toHaveBeenCalledExactlyOnceWith(originalUri, manipulatedUri)
	})

	it("reads the source BEFORE it is overwritten by the compressed bytes (byte-level order proof)", async () => {
		const { File: MockFile, Paths } = await import("@/tests/mocks/expoFileSystem")
		const { ImageManipulator } = await import("expo-image-manipulator")
		const { transplantMetadata } = await import("@/modules/filen-exif")

		const originalUri = `${Paths.cache.uri}/filen-tmp/photo.jpg`
		const manipulatedUri = `${Paths.cache.uri}/filen-tmp/photo-manip.jpg`
		const originalBytes = new Uint8Array(new Array(10).fill(0xaa))

		fs.set(originalUri, originalBytes)
		fs.set(manipulatedUri, new Uint8Array([1, 2, 3]))

		// Snapshot the source file's bytes at the moment the transplant is invoked. If the copy
		// had already overwritten `file` with the compressed bytes, this would capture [1,2,3].
		let sourceBytesAtCall: number[] | null = null

		vi.mocked(transplantMetadata).mockImplementationOnce(async (srcUri: string) => {
			sourceBytesAtCall = Array.from(fs.get(srcUri) as Uint8Array)

			return true
		})

		const file = new MockFile(originalUri)
		const fakeContext = {
			renderAsync: vi.fn(async () => ({ saveAsync: vi.fn(async () => ({ uri: manipulatedUri })), release: vi.fn() })),
			release: vi.fn()
		}

		vi.mocked(ImageManipulator.manipulate).mockReturnValueOnce(fakeContext as any)

		await (cameraUpload as any).compress(file)

		// The source still held its ORIGINAL bytes when the transplant read it.
		expect(sourceBytesAtCall).toEqual(Array.from(originalBytes))
	})

	it("ignores the transplant's boolean result — a `false` still uploads the valid compressed file", async () => {
		const { File: MockFile, Paths } = await import("@/tests/mocks/expoFileSystem")
		const { ImageManipulator } = await import("expo-image-manipulator")
		const { transplantMetadata } = await import("@/modules/filen-exif")

		vi.mocked(transplantMetadata).mockResolvedValueOnce(false)

		const originalUri = `${Paths.cache.uri}/filen-tmp/photo.jpg`
		const manipulatedUri = `${Paths.cache.uri}/filen-tmp/photo-manip.jpg`

		fs.set(originalUri, new Uint8Array(new Array(10).fill(1)))
		fs.set(manipulatedUri, new Uint8Array([5, 5, 5]))

		const file = new MockFile(originalUri)
		const fakeContext = {
			renderAsync: vi.fn(async () => ({ saveAsync: vi.fn(async () => ({ uri: manipulatedUri })), release: vi.fn() })),
			release: vi.fn()
		}

		vi.mocked(ImageManipulator.manipulate).mockReturnValueOnce(fakeContext as any)

		const result = await (cameraUpload as any).compress(file)

		expect(result.uri).toMatch(/\.jpg$/)
		expect(Array.from(fs.get(result.uri) as Uint8Array)).toEqual([5, 5, 5])
	})

	it("keeps the compressed file when the transplant fails (fail-open)", async () => {
		const { File: MockFile, Paths } = await import("@/tests/mocks/expoFileSystem")
		const { ImageManipulator } = await import("expo-image-manipulator")
		const { transplantMetadata } = await import("@/modules/filen-exif")

		vi.mocked(transplantMetadata).mockRejectedValueOnce(new Error("native boom"))

		const originalUri = `${Paths.cache.uri}/filen-tmp/photo.jpg`
		const manipulatedUri = `${Paths.cache.uri}/filen-tmp/photo-manip.jpg`

		fs.set(originalUri, new Uint8Array(new Array(10).fill(1)))
		fs.set(manipulatedUri, new Uint8Array([7, 7, 7]))

		const file = new MockFile(originalUri)
		const fakeContext = {
			renderAsync: vi.fn(async () => ({ saveAsync: vi.fn(async () => ({ uri: manipulatedUri })), release: vi.fn() })),
			release: vi.fn()
		}

		vi.mocked(ImageManipulator.manipulate).mockReturnValueOnce(fakeContext as any)

		const result = await (cameraUpload as any).compress(file)

		// The compressed bytes still landed in the returned file; the transplant failure was swallowed.
		expect(result.uri).toMatch(/\.jpg$/)
		expect(Array.from(fs.get(result.uri) as Uint8Array)).toEqual([7, 7, 7])
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
		cameraUploadState.hashes.clear()

		// Second sync — cache entry is expired, createDir must be called again
		resetSyncInterval()

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
				createDir: vi.fn(async () => ({ uuid: "dir" })),
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
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

// ─── HEIC→JPG conversion: stem-key dedup + no eternal re-upload loop ──────────

/**
 * The conversion STEP, as distinct from the dedup naming around it.
 *
 * The block below this one covers how a converted file is KEYED. Nothing covered whether the
 * conversion ran: with the manipulator stubbed to return undefined, every conversion threw into
 * convertHeicToJpg's fail-open catch and uploaded the original, so removing the conversion call
 * outright kept the suite green while users would have shipped .heic bytes under a .jpg name.
 */
/**
 * Failure modes a real camera roll produces that the suite never exercised: the photo is gone by the
 * time its turn comes, and the device runs out of room mid-staging. Both must fail exactly ONE asset
 * — the pass has to survive, the rest of the backlog has to upload, and nothing may be recorded that
 * would shield the failed photo from a later retry.
 */
/**
 * One photo across a realistic lifetime: backed up, viewed, viewed again, edited, deleted. Almost
 * every other test in this file is single-pass, and the state that decides camera upload's behaviour
 * — the shield ledger — only exists BETWEEN passes. This is where a regression in it shows up.
 */
describe("sync flow — a photo's life across passes", () => {
	// Scoped teardown: the md5 getter below is a prototype spy, and leaving it installed makes every
	// later test in the file see content-derived digests instead of the shared "mock-md5".
	let md5Spy: { mockRestore: () => void } | null = null

	afterEach(() => {
		md5Spy?.mockRestore()
		md5Spy = null
	})

	// Remote grows as uploads land, and each file reports the mtime it was uploaded with, so the
	// local-newer comparison behaves as it does in production rather than being pinned to a constant.
	function wireRemote(remote: Map<string, number>) {
		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({
					files: [...remote.keys()].map(path => ({ path, file: { uuid: `uuid:${path}` } }))
				})),
				createDir: vi.fn(async () => ({ uuid: "dir" })),
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
			}
		} as any)

		vi.mocked(unwrapFileMeta).mockImplementation((file: any) => {
			const path = String(file?.uuid ?? "").replace(/^uuid:/, "")

			return {
				meta: {
					name: path.slice(path.lastIndexOf("/") + 1),
					created: 1000n,
					modified: BigInt(remote.get(path) ?? 0)
				}
			} as any
		})
	}

	it("uploads once, ignores views, re-uploads a real edit, and forgets a deleted photo", async () => {
		const remote = new Map<string, number>()

		wireRemote(remote)

		// Content-derived digests: the shared mock returns a constant "mock-md5" for every file, which
		// cannot distinguish an edit from a view. Everything downstream (including BLAKE3, which the
		// hash mock derives from md5) follows from this.
		md5Spy = vi.spyOn(File.prototype, "md5", "get").mockImplementation(function (this: { uri: string }) {
			const entry = fs.get(this.uri)

			return entry instanceof Uint8Array ? `md5-${entry.join("-")}` : null
		}) as unknown as { mockRestore: () => void }

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

		const stored = ml.assets.get("a1") as { modificationTime: number }

		// ── Pass 1: a new photo is backed up.
		await cameraUpload.sync()

		expect(uploadedPayloads).toHaveLength(1)

		remote.set("/Camera Roll/photo.jpg", 2000)

		// ── Pass 2: opening it in Photos bumps the modification date. Content is untouched, so the
		// md5 comparison clears it and the ledger records the new time.
		stored.modificationTime = 5000

		await cameraUpload.sync({ manual: true })

		expect(uploadedPayloads).toHaveLength(1)
		expect(cameraUploadState.hashes.get("a1")).toMatchObject({ verifiedModificationTime: 5000 })

		// ── Pass 3: nothing changed since. Now the delta is never even produced, so no file is read.
		mockFileHash.mockClear()

		await cameraUpload.sync({ manual: true })

		expect(mockFileHash).not.toHaveBeenCalled()
		expect(uploadedPayloads).toHaveLength(1)

		// ── Pass 4: a real edit — different bytes AND a newer time. This must reach the server.
		fs.set("file:///media/a1", new Uint8Array([4, 5, 6]))
		stored.modificationTime = 7000

		await cameraUpload.sync({ manual: true })

		expect(uploadedPayloads).toHaveLength(2)
		expect(uploadedPayloads[1]?.bytes).toEqual(new Uint8Array([4, 5, 6]))

		// ── Pass 5: the photo is deleted from the device. Its ledger entry is hygiene-pruned, so a
		// re-added photo is not shielded by a stale entry from its previous life.
		ml.assets.delete("a1")
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: [] })

		await cameraUpload.sync({ manual: true })

		expect(cameraUploadState.hashes.get("a1")).toBeUndefined()
	})
})

describe("sync flow — photo access is revoked between passes", () => {
	it("does not prune the shield ledger when it can no longer see the library", async () => {
		// Revoking access makes every asset look "gone from the device". If the pass got as far as
		// the hygiene prune it would wipe the whole ledger, and re-granting access would re-upload
		// the user's entire camera roll. The permission gate runs before the prune for this reason.
		// Revocation does not just flip a flag — the library stops returning assets, which is what
		// makes the ledger look stale. The album is left EMPTY to model that; a test that kept the
		// asset visible would pass with or without the gate and prove nothing.
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: [] })

		cameraUploadState.hashes.set("a1", {
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})

		vi.mocked(hasAllNeededMediaPermissions).mockResolvedValueOnce(false as any)

		await cameraUpload.sync({ manual: true })

		expect(cameraUploadState.hashes.get("a1")).toBeDefined()
		expect(transfers.upload).not.toHaveBeenCalled()
	})
})

describe("sync flow — the asset disappears mid-pass", () => {
	function setupTwoAssets() {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["gone", "survivor"] })

		for (const id of ["gone", "survivor"]) {
			ml.addAsset({
				id,
				filename: `${id}.jpg`,
				uri: `file:///media/${id}`,
				mediaType: MediaType.IMAGE,
				creationTime: 1000,
				modificationTime: 2000
			})
			fs.set(`file:///media/${id}`, new Uint8Array([1, 2, 3]))
		}
	}

	it("uploads the rest of the backlog when one photo was deleted after the listing", async () => {
		// The listing is a snapshot; the user can delete a photo while the pass is running. Losing
		// the whole pass to one missing file would stall every remaining upload.
		setupTwoAssets()
		fs.delete("file:///media/gone")

		await cameraUpload.sync()

		expect(uploadedPayloads).toHaveLength(1)
		expect(uploadedPayloads[0]?.name).toBe("survivor.jpg")
	})

	it("records no shield entry for the photo it could not read", async () => {
		// A shield entry written here would mark content as backed up that never left the device,
		// and the mtime fast path would then skip it forever.
		setupTwoAssets()
		fs.delete("file:///media/gone")

		await cameraUpload.sync()

		expect(cameraUploadState.hashes.get("gone")).toBeUndefined()
		expect(cameraUploadState.hashes.get("survivor")).toBeDefined()
	})

	it("surfaces the failure instead of failing silently", async () => {
		// A photo that never made it must reach the issues surface — a silent drop is the failure
		// mode a backup app can least afford.
		setupTwoAssets()
		fs.delete("file:///media/gone")

		await cameraUpload.sync()

		expect(mockSetErrors).toHaveBeenCalled()

		// Attribution matters: the issues modal offers a retry per asset, so an error with no assetId
		// is not actionable.
		const surfaced = mockSetErrors.mock.calls.flatMap(call => (call[0] as (errors: unknown[]) => unknown[])([]))

		expect(surfaced.some(error => (error as { assetId?: string }).assetId === "gone")).toBe(true)
	})
})

describe("sync flow — the device runs out of storage while staging", () => {
	it("fails only the asset whose staging copy failed", async () => {
		// Staging copies the asset into filen-tmp before upload. On a full disk that copy throws,
		// and the SDK/FS already bubble ENOSPC — the pipeline just has to not treat it as fatal.
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["a1", "a2"] })

		for (const id of ["a1", "a2"]) {
			ml.addAsset({
				id,
				filename: `${id}.jpg`,
				uri: `file:///media/${id}`,
				mediaType: MediaType.IMAGE,
				creationTime: 1000,
				modificationTime: 2000
			})
			fs.set(`file:///media/${id}`, new Uint8Array([1, 2, 3]))
		}

		const copy = vi.spyOn(File.prototype, "copy")

		copy.mockRejectedValueOnce(new Error("ENOSPC: no space left on device"))

		try {
			await cameraUpload.sync()
		} finally {
			// Restored unconditionally: a prototype spy left installed by a throwing sync would follow
			// every later test in the file.
			copy.mockRestore()
		}

		expect(uploadedPayloads).toHaveLength(1)
	})

	it("leaves no shield entry behind for the asset that never uploaded", async () => {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["a1"] })
		ml.addAsset({
			id: "a1",
			filename: "a1.jpg",
			uri: "file:///media/a1",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		fs.set("file:///media/a1", new Uint8Array([1, 2, 3]))

		const copy = vi.spyOn(File.prototype, "copy")

		copy.mockRejectedValue(new Error("ENOSPC: no space left on device"))

		try {
			await cameraUpload.sync()
		} finally {
			copy.mockRestore()
		}

		expect(transfers.upload).not.toHaveBeenCalled()
		expect(cameraUploadState.hashes.get("a1")).toBeUndefined()
	})
})

describe("sync flow — HEIC→JPG conversion actually converts", () => {
	function setupHeic() {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["heic-1"] })
		ml.addAsset({
			id: "heic-1",
			filename: "photo.heic",
			uri: "file:///media/heic-1",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		fs.set("file:///media/heic-1", new Uint8Array([1, 2, 3]))

		vi.mocked(secureStore.get).mockImplementation(async (key: string) =>
			key === CONVERT_HEIC_TO_JPG_ENABLED_SECURE_STORE_KEY ? (true as any) : (ENABLED_CONFIG as any)
		)
	}

	it("uploads the converted bytes, not the original HEIC", async () => {
		setupHeic()

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(uploadedBytes()).toEqual(new Uint8Array([9, 9]))
	})

	it("uploads under a .jpg name so the remote name matches the bytes", async () => {
		setupHeic()

		await cameraUpload.sync()

		expect(vi.mocked(transfers.upload).mock.calls[0]?.[0]?.name).toBe("photo.jpg")
	})

	it("falls back to the original when conversion fails, rather than losing the photo", async () => {
		// Fail-open is deliberate: a decode failure must still back the photo up. The contract is
		// that the ORIGINAL bytes go out under the ORIGINAL name — not a half-converted file.
		setupHeic()

		mockManipulate.mockImplementationOnce(() => {
			throw new Error("decode failed")
		})

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(uploadedBytes()).toEqual(new Uint8Array([1, 2, 3]))
		expect(vi.mocked(transfers.upload).mock.calls[0]?.[0]?.name).toBe("photo.heic")
	})

	it("leaves a non-HEIC asset untouched even with conversion enabled", async () => {
		// convertHeic is a global flag; a JPEG under it must pass through byte-identical rather
		// than be re-encoded for nothing.
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["jpg-1"] })
		ml.addAsset({
			id: "jpg-1",
			filename: "photo.jpg",
			uri: "file:///media/jpg-1",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		fs.set("file:///media/jpg-1", new Uint8Array([1, 2, 3]))

		vi.mocked(secureStore.get).mockImplementation(async (key: string) =>
			key === CONVERT_HEIC_TO_JPG_ENABLED_SECURE_STORE_KEY ? (true as any) : (ENABLED_CONFIG as any)
		)

		await cameraUpload.sync()

		expect(uploadedBytes()).toEqual(new Uint8Array([1, 2, 3]))
	})

	it("composes with compression: converts first, then compresses the JPEG", async () => {
		// Both enabled at once is a real configuration and the order matters — converting at max
		// quality and then compressing is not the same as compressing a HEIC. Two manipulator
		// passes is the observable proof that both steps ran on this asset.
		setupHeic()

		vi.mocked(secureStore.get).mockImplementation(async (key: string) =>
			key === CONVERT_HEIC_TO_JPG_ENABLED_SECURE_STORE_KEY ? (true as any) : ({ ...ENABLED_CONFIG, compress: true } as any)
		)

		await cameraUpload.sync()

		// Order, not just count: converting at max quality and THEN compressing is not the same as
		// compressing a HEIC, and a count of two passes for either order.
		expect(mockManipulate).toHaveBeenCalledTimes(2)
		expect(String(mockManipulate.mock.calls[0]?.[0])).toMatch(/\.heic$/i)
		expect(String(mockManipulate.mock.calls[1]?.[0])).toMatch(/\.jpe?g$/i)
		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(vi.mocked(transfers.upload).mock.calls[0]?.[0]?.name).toBe("photo.jpg")
	})
})

describe("sync flow — HEIC→JPG conversion dedup", () => {
	function setupHeicAsset() {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["heic-1"] })

		const uri = "file:///media/heic-1"

		ml.addAsset({
			id: "heic-1",
			filename: "photo.heic",
			uri,
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})

		fs.set(uri, new Uint8Array([1, 2, 3]))
	}

	// A previous sync (with conversion on) uploaded photo.heic as photo.jpg.
	function remoteHasConvertedJpg() {
		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({
					files: [{ path: "/Camera Roll/photo.jpg", file: { uuid: "remote-jpg" } }]
				})),
				createDir: vi.fn(async () => ({ uuid: "dir" })),
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
			}
		} as any)

		vi.mocked(unwrapFileMeta).mockReturnValue({ meta: { name: "photo.jpg", created: 1000n, modified: 2000n } } as any)
	}

	it("convertHeic ON: a local .heic already uploaded as .jpg is matched by the normalized key and NOT re-uploaded", async () => {
		setupHeicAsset()
		remoteHasConvertedJpg()

		vi.mocked(secureStore.get).mockImplementation(async (key: string) =>
			key === CONVERT_HEIC_TO_JPG_ENABLED_SECURE_STORE_KEY ? (true as any) : (ENABLED_CONFIG as any)
		)

		await cameraUpload.sync()

		// Local /camera roll/photo.heic is NORMALIZED to /camera roll/photo.jpg; remote
		// /camera roll/photo.jpg keys verbatim → both land on the same key → matched → no
		// re-upload (the eternal-loop guard).
		expect(transfers.upload).not.toHaveBeenCalled()
	})

	it("convertHeic OFF: the same .heic does NOT match the remote .jpg (normalization is what links them)", async () => {
		setupHeicAsset()
		remoteHasConvertedJpg()

		// Default mock → convertHeic + compress both OFF → keys keep their extensions.
		await cameraUpload.sync()

		// /camera roll/photo.heic ≠ /camera roll/photo.jpg → seen as missing remotely → uploaded.
		expect(transfers.upload).toHaveBeenCalled()
	})

	// Toggle-cycle regression: the md5 shield is keyed by the STABLE asset id, so the tree-key
	// rewrite a convertHeic toggle applies to every HEIC asset (dedupTreeKey) no longer orphans
	// it — already-backed-up content stays skipped in BOTH toggle directions.

	it("toggle ON: an mtime-bumped .heic already uploaded as .heic keeps its id-keyed shield — no re-upload", async () => {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["heic-1"] })
		ml.addAsset({
			id: "heic-1",
			filename: "photo.heic",
			uri: "file:///media/heic-1",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 3000
		})
		fs.set("file:///media/heic-1", new Uint8Array([1, 2, 3]))

		// Remote still holds the ORIGINAL (unconverted) upload; its mtime predates the local
		// view-touch bump, so the matched-key delta fires and only the shield stops the upload.
		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({
					files: [{ path: "/Camera Roll/photo.heic", file: { uuid: "remote-heic" } }]
				})),
				createDir: vi.fn(async () => ({ uuid: "dir" })),
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
			}
		} as any)
		vi.mocked(unwrapFileMeta).mockReturnValue({ meta: { name: "photo.heic", created: 1000n, modified: 2000n } } as any)

		vi.mocked(secureStore.get).mockImplementation(async (key: string) =>
			key === CONVERT_HEIC_TO_JPG_ENABLED_SECURE_STORE_KEY ? (true as any) : (ENABLED_CONFIG as any)
		)

		cameraUploadState.hashes.set("heic-1", {
			md5: "mock-md5",
			verifiedModificationTime: 999
		})

		await cameraUpload.sync()

		// Stale verified mtime forces one hash; the md5 matches → skip + re-verify.
		expect(transfers.upload).not.toHaveBeenCalled()
		expect(cameraUploadState.hashes.get("heic-1")).toEqual({
			md5: "mock-md5",
			verifiedModificationTime: 3000
		})
	})

	it("toggle OFF after converted uploads exist: the id-keyed shield still blocks the missing-remote delta", async () => {
		setupHeicAsset()
		remoteHasConvertedJpg()

		// convertHeic OFF (default mocks): local /camera roll/photo.heic has no remote match
		// (the remote holds the converted photo.jpg), so a missing-remote delta fires — the
		// id-keyed entry short-circuits it via the verified-mtime fast path.
		cameraUploadState.hashes.set("heic-1", {
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
	})

	// CU-05 data-loss regression: two genuinely-distinct non-HEIC siblings that share a stem must
	// BOTH upload under convertHeic. The old code stripped the extension off EVERY file when
	// convertHeic was on, collapsing doc.jpg and doc.png onto one tree key — one overwrote the other
	// in the local tree and was silently never backed up. convertHeic never rewrites these, so their
	// keys stay distinct and both upload.
	it("convertHeic ON: two same-stem non-HEIC siblings (doc.jpg + doc.png) BOTH upload (no over-merge)", async () => {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["jpg-1", "png-1"] })

		for (const asset of [
			{ id: "jpg-1", filename: "doc.jpg" },
			{ id: "png-1", filename: "doc.png" }
		]) {
			const uri = `file:///media/${asset.id}`

			ml.addAsset({
				id: asset.id,
				filename: asset.filename,
				uri,
				mediaType: MediaType.IMAGE,
				creationTime: 1000,
				modificationTime: 2000
			})

			fs.set(uri, new Uint8Array([1, 2, 3]))
		}

		// convertHeic ON; remote empty (default mock) → both siblings are "missing remotely".
		vi.mocked(secureStore.get).mockImplementation(async (key: string) =>
			key === CONVERT_HEIC_TO_JPG_ENABLED_SECURE_STORE_KEY ? (true as any) : (ENABLED_CONFIG as any)
		)

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(2)
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

// ─── Falsy-bigint regression (#106) ──────────────────────────────────────────
// cameraUpload.ts:524 used truthiness (`remoteFileMeta.meta?.modified &&`) which
// short-circuits for 0n (Unix epoch), causing the local-newer comparison to be
// skipped. The guards are now `!= null` so 0n is treated as a real timestamp.

describe("falsy-bigint: modified=0n and modificationTime=0 are valid epoch timestamps", () => {
	function setupLocalAsset(opts: { id?: string; filename?: string; creationTime?: number; modificationTime?: number }) {
		const id = opts.id ?? "a1"
		const uri = `file:///media/${id}`

		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: [id] })
		ml.addAsset({
			id,
			filename: opts.filename ?? "photo.jpg",
			uri,
			mediaType: MediaType.IMAGE,
			creationTime: opts.creationTime ?? 1000,
			modificationTime: opts.modificationTime ?? 2000
		})
		fs.set(uri, new Uint8Array([1, 2, 3]))
	}

	function setupRemote(opts: { modified: bigint }) {
		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({
					files: [{ path: "/Camera Roll/photo.jpg", file: { uuid: "remote-1" } }]
				})),
				createDir: vi.fn(async () => ({ uuid: "dir" })),
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
			}
		} as any)

		vi.mocked(unwrapFileMeta).mockReturnValue({
			meta: { name: "photo.jpg", created: 0n, modified: opts.modified }
		} as any)
	}

	it("remote modified=0n + local modificationTime=0 — files match, no upload (epoch equals epoch)", async () => {
		// Both remote and local have epoch timestamps.
		// 0n was previously falsy so comparison was skipped; the file appeared
		// as a new-upload candidate. With != null guard, the comparison runs:
		// normalise(Number(0n)) < normalise(0) → 0 < 0 → false → no upload.
		setupLocalAsset({ modificationTime: 0 })
		setupRemote({ modified: 0n })

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
	})

	it("remote modified=0n + local modificationTime=5000 — local is newer, upload fires", async () => {
		// Remote has epoch (0n). Local was modified at 5000ms.
		// Old code: 0n is falsy → comparison skipped → no upload (wrong).
		// New code: 0n != null → comparison runs: normalise(0) < normalise(5000) → true → upload.
		setupLocalAsset({ modificationTime: 5000 })
		setupRemote({ modified: 0n })

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
	})

	it("remote modified=1000n + local modificationTime=0 — remote is newer, no upload", async () => {
		// Remote is at 1000ms, local is at epoch 0.
		// normalise(1000) < normalise(0) → false → no upload.
		setupLocalAsset({ modificationTime: 0 })
		setupRemote({ modified: 1000n })

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
	})

	it("remote modified=null (meta.modified absent) + local modificationTime=5000 — no comparison, no upload", async () => {
		// When modified is null (unknown), the guard correctly stops the comparison.
		// The file is not treated as needing re-upload.
		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({
					files: [{ path: "/Camera Roll/photo.jpg", file: { uuid: "remote-1" } }]
				})),
				createDir: vi.fn(async () => ({ uuid: "dir" })),
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
			}
		} as any)

		vi.mocked(unwrapFileMeta).mockReturnValue({
			meta: { name: "photo.jpg", created: 0n, modified: null }
		} as any)

		setupLocalAsset({ modificationTime: 5000 })

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

		// Drive 3 failures — each sync increments uploadFailures.get("a1") by 1. Each is a separate
		// trigger occasion (the gate would otherwise coalesce them), so reset the interval each time.
		await cameraUpload.sync()
		resetSyncInterval()
		await cameraUpload.sync()
		resetSyncInterval()
		await cameraUpload.sync()

		// Failure count is now MAX_UPLOAD_FAILURES (3). Switch to success mock so the
		// only reason upload is not called is the skip guard, not the failure path.
		vi.mocked(transfers.upload).mockResolvedValue({ files: [] } as any)

		// Clear call history so the count we check below only reflects sync 4
		vi.mocked(transfers.upload).mockClear()
		mockAddSkippedAsset.mockClear()

		resetSyncInterval()

		await cameraUpload.sync()

		// Skipped: upload never called in the 4th pass because count >= MAX_UPLOAD_FAILURES
		expect(mockAddSkippedAsset).toHaveBeenCalledWith({ id: "a1", name: "photo.jpg" })
		expect(transfers.upload).not.toHaveBeenCalled()
	})

	it("asset is NOT skipped before reaching MAX_UPLOAD_FAILURES failures", async () => {
		setupSingleAsset()

		vi.mocked(transfers.upload).mockRejectedValue(new Error("Network error"))

		// Two failures — one below the threshold of 3. Separate trigger occasions (see resetSyncInterval).
		await cameraUpload.sync()
		resetSyncInterval()
		await cameraUpload.sync()

		// Switch to success mock for the third attempt; count is 2 < 3, should upload
		vi.mocked(transfers.upload).mockResolvedValue({ files: [] } as any)

		// Clear history so we only count calls from sync 3
		vi.mocked(transfers.upload).mockClear()
		mockAddSkippedAsset.mockClear()

		resetSyncInterval()

		await cameraUpload.sync()

		// Should have uploaded on the third pass (count 2 < MAX_UPLOAD_FAILURES=3)
		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(mockAddSkippedAsset).not.toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }))
	})
})

// ─── BG-05: min-interval coalescing gate ──────────────────────────────────────

describe("BG-05 — min-interval coalescing for non-manual sync triggers", () => {
	function addOneAsset(): void {
		const uri = "file:///media/a1"

		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["a1"] })
		ml.addAsset({ id: "a1", filename: "photo.jpg", uri, mediaType: MediaType.IMAGE, creationTime: 1000, modificationTime: 2000 })
		fs.set(uri, new Uint8Array([1, 2, 3]))
	}

	it("coalesces an auto sync within the interval but lets a manual sync bypass", async () => {
		addOneAsset()

		// First pass uploads and stamps lastCompletedAt.
		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)

		// Clear the md5 cache so the asset WOULD upload again if a pass actually ran — this isolates
		// the gate as the only reason the next pass does nothing.
		cameraUploadState.hashes.clear()
		vi.mocked(transfers.upload).mockClear()

		// An AUTO trigger arriving within AUTO_SYNC_MIN_INTERVAL_MS of the completed pass is coalesced:
		// it returns before scanning, so nothing uploads.
		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()

		// An explicit (manual) trigger bypasses the gate and runs the pass.
		await cameraUpload.sync({ manual: true })

		expect(transfers.upload).toHaveBeenCalledTimes(1)
	})

	it("does not coalesce after the interval stamp is cleared (a later trigger occasion runs)", async () => {
		addOneAsset()

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)

		cameraUploadState.hashes.clear()
		vi.mocked(transfers.upload).mockClear()

		// Simulate ≥60s elapsed (a separate reconnect/foreground occasion) — the auto pass runs.
		resetSyncInterval()

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
	})
})

// ─── BG-03: foreground sync dropped during a background pass is re-fired ────────

describe("BG-03 — foreground sync dropped during a background pass is re-fired", () => {
	it("re-fires a foreground sync that arrived while a background pass was in flight", async () => {
		let releaseConfig!: () => void
		const configGate = new Promise<void>(resolve => {
			releaseConfig = resolve
		})
		let configCalls = 0
		const spy = vi.spyOn(cameraUpload as unknown as { getConfig: () => Promise<Config> }, "getConfig").mockImplementation(async () => {
			configCalls++

			if (configCalls === 1) {
				await configGate
			}

			// A disabled config makes each pass early-return right after getConfig — enough to exercise
			// the in-flight guard + the post-run re-fire without the full upload pipeline.
			return { enabled: false } as unknown as Config
		})

		const drain = () => new Promise<void>(resolve => setTimeout(resolve, 0))

		// Background pass parks on the gated getConfig (in flight, syncingBackground = true).
		const bg = cameraUpload.sync({ background: true, maxUploads: 1 })
		await drain()

		expect(configCalls).toBe(1)

		// A foreground sync arrives mid-background-pass — dropped by the in-flight guard, but it sets the
		// rerun flag instead of being lost.
		await cameraUpload.sync()

		expect(configCalls).toBe(1)

		// Let the background pass finish — it re-fires the foreground pass on completion.
		releaseConfig()
		await bg
		await drain()
		await drain()

		// Pre-fix the dropped foreground edge was lost (configCalls stays 1). Post-fix the background pass
		// re-fires it → a 2nd getConfig.
		expect(configCalls).toBeGreaterThanOrEqual(2)

		spy.mockRestore()
	})
})

// ─── #14 regression: seconds-timestamp dedup + second-granularity + null creationTime ─

describe("#14 regression — seconds-timestamp dedup and timestamp normalisation", () => {
	// These tests exercise the direct collision-suffix logic against the
	// exposed modifyAssetPathOnCollision function and the listLocal/listRemote
	// symmetry properties expected by the sync engine.
	// The dedup key is a seconds-floored creation timestamp — cheap, no file
	// read at listing time, and symmetric between local and remote trees.

	describe("seconds-timestamp dedup via modifyAssetPathOnCollision", () => {
		it("two same-named assets at different creation seconds resolve to different paths at iteration 0", () => {
			// Two IMG_0001.jpg assets created 1 second apart must get different paths.
			const pathA = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: String(Math.floor(1700000000000 / 1000)) }
			})
			const pathB = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: String(Math.floor(1700000001000 / 1000)) }
			})

			expect(pathA).not.toBeNull()
			expect(pathB).not.toBeNull()
			expect(pathA).not.toBe(pathB)
		})

		it("two same-named assets within the same second collapse to one path (sub-second drift — deduped by design)", () => {
			// 700ms and 200ms within the same second both floor to "1700000000".
			const pathA = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: String(Math.floor(1700000000700 / 1000)) }
			})
			const pathB = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: String(Math.floor(1700000000200 / 1000)) }
			})

			expect(pathA).toBe(pathB)
			expect(pathA).toBe("/camera roll/img_0001_1700000000.jpg")
		})
	})

	describe("second-granularity symmetry", () => {
		it("local and remote produce the same collision path when using seconds-floored timestamps", () => {
			// Local: String(Math.floor((creationTime ?? 0) / 1000))
			// Remote: String(Math.floor(Number(meta.created ?? 0) / 1000))
			// Both must produce an identical contentHash for the same wall-clock second.

			// Millisecond timestamps that differ by 500ms but share the same second
			const localMs = 1700000000700
			const remoteMs = 1700000000200 // same second, 500ms earlier

			const localHash = String(Math.floor(localMs / 1000)) // "1700000000"
			const remoteHash = String(Math.floor(remoteMs / 1000)) // "1700000000"

			const localPath = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: localHash }
			})
			const remotePath = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: remoteHash }
			})

			expect(localPath).toBe(remotePath)
			expect(localPath).toBe("/camera roll/img_0001_1700000000.jpg")
		})

		it("timestamps in different seconds produce different collision paths (no false equalities)", () => {
			const hashSecA = String(Math.floor(1700000000000 / 1000)) // "1700000000"
			const hashSecB = String(Math.floor(1700000001000 / 1000)) // "1700000001"

			const pathA = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: hashSecA }
			})
			const pathB = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: hashSecB }
			})

			expect(pathA).not.toBe(pathB)
		})
	})

	describe("null creationTime fallback symmetry (#B7 ONE rule)", () => {
		it("local effectiveCreationTimestamp mirrors the remote `meta.created` because the upload sends the same value", () => {
			// Local: Math.floor(effectiveCreationTimestamp(info) / 1000) — falls back to
			// modificationTime, then 0. Remote: Math.floor(Number(meta?.created ?? 0) / 1000)
			// where created IS the uploaded effectiveCreationTimestamp — so both sides
			// derive the identical hash for the same asset, for every fallback branch.
			const infoModFallback = { creationTime: null, modificationTime: 9999000 }
			const localHashModFallback = String(Math.floor(effectiveCreationTimestamp(infoModFallback) / 1000))
			const remoteHashModFallback = String(Math.floor(Number(BigInt(effectiveCreationTimestamp(infoModFallback))) / 1000))

			expect(localHashModFallback).toBe("9999")
			expect(localHashModFallback).toBe(remoteHashModFallback)

			const infoBothNull = { creationTime: null, modificationTime: null }
			const localHashBothNull = String(Math.floor(effectiveCreationTimestamp(infoBothNull) / 1000))
			// Upload sends created=0 (null-guarded, not falsy-dropped); remote `?? 0`
			// resolves identically even for foreign files with absent meta.
			const remoteHashBothNull = String(Math.floor(Number(0n) / 1000))

			expect(localHashBothNull).toBe("0")
			expect(localHashBothNull).toBe(remoteHashBothNull)

			const localPath = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: localHashModFallback }
			})
			const remotePath = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: remoteHashModFallback }
			})

			expect(localPath).toBe(remotePath)
		})
	})

	describe("sync — same-named assets at different seconds get distinct tree paths", () => {
		it("two same-named assets with different creationTimes are assigned distinct tree paths and uploaded separately", async () => {
			// Two IMG_0001.jpg assets created 1 second apart must each get a distinct
			// path in listLocal (via seconds-timestamp dedup) so both are uploaded.
			ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["a1", "a2"] })
			ml.addAsset({
				id: "a1",
				filename: "IMG_0001.jpg",
				uri: "file:///media/a1",
				mediaType: MediaType.IMAGE,
				creationTime: 1000,
				modificationTime: 2000
			})
			ml.addAsset({
				id: "a2",
				filename: "IMG_0001.jpg",
				uri: "file:///media/a2",
				mediaType: MediaType.IMAGE,
				creationTime: 2000,
				modificationTime: 3000
			})
			fs.set("file:///media/a1", new Uint8Array([1, 2, 3]))
			fs.set("file:///media/a2", new Uint8Array([4, 5, 6]))

			await cameraUpload.sync()

			// Different creation seconds → distinct collision paths → both uploaded
			expect(transfers.upload).toHaveBeenCalledTimes(2)
		})

		it("two same-named assets within the same second get distinct tree slots via the base + collision paths and both upload", async () => {
			// The first asset (sorted earliest by creationTime) wins the base slot.
			// The second asset (same second) tries iteration 0 — that slot is free
			// (different from the base), so both assets end up in distinct tree slots
			// and both are uploaded. The seconds-timestamp suffix only collapses two
			// assets when they compete for ALL collision paths (iteration 0 and 1),
			// which requires that the entire resolution chain is already occupied.
			ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["b1", "b2"] })
			ml.addAsset({
				id: "b1",
				filename: "IMG_0001.jpg",
				uri: "file:///media/b1",
				mediaType: MediaType.IMAGE,
				creationTime: 1000,
				modificationTime: 2000
			})
			ml.addAsset({
				id: "b2",
				filename: "IMG_0001.jpg",
				uri: "file:///media/b2",
				mediaType: MediaType.IMAGE,
				// Same second as b1: Math.floor(1500/1000) = Math.floor(1000/1000) = 1.
				creationTime: 1500,
				modificationTime: 2000
			})
			fs.set("file:///media/b1", new Uint8Array([1, 2, 3]))
			fs.set("file:///media/b2", new Uint8Array([4, 5, 6]))

			await cameraUpload.sync()

			// b1 → base slot (/img_0001.jpg), b2 → iteration-0 slot (/img_0001_1.jpg)
			// Both distinct → both uploaded.
			expect(transfers.upload).toHaveBeenCalledTimes(2)
		})
	})
})

// ─── #15 regression: compress tmp-file extension ─────────────────────────────

describe("#15 regression — compress() extension gate", () => {
	it("staging tmp file is created with the source extension so the compress extension gate passes for .jpg", async () => {
		// Before the fix newTmpFile() produced a bare UUID with no extension, so
		// compress() always got extname("") and returned the file uncompressed.
		// After the fix the tmp file has the same extension as the source asset.

		const { Paths } = await import("@/tests/mocks/expoFileSystem")
		const { ImageManipulator } = await import("expo-image-manipulator")

		// Source asset is a .jpg
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["compress-a"] })
		ml.addAsset({
			id: "compress-a",
			filename: "photo.jpg",
			uri: "file:///media/compress-a",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		fs.set("file:///media/compress-a", new Uint8Array(new Array(100).fill(1)))

		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, compress: true })

		// Set up ImageManipulator to produce a smaller output
		const manipulatedUri = `${Paths.cache.uri}/filen-tmp/photo-manip.jpg`

		fs.set(manipulatedUri, new Uint8Array([1, 2, 3])) // smaller than source (100 bytes)

		const fakeSaveAsync = vi.fn(async () => ({ uri: manipulatedUri }))
		const fakeContext = { renderAsync: vi.fn(async () => ({ saveAsync: fakeSaveAsync, release: vi.fn() })), release: vi.fn() }

		vi.mocked(ImageManipulator.manipulate).mockReturnValueOnce(fakeContext as any)

		await cameraUpload.sync()

		// compress() was invoked (ImageManipulator.manipulate was called) — the extension
		// gate passed because the tmp file had ".jpg" extension, not "".
		expect(vi.mocked(ImageManipulator.manipulate)).toHaveBeenCalledTimes(1)
	})

	it("staging tmp file with .png extension reaches compress() and triggers ImageManipulator", async () => {
		const { Paths } = await import("@/tests/mocks/expoFileSystem")
		const { ImageManipulator } = await import("expo-image-manipulator")

		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["compress-b"] })
		ml.addAsset({
			id: "compress-b",
			filename: "screenshot.png",
			uri: "file:///media/compress-b",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		fs.set("file:///media/compress-b", new Uint8Array(new Array(100).fill(2)))

		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, compress: true })

		// Manipulated file is larger — compress() returns original file unchanged
		const manipulatedUri = `${Paths.cache.uri}/filen-tmp/screenshot-manip.png`

		fs.set(manipulatedUri, new Uint8Array(new Array(200).fill(2))) // larger — compress returns original

		const fakeSaveAsync = vi.fn(async () => ({ uri: manipulatedUri }))
		const fakeContext = { renderAsync: vi.fn(async () => ({ saveAsync: fakeSaveAsync, release: vi.fn() })), release: vi.fn() }

		vi.mocked(ImageManipulator.manipulate).mockReturnValueOnce(fakeContext as any)

		await cameraUpload.sync()

		// ImageManipulator was called (extension gate passed) even though it returned
		// the original (no net compression in this test case)
		expect(vi.mocked(ImageManipulator.manipulate)).toHaveBeenCalledTimes(1)
	})

	it("when compress rewrites .png to .jpg, the uploaded filename has .jpg extension", async () => {
		const { Paths } = await import("@/tests/mocks/expoFileSystem")
		const { ImageManipulator } = await import("expo-image-manipulator")

		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["compress-c"] })
		ml.addAsset({
			id: "compress-c",
			filename: "photo.png",
			uri: "file:///media/compress-c",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		fs.set("file:///media/compress-c", new Uint8Array(new Array(100).fill(3)))

		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, compress: true })

		// Manipulated file is smaller — compress() will rename to .jpg
		const manipulatedUri = `${Paths.cache.uri}/filen-tmp/photo-manip.png`

		fs.set(manipulatedUri, new Uint8Array([1, 2, 3])) // smaller than 100 bytes

		const fakeSaveAsync = vi.fn(async () => ({ uri: manipulatedUri }))
		const fakeContext = { renderAsync: vi.fn(async () => ({ saveAsync: fakeSaveAsync, release: vi.fn() })), release: vi.fn() }

		vi.mocked(ImageManipulator.manipulate).mockReturnValueOnce(fakeContext as any)

		await cameraUpload.sync()

		expect(vi.mocked(transfers.upload)).toHaveBeenCalledTimes(1)

		const uploadCall = vi.mocked(transfers.upload).mock.calls[0]?.[0] as any

		// compress() rewrites .png → .jpg; the upload name should follow
		expect(uploadCall.name).toMatch(/\.jpg$/)
		expect(uploadCall.name).not.toMatch(/\.png$/)
	})

	it("when compress is disabled, uploaded filename preserves the original extension", async () => {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["nocompress-a"] })
		ml.addAsset({
			id: "nocompress-a",
			filename: "photo.png",
			uri: "file:///media/nocompress-a",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		fs.set("file:///media/nocompress-a", new Uint8Array([1, 2, 3]))

		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, compress: false })

		await cameraUpload.sync()

		expect(vi.mocked(transfers.upload)).toHaveBeenCalledTimes(1)

		const uploadCall = vi.mocked(transfers.upload).mock.calls[0]?.[0] as any

		expect(uploadCall.name).toBe("photo.png")
	})
})

// ─── #15 regression: compress-rename dedup tree-key symmetry ─────────────────
// When compress rewrites .png → .jpg the remote tree-key becomes .jpg while the
// local key would stay .png. listLocal/listRemote now compute extension-agnostic
// keys when compress is on, so the asset is matched and NOT re-uploaded each sync.

describe("#15 regression — compress-rename dedup tree-key symmetry", () => {
	function setupLocalPng(id: string) {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: [id] })
		ml.addAsset({
			id,
			filename: "photo.png",
			uri: `file:///media/${id}`,
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		fs.set(`file:///media/${id}`, new Uint8Array([1, 2, 3]))
	}

	function setupRemote(path: string) {
		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({
					files: [{ path, file: { uuid: "remote-1" } }]
				})),
				createDir: vi.fn(async () => ({ uuid: "dir" })),
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
			}
		} as any)

		vi.mocked(unwrapFileMeta).mockReturnValue({
			meta: { name: FileSystem.Paths.basename(path), created: 1000n, modified: 2000n }
		} as any)
	}

	it("compress ON: local .png matches remote .jpg (compressed) — no re-upload", async () => {
		setupLocalPng("c1")
		// Remote already holds the compressed JPEG result of the same asset.
		setupRemote("/Camera Roll/photo.jpg")

		vi.mocked(secureStore.get).mockResolvedValue({ ...ENABLED_CONFIG, compress: true })

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
	})

	it("compress ON: local .png matches remote .png (compression did not win) — no re-upload", async () => {
		setupLocalPng("c2")
		setupRemote("/Camera Roll/photo.png")

		vi.mocked(secureStore.get).mockResolvedValue({ ...ENABLED_CONFIG, compress: true })

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
	})

	it("compress OFF: local .png does NOT match remote .jpg — genuinely different, upload fires", async () => {
		// With compress off the upload never renames, so .png and .jpg are different
		// files. The keys stay extension-bearing and must NOT merge.
		setupLocalPng("c3")
		setupRemote("/Camera Roll/photo.jpg")

		vi.mocked(secureStore.get).mockResolvedValue({ ...ENABLED_CONFIG, compress: false })

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
	})

	it("compress ON: two same-stem assets at different seconds both upload (suffix symmetry holds)", async () => {
		// Two photo.png assets one second apart. Both must get distinct stem-based
		// tree slots (base + iteration-0 suffix), neither matching the single remote
		// entry, so both upload — proving the extension-agnostic keying does not
		// over-collapse distinct assets.
		const { Paths } = await import("@/tests/mocks/expoFileSystem")
		const { ImageManipulator } = await import("expo-image-manipulator")

		// compress is ON and .png passes the manipulator gate, so stub manipulate to
		// produce a LARGER output → compress() returns the original (no rename),
		// keeping this test focused on dedup keying rather than the rename path. Each
		// call yields a UNIQUE manipulated uri so per-asset cleanup doesn't clobber a
		// sibling's temp file.
		let manipCount = 0

		vi.mocked(ImageManipulator.manipulate).mockImplementation(() => {
			const manipulatedUri = `${Paths.cache.uri}/filen-tmp/manip-${manipCount++}.jpg`

			fs.set(manipulatedUri, new Uint8Array(new Array(50).fill(9)))

			const fakeSaveAsync = vi.fn(async () => ({ uri: manipulatedUri }))

			return { renderAsync: vi.fn(async () => ({ saveAsync: fakeSaveAsync, release: vi.fn() })), release: vi.fn() } as any
		})

		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["d1", "d2"] })
		ml.addAsset({
			id: "d1",
			filename: "photo.png",
			uri: "file:///media/d1",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		ml.addAsset({
			id: "d2",
			filename: "photo.png",
			uri: "file:///media/d2",
			mediaType: MediaType.IMAGE,
			creationTime: 2000,
			modificationTime: 3000
		})
		fs.set("file:///media/d1", new Uint8Array([1, 2, 3]))
		fs.set("file:///media/d2", new Uint8Array([4, 5, 6]))

		vi.mocked(secureStore.get).mockResolvedValue({ ...ENABLED_CONFIG, compress: true })

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(2)
	})
})

// ─── #B7 regression: null-creationTime collision key symmetry ─────────────────
// ONE timestamp rule (creationTime ?? modificationTime ?? 0) drives the collision
// suffix, the tree sort AND the upload's `created` parameter. The remote
// `meta.created` therefore mirrors the exact value the local key was derived
// from. (The previous "fix" floored the local KEY to 0 for null creationTime
// while the upload still sent modificationTime as `created` — so the remote
// suffixed slot diverged anyway and the asset re-evaluated every sync.)

describe("#B7 regression — null-creationTime collision key symmetry", () => {
	it("two same-named null-creation assets match their remote counterparts — no re-upload", async () => {
		// Two IMG_0001.jpg assets, BOTH with null creationTime but distinct
		// modificationTimes. The remote tree mirrors what THIS pipeline uploads:
		// created = effectiveCreationTimestamp (= modificationTime here) and — per
		// #B2 — the collision member sits under its SUFFIXED filename.
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["n1", "n2"] })
		ml.addAsset({
			id: "n1",
			filename: "IMG_0001.jpg",
			uri: "file:///media/n1",
			mediaType: MediaType.IMAGE,
			creationTime: null,
			modificationTime: 2000
		})
		ml.addAsset({
			id: "n2",
			filename: "IMG_0001.jpg",
			uri: "file:///media/n2",
			mediaType: MediaType.IMAGE,
			creationTime: null,
			modificationTime: 9999000
		})
		fs.set("file:///media/n1", new Uint8Array([1, 2, 3]))
		fs.set("file:///media/n2", new Uint8Array([4, 5, 6]))

		// n1 (effective 2000 → second 2) wins the base slot; n2 (effective 9999000 →
		// second 9999) carries the iteration-0 suffix and was uploaded as
		// "IMG_0001_9999.jpg", so its remote BASE key equals the local suffixed key.
		const basePath = "/Camera Roll/IMG_0001.jpg"
		const suffixedPath = "/Camera Roll/IMG_0001_9999.jpg"

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({
					files: [
						{ path: basePath, file: { uuid: "remote-base" } },
						{ path: suffixedPath, file: { uuid: "remote-suffixed" } }
					]
				})),
				createDir: vi.fn(async () => ({ uuid: "dir" })),
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
			}
		} as any)

		vi.mocked(unwrapFileMeta).mockImplementation(
			(file: any) =>
				({
					meta:
						file.uuid === "remote-suffixed"
							? { name: "IMG_0001_9999.jpg", created: 9999000n, modified: 9999000n }
							: { name: "IMG_0001.jpg", created: 2000n, modified: 2000n }
				}) as any
		)

		await cameraUpload.sync()

		// Both local files map to slots already present remotely → no uploads.
		expect(transfers.upload).not.toHaveBeenCalled()
	})
})

// ─── B7: ONE timestamp rule feeds the upload `created` parameter ──────────────

describe("B7 — upload `created` uses effectiveCreationTimestamp", () => {
	function setupAsset(creationTime: number | null, modificationTime: number | null) {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["a1"] })
		ml.addAsset({
			id: "a1",
			filename: "photo.jpg",
			uri: "file:///media/a1",
			mediaType: MediaType.IMAGE,
			creationTime,
			modificationTime
		})
		fs.set("file:///media/a1", new Uint8Array([1, 2, 3]))
	}

	it("null creationTime falls back to modificationTime — the SAME value the dedup key uses", async () => {
		setupAsset(null, 5000)

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledWith(
			expect.objectContaining({
				created: 5000,
				modified: 5000
			})
		)
	})

	it("both timestamps null → created is epoch 0 (NOT undefined), so the remote identity matches the local '0' key", async () => {
		setupAsset(null, null)

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)

		const args = vi.mocked(transfers.upload).mock.calls[0]?.[0] as { created?: number }

		expect(args.created).toBe(0)
	})

	it("creationTime 0 is a valid epoch timestamp and survives as created: 0", async () => {
		setupAsset(0, 2000)

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)

		const args = vi.mocked(transfers.upload).mock.calls[0]?.[0] as { created?: number }

		expect(args.created).toBe(0)
	})
})

// ─── B2: collision members upload under their collision-resolved name ─────────
// Backend contract: same name + same parent = NEW VERSION (silently replaces).
// Uploading every collision member under the plain name made the newest member
// silently replace its siblings remotely. Members now upload under the suffixed
// basename their tree key carries, so the remote base keys reproduce the local
// keys exactly and siblings coexist.

describe("B2 — collision-resolved upload names", () => {
	function setupTwoSameNamed() {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["a1", "a2"] })
		ml.addAsset({
			id: "a1",
			filename: "IMG_0001.jpg",
			uri: "file:///media/a1",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		ml.addAsset({
			id: "a2",
			filename: "IMG_0001.jpg",
			uri: "file:///media/a2",
			mediaType: MediaType.IMAGE,
			creationTime: 2000,
			modificationTime: 3000
		})
		fs.set("file:///media/a1", new Uint8Array([1, 2, 3]))
		fs.set("file:///media/a2", new Uint8Array([4, 5, 6]))
	}

	it("two same-named assets upload under DISTINCT names: plain base + suffixed member (no versioning collision)", async () => {
		setupTwoSameNamed()

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(2)

		const names = vi.mocked(transfers.upload).mock.calls.map(call => (call[0] as { name?: string }).name)

		// Oldest (creationTime 1000) wins the base slot → plain name; the second
		// (creationTime 2000 → second 2) carries the iteration-0 suffix.
		expect(names).toContain("IMG_0001.jpg")
		expect(names).toContain("IMG_0001_2.jpg")
		expect(new Set(names).size).toBe(2)
	})

	it("an md5-cached collision member with a plain-named remote counterpart does NOT re-upload (migration shield)", async () => {
		// Migration scenario: pre-B2, the collision member was uploaded under its
		// PLAIN name (silently versioning the base member). Remotely there is ONE
		// plain-named file; locally the member's tree key was ALREADY suffixed and
		// its md5-cache entry exists. After B2 the suffixed local key has no remote
		// counterpart — the md5 entry must keep shielding it from re-upload.
		setupTwoSameNamed()

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({
					files: [{ path: "/Camera Roll/IMG_0001.jpg", file: { uuid: "remote-1" } }]
				})),
				createDir: vi.fn(async () => ({ uuid: "dir" })),
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
			}
		} as any)

		vi.mocked(unwrapFileMeta).mockReturnValue({
			meta: { name: "IMG_0001.jpg", created: 1000n, modified: 2000n }
		} as any)

		// The member's entry under its (already-suffixed) local key — legacy string shape.
		cameraUploadState.hashes.set("/camera roll/img_0001_2.jpg", "mock-md5")

		await cameraUpload.sync()

		// Base member matches the remote plain file; suffixed member is shielded.
		expect(transfers.upload).not.toHaveBeenCalled()
	})

	it("suffix composes onto the FINAL name after the compress extension rewrite (photo.png → photo_2.jpg)", async () => {
		const { Paths } = await import("@/tests/mocks/expoFileSystem")
		const { ImageManipulator } = await import("expo-image-manipulator")

		// Compression WINS (smaller output) → compress() rewrites .png → .jpg. Each
		// manipulate call yields a unique uri so per-asset cleanup doesn't clobber a
		// sibling's temp file.
		let manipCount = 0

		vi.mocked(ImageManipulator.manipulate).mockImplementation(() => {
			const manipulatedUri = `${Paths.cache.uri}/filen-tmp/manip-b2-${manipCount++}.jpg`

			fs.set(manipulatedUri, new Uint8Array([9]))

			const fakeSaveAsync = vi.fn(async () => ({ uri: manipulatedUri }))

			return { renderAsync: vi.fn(async () => ({ saveAsync: fakeSaveAsync, release: vi.fn() })), release: vi.fn() } as any
		})

		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["c1", "c2"] })
		ml.addAsset({
			id: "c1",
			filename: "photo.png",
			uri: "file:///media/c1",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		ml.addAsset({
			id: "c2",
			filename: "photo.png",
			uri: "file:///media/c2",
			mediaType: MediaType.IMAGE,
			creationTime: 2000,
			modificationTime: 3000
		})
		fs.set("file:///media/c1", new Uint8Array(new Array(100).fill(1)))
		fs.set("file:///media/c2", new Uint8Array(new Array(100).fill(2)))

		vi.mocked(secureStore.get).mockResolvedValue({ ...ENABLED_CONFIG, compress: true })

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(2)

		const names = vi.mocked(transfers.upload).mock.calls.map(call => (call[0] as { name?: string }).name)

		// Rewritten extension on both; the collision member's suffix sits BEFORE the
		// final (rewritten) extension.
		expect(names).toContain("photo.jpg")
		expect(names).toContain("photo_2.jpg")
	})
})

// ─── E2/B8: raw dedup keys — literal %XX never decodes ────────────────────────
// The remote listing's `file.path` is the RAW decrypted name. The old pipeline
// percent-DECODED it (and round-tripped the local side through join's encode +
// normalize's decode), so a literal well-formed %XX in a real filename corrupted
// the remote key and the asset re-uploaded forever.

describe("E2/B8 — raw dedup keys (literal %XX filenames)", () => {
	function setupLocalAndRemoteSameName(filename: string) {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["a1"] })
		ml.addAsset({
			id: "a1",
			filename,
			uri: "file:///media/a1",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		fs.set("file:///media/a1", new Uint8Array([1, 2, 3]))

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({
					files: [{ path: `/Camera Roll/${filename}`, file: { uuid: "remote-1" } }]
				})),
				createDir: vi.fn(async () => ({ uuid: "dir" })),
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
			}
		} as any)

		vi.mocked(unwrapFileMeta).mockReturnValue({
			meta: { name: filename, created: 1000n, modified: 2000n }
		} as any)
	}

	it("a filename containing literal %20 produces IDENTICAL local and remote keys — no re-upload", async () => {
		setupLocalAndRemoteSameName("photo %20 test.jpg")

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
	})

	it("a filename containing literal %2F never gains a phantom separator — keys match, no re-upload", async () => {
		setupLocalAndRemoteSameName("a%2Fb.jpg")

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
	})

	it("a filename with a malformed % (e.g. 'Invoice 50%.jpg') matches its remote counterpart", async () => {
		setupLocalAndRemoteSameName("Invoice 50%.jpg")

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
	})

	it("%XX-named uploads store their md5 entry under the asset id (name-agnostic keying)", async () => {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["a1"] })
		ml.addAsset({
			id: "a1",
			filename: "photo %20 test.jpg",
			uri: "file:///media/a1",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		fs.set("file:///media/a1", new Uint8Array([1, 2, 3]))

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(cameraUploadState.hashes.get("a1")).toMatchObject({
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})
	})
})

// ─── B4: md5-cache pruning + "Re-upload deleted photos" mirror mode ───────────

describe("B4 — md5-cache pruning and mirror mode", () => {
	function setupAsset() {
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

	function setupRemoteWith(paths: string[]) {
		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({
					files: paths.map((path, index) => ({ path, file: { uuid: `remote-${index}` } }))
				})),
				createDir: vi.fn(async () => ({ uuid: "dir" })),
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
			}
		} as any)

		vi.mocked(unwrapFileMeta).mockReturnValue({
			meta: { name: "photo.jpg", created: 1000n, modified: 2000n }
		} as any)
	}

	function enableMirrorMode() {
		vi.mocked(secureStore.get).mockImplementation(async (key: string) => {
			if (key === CAMERA_UPLOAD_REUPLOAD_DELETED_SECURE_STORE_KEY) {
				return true as any
			}

			return ENABLED_CONFIG as any
		})
	}

	it("pruning removes entries whose local asset is gone (foreground, clean listing)", async () => {
		setupAsset()

		cameraUploadState.hashes.set("/camera roll/photo.jpg", {
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})
		cameraUploadState.hashes.set("/camera roll/deleted-from-device.jpg", {
			md5: "stale",
			verifiedModificationTime: 1
		})

		await cameraUpload.sync()

		// The local-gone key is pruned; the live asset's legacy entry is re-keyed to its id.
		expect(cameraUploadState.hashes.has("/camera roll/deleted-from-device.jpg")).toBe(false)
		expect(cameraUploadState.hashes.has("/camera roll/photo.jpg")).toBe(false)
		expect(cameraUploadState.hashes.get("a1")).toEqual({
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})
	})

	it("background passes do NOT prune (their tree is filtered, not authoritative)", async () => {
		setupAsset()

		cameraUploadState.hashes.set("/camera roll/video-or-gone.mp4", {
			md5: "stale",
			verifiedModificationTime: 1
		})

		await cameraUpload.sync({ background: true })

		expect(cameraUploadState.hashes.has("/camera roll/video-or-gone.mp4")).toBe(true)
	})

	it("a degraded LOCAL listing does NOT prune (absences are not evidence)", async () => {
		const { Query } = await import("@/tests/mocks/expoMediaLibrary")

		vi.mocked(secureStore.get).mockResolvedValue({ ...ENABLED_CONFIG, albumIds: ["album-1", "album-bad"] })

		setupAsset()
		ml.addAlbum({ id: "album-bad", title: "Bad Album", assetIds: ["b1"] })
		ml.addAsset({
			id: "b1",
			filename: "bad.jpg",
			uri: "file:///media/b1",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		fs.set("file:///media/b1", new Uint8Array([4, 5, 6]))

		// The bad album's assets are absent from the tree this pass — their cache
		// entries must survive.
		cameraUploadState.hashes.set("/bad album/bad.jpg", {
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})

		const originalExeForMetadata = Query.prototype.exeForMetadata
		const spy = vi.spyOn(Query.prototype, "exeForMetadata").mockImplementation(async function (this: any) {
			if (this.albumFilter?.id === "album-bad") {
				throw new Error("album query failed")
			}

			return await originalExeForMetadata.call(this)
		})

		try {
			await cameraUpload.sync()
		} finally {
			spy.mockRestore()
		}

		expect(cameraUploadState.hashes.has("/bad album/bad.jpg")).toBe(true)
	})

	it("a legacy path-keyed entry still shields via the read fallback while migration hasn't run (degraded local pass)", async () => {
		const { Query } = await import("@/tests/mocks/expoMediaLibrary")

		vi.mocked(secureStore.get).mockResolvedValue({ ...ENABLED_CONFIG, albumIds: ["album-1", "album-bad"] })

		setupAsset()
		ml.addAlbum({ id: "album-bad", title: "Bad Album", assetIds: [] })

		// Legacy (pre-id-keying) entry under the tree path; the degraded pass skips the
		// prune/migration, so the delta's shield lookup must fall back to the path key.
		cameraUploadState.hashes.set("/camera roll/photo.jpg", {
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})

		const originalExeForMetadata = Query.prototype.exeForMetadata
		const spy = vi.spyOn(Query.prototype, "exeForMetadata").mockImplementation(async function (this: any) {
			if (this.albumFilter?.id === "album-bad") {
				throw new Error("album query failed")
			}

			return await originalExeForMetadata.call(this)
		})

		try {
			await cameraUpload.sync()
		} finally {
			spy.mockRestore()
		}

		// Shielded through the fallback; the entry stays under the path key (no migration
		// on a degraded pass — its absences and mappings are not authoritative).
		expect(transfers.upload).not.toHaveBeenCalled()
		expect(cameraUploadState.hashes.has("/camera roll/photo.jpg")).toBe(true)
		expect(cameraUploadState.hashes.has("a1")).toBe(false)
	})

	it("mirror mode OFF (default): a remote-absent entry keeps shielding — no drop, no upload", async () => {
		setupAsset()
		setupRemoteWith([])

		cameraUploadState.hashes.set("/camera roll/photo.jpg", {
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
		expect(cameraUploadState.hashes.has("a1")).toBe(true)
	})

	it("mirror mode ON + clean listing: the remote-absent entry is dropped and the photo re-uploads", async () => {
		setupAsset()
		setupRemoteWith([])
		enableMirrorMode()

		cameraUploadState.hashes.set("/camera roll/photo.jpg", {
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
		// Re-recorded after the successful upload, under the asset id.
		expect(cameraUploadState.hashes.get("a1")).toMatchObject({
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})
	})

	it("mirror mode ON: content dedup must not cancel the re-upload, or the wave never converges", async () => {
		// Mirror mode asks for anything missing from its remote PATH to be put back. If the content
		// check cancels that because the same bytes sit in the directory under another name, the
		// setting is silently overridden AND the pass never converges: the mirror wave drops the shield
		// entry every time, the skip re-creates it, and the asset pays a full MD5 + BLAKE3 read on
		// every foreground sync, forever.
		setupAsset()
		enableMirrorMode()

		// The tree key is absent remotely (so mirror fires), but the same content IS in the directory
		// under a different name — the rename case.
		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({
					files: [{ path: "/Camera Roll/renamed.jpg", file: { uuid: "remote-1" } }]
				})),
				createDir: vi.fn(async () => ({ uuid: "dir" })),
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
			}
		} as any)

		vi.mocked(unwrapFileMeta).mockReturnValue({
			meta: {
				name: "renamed.jpg",
				created: 1000n,
				modified: 2000n,
				size: 3n,
				hash: blake3BytesForContent("mock-md5")
			}
		} as any)

		cameraUploadState.hashes.set("a1", {
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
	})

	it("mirror mode ON: entries present remotely are NOT dropped (no upload either)", async () => {
		setupAsset()
		setupRemoteWith(["/Camera Roll/photo.jpg"])
		enableMirrorMode()

		cameraUploadState.hashes.set("/camera roll/photo.jpg", {
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
		expect(cameraUploadState.hashes.has("a1")).toBe(true)
	})

	it("mirror mode ON + DEGRADED listing: nothing is dropped (absences are not evidence), no upload", async () => {
		setupAsset()
		enableMirrorMode()

		// Remote listing returns nothing but reports scan errors → degraded.
		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async (_dir: any, _progress: any, errorCallback: any) => {
					errorCallback.onErrors([new Error("subtree failed")])

					return { files: [] }
				}),
				createDir: vi.fn(async () => ({ uuid: "dir" }))
			}
		} as any)

		cameraUploadState.hashes.set("/camera roll/photo.jpg", {
			md5: "mock-md5",
			verifiedModificationTime: 2000
		})

		await cameraUpload.sync()

		// The entry survived (re-keyed by the clean LOCAL pass) and kept shielding
		// the (still-cached) photo — the degraded REMOTE listing dropped nothing.
		expect(cameraUploadState.hashes.has("a1")).toBe(true)
		expect(transfers.upload).not.toHaveBeenCalled()
	})
})

// ─── B1 regression: compress copy must overwrite the staging file ─────────────
// compress() copies the compressed output back onto the tmp staging file, which
// ALWAYS exists by construction (the asset was copied into it first). Native copy
// throws when the destination exists unless { overwrite: true } — without it every
// compression-wins upload failed and the asset was silently skipped after
// MAX_UPLOAD_FAILURES strikes.

describe("B1 regression — compress copy overwrites the existing staging file", () => {
	it("mock parity: File.copy onto an existing destination throws without overwrite and succeeds with it", async () => {
		const { File: MockFile } = await import("@/tests/mocks/expoFileSystem")

		fs.set("file:///cache/src.bin", new Uint8Array([1]))
		fs.set("file:///cache/dst.bin", new Uint8Array([2]))

		const src = new MockFile("file:///cache/src.bin")
		const dst = new MockFile("file:///cache/dst.bin")

		// copy() is async since expo-file-system 56 (the mock mirrors that): overwrite
		// conflicts surface as rejections, not synchronous throws.
		await expect(src.copy(dst)).rejects.toThrow("Destination already exists")
		await expect(src.copy(dst, { overwrite: true })).resolves.toBeUndefined()
		expect(fs.get("file:///cache/dst.bin")).toEqual(new Uint8Array([1]))
	})

	it("compression-wins path copies the compressed output onto the existing staging file and the upload proceeds", async () => {
		const { Paths } = await import("@/tests/mocks/expoFileSystem")
		const { ImageManipulator } = await import("expo-image-manipulator")

		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["b1a"] })
		ml.addAsset({
			id: "b1a",
			filename: "photo.jpg",
			uri: "file:///media/b1a",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		fs.set("file:///media/b1a", new Uint8Array(new Array(100).fill(1)))

		vi.mocked(secureStore.get).mockResolvedValueOnce({ ...ENABLED_CONFIG, compress: true })

		// Manipulated output is smaller — compression wins and gets copied onto the
		// staging file (which still holds the 100-byte original).
		const manipulatedUri = `${Paths.cache.uri}/filen-tmp/photo-manip.jpg`

		fs.set(manipulatedUri, new Uint8Array([9, 9, 9]))

		const fakeSaveAsync = vi.fn(async () => ({ uri: manipulatedUri }))
		const fakeContext = { renderAsync: vi.fn(async () => ({ saveAsync: fakeSaveAsync, release: vi.fn() })), release: vi.fn() }

		vi.mocked(ImageManipulator.manipulate).mockReturnValueOnce(fakeContext as any)

		let uploadedBytes: Uint8Array | undefined

		vi.mocked(transfers.upload).mockImplementationOnce(async (args: any) => {
			const entry = fs.get(args.localFileOrDir.uri)

			uploadedBytes = entry instanceof Uint8Array ? entry : undefined

			return { files: [] } as any
		})

		await cameraUpload.sync()

		// The staging file existed when compress() copied onto it — the upload still
		// ran, with the compressed bytes, and no error was recorded.
		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(uploadedBytes).toEqual(new Uint8Array([9, 9, 9]))
		expect(mockSetErrors).not.toHaveBeenCalled()
	})
})

// ─── B3: degraded remote listing is surfaced, sync still proceeds ─────────────
// Entries inside errored subtrees are silently ABSENT from listDirRecursiveWithPaths'
// result while the call still resolves Ok. The scan errors are now collected: ONE
// degraded-listing entry is recorded into the error store and the pass continues
// (a permanent scan error must not stop camera backup forever).

describe("B3 — degraded remote listing", () => {
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

	it("scan errors record ONE degraded-listing error and the sync pass still uploads", async () => {
		setupSingleAsset()

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async (_dir: any, _progress: any, errorCallback: any) => {
					// Two error batches from different subtrees — still ONE recorded entry.
					errorCallback.onErrors([new Error("subtree A failed")])
					errorCallback.onErrors([new Error("subtree B failed")])

					return { files: [] }
				}),
				createDir: vi.fn(async () => ({ uuid: "dir" }))
			}
		} as any)

		await cameraUpload.sync()

		// The pass proceeded: the local asset still uploaded.
		expect(transfers.upload).toHaveBeenCalledTimes(1)

		// Exactly one error entry, carrying the degraded-listing message.
		expect(mockSetErrors).toHaveBeenCalledTimes(1)

		const updater = mockSetErrors.mock.calls[0]?.[0] as (prev: unknown[]) => any[]
		const entries = updater([])

		expect(entries).toHaveLength(1)
		expect(entries[0].error).toBeInstanceOf(Error)
		expect((entries[0].error as Error).message).toBe("camera_upload_remote_listing_incomplete")
	})

	it("no scan errors → no degraded-listing entry (negative case)", async () => {
		setupSingleAsset()

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(mockSetErrors).not.toHaveBeenCalled()
	})
})

// ─── B5: staging bound — at most 4 assets staged in filen-tmp concurrently ────

describe("B5 — staging bound (Semaphore(4) around the per-delta pipeline)", () => {
	it("with 8 pending deltas at most 4 assets are staged in filen-tmp simultaneously", async () => {
		const letters = ["a", "b", "c", "d", "e", "f", "g", "h"]

		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: letters.map(letter => `s-${letter}`) })

		for (let index = 0; index < letters.length; index++) {
			const id = `s-${letters[index]}`

			ml.addAsset({
				id,
				filename: `photo-${letters[index]}.jpg`,
				uri: `file:///media/${id}`,
				mediaType: MediaType.IMAGE,
				creationTime: 1000 * (index + 1),
				modificationTime: 1000 * (index + 1)
			})

			fs.set(`file:///media/${id}`, new Uint8Array([1, 2, 3]))
		}

		let maxStaged = 0

		vi.mocked(transfers.upload).mockImplementation(async () => {
			const staged = [...fs.entries()].filter(([key, value]) => key.includes("/filen-tmp/") && value instanceof Uint8Array).length

			maxStaged = Math.max(maxStaged, staged)

			// Yield a macrotask so the other pipelines can progress to their own
			// staging copies while this upload is "in flight".
			await new Promise(resolve => setTimeout(resolve, 5))

			return { files: [] } as any
		})

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(8)
		expect(maxStaged).toBeGreaterThan(0)
		// Without the staging semaphore every delta copies its asset into filen-tmp
		// up front, so this observes 8 staged files; the Semaphore(4) bounds it.
		expect(maxStaged).toBeLessThanOrEqual(4)
	})
})

// ─── B5: ensureParentDirectoryExists in-flight dedupe ─────────────────────────
// Concurrent deltas for the same album each fired their own createDir round trip
// before the 60s TTL cache populated. The first caller now creates an in-flight
// promise keyed like the TTL cache; the rest await it.

describe("B5 — ensureParentDirectoryExists in-flight dedupe", () => {
	it("N concurrent calls for the same album fire exactly one createDir", async () => {
		let resolveCreateDir: ((value: { uuid: string }) => void) | undefined
		const createDir = vi.fn(
			() =>
				new Promise(resolve => {
					resolveCreateDir = resolve
				})
		)

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { createDir }
		} as any)

		const signal = new AbortController().signal
		const calls = Array.from({ length: 5 }, () =>
			(cameraUpload as any).ensureParentDirectoryExists({
				config: ENABLED_CONFIG,
				signal,
				originalPath: "/Camera Roll/photo.jpg"
			})
		)

		// Let every caller reach the in-flight gate before resolving the createDir.
		await new Promise(resolve => setTimeout(resolve, 0))

		resolveCreateDir?.({ uuid: "created-dir" })

		const dirs = await Promise.all(calls)

		expect(createDir).toHaveBeenCalledTimes(1)
		// All callers received the SAME resolved directory instance.
		expect(new Set(dirs).size).toBe(1)
	})

	it("the in-flight result populates the TTL cache so later calls do not re-create", async () => {
		const createDir = vi.fn(async () => ({ uuid: "created-dir" }))

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { createDir }
		} as any)

		const signal = new AbortController().signal
		const params = { config: ENABLED_CONFIG, signal, originalPath: "/Camera Roll/photo.jpg" }

		await Promise.all([
			(cameraUpload as any).ensureParentDirectoryExists(params),
			(cameraUpload as any).ensureParentDirectoryExists(params)
		])

		// Sequential follow-up — served from the TTL cache, not a new createDir.
		await (cameraUpload as any).ensureParentDirectoryExists(params)

		expect(createDir).toHaveBeenCalledTimes(1)
	})

	it("a failed createDir clears the in-flight slot so the next call can retry", async () => {
		const createDir = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ uuid: "created-dir" })

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { createDir }
		} as any)

		const signal = new AbortController().signal
		const params = { config: ENABLED_CONFIG, signal, originalPath: "/Camera Roll/photo.jpg" }

		await expect((cameraUpload as any).ensureParentDirectoryExists(params)).rejects.toThrow("boom")
		await expect((cameraUpload as any).ensureParentDirectoryExists(params)).resolves.toBeDefined()

		expect(createDir).toHaveBeenCalledTimes(2)

		// The in-flight map is empty once everything settled.
		expect(((cameraUpload as any).ensureParentDirectoryExistsInFlight as Map<string, unknown>).size).toBe(0)
	})
})

// ─── B10: silent enumeration drops are surfaced ───────────────────────────────
// Per-asset and per-album enumeration rejections were filtered out of the
// allSettled results and discarded — an asset whose info fetch persistently fails
// was permanently excluded from backup with zero signal. Each rejection is now
// recorded once per pass in the error store (the failing entry stays excluded
// from the tree, which is correct).

describe("B10 — enumeration failures are surfaced", () => {
	it("an asset without a usable filename records an error entry with the asset id and the others still sync", async () => {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["good", "bad"] })
		ml.addAsset({
			id: "good",
			filename: "good.jpg",
			uri: "file:///media/good",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		ml.addAsset({
			id: "bad",
			filename: null,
			uri: "file:///media/bad",
			mediaType: MediaType.IMAGE,
			creationTime: 2000,
			modificationTime: 3000
		})
		fs.set("file:///media/good", new Uint8Array([1, 2, 3]))
		fs.set("file:///media/bad", new Uint8Array([4, 5, 6]))

		await cameraUpload.sync()

		// The good asset still uploaded.
		expect(transfers.upload).toHaveBeenCalledTimes(1)

		// One error entry for the bad asset, carrying the asset identifier.
		const entries = mockSetErrors.mock.calls.map(call => (call[0] as (prev: unknown[]) => any[])([])).flat()
		const badEntries = entries.filter(entry => entry.assetId === "bad")

		expect(badEntries).toHaveLength(1)
		expect((badEntries[0].error as Error).message).toBe("camera_upload_asset_filename_missing")
	})

	it("an asset that is unusable in two selected albums is recorded once per pass (dedupe)", async () => {
		vi.mocked(secureStore.get).mockResolvedValue({ ...ENABLED_CONFIG, albumIds: ["album-1", "album-2"] })

		ml.addAlbum({ id: "album-1", title: "Album One", assetIds: ["bad"] })
		ml.addAlbum({ id: "album-2", title: "Album Two", assetIds: ["bad"] })
		ml.addAsset({
			id: "bad",
			filename: null,
			uri: "file:///media/bad",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		fs.set("file:///media/bad", new Uint8Array([1, 2, 3]))

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()

		const entries = mockSetErrors.mock.calls.map(call => (call[0] as (prev: unknown[]) => any[])([])).flat()
		const badEntries = entries.filter(entry => entry.assetId === "bad")

		expect(badEntries).toHaveLength(1)
	})

	it("a rejecting album query records an album-level error entry and other albums still sync", async () => {
		const { Query } = await import("@/tests/mocks/expoMediaLibrary")

		vi.mocked(secureStore.get).mockResolvedValue({ ...ENABLED_CONFIG, albumIds: ["album-good", "album-bad"] })

		ml.addAlbum({ id: "album-good", title: "Good Album", assetIds: ["g1"] })
		ml.addAlbum({ id: "album-bad", title: "Bad Album", assetIds: ["b1"] })
		ml.addAsset({
			id: "g1",
			filename: "good.jpg",
			uri: "file:///media/g1",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		ml.addAsset({
			id: "b1",
			filename: "bad.jpg",
			uri: "file:///media/b1",
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})
		fs.set("file:///media/g1", new Uint8Array([1, 2, 3]))
		fs.set("file:///media/b1", new Uint8Array([4, 5, 6]))

		const originalExeForMetadata = Query.prototype.exeForMetadata
		const spy = vi.spyOn(Query.prototype, "exeForMetadata").mockImplementation(async function (this: any) {
			if (this.albumFilter?.id === "album-bad") {
				throw new Error("album query failed")
			}

			return await originalExeForMetadata.call(this)
		})

		try {
			await cameraUpload.sync()
		} finally {
			spy.mockRestore()
		}

		// The good album's asset still uploaded.
		expect(transfers.upload).toHaveBeenCalledTimes(1)

		const entries = mockSetErrors.mock.calls.map(call => (call[0] as (prev: unknown[]) => any[])([])).flat()
		const albumFailureEntries = entries.filter(
			entry => entry.error instanceof Error && (entry.error as Error).message === "camera_upload_album_listing_failed"
		)

		expect(albumFailureEntries).toHaveLength(1)
	})
})

// ─── canonicalRemoteName (SDK name canonicalization, #issue-colon-albums) ────

describe("canonicalRemoteName", () => {
	it("returns SDK-valid names byte-identical (parseName passthrough)", () => {
		expect(canonicalRemoteName("IMG_0001.JPG")).toBe("IMG_0001.JPG")
		expect(canonicalRemoteName("Camera Roll")).toBe("Camera Roll")
	})

	it("keeps valid fullwidth names untouched instead of quote-escaping them", () => {
		// A CJK title with fullwidth punctuation is VALID — it must not be re-encoded,
		// or every existing folder using one would silently migrate.
		expect(canonicalRemoteName("旅行：2024")).toBe("旅行：2024")
	})

	it("falls back to the encoded form for names the SDK rejects", () => {
		expect(canonicalRemoteName("12:30.png")).toBe("12：30.png")
	})

	it("returns null when no valid remote name is derivable", () => {
		expect(canonicalRemoteName("x".repeat(300))).toBeNull()
	})

	it("memoizes per name — repeats do not re-cross the FFI", () => {
		const name = "memo-probe-unique.jpg"

		canonicalRemoteName(name)

		const callsAfterFirst = mockParseName.mock.calls.filter(call => call[0] === name).length

		canonicalRemoteName(name)
		canonicalRemoteName(name)

		expect(mockParseName.mock.calls.filter(call => call[0] === name).length).toBe(callsAfterFirst)
	})
})

// ─── sync flow — SDK-rejected names (canonical encoding, loop invariants) ────

describe("sync flow with SDK-rejected names", () => {
	function setupColonAsset() {
		ml.addAlbum({ id: "album-1", title: "Camera Roll", assetIds: ["a1"] })

		const uri = "file:///media/a1"

		ml.addAsset({
			id: "a1",
			filename: "12:30.png",
			uri,
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})

		fs.set(uri, new Uint8Array([1, 2, 3]))
	}

	it("uploads a forbidden-char filename under its encoded name", async () => {
		setupColonAsset()

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
		expect(transfers.upload).toHaveBeenCalledWith(expect.objectContaining({ name: "12：30.png" }))
	})

	it("does NOT re-upload when the remote listing already holds the encoded name (no sync loop)", async () => {
		setupColonAsset()

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({
					files: [
						{
							path: "/Camera Roll/12：30.png",
							file: { uuid: "remote-1" }
						}
					]
				})),
				createDir: vi.fn(async () => ({ uuid: "dir" })),
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
			}
		} as any)

		vi.mocked(unwrapFileMeta).mockReturnValue({
			meta: { name: "12：30.png", created: 1000n, modified: 2000n }
		} as any)

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
	})

	it("creates the album folder under the encoded title and uploads into it", async () => {
		// id must be in ENABLED_CONFIG.albumIds — the title is the part under test.
		ml.addAlbum({ id: "album-1", title: "2024: Japan", assetIds: ["a2"] })

		const uri = "file:///media/a2"

		ml.addAsset({
			id: "a2",
			filename: "photo.jpg",
			uri,
			mediaType: MediaType.IMAGE,
			creationTime: 1000,
			modificationTime: 2000
		})

		fs.set(uri, new Uint8Array([1, 2, 3]))

		const createDir = vi.fn(async () => ({ uuid: "album-dir" }))

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				listDirRecursiveWithPaths: vi.fn(async () => ({ files: [] })),
				createDir,
				getDirOptional: vi.fn(async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } }))
			}
		} as any)

		await cameraUpload.sync()

		expect(createDir).toHaveBeenCalledWith(expect.anything(), "2024： Japan", expect.anything())
		expect(transfers.upload).toHaveBeenCalledWith(expect.objectContaining({ name: "photo.jpg" }))
	})
})

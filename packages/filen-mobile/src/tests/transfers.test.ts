import { vi, describe, it, expect, beforeEach } from "vitest"

const {
	MockPauseSignal,
	createdPauseSignalInstances,
	mockUploadFile,
	mockUploadDirRecursively,
	mockDownloadFileToPath,
	mockDownloadDirRecursively,
	mockSetTransfers,
	mockAddFinishedTransfer,
	mockDriveItemsQueryUpdate,
	mockGetSdkClients,
	mockTransfersState,
	mockCreateCompositePauseSignal,
	mockCreateCompositeAbortSignal,
	mockWrapAbortSignalForSdk,
	mockUnwrapDirMeta,
	mockUnwrapFileMeta,
	mockUnwrapParentUuid,
	mockFileCacheHas,
	mockFileCacheGet
} = vi.hoisted(() => {
	const mockUploadFile = vi.fn().mockResolvedValue({
		uuid: "uploaded-file-uuid",
		parent: { tag: "Uuid", inner: ["parent-uuid"] }
	})

	const mockUploadDirRecursively = vi.fn().mockResolvedValue(undefined)
	const mockDownloadFileToPath = vi.fn().mockResolvedValue(undefined)
	const mockDownloadDirRecursively = vi.fn().mockResolvedValue(undefined)

	const state = { transfers: [] as unknown[] }

	const mockSetTransfers = vi.fn((fn: unknown) => {
		if (typeof fn === "function") {
			state.transfers = (fn as (prev: unknown[]) => unknown[])(state.transfers)
		} else {
			state.transfers = fn as unknown[]
		}
	})

	const mockGetSdkClients = vi.fn().mockResolvedValue({
		authedSdkClient: {
			uploadFile: mockUploadFile,
			uploadDirRecursively: mockUploadDirRecursively,
			downloadFileToPath: mockDownloadFileToPath,
			downloadDirRecursively: mockDownloadDirRecursively
		}
	})

	const mockAddFinishedTransfer = vi.fn()

	const mockDriveItemsQueryUpdate = vi.fn()

	// Tracks every MockPauseSignal instance created via `new PauseSignal()` in the source.
	// Plain array — not a vi.fn() — so vi.clearAllMocks() does not clear it.
	const createdPauseSignalInstances: InstanceType<typeof MockPauseSignal>[] = []

	class MockPauseSignal {
		private _paused = false
		private _listeners = new Map<string, Set<() => void>>()

		constructor() {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			createdPauseSignalInstances.push(this as any)
		}

		pause() {
			this._paused = true
			this._listeners.get("pause")?.forEach(fn => fn())
		}

		resume() {
			this._paused = false
			this._listeners.get("resume")?.forEach(fn => fn())
		}

		isPaused() {
			return this._paused
		}

		getSignal() {
			return {}
		}

		addEventListener(event: string, fn: () => void) {
			if (!this._listeners.has(event)) {
				this._listeners.set(event, new Set())
			}

			const set = this._listeners.get(event) as Set<() => void>

			set.add(fn)

			return { remove: () => set.delete(fn) }
		}

		removeEventListener(event: string, fn: () => void) {
			this._listeners.get(event)?.delete(fn)
		}

		removeAllListeners() {
			this._listeners.clear()
		}

		dispose = vi.fn(() => {
			this._listeners.clear()
		})
	}

	const mockCreateCompositePauseSignal = vi.fn((..._signals: unknown[]) => Object.assign(new MockPauseSignal(), { dispose: vi.fn() }))

	const mockCreateCompositeAbortSignal = vi.fn((...signals: AbortSignal[]) => {
		const controller = new AbortController()

		for (const s of signals) {
			if (s.aborted) {
				controller.abort()

				return Object.assign(controller.signal, { dispose: vi.fn() })
			}

			s.addEventListener("abort", () => controller.abort(), { once: true })
		}

		return Object.assign(controller.signal, { dispose: vi.fn() })
	})

	// Returns a fresh wrapped ManagedAbortSignal stand-in per call, each carrying its own uniffiDestroy
	// spy so tests can assert the SDK handle is released (matching the real uniffi binding's reclaim path).
	const mockWrapAbortSignalForSdk = vi.fn(() => ({ uniffiDestroy: vi.fn() }))

	const mockUnwrapDirMeta = vi.fn()
	const mockUnwrapFileMeta = vi.fn()
	const mockUnwrapParentUuid = vi.fn()
	const mockFileCacheHas = vi.fn().mockResolvedValue(false)
	const mockFileCacheGet = vi.fn()

	return {
		MockPauseSignal,
		createdPauseSignalInstances,
		mockUploadFile,
		mockUploadDirRecursively,
		mockDownloadFileToPath,
		mockDownloadDirRecursively,
		mockSetTransfers,
		mockAddFinishedTransfer,
		mockDriveItemsQueryUpdate,
		mockGetSdkClients,
		mockTransfersState: state,
		mockCreateCompositePauseSignal,
		mockCreateCompositeAbortSignal,
		mockWrapAbortSignalForSdk,
		mockUnwrapDirMeta,
		mockUnwrapFileMeta,
		mockUnwrapParentUuid,
		mockFileCacheHas,
		mockFileCacheGet
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

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
		File: class {},
		FilenSdkError: {
			hasInner: vi.fn(() => false),
			getInner: vi.fn(() => new Error("sdk error"))
		},
		ManagedFuture: {
			new: vi.fn(() => ({}))
		},
		AnyNormalDir: {
			Dir: class extends TaggedUnion {
				constructor(dir: unknown) {
					super("Dir", dir)
				}
			},
			Root: class extends TaggedUnion {
				constructor(root: unknown) {
					super("Root", root)
				}
			}
		},
		AnyNormalDir_Tags: {
			Dir: "Dir",
			Root: "Root"
		},
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
		AnyDirWithContext: {
			Normal: class extends TaggedUnion {
				constructor(dir: unknown) {
					super("Normal", dir)
				}
			},
			Shared: class extends TaggedUnion {
				constructor(shared: unknown) {
					super("Shared", shared)
				}
			}
		},
		AnySharedDirWithContext: {
			new: vi.fn(({ dir, shareInfo }: { dir: unknown; shareInfo: unknown }) => ({ dir, shareInfo }))
		},
		AnySharedDir: {
			Dir: class extends TaggedUnion {
				constructor(dir: unknown) {
					super("Dir", dir)
				}
			},
			Root: class extends TaggedUnion {
				constructor(root: unknown) {
					super("Root", root)
				}
			}
		}
	}
})

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@/features/transfers/store/useTransfers.store", () => ({
	default: {
		getState: () => ({
			setTransfers: mockSetTransfers,
			transfers: mockTransfersState.transfers,
			addFinishedTransfer: mockAddFinishedTransfer
		})
	}
}))

vi.mock("@/features/drive/queries/useDriveItems.query", () => ({
	driveItemsQueryUpdate: mockDriveItemsQueryUpdate,
	driveItemsQueryUpdateForNormalParent: mockDriveItemsQueryUpdate
}))

vi.mock("@/lib/cache", () => ({
	default: {
		directoryUuidToAnySharedDirWithContext: new Map(),
		cacheNewFile: vi.fn(),
		cacheNewNormalDir: vi.fn(),
		refreshCachedItem: vi.fn(),
		forgetItem: vi.fn()
	}
}))

vi.mock("@/lib/fileCache", () => ({
	default: {
		has: mockFileCacheHas,
		get: mockFileCacheGet,
		set: vi.fn(),
		remove: vi.fn()
	}
}))

vi.mock("@op-engineering/op-sqlite", async () => await import("@/tests/mocks/opSqlite"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

vi.mock("@/features/drive/drive", () => ({
	default: {
		createDirectory: vi.fn().mockResolvedValue({ data: { uuid: "dir-uuid" } })
	}
}))

vi.mock("@/lib/thumbnails", () => ({
	default: {
		generateFromLocalFile: vi.fn().mockResolvedValue(null)
	}
}))

vi.mock("@/lib/utils", () => ({
	listLocalDirectoryRecursive: vi.fn(() => [])
}))

vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapDirMeta: mockUnwrapDirMeta,
	unwrapFileMeta: mockUnwrapFileMeta,
	unwrapParentUuid: mockUnwrapParentUuid
}))

vi.mock("@/lib/paths", () => ({
	normalizeFilePathForSdk: vi.fn((path: string) => path.replace("file://", "")),
	normalizeFilePathForExpo: vi.fn((path: string) => path)
}))

vi.mock("@/lib/signals", () => ({
	wrapAbortSignalForSdk: mockWrapAbortSignalForSdk,
	// Faithful to the real disposeSdkAbortSignal: it frees the wrapped signal handle (and its
	// controller). The mock-returned wrapped value only carries uniffiDestroy, so free that — keeps the
	// "no uniffi handle leak" assertions meaningful now that disposal routes through this function.
	disposeSdkAbortSignal: vi.fn((signal?: { uniffiDestroy?: () => void }) => {
		signal?.uniffiDestroy?.()
	}),
	PauseSignal: MockPauseSignal,
	createCompositePauseSignal: mockCreateCompositePauseSignal,
	createCompositeAbortSignal: mockCreateCompositeAbortSignal
}))

import transfers from "@/features/transfers/transfers"
import { shouldRemoveSettledTransfer } from "@/features/transfers/transferCore"
import cache from "@/lib/cache"
import { fs, File as MockFile, Directory as MockDir } from "@/tests/mocks/expoFileSystem"
import type * as FileSystem from "expo-file-system"

const FsFile = MockFile as unknown as typeof FileSystem.File
const FsDirectory = MockDir as unknown as typeof FileSystem.Directory

function makeParentDir(uuid: string): any {
	return { tag: "Dir" as const, inner: [{ uuid }] }
}

function makeFileItem(uuid: string, size = 1024n): any {
	return {
		type: "file" as const,
		data: {
			uuid,
			size,
			parent: { tag: "Uuid", inner: ["parent-uuid"] },
			meta: { name: "test.txt" },
			favorited: false,
			region: "us",
			bucket: "bucket",
			timestamp: 1000,
			chunks: 1n,
			canMakeThumbnail: false
		}
	}
}

function makeDirItem(uuid: string): any {
	return {
		type: "directory" as const,
		data: {
			uuid,
			parent: { tag: "Uuid", inner: ["parent-uuid"] },
			color: "default",
			timestamp: 1000,
			favorited: false,
			meta: { name: "testdir" },
			size: 0n,
			decryptedMeta: { name: "testdir" }
		}
	}
}

describe("Transfers", () => {
	beforeEach(() => {
		fs.clear()
		transfers.cancelAll()
		mockTransfersState.transfers = []
		vi.clearAllMocks()

		mockUploadFile.mockResolvedValue({
			uuid: "uploaded-file-uuid",
			parent: { tag: "Uuid", inner: ["parent-uuid"] }
		})

		mockUploadDirRecursively.mockResolvedValue(undefined)
		mockDownloadFileToPath.mockResolvedValue(undefined)
		mockDownloadDirRecursively.mockResolvedValue(undefined)

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				uploadFile: mockUploadFile,
				uploadDirRecursively: mockUploadDirRecursively,
				downloadFileToPath: mockDownloadFileToPath,
				downloadDirRecursively: mockDownloadDirRecursively
			}
		})

		mockUnwrapFileMeta.mockReturnValue({
			shared: false,
			file: { uuid: "uploaded-file-uuid" },
			meta: { name: "test.txt" }
		})

		mockUnwrapDirMeta.mockReturnValue({
			shared: false,
			dir: { uuid: "uploaded-dir-uuid" },
			meta: { name: "testdir" }
		})

		mockUnwrapParentUuid.mockReturnValue("parent-uuid")

		mockFileCacheHas.mockResolvedValue(false)
		mockFileCacheGet.mockResolvedValue(undefined)
	})

	describe("upload", () => {
		describe("file", () => {
			it("uploads file and updates query cache", async () => {
				const file = new FsFile("file:///document/test.txt")
				fs.set(file.uri, new Uint8Array([1, 2, 3]))
				const parent = makeParentDir("parent-uuid")

				const result = await transfers.upload({
					localFileOrDir: file,
					parent,
					hideProgress: true
				})

				expect(mockUploadFile).toHaveBeenCalledTimes(1)
				expect(result!.files).toHaveLength(1)
				expect(result!.directories).toHaveLength(0)
				expect(mockDriveItemsQueryUpdate).toHaveBeenCalledWith(
					expect.objectContaining({
						parentUuid: "parent-uuid"
					})
				)
			})

			it("adds transfer to store when hideProgress is false", async () => {
				const file = new FsFile("file:///document/test.txt")
				fs.set(file.uri, new Uint8Array([1, 2, 3]))
				const parent = makeParentDir("parent-uuid")

				await transfers.upload({
					localFileOrDir: file,
					parent
				})

				expect(mockSetTransfers).toHaveBeenCalled()

				const firstCall = mockSetTransfers.mock.calls[0] as [unknown]
				expect(typeof firstCall[0]).toBe("function")

				const added = (firstCall[0] as (prev: unknown[]) => unknown[])([] as unknown[])
				expect(added).toHaveLength(1)
				expect((added[0] as { id: string }).id).toBeTypeOf("string")
				expect((added[0] as { type: string }).type).toBe("uploadFile")
			})

			it("does not update store when hideProgress is true", async () => {
				const file = new FsFile("file:///document/test.txt")
				fs.set(file.uri, new Uint8Array([1, 2, 3]))
				const parent = makeParentDir("parent-uuid")

				await transfers.upload({
					localFileOrDir: file,
					parent,
					hideProgress: true
				})

				expect(mockSetTransfers).not.toHaveBeenCalled()
			})

			it("epoch-0 created/modified survive to the SDK uploadFile params as 0n (null-guard, not falsy-drop)", async () => {
				// REGRESSION (#B7): `created ? BigInt(created) : undefined` dropped a valid
				// epoch-0 timestamp to undefined, letting the server assign its own created
				// and breaking camera upload's dedup identity for both-null-timestamp assets.
				const file = new FsFile("file:///document/test.txt")
				fs.set(file.uri, new Uint8Array([1, 2, 3]))
				const parent = makeParentDir("parent-uuid")

				await transfers.upload({
					localFileOrDir: file,
					parent,
					hideProgress: true,
					created: 0,
					modified: 0
				})

				expect(mockUploadFile).toHaveBeenCalledTimes(1)

				const params = mockUploadFile.mock.calls[0]?.[0] as { created?: bigint; modified?: bigint }

				expect(params.created).toBe(0n)
				expect(params.modified).toBe(0n)
			})

			it("absent created/modified stay undefined in the SDK uploadFile params", async () => {
				const file = new FsFile("file:///document/test.txt")
				fs.set(file.uri, new Uint8Array([1, 2, 3]))
				const parent = makeParentDir("parent-uuid")

				await transfers.upload({
					localFileOrDir: file,
					parent,
					hideProgress: true
				})

				expect(mockUploadFile).toHaveBeenCalledTimes(1)

				const params = mockUploadFile.mock.calls[0]?.[0] as { created?: bigint; modified?: bigint }

				expect(params.created).toBeUndefined()
				expect(params.modified).toBeUndefined()
			})

			it("second upload succeeds after first upload throws (no residual state blocking retry)", async () => {
				const file = new FsFile("file:///document/test.txt")
				fs.set(file.uri, new Uint8Array([1, 2, 3]))
				const parent = makeParentDir("parent-uuid")

				mockUploadFile.mockRejectedValueOnce(new Error("upload failed"))

				await expect(
					transfers.upload({
						localFileOrDir: file,
						parent,
						hideProgress: true
					})
				).rejects.toThrow("upload failed")

				const result = await transfers.upload({
					localFileOrDir: file,
					parent,
					hideProgress: true
				})

				expect(result).not.toBeNull()
				expect(result!.files).toHaveLength(1)
			})

			it("disposes composite signals on completion", async () => {
				const file = new FsFile("file:///document/test.txt")
				fs.set(file.uri, new Uint8Array([1, 2, 3]))
				const parent = makeParentDir("parent-uuid")

				await transfers.upload({
					localFileOrDir: file,
					parent,
					hideProgress: true
				})

				const compositePause = mockCreateCompositePauseSignal.mock.results[0] as { value: { dispose: ReturnType<typeof vi.fn> } }
				const compositeAbort = mockCreateCompositeAbortSignal.mock.results[0] as { value: { dispose: ReturnType<typeof vi.fn> } }

				expect(compositePause.value.dispose).toHaveBeenCalledTimes(1)
				expect(compositeAbort.value.dispose).toHaveBeenCalledTimes(1)
			})

			it("destroys the wrapped SDK abort signal on completion (no uniffi handle leak)", async () => {
				const file = new FsFile("file:///document/test.txt")
				fs.set(file.uri, new Uint8Array([1, 2, 3]))
				const parent = makeParentDir("parent-uuid")

				await transfers.upload({
					localFileOrDir: file,
					parent,
					hideProgress: true
				})

				const wrapped = mockWrapAbortSignalForSdk.mock.results[0] as { value: { uniffiDestroy: ReturnType<typeof vi.fn> } }

				expect(mockWrapAbortSignalForSdk).toHaveBeenCalledTimes(1)
				expect(wrapped.value.uniffiDestroy).toHaveBeenCalledTimes(1)
			})

			it("disposes the self-created pause signal but not a caller-supplied one", async () => {
				const file = new FsFile("file:///document/test.txt")
				fs.set(file.uri, new Uint8Array([1, 2, 3]))
				const parent = makeParentDir("parent-uuid")

				// No pauseSignal passed: transfers owns the one it allocates and must dispose it.
				await transfers.upload({
					localFileOrDir: file,
					parent,
					hideProgress: true
				})

				const owned = mockCreateCompositePauseSignal.mock.calls[0]?.[1] as { dispose: ReturnType<typeof vi.fn> }

				expect(owned.dispose).toHaveBeenCalledTimes(1)

				mockCreateCompositePauseSignal.mockClear()

				// Caller-supplied pauseSignal: transfers must NOT dispose it (the caller owns its lifecycle).
				const callerPauseSignal = new MockPauseSignal()

				await transfers.upload({
					localFileOrDir: file,
					parent,
					hideProgress: true,
					pauseSignal: callerPauseSignal as unknown as Parameters<typeof transfers.upload>[0]["pauseSignal"]
				})

				expect(callerPauseSignal.dispose).not.toHaveBeenCalled()
			})

			it("throws when local file does not exist", async () => {
				const file = new FsFile("file:///document/nonexistent.txt")
				const parent = makeParentDir("parent-uuid")

				await expect(
					transfers.upload({
						localFileOrDir: file,
						parent,
						hideProgress: true
					})
				).rejects.toThrow("Local file does not exist")
			})

			it("returns null (not an unresolved promise or unexpected value) when aborted", async () => {
				const file = new FsFile("file:///document/test.txt")
				fs.set(file.uri, new Uint8Array([1, 2, 3]))
				const parent = makeParentDir("parent-uuid")
				const controller = new AbortController()

				mockUploadFile.mockImplementation(async () => {
					controller.abort()

					throw new Error("Aborted")
				})

				const result = await transfers.upload({
					localFileOrDir: file,
					parent,
					hideProgress: true,
					signal: controller.signal
				})

				expect(result).toBeNull()
			})

			it("registers and graceful-aborts with external signal when hideProgress is false", async () => {
				const file = new FsFile("file:///document/test.txt")
				fs.set(file.uri, new Uint8Array([1, 2, 3]))
				const parent = makeParentDir("parent-uuid")
				const controller = new AbortController()

				mockSetTransfers.mockClear()

				mockUploadFile.mockImplementation(async () => {
					controller.abort()

					throw new Error("Aborted")
				})

				const result = await transfers.upload({
					localFileOrDir: file,
					parent,
					signal: controller.signal
				})

				expect(result).toBeNull()
				expect(mockSetTransfers).toHaveBeenCalled()
			})

			it("skips query cache update for shared files", async () => {
				const file = new FsFile("file:///document/test.txt")
				fs.set(file.uri, new Uint8Array([1, 2, 3]))
				const parent = makeParentDir("parent-uuid")

				mockUnwrapFileMeta.mockReturnValueOnce({
					shared: true,
					file: { uuid: "uploaded-file-uuid" },
					meta: { name: "test.txt" }
				})

				await transfers.upload({
					localFileOrDir: file,
					parent,
					hideProgress: true
				})

				expect(mockDriveItemsQueryUpdate).not.toHaveBeenCalled()
			})

			it("writes the error to the store entry then removes the settled (errored) transfer when hideProgress is false and upload throws a non-abort error", async () => {
				const file = new FsFile("file:///document/test.txt")
				fs.set(file.uri, new Uint8Array([1, 2, 3]))
				const parent = makeParentDir("parent-uuid")
				const uploadError = new Error("network failure")

				mockUploadFile.mockRejectedValueOnce(uploadError)

				// Snapshot every store update so we can assert the error was written BEFORE the entry was
				// removed — the error must surface to the transfers screen even though the entry is dropped.
				type ErroredEntry = { type: string; errors: { unknown: Error[]; upload: unknown[] } }
				const snapshots: { type: string; unknownCount: number }[][] = []

				mockSetTransfers.mockImplementation((fn: unknown) => {
					if (typeof fn === "function") {
						mockTransfersState.transfers = (fn as (prev: unknown[]) => unknown[])(mockTransfersState.transfers)
					} else {
						mockTransfersState.transfers = fn as unknown[]
					}

					// Project to a bigint-free shape — the download entries embed bigint-laden DriveItems
					// that JSON.stringify cannot serialize.
					snapshots.push(
						(mockTransfersState.transfers as ErroredEntry[]).map(t => ({
							type: t.type,
							unknownCount: t.errors.unknown.length
						}))
					)
				})

				await expect(
					transfers.upload({
						localFileOrDir: file,
						parent,
						hideProgress: false
					})
				).rejects.toThrow("network failure")

				// Let the removal .then() microtask flush.
				await new Promise(res => setTimeout(res, 0))

				// At some point the entry carried the appended error (so the error surfaced).
				const erroredSnapshot = snapshots.find(snapshot =>
					snapshot.some(t => t.type === "uploadFile" && t.unknownCount === 1)
				)

				expect(erroredSnapshot).toBeDefined()

				// And the settled, errored transfer is no longer in the store — the leak is fixed.
				const finalEntry = (mockTransfersState.transfers as ErroredEntry[]).find(t => t.type === "uploadFile")

				expect(finalEntry).toBeUndefined()
			})

			it("calls thumbnails.generateFromLocalFile for image extensions after a successful upload", async () => {
				const file = new FsFile("file:///document/photo.jpg")
				fs.set(file.uri, new Uint8Array([1, 2, 3]))
				const parent = makeParentDir("parent-uuid")

				const { default: thumbnails } = await import("@/lib/thumbnails")

				await transfers.upload({
					localFileOrDir: file,
					parent,
					hideProgress: true
				})

				expect(thumbnails.generateFromLocalFile).toHaveBeenCalledTimes(1)
				expect(thumbnails.generateFromLocalFile).toHaveBeenCalledWith(
					expect.objectContaining({
						uuid: "uploaded-file-uuid"
					})
				)
			})

			it("does not call thumbnails.generateFromLocalFile for non-image/video extensions", async () => {
				const file = new FsFile("file:///document/document.pdf")
				fs.set(file.uri, new Uint8Array([1, 2, 3]))
				const parent = makeParentDir("parent-uuid")

				const { default: thumbnails } = await import("@/lib/thumbnails")

				await transfers.upload({
					localFileOrDir: file,
					parent,
					hideProgress: true
				})

				expect(thumbnails.generateFromLocalFile).not.toHaveBeenCalled()
			})

			it("onUpdate callback increments bytesTransferred in the store", async () => {
				const file = new FsFile("file:///document/test.txt")
				fs.set(file.uri, new Uint8Array([1, 2, 3]))
				const parent = makeParentDir("parent-uuid")

				// Capture each intermediate state snapshot so we can find the peak
				// bytesTransferred value before the async deferred filter removes the entry.
				const stateSnapshots: unknown[][] = []

				mockSetTransfers.mockImplementation((fn: unknown) => {
					if (typeof fn === "function") {
						const next = (fn as (prev: unknown[]) => unknown[])(mockTransfersState.transfers)

						stateSnapshots.push([...next])
						mockTransfersState.transfers = next
					} else {
						const next = fn as unknown[]

						stateSnapshots.push([...next])
						mockTransfersState.transfers = next
					}
				})

				mockUploadFile.mockImplementationOnce(
					async (_opts: unknown, _path: string, callbacks: { onUpdate: (n: bigint) => void }) => {
						// Fire the onUpdate callback — this calls setTransfers with a map-updater
						// that increments bytesTransferred on the matching in-flight transfer.
						callbacks.onUpdate(512n)

						return {
							uuid: "uploaded-file-uuid",
							parent: { tag: "Uuid", inner: ["parent-uuid"] }
						}
					}
				)

				await transfers.upload({
					localFileOrDir: file,
					parent,
					hideProgress: false
				})

				// Find the snapshot that shows bytesTransferred === 512 for the upload transfer.
				type TransferSnapshot = { type?: string; bytesTransferred?: number }
				const progressSnapshot = stateSnapshots.find(snapshot =>
					(snapshot as TransferSnapshot[]).some(t => t.type === "uploadFile" && t.bytesTransferred === 512)
				)

				expect(progressSnapshot).toBeDefined()
			})

			it("awaitExternalCompletionBeforeMarkingAsFinished defers removal from store until callback resolves", async () => {
				const file = new FsFile("file:///document/test.txt")
				fs.set(file.uri, new Uint8Array([1, 2, 3]))
				const parent = makeParentDir("parent-uuid")

				let resolveExternal!: () => void
				const externalPromise = new Promise<void>(res => {
					resolveExternal = res
				})

				// Seed the transfers store so the filter updater actually removes the entry.
				mockTransfersState.transfers = [{ id: "seeded", type: "uploadFile" }]

				let filterCallCount = 0

				mockSetTransfers.mockImplementation((fn: unknown) => {
					if (typeof fn === "function") {
						const result = (fn as (prev: unknown[]) => unknown[])(mockTransfersState.transfers)

						// Detect the filter call (removes the upload entry)
						if (result.length < mockTransfersState.transfers.length) {
							filterCallCount++
						}

						mockTransfersState.transfers = result
					} else {
						mockTransfersState.transfers = fn as unknown[]
					}
				})

				const uploadPromise = transfers.upload({
					localFileOrDir: file,
					parent,
					hideProgress: false,
					awaitExternalCompletionBeforeMarkingAsFinished: () => externalPromise
				})

				await uploadPromise

				// The deferred callback hasn't resolved yet — the removal filter must not have run.
				expect(filterCallCount).toBe(0)

				// Now resolve to trigger the deferred removal.
				resolveExternal()

				// Give microtasks a turn to flush the .then() chain.
				await new Promise(res => setTimeout(res, 0))

				expect(filterCallCount).toBe(1)
			})
		})

		describe("directory", () => {
			it("creates directory in root before uploading", async () => {
				const dir = new FsDirectory("file:///document/testdir")
				fs.set(dir.uri, "dir")
				const parent: any = { tag: "Root" as const, inner: [{ uuid: "root" }] }

				const { default: drive } = await import("@/features/drive/drive")

				await transfers.upload({
					localFileOrDir: dir,
					parent,
					hideProgress: true
				})

				expect(drive.createDirectory).toHaveBeenCalled()
			})

			it("throws when local directory does not exist", async () => {
				const dir = new FsDirectory("file:///document/nonexistent")
				const parent = makeParentDir("parent-uuid")

				await expect(
					transfers.upload({
						localFileOrDir: dir,
						parent,
						hideProgress: true
					})
				).rejects.toThrow("Local directory does not exist")
			})

			it("uses each uploaded item's own parent UUID for cache updates", async () => {
				const dir = new FsDirectory("file:///document/testdir")
				fs.set(dir.uri, "dir")
				const topParentUuid = "top-parent-uuid"
				const subDirParentUuid = "sub-dir-parent-uuid"
				const subFileParentUuid = "sub-file-parent-uuid"
				const parent = makeParentDir(topParentUuid)

				const uploadedDir = {
					uuid: "uploaded-dir-uuid",
					parent: { tag: "Uuid", inner: [subDirParentUuid] }
				}

				const uploadedFile = {
					uuid: "uploaded-file-uuid",
					parent: { tag: "Uuid", inner: [subFileParentUuid] }
				}

				mockUnwrapParentUuid.mockReturnValueOnce(subDirParentUuid).mockReturnValueOnce(subFileParentUuid)

				mockUnwrapDirMeta.mockReturnValueOnce({
					shared: false,
					dir: uploadedDir,
					meta: { name: "subdir" }
				})

				mockUnwrapFileMeta.mockReturnValueOnce({
					shared: false,
					file: uploadedFile,
					meta: { name: "file.txt" }
				})

				mockUploadDirRecursively.mockImplementationOnce(async (_path: string, callbacks: any) => {
					callbacks.onUploadUpdate([uploadedDir], [uploadedFile], 512n)
				})

				await transfers.upload({
					localFileOrDir: dir,
					parent,
					hideProgress: true
				})

				expect(mockDriveItemsQueryUpdate).toHaveBeenCalledTimes(2)

				const dirCall = mockDriveItemsQueryUpdate.mock.calls[0] as [{ parentUuid: string }]
				expect(dirCall[0].parentUuid).toBe(subDirParentUuid)

				const fileCall = mockDriveItemsQueryUpdate.mock.calls[1] as [{ parentUuid: string }]
				expect(fileCall[0].parentUuid).toBe(subFileParentUuid)
			})

			it("skips cache update for shared directories", async () => {
				const dir = new FsDirectory("file:///document/testdir")
				fs.set(dir.uri, "dir")
				const parent = makeParentDir("parent-uuid")

				const uploadedDir = {
					uuid: "uploaded-dir-uuid",
					parent: { tag: "Uuid", inner: ["parent-uuid"] }
				}

				mockUnwrapDirMeta.mockReturnValueOnce({
					shared: true,
					dir: uploadedDir,
					meta: { name: "shared-dir" }
				})

				mockUploadDirRecursively.mockImplementationOnce(async (_path: string, callbacks: any) => {
					callbacks.onUploadUpdate([uploadedDir], [], 0n)
				})

				await transfers.upload({
					localFileOrDir: dir,
					parent,
					hideProgress: true
				})

				expect(mockDriveItemsQueryUpdate).not.toHaveBeenCalled()
			})

			it("returns uploaded files and directories", async () => {
				const dir = new FsDirectory("file:///document/testdir")
				fs.set(dir.uri, "dir")
				const parent = makeParentDir("parent-uuid")

				const uploadedDir = { uuid: "dir-1", parent: { tag: "Uuid", inner: ["parent-uuid"] } }
				const uploadedFile = { uuid: "file-1", parent: { tag: "Uuid", inner: ["dir-1"] } }

				mockUploadDirRecursively.mockImplementationOnce(async (_path: string, callbacks: any) => {
					callbacks.onUploadUpdate([uploadedDir], [uploadedFile], 1024n)
				})

				const result = await transfers.upload({
					localFileOrDir: dir,
					parent,
					hideProgress: true
				})

				expect(result!.directories).toHaveLength(1)
				expect(result!.files).toHaveLength(1)
			})

			// Pins the directory-branch resolved-value contract (parity with downloadCore): per-entry
			// failures arrive ONLY via the onUploadErrors callback (the SDK call still resolves Ok)
			// and MUST be included in the resolved value so callers can act on partial uploads.
			it("resolves { files, directories, errors } with callback-fed upload errors included", async () => {
				const dir = new FsDirectory("file:///document/testdir")
				fs.set(dir.uri, "dir")
				const parent = makeParentDir("parent-uuid")
				const entryError = { error: { message: () => "entry failed" }, path: "/document/testdir/f.txt" }
				const uploadedFile = { uuid: "file-1", parent: { tag: "Uuid", inner: ["parent-uuid"] } }

				mockUploadDirRecursively.mockImplementationOnce(async (_path: string, callbacks: any) => {
					callbacks.onUploadErrors([entryError])
					callbacks.onUploadUpdate([], [uploadedFile], 256n)
				})

				const result = await transfers.upload({
					localFileOrDir: dir,
					parent,
					hideProgress: true
				})

				expect(result).not.toBeNull()
				expect(result && "errors" in result ? result.errors : null).toEqual([entryError])
				expect(result!.files).toEqual([uploadedFile])
			})

			it("returns null (not a rejected promise or unexpected value) when directory upload is aborted", async () => {
				const dir = new FsDirectory("file:///document/testdir")
				fs.set(dir.uri, "dir")
				const parent = makeParentDir("parent-uuid")
				const controller = new AbortController()

				mockUploadDirRecursively.mockImplementation(async () => {
					controller.abort()

					throw new Error("Aborted")
				})

				const result = await transfers.upload({
					localFileOrDir: dir,
					parent,
					hideProgress: true,
					signal: controller.signal
				})

				expect(result).toBeNull()
			})

			it("registers and graceful-aborts a directory upload with external signal when hideProgress is false", async () => {
				const dir = new FsDirectory("file:///document/testdir")
				fs.set(dir.uri, "dir")
				const parent: any = { tag: "Root" as const, inner: [{ uuid: "root" }] }
				const controller = new AbortController()

				mockSetTransfers.mockClear()

				mockUploadDirRecursively.mockImplementation(async () => {
					controller.abort()

					throw new Error("Aborted")
				})

				const result = await transfers.upload({
					localFileOrDir: dir,
					parent,
					signal: controller.signal
				})

				expect(result).toBeNull()
				expect(mockSetTransfers).toHaveBeenCalled()
			})

			it("writes the error to the store entry then removes the settled (errored) transfer when hideProgress is false and directory upload throws a non-abort error", async () => {
				const dir = new FsDirectory("file:///document/testdir")
				fs.set(dir.uri, "dir")
				const parent = makeParentDir("parent-uuid")
				const uploadError = new Error("dir upload failed")

				mockUploadDirRecursively.mockRejectedValueOnce(uploadError)

				type ErroredEntry = { type: string; errors: { unknown: Error[]; upload: unknown[] } }
				const snapshots: { type: string; unknownCount: number }[][] = []

				mockSetTransfers.mockImplementation((fn: unknown) => {
					if (typeof fn === "function") {
						mockTransfersState.transfers = (fn as (prev: unknown[]) => unknown[])(mockTransfersState.transfers)
					} else {
						mockTransfersState.transfers = fn as unknown[]
					}

					// Project to a bigint-free shape — the download entries embed bigint-laden DriveItems
					// that JSON.stringify cannot serialize.
					snapshots.push(
						(mockTransfersState.transfers as ErroredEntry[]).map(t => ({
							type: t.type,
							unknownCount: t.errors.unknown.length
						}))
					)
				})

				await expect(
					transfers.upload({
						localFileOrDir: dir,
						parent,
						hideProgress: false
					})
				).rejects.toThrow("dir upload failed")

				await new Promise(res => setTimeout(res, 0))

				const erroredSnapshot = snapshots.find(snapshot =>
					snapshot.some(t => t.type === "uploadDirectory" && t.unknownCount === 1)
				)

				expect(erroredSnapshot).toBeDefined()

				const finalEntry = (mockTransfersState.transfers as ErroredEntry[]).find(t => t.type === "uploadDirectory")

				expect(finalEntry).toBeUndefined()
			})
		})
	})

	describe("download", () => {
		describe("file", () => {
			it("downloads file to destination", async () => {
				const dest = new FsFile("file:///document/dest1.txt")
				const item = makeFileItem("file-uuid")

				const result = await transfers.download({
					item,
					destination: dest,
					hideProgress: true
				})

				expect(mockDownloadFileToPath).toHaveBeenCalledTimes(1)
				expect(result!.files).toHaveLength(1)
				expect(result!.directories).toHaveLength(0)
			})

			it("serves file from cache when fileCache has a cached copy", async () => {
				const cachedFile = new FsFile("file:///document/cached.txt")
				fs.set(cachedFile.uri, new Uint8Array([9, 8, 7]))

				const dest = new FsFile("file:///document/dest-cached.txt")
				const item = makeFileItem("file-uuid")

				mockFileCacheHas.mockResolvedValue(true)
				mockFileCacheGet.mockResolvedValue(cachedFile)

				const result = await transfers.download({
					item,
					destination: dest,
					hideProgress: true
				})

				expect(mockDownloadFileToPath).not.toHaveBeenCalled()
				expect(result).not.toBeNull()
				expect(result!.files).toHaveLength(1)
			})

			it("does NOT call wrapAbortSignalForSdk on a fileCache cache hit (no handle allocated)", async () => {
				const cachedFile = new FsFile("file:///document/cached.txt")
				fs.set(cachedFile.uri, new Uint8Array([9, 8, 7]))

				const dest = new FsFile("file:///document/dest-cached.txt")
				const item = makeFileItem("file-uuid")

				mockFileCacheHas.mockResolvedValue(true)
				mockFileCacheGet.mockResolvedValue(cachedFile)

				await transfers.download({
					item,
					destination: dest,
					hideProgress: true
				})

				expect(mockWrapAbortSignalForSdk).not.toHaveBeenCalled()
			})

			it("does not update store when hideProgress is true", async () => {
				const dest = new FsFile("file:///document/dest.txt")
				const item = makeFileItem("file-uuid")

				await transfers.download({
					item,
					destination: dest,
					hideProgress: true
				})

				expect(mockSetTransfers).not.toHaveBeenCalled()
			})

			it("disposes composite signals on completion", async () => {
				const dest = new FsFile("file:///document/dest.txt")
				const item = makeFileItem("file-uuid")

				await transfers.download({
					item,
					destination: dest,
					hideProgress: true
				})

				const compositePause = mockCreateCompositePauseSignal.mock.results[0] as { value: { dispose: ReturnType<typeof vi.fn> } }
				const compositeAbort = mockCreateCompositeAbortSignal.mock.results[0] as { value: { dispose: ReturnType<typeof vi.fn> } }

				expect(compositePause.value.dispose).toHaveBeenCalledTimes(1)
				expect(compositeAbort.value.dispose).toHaveBeenCalledTimes(1)
			})

			it("second download succeeds after first download throws (no residual state blocking retry)", async () => {
				const dest = new FsFile("file:///document/dest.txt")
				const item = makeFileItem("file-uuid")

				mockDownloadFileToPath.mockRejectedValueOnce(new Error("download failed"))

				await expect(
					transfers.download({
						item,
						destination: dest,
						hideProgress: true
					})
				).rejects.toThrow("download failed")

				const result = await transfers.download({
					item,
					destination: dest,
					hideProgress: true
				})

				expect(result).not.toBeNull()
				expect(result!.files).toHaveLength(1)
			})

			it("returns null (not a non-null result) when file download is aborted", async () => {
				const dest = new FsFile("file:///document/dest.txt")
				const item = makeFileItem("file-uuid")
				const controller = new AbortController()

				mockDownloadFileToPath.mockImplementation(async () => {
					controller.abort()

					throw new Error("Aborted")
				})

				const result = await transfers.download({
					item,
					destination: dest,
					hideProgress: true,
					signal: controller.signal
				})

				expect(result).toBeNull()
			})

			it("registers and graceful-aborts a file download with external signal when hideProgress is false", async () => {
				const dest = new FsFile("file:///document/dest.txt")
				const item = makeFileItem("file-uuid")
				const controller = new AbortController()

				mockSetTransfers.mockClear()

				mockDownloadFileToPath.mockImplementation(async () => {
					controller.abort()

					throw new Error("Aborted")
				})

				const result = await transfers.download({
					item,
					destination: dest,
					signal: controller.signal
				})

				expect(result).toBeNull()
				expect(mockSetTransfers).toHaveBeenCalled()
			})

			it("throws when destination is a Directory for a file item", async () => {
				const dest = new FsDirectory("file:///document/destdir")
				const item = makeFileItem("file-uuid")

				await expect(
					transfers.download({
						item,
						destination: dest,
						hideProgress: true
					})
				).rejects.toThrow("Destination must be a file for file downloads.")
			})

			it("writes the error to the store entry then removes the settled (errored) transfer when hideProgress is false and file download throws a non-abort error", async () => {
				const dest = new FsFile("file:///document/dest.txt")
				const item = makeFileItem("file-uuid")
				const downloadError = new Error("download failed")

				mockDownloadFileToPath.mockRejectedValueOnce(downloadError)

				type ErroredEntry = { type: string; errors: { unknown: Error[]; download: unknown[] } }
				const snapshots: { type: string; unknownCount: number }[][] = []

				mockSetTransfers.mockImplementation((fn: unknown) => {
					if (typeof fn === "function") {
						mockTransfersState.transfers = (fn as (prev: unknown[]) => unknown[])(mockTransfersState.transfers)
					} else {
						mockTransfersState.transfers = fn as unknown[]
					}

					// Project to a bigint-free shape — the download entries embed bigint-laden DriveItems
					// that JSON.stringify cannot serialize.
					snapshots.push(
						(mockTransfersState.transfers as ErroredEntry[]).map(t => ({
							type: t.type,
							unknownCount: t.errors.unknown.length
						}))
					)
				})

				await expect(
					transfers.download({
						item,
						destination: dest,
						hideProgress: false
					})
				).rejects.toThrow("download failed")

				await new Promise(res => setTimeout(res, 0))

				const erroredSnapshot = snapshots.find(snapshot =>
					snapshot.some(t => t.type === "downloadFile" && t.unknownCount === 1)
				)

				expect(erroredSnapshot).toBeDefined()

				const finalEntry = (mockTransfersState.transfers as ErroredEntry[]).find(t => t.type === "downloadFile")

				expect(finalEntry).toBeUndefined()
			})
		})

		describe("directory", () => {
			it("rejects file destination for directory download", async () => {
				const dest = new FsFile("file:///document/dest.txt")
				const item = makeDirItem("dir-uuid")

				await expect(
					transfers.download({
						item,
						destination: dest,
						hideProgress: true
					})
				).rejects.toThrow("Destination must be a directory")
			})

			it("downloads directory to destination", async () => {
				const dest = new FsDirectory("file:///document/destdir")
				const item = makeDirItem("dir-uuid")

				const result = await transfers.download({
					item,
					destination: dest,
					hideProgress: true
				})

				expect(mockDownloadDirRecursively).toHaveBeenCalledTimes(1)
				expect(result!.files).toHaveLength(0)
				expect(result!.directories).toHaveLength(0)
			})

			// Pins the directory-branch resolved-value contract the offline reconcile depends on:
			// per-entry failures arrive ONLY via the onDownloadErrors callback (the SDK call still
			// resolves Ok) and MUST be included in the resolved value — offline treats a non-empty
			// errors array as pass failure for that tree.
			it("resolves { files, directories, errors } with callback-fed download errors and updates included", async () => {
				const dest = new FsDirectory("file:///document/destdir")
				const item = makeDirItem("dir-uuid")
				const entryError = { error: { message: () => "entry failed" }, path: "/private/destdir/sub/f.txt" }
				const downloadedDir = { path: "/private/destdir/sub", dir: {} }
				const downloadedFile = { path: "/private/destdir/sub/g.txt", file: {} }

				mockDownloadDirRecursively.mockImplementationOnce(async (_path: string, callbacks: any) => {
					callbacks.onDownloadErrors([entryError])
					callbacks.onDownloadUpdate([downloadedDir], [downloadedFile], 128n)
				})

				const result = await transfers.download({
					item,
					destination: dest,
					hideProgress: true
				})

				expect(result).not.toBeNull()
				expect(result && "errors" in result ? result.errors : null).toEqual([entryError])
				expect(result!.files).toEqual([downloadedFile])
				expect(result!.directories).toEqual([downloadedDir])
			})

			// Offline's in-place tree reconcile contract: the destination IS the live stored tree.
			// preserveDestinationOnStart: true must never delete it — not at start, not on failure,
			// not on abort — while the default destructive behavior stays for every other caller.
			it("preserveDestinationOnStart: true keeps an existing destination intact at start and on a non-abort failure", async () => {
				const dest = new FsDirectory("file:///document/destdir")
				fs.set(dest.uri, "dir")
				fs.set(`${dest.uri}/keep.txt`, new Uint8Array([1]))
				const item = makeDirItem("dir-uuid")
				let existedAtSdkCall: boolean | null = null

				mockDownloadDirRecursively.mockImplementationOnce(async () => {
					existedAtSdkCall = fs.has(`${dest.uri}/keep.txt`)
				})

				await transfers.download({
					item,
					destination: dest,
					hideProgress: true,
					preserveDestinationOnStart: true
				})

				// The SDK saw the existing bytes (hash-idempotency depends on them)…
				expect(existedAtSdkCall).toBe(true)
				expect(fs.has(`${dest.uri}/keep.txt`)).toBe(true)

				// …and a failed pass leaves them for the next reconcile.
				mockDownloadDirRecursively.mockRejectedValueOnce(new Error("dir download failed"))

				await expect(
					transfers.download({
						item,
						destination: dest,
						hideProgress: true,
						preserveDestinationOnStart: true
					})
				).rejects.toThrow("dir download failed")

				expect(fs.has(`${dest.uri}/keep.txt`)).toBe(true)
			})

			it("preserveDestinationOnStart: true keeps the destination intact when the download is aborted (resolves null)", async () => {
				const dest = new FsDirectory("file:///document/destdir")
				fs.set(dest.uri, "dir")
				fs.set(`${dest.uri}/keep.txt`, new Uint8Array([1]))
				const item = makeDirItem("dir-uuid")
				const controller = new AbortController()

				mockDownloadDirRecursively.mockImplementationOnce(async () => {
					controller.abort()

					throw new Error("Aborted")
				})

				const result = await transfers.download({
					item,
					destination: dest,
					hideProgress: true,
					signal: controller.signal,
					preserveDestinationOnStart: true
				})

				expect(result).toBeNull()
				expect(fs.has(`${dest.uri}/keep.txt`)).toBe(true)
			})

			it("default (no preserveDestinationOnStart) deletes an existing destination before the SDK call and again on a non-abort failure", async () => {
				const dest = new FsDirectory("file:///document/destdir")
				fs.set(dest.uri, "dir")
				fs.set(`${dest.uri}/keep.txt`, new Uint8Array([1]))
				const item = makeDirItem("dir-uuid")
				let existedAtSdkCall: boolean | null = null

				mockDownloadDirRecursively.mockImplementationOnce(async () => {
					existedAtSdkCall = fs.has(`${dest.uri}/keep.txt`)
				})

				await transfers.download({
					item,
					destination: dest,
					hideProgress: true
				})

				expect(existedAtSdkCall).toBe(false)
				expect(fs.has(`${dest.uri}/keep.txt`)).toBe(false)

				// Failure-path cleanup: partial bytes the SDK wrote before failing are deleted too
				// (non-offline callers download into a disposable destination).
				mockDownloadDirRecursively.mockImplementationOnce(async () => {
					fs.set(dest.uri, "dir")
					fs.set(`${dest.uri}/partial.txt`, new Uint8Array([1]))

					throw new Error("dir download failed")
				})

				await expect(
					transfers.download({
						item,
						destination: dest,
						hideProgress: true
					})
				).rejects.toThrow("dir download failed")

				expect(fs.has(`${dest.uri}/partial.txt`)).toBe(false)
				expect(fs.has(dest.uri)).toBe(false)
			})

			it("returns null (not a non-null result) when directory download is aborted", async () => {
				const dest = new FsDirectory("file:///document/destdir")
				const item = makeDirItem("dir-uuid")
				const controller = new AbortController()

				mockDownloadDirRecursively.mockImplementation(async () => {
					controller.abort()

					throw new Error("Aborted")
				})

				const result = await transfers.download({
					item,
					destination: dest,
					hideProgress: true,
					signal: controller.signal
				})

				expect(result).toBeNull()
			})

			it("registers and graceful-aborts a directory download with external signal when hideProgress is false", async () => {
				const dest = new FsDirectory("file:///document/destdir")
				const item = makeDirItem("dir-uuid")
				const controller = new AbortController()

				mockSetTransfers.mockClear()

				mockDownloadDirRecursively.mockImplementation(async () => {
					controller.abort()

					throw new Error("Aborted")
				})

				const result = await transfers.download({
					item,
					destination: dest,
					signal: controller.signal
				})

				expect(result).toBeNull()
				expect(mockSetTransfers).toHaveBeenCalled()
			})

			it("writes the error to the store entry then removes the settled (errored) transfer when hideProgress is false and directory download throws a non-abort error", async () => {
				const dest = new FsDirectory("file:///document/destdir")
				const item = makeDirItem("dir-uuid")
				const downloadError = new Error("dir download failed")

				mockDownloadDirRecursively.mockRejectedValueOnce(downloadError)

				type ErroredEntry = { type: string; errors: { unknown: Error[]; download: unknown[] } }
				const snapshots: { type: string; unknownCount: number }[][] = []

				mockSetTransfers.mockImplementation((fn: unknown) => {
					if (typeof fn === "function") {
						mockTransfersState.transfers = (fn as (prev: unknown[]) => unknown[])(mockTransfersState.transfers)
					} else {
						mockTransfersState.transfers = fn as unknown[]
					}

					// Project to a bigint-free shape — the download entries embed bigint-laden DriveItems
					// that JSON.stringify cannot serialize.
					snapshots.push(
						(mockTransfersState.transfers as ErroredEntry[]).map(t => ({
							type: t.type,
							unknownCount: t.errors.unknown.length
						}))
					)
				})

				await expect(
					transfers.download({
						item,
						destination: dest,
						hideProgress: false
					})
				).rejects.toThrow("dir download failed")

				await new Promise(res => setTimeout(res, 0))

				const erroredSnapshot = snapshots.find(snapshot =>
					snapshot.some(t => t.type === "downloadDirectory" && t.unknownCount === 1)
				)

				expect(erroredSnapshot).toBeDefined()

				const finalEntry = (mockTransfersState.transfers as ErroredEntry[]).find(t => t.type === "downloadDirectory")

				expect(finalEntry).toBeUndefined()
			})

			it("throws 'Parent directory of shared directory not found in cache' when sharedDirectory parent is absent", async () => {
				const dest = new FsDirectory("file:///document/destdir")
				const sharedDirItem = {
					type: "sharedDirectory" as const,
					data: {
						inner: {
							parent: { tag: "Uuid", inner: ["missing-parent-uuid"] },
							uuid: "shared-dir-uuid"
						},
						sharingRole: "owner"
					}
				}

				mockUnwrapParentUuid.mockReturnValue("missing-parent-uuid")

				// Ensure the cache does NOT have the parent entry — Map is a fresh instance per describe block.
				const cacheMap = (cache as any).directoryUuidToAnySharedDirWithContext as Map<string, unknown>

				cacheMap.clear()

				await expect(
					transfers.download({
						item: sharedDirItem as any,
						destination: dest,
						hideProgress: true
					})
				).rejects.toThrow("Parent directory of shared directory not found in cache.")
			})

			it("resolves the sharedRootDirectory targetDir branch without throwing", async () => {
				const dest = new FsDirectory("file:///document/destdir")
				const sharedRootItem = {
					type: "sharedRootDirectory" as const,
					data: {
						uuid: "shared-root-uuid",
						sharingRole: "owner"
					}
				}

				const result = await transfers.download({
					item: sharedRootItem as any,
					destination: dest,
					hideProgress: true
				})

				expect(mockDownloadDirRecursively).toHaveBeenCalledTimes(1)
				expect(result).not.toBeNull()
			})

			// Regression (#25): a sharedDirectory (non-root) download must target the CHILD directory itself
			// (item.data), borrowing only the shareInfo from the cached parent — NOT the parent's whole
			// AnySharedDirWithContext, which would download the parent's (larger) tree.
			it("targets the child directory (item.data), not the parent, for a sharedDirectory download", async () => {
				const dest = new FsDirectory("file:///document/destdir")
				const sharedDirItem = {
					type: "sharedDirectory" as const,
					data: {
						inner: {
							parent: { tag: "Uuid", inner: ["parent-uuid"] },
							uuid: "shared-dir-uuid"
						},
						sharingRole: "owner"
					}
				}

				mockUnwrapParentUuid.mockReturnValue("parent-uuid")

				// Seed the cache with the PARENT's shared-dir context (a distinct uuid/shareInfo).
				const parentSharedDirWithContext = { dir: { tag: "Root", inner: [{ inner: { uuid: "parent-uuid" } }] }, shareInfo: "parent-share-info" }
				const cacheMap = (cache as any).directoryUuidToAnySharedDirWithContext as Map<string, unknown>

				cacheMap.clear()
				cacheMap.set("parent-uuid", parentSharedDirWithContext)

				await transfers.download({
					item: sharedDirItem as any,
					destination: dest,
					hideProgress: true
				})

				expect(mockDownloadDirRecursively).toHaveBeenCalledTimes(1)

				// downloadDirRecursively(path, callbacks, targetDir, future, opts) — targetDir is arg index 2.
				const targetDir = mockDownloadDirRecursively.mock.calls[0]?.[2] as any

				// AnyDirWithContext.Shared wrapping AnySharedDirWithContext.new({ dir, shareInfo }).
				expect(targetDir.tag).toBe("Shared")

				const sharedCtx = targetDir.inner[0]

				// shareInfo is borrowed from the cached PARENT...
				expect(sharedCtx.shareInfo).toBe("parent-share-info")

				// ...but the targeted dir is the CHILD (item.data) wrapped in AnySharedDir.Dir, NOT the parent.
				expect(sharedCtx.dir.tag).toBe("Dir")
				expect(sharedCtx.dir.inner[0].inner.uuid).toBe("shared-dir-uuid")
				expect(sharedCtx.dir.inner[0]).toBe(sharedDirItem.data)
			})
		})
	})

	describe("pauseAll and resumeAll", () => {
		it("pauseAll sets globalPauseSignal to paused and resumeAll clears it", () => {
			// After beforeEach, cancelAll() has created a fresh MockPauseSignal. It is the last
			// entry in createdPauseSignalInstances (the tracker is a plain array, not a vi.fn(),
			// so vi.clearAllMocks() does not reset it).
			const globalSignal = createdPauseSignalInstances[createdPauseSignalInstances.length - 1]

			expect(globalSignal).toBeDefined()

			// Initially not paused.
			expect(globalSignal?.isPaused()).toBe(false)

			transfers.pauseAll()

			// After pauseAll the signal must report paused.
			expect(globalSignal?.isPaused()).toBe(true)

			transfers.resumeAll()

			// After resumeAll it must be unpaused again.
			expect(globalSignal?.isPaused()).toBe(false)
		})

		it("pauseAll is idempotent — calling it twice leaves the signal paused, not erroring", () => {
			const globalSignal = createdPauseSignalInstances[createdPauseSignalInstances.length - 1]

			transfers.pauseAll()
			transfers.pauseAll() // second call must not throw and must leave it paused

			expect(globalSignal?.isPaused()).toBe(true)

			// Clean up for subsequent tests.
			transfers.resumeAll()
		})

		it("resumeAll is idempotent — calling it while not paused does not throw", () => {
			const globalSignal = createdPauseSignalInstances[createdPauseSignalInstances.length - 1]

			// Already not paused; calling resumeAll must not throw.
			expect(() => transfers.resumeAll()).not.toThrow()

			expect(globalSignal?.isPaused()).toBe(false)
		})

		it("pause and resume events propagate to registered listeners on the global signal", () => {
			const globalSignal = createdPauseSignalInstances[createdPauseSignalInstances.length - 1]

			const received: string[] = []

			globalSignal?.addEventListener("pause", () => received.push("paused"))
			globalSignal?.addEventListener("resume", () => received.push("resumed"))

			transfers.pauseAll()
			transfers.resumeAll()

			// Both events must have fired exactly once in order.
			expect(received).toEqual(["paused", "resumed"])
		})
	})

	// C1 settle honesty: a directory transfer that RESOLVES while having accumulated per-entry
	// errors (via the SDK error callbacks) must settle as "completedWithErrors", not "succeeded" —
	// and a clean resolution stays "succeeded" with errorCount 0.
	describe("settle honesty (completedWithErrors)", () => {
		it("settles a resolved directory download with accumulated entry errors as completedWithErrors", async () => {
			const dest = new FsDirectory("file:///document/destdir")
			const item = makeDirItem("dir-uuid")
			const entryError = { error: { message: () => "entry failed" }, path: "/document/destdir/f.txt" }

			mockDownloadDirRecursively.mockImplementationOnce(async (_path: string, callbacks: any) => {
				callbacks.onDownloadErrors([entryError])
			})

			const result = await transfers.download({
				item,
				destination: dest,
				hideProgress: false
			})

			expect(result).not.toBeNull()

			// Let the deferred removal/append .then() microtask flush.
			await new Promise(res => setTimeout(res, 0))

			expect(mockAddFinishedTransfer).toHaveBeenCalledTimes(1)
			expect(mockAddFinishedTransfer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "downloadDirectory",
					outcome: "completedWithErrors",
					errorCount: 1
				})
			)

			// The settled entry is still removed from the active store (no floating-bar leak).
			const finalEntry = (mockTransfersState.transfers as { type: string }[]).find(t => t.type === "downloadDirectory")

			expect(finalEntry).toBeUndefined()
		})

		it("settles a resolved directory upload with accumulated entry errors as completedWithErrors", async () => {
			const dir = new FsDirectory("file:///document/testdir")
			fs.set(dir.uri, "dir")
			const parent = makeParentDir("parent-uuid")
			const entryError = { error: { message: () => "entry failed" }, path: "/document/testdir/f.txt" }

			mockUploadDirRecursively.mockImplementationOnce(async (_path: string, callbacks: any) => {
				callbacks.onUploadErrors([entryError])
			})

			const result = await transfers.upload({
				localFileOrDir: dir,
				parent,
				hideProgress: false
			})

			expect(result).not.toBeNull()

			await new Promise(res => setTimeout(res, 0))

			expect(mockAddFinishedTransfer).toHaveBeenCalledTimes(1)
			expect(mockAddFinishedTransfer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "uploadDirectory",
					outcome: "completedWithErrors",
					errorCount: 1
				})
			)

			const finalEntry = (mockTransfersState.transfers as { type: string }[]).find(t => t.type === "uploadDirectory")

			expect(finalEntry).toBeUndefined()
		})

		it("settles a cleanly resolved directory download as succeeded with errorCount 0", async () => {
			const dest = new FsDirectory("file:///document/destdir")
			const item = makeDirItem("dir-uuid")

			const result = await transfers.download({
				item,
				destination: dest,
				hideProgress: false
			})

			expect(result).not.toBeNull()

			await new Promise(res => setTimeout(res, 0))

			expect(mockAddFinishedTransfer).toHaveBeenCalledTimes(1)
			expect(mockAddFinishedTransfer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "downloadDirectory",
					outcome: "succeeded",
					errorCount: 0
				})
			)
		})

		it("does not append a finished snapshot for an aborted directory download (dropped silently)", async () => {
			const dest = new FsDirectory("file:///document/destdir")
			const item = makeDirItem("dir-uuid")
			const controller = new AbortController()

			mockDownloadDirRecursively.mockImplementationOnce(async (_path: string, callbacks: any) => {
				// Accumulate an entry error, then abort — abort wins, no snapshot.
				callbacks.onDownloadErrors([{ error: { message: () => "entry failed" }, path: "/x" }])
				controller.abort()

				throw new Error("Aborted")
			})

			const result = await transfers.download({
				item,
				destination: dest,
				signal: controller.signal
			})

			expect(result).toBeNull()

			await new Promise(res => setTimeout(res, 0))

			expect(mockAddFinishedTransfer).not.toHaveBeenCalled()
		})
	})

	describe("cancelAll", () => {
		it("aborts an in-flight transfer when cancelAll is called mid-upload", async () => {
			const file = new FsFile("file:///document/test.txt")
			fs.set(file.uri, new Uint8Array([1, 2, 3]))
			const parent = makeParentDir("parent-uuid")

			// uploadFile hangs until the abort signal fires.
			mockUploadFile.mockImplementation(
				(_opts: unknown, _path: string, _cb: unknown, _future: unknown, opts: { signal: AbortSignal }) => {
					return new Promise<never>((_resolve, reject) => {
						opts.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true })
					})
				}
			)

			const uploadPromise = transfers.upload({
				localFileOrDir: file,
				parent,
				hideProgress: true
			})

			// Give the upload a tick to reach the awaited SDK call.
			await new Promise(res => setTimeout(res, 0))

			transfers.cancelAll()

			const result = await uploadPromise

			expect(result).toBeNull()
		})
	})
})

describe("shouldRemoveSettledTransfer", () => {
	it("removes a transfer that succeeded", () => {
		expect(shouldRemoveSettledTransfer({ succeeded: true, aborted: false, hasErrors: false })).toBe(true)
	})

	it("removes a transfer that was aborted", () => {
		expect(shouldRemoveSettledTransfer({ succeeded: false, aborted: true, hasErrors: false })).toBe(true)
	})

	it("removes a transfer that settled with errors (the previously-leaked case)", () => {
		expect(shouldRemoveSettledTransfer({ succeeded: false, aborted: false, hasErrors: true })).toBe(true)
	})

	it("keeps a still-running transfer (none of succeeded/aborted/errored)", () => {
		expect(shouldRemoveSettledTransfer({ succeeded: false, aborted: false, hasErrors: false })).toBe(false)
	})

	it("removes when more than one terminal condition is true", () => {
		expect(shouldRemoveSettledTransfer({ succeeded: true, aborted: true, hasErrors: true })).toBe(true)
		expect(shouldRemoveSettledTransfer({ succeeded: false, aborted: true, hasErrors: true })).toBe(true)
	})
})

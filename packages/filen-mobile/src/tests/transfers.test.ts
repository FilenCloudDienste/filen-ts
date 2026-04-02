import { vi, describe, it, expect, beforeEach } from "vitest"

const {
	MockPauseSignal,
	mockUploadFile,
	mockUploadDirRecursively,
	mockDownloadFileToPath,
	mockDownloadDirRecursively,
	mockSetTransfers,
	mockDriveItemsQueryUpdate,
	mockGetSdkClients,
	mockTransfersState,
	mockCreateCompositePauseSignal,
	mockCreateCompositeAbortSignal,
	mockUnwrapDirMeta,
	mockUnwrapFileMeta,
	mockUnwrapParentUuid
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

	const mockDriveItemsQueryUpdate = vi.fn()

	class MockPauseSignal {
		private _paused = false
		private _listeners = new Map<string, Set<() => void>>()

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

	const mockUnwrapDirMeta = vi.fn()
	const mockUnwrapFileMeta = vi.fn()
	const mockUnwrapParentUuid = vi.fn()

	return {
		MockPauseSignal,
		mockUploadFile,
		mockUploadDirRecursively,
		mockDownloadFileToPath,
		mockDownloadDirRecursively,
		mockSetTransfers,
		mockDriveItemsQueryUpdate,
		mockGetSdkClients,
		mockTransfersState: state,
		mockCreateCompositePauseSignal,
		mockCreateCompositeAbortSignal,
		mockUnwrapDirMeta,
		mockUnwrapFileMeta,
		mockUnwrapParentUuid
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

vi.mock("@/stores/useTransfers.store", () => ({
	default: {
		getState: () => ({
			setTransfers: mockSetTransfers,
			transfers: mockTransfersState.transfers
		})
	}
}))

vi.mock("@/queries/useDriveItems.query", () => ({
	driveItemsQueryUpdate: mockDriveItemsQueryUpdate
}))

vi.mock("@/lib/cache", () => ({
	default: {
		directoryUuidToAnySharedDirWithContext: new Map()
	}
}))

vi.mock("@/lib/fileCache", () => ({
	default: {
		get: vi.fn(),
		set: vi.fn(),
		remove: vi.fn()
	}
}))

vi.mock("@op-engineering/op-sqlite", async () => await import("@/tests/mocks/opSqlite"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

vi.mock("@/lib/drive", () => ({
	default: {
		createDirectory: vi.fn().mockResolvedValue({ data: { uuid: "dir-uuid" } })
	}
}))

vi.mock("@/lib/utils", () => ({
	normalizeFilePathForSdk: vi.fn((path: string) => path.replace("file://", "")),
	unwrapDirMeta: mockUnwrapDirMeta,
	unwrapFileMeta: mockUnwrapFileMeta,
	wrapAbortSignalForSdk: vi.fn(() => ({})),
	PauseSignal: MockPauseSignal,
	createCompositePauseSignal: mockCreateCompositePauseSignal,
	createCompositeAbortSignal: mockCreateCompositeAbortSignal,
	unwrapParentUuid: mockUnwrapParentUuid
}))

import transfers from "@/lib/transfers"
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
						params: {
							path: {
								type: "drive",
								uuid: "parent-uuid"
							}
						}
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

			it("cleans up tracking sets on error", async () => {
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

				await transfers.upload({
					localFileOrDir: file,
					parent,
					hideProgress: true
				})
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

			it("does not throw when aborted", async () => {
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
					abortController: controller
				})

				expect(result).toBeNull()
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
		})

		describe("directory", () => {
			it("creates directory in root before uploading", async () => {
				const dir = new FsDirectory("file:///document/testdir")
				fs.set(dir.uri, "dir")
				const parent: any = { tag: "Root" as const, inner: [{ uuid: "root" }] }

				const { default: drive } = await import("@/lib/drive")

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

				mockUploadDirRecursively.mockImplementationOnce(
					async (_path: string, callbacks: any) => {
						callbacks.onUploadUpdate([uploadedDir], [uploadedFile], 512n)
					}
				)

				await transfers.upload({
					localFileOrDir: dir,
					parent,
					hideProgress: true
				})

				expect(mockDriveItemsQueryUpdate).toHaveBeenCalledTimes(2)

				const dirCall = mockDriveItemsQueryUpdate.mock.calls[0] as [{ params: { path: { uuid: string } } }]
				expect(dirCall[0].params.path.uuid).toBe(subDirParentUuid)

				const fileCall = mockDriveItemsQueryUpdate.mock.calls[1] as [{ params: { path: { uuid: string } } }]
				expect(fileCall[0].params.path.uuid).toBe(subFileParentUuid)
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

				mockUploadDirRecursively.mockImplementationOnce(
					async (_path: string, callbacks: any) => {
						callbacks.onUploadUpdate([uploadedDir], [], 0n)
					}
				)

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

				mockUploadDirRecursively.mockImplementationOnce(
					async (_path: string, callbacks: any) => {
						callbacks.onUploadUpdate([uploadedDir], [uploadedFile], 1024n)
					}
				)

				const result = await transfers.upload({
					localFileOrDir: dir,
					parent,
					hideProgress: true
				})

				expect(result!.directories).toHaveLength(1)
				expect(result!.files).toHaveLength(1)
			})

			it("does not throw when aborted", async () => {
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
					abortController: controller
				})

				expect(result).toBeNull()
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

			it("cleans up tracking sets on error", async () => {
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

				await transfers.download({
					item,
					destination: dest,
					hideProgress: true
				})
			})
			it("does not throw when aborted", async () => {
				const dest = new FsFile("file:///document/dest.txt")
				const item = makeFileItem("file-uuid")
				const controller = new AbortController()

				mockDownloadFileToPath.mockImplementation(async () => {
					controller.abort()

					throw new Error("Aborted")
				})

				await expect(
					transfers.download({
						item,
						destination: dest,
						hideProgress: true,
						abortController: controller
					})
				).resolves.not.toThrow()
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

			it("does not throw when aborted", async () => {
				const dest = new FsDirectory("file:///document/destdir")
				const item = makeDirItem("dir-uuid")
				const controller = new AbortController()

				mockDownloadDirRecursively.mockImplementation(async () => {
					controller.abort()

					throw new Error("Aborted")
				})

				await expect(
					transfers.download({
						item,
						destination: dest,
						hideProgress: true,
						abortController: controller
					})
				).resolves.not.toThrow()
			})
		})
	})

	describe("pauseAll and resumeAll", () => {
		it("do not throw", () => {
			expect(() => transfers.pauseAll()).not.toThrow()
			expect(() => transfers.resumeAll()).not.toThrow()
		})
	})
})

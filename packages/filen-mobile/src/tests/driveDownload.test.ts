import { vi, describe, it, expect, beforeEach } from "vitest"

// ------------------------------------------------------------------
// Hoisted mocks (must be defined before any imports)
// ------------------------------------------------------------------

const { mockCopyToMediaStore, mockTransfersDownload, mockNewTmpDir } = vi.hoisted(() => ({
	mockCopyToMediaStore: vi.fn().mockResolvedValue(undefined),
	mockTransfersDownload: vi.fn().mockResolvedValue(true),
	mockNewTmpDir: vi.fn()
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

vi.mock("react-native-blob-util", () => ({
	default: {
		MediaCollection: {
			copyToMediaStore: mockCopyToMediaStore
		}
	}
}))

vi.mock("@/features/transfers/transfers", () => ({
	default: {
		download: mockTransfersDownload
	}
}))

// Provide only the functions that driveDownload.ts actually imports from utils.
// listLocalDirectoryRecursive uses the real expo-file-system mock internally so we
// implement it faithfully; normalizeFilePathForBlobUtil is a trivial wrapper.
vi.mock("@/lib/utils", async () => {
	const { File, Directory } = await import("@/tests/mocks/expoFileSystem")

	function walkDir(dir: InstanceType<typeof Directory>): (InstanceType<typeof File> | InstanceType<typeof Directory>)[] {
		const entries: (InstanceType<typeof File> | InstanceType<typeof Directory>)[] = []
		const visited = new Set<string>()

		function traverse(d: InstanceType<typeof Directory>): void {
			if (visited.has(d.uri)) {
				return
			}

			visited.add(d.uri)

			try {
				for (const entry of d.list()) {
					entries.push(entry)

					if (entry instanceof Directory) {
						traverse(entry)
					}
				}
			} catch {
				// best-effort
			}
		}

		traverse(dir)

		return entries
	}

	function normalizeFilePathForSdk(filePath: string): string {
		const cleaned = filePath
			.trim()
			.replace(/^file:\/+/, "/")
			.split("/")
			.map(segment => {
				if (segment.length === 0) {
					return segment
				}

				try {
					return decodeURIComponent(segment)
				} catch {
					return segment
				}
			})
			.join("/")

		let result = cleaned.startsWith("/") ? cleaned : `/${cleaned}`

		if (result.endsWith("/") && result !== "/") {
			result = result.slice(0, -1)
		}

		// Simple posix normalize (no external dep needed for tests)
		return result.replace(/\/+/g, "/")
	}

	function normalizeFilePathForBlobUtil(filePath: string): string {
		return `file://${normalizeFilePathForSdk(filePath)}`
	}

	return {
		listLocalDirectoryRecursive: walkDir,
		normalizeFilePathForBlobUtil,
		normalizeFilePathForSdk
	}
})

vi.mock("@/lib/tmp", () => ({
	newTmpDir: mockNewTmpDir
}))

// mime-types maps extension to content type — keep the real module (it's node-safe).
// No need to mock it.

// ------------------------------------------------------------------
// Imports (after all vi.mock calls)
// ------------------------------------------------------------------

import * as FileSystem from "expo-file-system"
import { fs } from "@/tests/mocks/expoFileSystem"
import { downloadDriveItemToDevice } from "@/lib/driveDownload"
import type { DriveItem } from "@/types"

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

type DecryptedMeta = {
	name: string
	mime: string
	size: bigint
	version: number
	key: string
	modified: number
	created: number
}

function makeFileItem(overrides: {
	name?: string
	mime?: string
	uuid?: string
	decryptedMeta?: DecryptedMeta | null
}): DriveItem {
	const name = overrides.name ?? "testfile.txt"
	const uuid = overrides.uuid ?? "test-file-uuid"

	return {
		type: "file",
		data: {
			uuid,
			size: 0n,
			undecryptable: false,
			decryptedMeta:
				overrides.decryptedMeta !== undefined
					? overrides.decryptedMeta
					: {
							name,
							mime: overrides.mime ?? "text/plain",
							size: 0n,
							version: 1,
							key: "key",
							modified: 1000,
							created: 1000
						}
		}
	} as unknown as DriveItem
}

function makeDirItem(overrides: {
	name?: string
	uuid?: string
	decryptedMeta?: DecryptedMeta | null
}): DriveItem {
	const name = overrides.name ?? "testdir"
	const uuid = overrides.uuid ?? "test-dir-uuid"

	return {
		type: "directory",
		data: {
			uuid,
			size: 0n,
			undecryptable: false,
			decryptedMeta:
				overrides.decryptedMeta !== undefined
					? overrides.decryptedMeta
					: {
							name,
							mime: "",
							size: 0n,
							version: 1,
							key: "key",
							modified: 1000,
							created: 1000
						}
		}
	} as unknown as DriveItem
}

// ------------------------------------------------------------------
// Test setup
// ------------------------------------------------------------------

// Expose Platform.OS setter — we'll switch between 'ios' and 'android' per test.
const reactNativeMock = await import("@/tests/mocks/reactNative")

function setOS(os: "ios" | "android"): void {
	;(reactNativeMock.Platform as { OS: string }).OS = os
}

// Create a tmp directory that newTmpDir() returns on each call.
const TMP_BASE = "file:///cache/filen-tmp"

beforeEach(() => {
	fs.clear()
	mockCopyToMediaStore.mockClear()
	mockTransfersDownload.mockReset()
	mockTransfersDownload.mockResolvedValue(true)
	mockNewTmpDir.mockReset()
	mockNewTmpDir.mockImplementation(() => new FileSystem.Directory(`${TMP_BASE}/${crypto.randomUUID()}`))
	setOS("ios")
})

// ------------------------------------------------------------------
// 1. destination path selection: iOS vs Android, file vs directory
// ------------------------------------------------------------------

describe("downloadDriveItemToDevice — destination path selection", () => {
	it("iOS + file: destination is FileSystem.File under document/Downloads/name", async () => {
		setOS("ios")

		const item = makeFileItem({ name: "photo.jpg" })

		mockTransfersDownload.mockImplementation(({ destination }: { destination: unknown }) => {
			expect(destination).toBeInstanceOf(FileSystem.File)
			expect((destination as FileSystem.File).uri).toContain("Downloads/photo.jpg")

			return Promise.resolve(null) // null = cancelled, no further processing
		})

		await downloadDriveItemToDevice({ item })

		expect(mockTransfersDownload).toHaveBeenCalledOnce()
	})

	it("iOS + directory: destination is FileSystem.Directory under document/Downloads/name", async () => {
		setOS("ios")

		const item = makeDirItem({ name: "mydir" })

		mockTransfersDownload.mockImplementation(({ destination }: { destination: unknown }) => {
			expect(destination).toBeInstanceOf(FileSystem.Directory)
			expect((destination as FileSystem.Directory).uri).toContain("Downloads/mydir")

			return Promise.resolve(null)
		})

		await downloadDriveItemToDevice({ item })

		expect(mockTransfersDownload).toHaveBeenCalledOnce()
	})

	it("Android + file: destination is FileSystem.File under newTmpDir()/name", async () => {
		setOS("android")

		const tmpDir = new FileSystem.Directory(`${TMP_BASE}/fixed-uuid`)

		mockNewTmpDir.mockReturnValue(tmpDir)

		const item = makeFileItem({ name: "doc.pdf" })

		mockTransfersDownload.mockImplementation(({ destination }: { destination: unknown }) => {
			expect(destination).toBeInstanceOf(FileSystem.File)
			expect((destination as FileSystem.File).uri).toBe(`${TMP_BASE}/fixed-uuid/doc.pdf`)

			return Promise.resolve(null)
		})

		await downloadDriveItemToDevice({ item })

		expect(mockTransfersDownload).toHaveBeenCalledOnce()
	})

	it("Android + directory: destination is FileSystem.Directory under newTmpDir()/name", async () => {
		setOS("android")

		const tmpDir = new FileSystem.Directory(`${TMP_BASE}/fixed-uuid`)

		mockNewTmpDir.mockReturnValue(tmpDir)

		const item = makeDirItem({ name: "photos" })

		mockTransfersDownload.mockImplementation(({ destination }: { destination: unknown }) => {
			expect(destination).toBeInstanceOf(FileSystem.Directory)
			expect((destination as FileSystem.Directory).uri).toBe(`${TMP_BASE}/fixed-uuid/photos`)

			return Promise.resolve(null)
		})

		await downloadDriveItemToDevice({ item })

		expect(mockTransfersDownload).toHaveBeenCalledOnce()
	})

	it("type='sharedFile' treated as isFile=true", async () => {
		setOS("ios")

		const item: DriveItem = {
			type: "sharedFile",
			data: {
				uuid: "sf-uuid",
				size: 0n,
				undecryptable: false,
				decryptedMeta: {
					name: "shared.jpg",
					mime: "image/jpeg",
					size: 0n,
					version: 1,
					key: "key",
					modified: 1000,
					created: 1000
				}
			}
		} as unknown as DriveItem

		mockTransfersDownload.mockImplementation(({ destination }: { destination: unknown }) => {
			expect(destination).toBeInstanceOf(FileSystem.File)

			return Promise.resolve(null)
		})

		await downloadDriveItemToDevice({ item })

		expect(mockTransfersDownload).toHaveBeenCalledOnce()
	})

	it("type='sharedRootFile' treated as isFile=true", async () => {
		setOS("ios")

		const item: DriveItem = {
			type: "sharedRootFile",
			data: {
				uuid: "srf-uuid",
				size: 0n,
				undecryptable: false,
				decryptedMeta: {
					name: "root.jpg",
					mime: "image/jpeg",
					size: 0n,
					version: 1,
					key: "key",
					modified: 1000,
					created: 1000
				}
			}
		} as unknown as DriveItem

		mockTransfersDownload.mockImplementation(({ destination }: { destination: unknown }) => {
			expect(destination).toBeInstanceOf(FileSystem.File)

			return Promise.resolve(null)
		})

		await downloadDriveItemToDevice({ item })
	})

	it("type='directory' treated as isFile=false", async () => {
		setOS("ios")

		const item = makeDirItem({ name: "somedir" })

		mockTransfersDownload.mockImplementation(({ destination }: { destination: unknown }) => {
			expect(destination).toBeInstanceOf(FileSystem.Directory)

			return Promise.resolve(null)
		})

		await downloadDriveItemToDevice({ item })
	})

	it("missing decryptedMeta throws immediately with 'Missing decrypted metadata'", async () => {
		setOS("ios")

		const item = makeFileItem({ decryptedMeta: null })
		const result = await downloadDriveItemToDevice({ item })

		expect(result.success).toBe(false)
		expect((result as { success: false; error: Error }).error.message).toBe("Missing decrypted metadata")
		expect(mockTransfersDownload).not.toHaveBeenCalled()
	})
})

// ------------------------------------------------------------------
// 2. segment-decode pipeline (parentFolder computation)
// ------------------------------------------------------------------

describe("downloadDriveItemToDevice — segment-decode pipeline (Android directory)", () => {
	beforeEach(() => {
		setOS("android")
	})

	// Sets up the fake filesystem with a file inside a destination directory,
	// calls downloadDriveItemToDevice, and returns the parentFolder strings
	// passed to copyToMediaStore.
	//
	// Strategy: the tmpBase dir already exists (it's the parent). We do NOT
	// pre-create destUri so `destination.exists` is false → the code skips
	// the delete. transfers.download populates the destination with files
	// (simulating a real download completing).
	async function runAndCapture(
		dirName: string,
		subPath: string, // path segment(s) under destination dir, e.g. "subdir/file.txt"
		uuid = "test-dir-uuid"
	): Promise<string[]> {
		const tmpBase = `${TMP_BASE}/${uuid}`
		const destUri = `${tmpBase}/${dirName}`

		// tmpBase must exist so parentDirectory.exists is true — prevents the
		// intermediates create call from adding noise.
		fs.set(tmpBase, "dir")

		// Do NOT pre-set destUri so destination.exists === false (no delete).

		mockNewTmpDir.mockReturnValue(new FileSystem.Directory(tmpBase))

		const item = makeDirItem({ name: dirName, uuid })

		const capturedParentFolders: string[] = []

		// transfers.download simulates populating the destination directory with files
		mockTransfersDownload.mockImplementation(async () => {
			// Populate fs with destination dir + subpath
			fs.set(destUri, "dir")

			const parts = subPath.split("/")
			let current = destUri

			for (let i = 0; i < parts.length - 1; i++) {
				current = `${current}/${parts[i]}`
				fs.set(current, "dir")
			}

			fs.set(`${destUri}/${subPath}`, new Uint8Array([1]))

			return true
		})

		mockCopyToMediaStore.mockImplementation(({ parentFolder }: { parentFolder: string }) => {
			capturedParentFolders.push(parentFolder)

			return Promise.resolve(undefined)
		})

		await downloadDriveItemToDevice({ item })

		return capturedParentFolders
	}

	it("plain ASCII path: Filen/dirName/subdir — no decoding needed, output equals input", async () => {
		const folders = await runAndCapture("dirName", "subdir/file.txt")

		expect(folders).toHaveLength(1)
		expect(folders[0]).toBe("Filen/dirName/subdir")
	})

	it("path with space-encoded segment ('%20'): decoded back to 'Sub Folder'", async () => {
		// The entry path has a literal space in fs key, but Paths.join re-encodes it to %20.
		// We simulate what actually happens: the entry uri coming from the mock fs will have
		// the raw encoded form because that's how we set it up.
		const tmpBase = `${TMP_BASE}/space-test`
		const dirName = "topdir"
		const destUri = `${tmpBase}/${dirName}`

		// Encode the space the way Paths.join would: Sub%20Folder
		const encodedSubdir = "Sub%20Folder"
		const subDirUri = `${destUri}/${encodedSubdir}`

		fs.set(tmpBase, "dir")
		// Note: destUri is NOT pre-created; transfers.download populates it.

		mockNewTmpDir.mockReturnValue(new FileSystem.Directory(tmpBase))

		const item = makeDirItem({ name: dirName, uuid: "space-test" })
		const capturedParentFolders: string[] = []

		mockTransfersDownload.mockImplementation(async () => {
			fs.set(destUri, "dir")
			fs.set(subDirUri, "dir")
			fs.set(`${subDirUri}/file.txt`, new Uint8Array([1]))

			return true
		})

		mockCopyToMediaStore.mockImplementation(({ parentFolder }: { parentFolder: string }) => {
			capturedParentFolders.push(parentFolder)

			return Promise.resolve(undefined)
		})

		await downloadDriveItemToDevice({ item })

		expect(capturedParentFolders).toHaveLength(1)
		// %20 in the parentFolder segment must be decoded to a space
		expect(capturedParentFolders[0]).toBe("Filen/topdir/Sub Folder")
	})

	it("path with percent-encoded percent ('%25'): decoded back to '%'", async () => {
		const tmpBase = `${TMP_BASE}/percent-test`
		const dirName = "topdir"
		const destUri = `${tmpBase}/${dirName}`

		// %25 is how Paths.join encodes a literal "%" in a segment name
		const encodedSubdir = "50%25off"
		const subDirUri = `${destUri}/${encodedSubdir}`

		fs.set(tmpBase, "dir")
		// Note: destUri is NOT pre-created; transfers.download populates it.

		mockNewTmpDir.mockReturnValue(new FileSystem.Directory(tmpBase))

		const item = makeDirItem({ name: dirName, uuid: "percent-test" })
		const capturedParentFolders: string[] = []

		mockTransfersDownload.mockImplementation(async () => {
			fs.set(destUri, "dir")
			fs.set(subDirUri, "dir")
			fs.set(`${subDirUri}/file.txt`, new Uint8Array([1]))

			return true
		})

		mockCopyToMediaStore.mockImplementation(({ parentFolder }: { parentFolder: string }) => {
			capturedParentFolders.push(parentFolder)

			return Promise.resolve(undefined)
		})

		await downloadDriveItemToDevice({ item })

		expect(capturedParentFolders).toHaveLength(1)
		// %25 must decode to '%'
		expect(capturedParentFolders[0]).toBe("Filen/topdir/50%off")
	})

	it("path with bare '%' in a segment: decodeURIComponent throws → fallback returns raw segment unchanged", async () => {
		const tmpBase = `${TMP_BASE}/bare-percent-test`
		const dirName = "topdir"
		const destUri = `${tmpBase}/${dirName}`

		// A bare "%" is a malformed percent-escape — decodeURIComponent throws URIError
		// The segment is stored raw in the fs (as if the OS gave us this path)
		const rawSubdir = "50% off" // literal percent in the dir name
		const subDirUri = `${destUri}/${rawSubdir}`

		fs.set(tmpBase, "dir")
		// Note: destUri is NOT pre-created; transfers.download populates it.

		mockNewTmpDir.mockReturnValue(new FileSystem.Directory(tmpBase))

		const item = makeDirItem({ name: dirName, uuid: "bare-percent-test" })
		const capturedParentFolders: string[] = []

		mockTransfersDownload.mockImplementation(async () => {
			fs.set(destUri, "dir")
			fs.set(subDirUri, "dir")
			fs.set(`${subDirUri}/file.txt`, new Uint8Array([1]))

			return true
		})

		mockCopyToMediaStore.mockImplementation(({ parentFolder }: { parentFolder: string }) => {
			capturedParentFolders.push(parentFolder)

			return Promise.resolve(undefined)
		})

		// Should NOT throw — the try/catch fallback keeps the raw segment
		await expect(downloadDriveItemToDevice({ item })).resolves.toBeDefined()
		expect(capturedParentFolders).toHaveLength(1)

		// The segment "50% off" fails decodeURIComponent → falls back to the raw string
		expect(capturedParentFolders[0]).toContain("50% off")
	})

	it("empty segment ('') is passed through unchanged (no decode attempted)", async () => {
		// An empty segment in the middle of a path arises from double-slashes after join.
		// The pipeline's `if (segment.length === 0) return segment` guard handles it.
		// We test via a path where the relative slice starts with '/' → first segment is ''.
		// A file directly in the destination produces a dirname of "" or "." from the slice.
		const folders = await runAndCapture("dirName", "subfile.txt")

		// The empty-segment guard keeps the output from ever producing "//"
		expect(folders).toHaveLength(1)
		expect(folders[0]).not.toContain("//")
	})

	it("deep nesting: Filen/rootDir/a/b/c — all intermediate segments decoded correctly", async () => {
		const tmpBase = `${TMP_BASE}/deep-test`
		const dirName = "rootDir"
		const destUri = `${tmpBase}/${dirName}`

		fs.set(tmpBase, "dir")
		// Note: destUri is NOT pre-created; transfers.download populates it.

		mockNewTmpDir.mockReturnValue(new FileSystem.Directory(tmpBase))

		const item = makeDirItem({ name: dirName, uuid: "deep-test" })
		const capturedParentFolders: string[] = []

		mockTransfersDownload.mockImplementation(async () => {
			fs.set(destUri, "dir")
			fs.set(`${destUri}/a`, "dir")
			fs.set(`${destUri}/a/b`, "dir")
			fs.set(`${destUri}/a/b/c`, "dir")
			fs.set(`${destUri}/a/b/c/leaf.bin`, new Uint8Array([1]))

			return true
		})

		mockCopyToMediaStore.mockImplementation(({ parentFolder }: { parentFolder: string }) => {
			capturedParentFolders.push(parentFolder)

			return Promise.resolve(undefined)
		})

		await downloadDriveItemToDevice({ item })

		expect(capturedParentFolders).toHaveLength(1)
		expect(capturedParentFolders[0]).toBe("Filen/rootDir/a/b/c")
	})

	it("entry path at destination root: relative slice is empty, parentFolder is derived from dirname of root", async () => {
		// A file directly inside the destination directory (no subdir).
		// The parentFolder segments come from Paths.dirname of the "/" prefix after slicing,
		// which in the mock Paths.dirname of "/file.txt" returns "" (empty from the regex).
		// The final parentFolder is the join of Filen + dirName + dirname("").
		const folders = await runAndCapture("dirName", "file.txt")

		expect(folders).toHaveLength(1)
		// The parentFolder must contain "Filen" and "dirName"
		expect(folders[0]).toContain("Filen")
		expect(folders[0]).toContain("dirName")
	})

	it("parentFolder uses decryptedMeta.name as the directory segment in the path", async () => {
		// Verifies that `item.data.decryptedMeta?.name ?? item.data.uuid` is evaluated
		// in the parentFolder computation. When name is present, the name (not the uuid)
		// appears as the directory segment after "Filen/".
		const uuid = "uuid-that-should-not-appear"
		const dirName = "My Documents"

		const folders = await runAndCapture(dirName, "sub/file.txt", uuid)

		expect(folders).toHaveLength(1)
		// parentFolder is "Filen/My Documents/sub" — name is used, not uuid
		expect(folders[0]).toContain(dirName)
		expect(folders[0]).not.toContain(uuid)
	})
})

// ------------------------------------------------------------------
// 3. Android defer cleanup
// ------------------------------------------------------------------

describe("downloadDriveItemToDevice — Android defer cleanup", () => {
	it("on Android: defer deletes parentDirectory when it exists after download completes", async () => {
		setOS("android")

		const tmpBase = `${TMP_BASE}/defer-test`
		const dirName = "somefile.txt"
		const destUri = `${tmpBase}/${dirName}`

		// parentDirectory of the destination file is tmpBase
		fs.set(tmpBase, "dir")
		fs.set(destUri, new Uint8Array([1]))

		mockNewTmpDir.mockReturnValue(new FileSystem.Directory(tmpBase))

		const item = makeFileItem({ name: dirName })

		// downloads succeed, returning a truthy result triggers MediaStore copy
		mockTransfersDownload.mockResolvedValue(true)
		mockCopyToMediaStore.mockResolvedValue(undefined)

		await downloadDriveItemToDevice({ item })

		// After run() defers fire, tmpBase should be deleted
		expect(fs.has(tmpBase)).toBe(false)
	})

	it("on Android: defer fires even when transfers.download() throws", async () => {
		setOS("android")

		const tmpBase = `${TMP_BASE}/defer-throw-test`
		const dirName = "somefile.txt"
		const destUri = `${tmpBase}/${dirName}`

		fs.set(tmpBase, "dir")
		fs.set(destUri, new Uint8Array([1]))

		mockNewTmpDir.mockReturnValue(new FileSystem.Directory(tmpBase))

		const item = makeFileItem({ name: dirName })

		mockTransfersDownload.mockRejectedValue(new Error("download failed"))

		const result = await downloadDriveItemToDevice({ item })

		// run() catches the error
		expect(result.success).toBe(false)
		// defer must have run: tmpBase deleted
		expect(fs.has(tmpBase)).toBe(false)
	})

	it("on iOS: defer does NOT delete parentDirectory", async () => {
		setOS("ios")

		const destBase = "file:///document/Downloads"
		const dirName = "somefile.txt"
		const destUri = `${destBase}/${dirName}`

		// pre-populate so parentDirectory.exists === true on iOS
		fs.set(destBase, "dir")
		fs.set(destUri, new Uint8Array([1]))

		const item = makeFileItem({ name: dirName })

		mockTransfersDownload.mockResolvedValue(null) // cancelled

		await downloadDriveItemToDevice({ item })

		// iOS defer guard (Platform.OS === "android") prevents deletion
		expect(fs.has(destBase)).toBe(true)
	})
})

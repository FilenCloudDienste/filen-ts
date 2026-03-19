import { vi, describe, it, expect, beforeEach } from "vitest"

const { UniffiEnum } = vi.hoisted(() => ({
	UniffiEnum: class UniffiEnum {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		protected constructor(..._args: any[]) {}
	}
}))

vi.mock("uniffi-bindgen-react-native", () => ({
	UniffiEnum
}))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("@filen/sdk-rs", () => ({
	AnyFile: {
		File: class {
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		},
		Shared: class {
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		}
	},
	ManagedFuture: {
		new: vi.fn().mockReturnValue({})
	}
}))

vi.mock("@filen/utils", () => {
	class Semaphore {
		async acquire(): Promise<void> {}
		release(): void {}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async function run(fn: (defer: (cleanup: () => void) => void) => Promise<any>, opts?: { throw?: boolean }): Promise<any> {
		const cleanups: (() => void)[] = []

		const defer = (cleanup: () => void) => {
			cleanups.push(cleanup)
		}

		try {
			const data = await fn(defer)

			for (const cleanup of cleanups) {
				cleanup()
			}

			return opts?.throw ? data : { success: true, data }
		} catch (error) {
			for (const cleanup of cleanups) {
				cleanup()
			}

			if (opts?.throw) {
				throw error
			}

			return { success: false, error }
		}
	}

	return { Semaphore, run }
})

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: vi.fn().mockResolvedValue({
			authedSdkClient: {
				downloadFileToPath: vi.fn().mockResolvedValue(undefined)
			}
		})
	}
}))

vi.mock("@/lib/utils", () => ({
	wrapAbortSignalForSdk: vi.fn(s => s),
	normalizeFilePathForSdk: (p: string) =>
		p
			.trim()
			.replace(/^file:\/+/, "/")
			.replace(/\/+/g, "/")
			.replace(/\/$/, "")
}))

vi.mock("react-fast-compare", () => ({
	default: (a: unknown, b: unknown) =>
		JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? `__bigint__${v.toString()}` : v)) ===
		JSON.stringify(b, (_k, v) => (typeof v === "bigint" ? `__bigint__${v.toString()}` : v))
}))

// eslint-disable-next-line import/first
import { pack, unpack } from "@/lib/msgpack"
// eslint-disable-next-line import/first
import { fs, File } from "@/tests/mocks/expoFileSystem"
// eslint-disable-next-line import/first
import type { DriveItem } from "@/types"
// eslint-disable-next-line import/first
import auth from "@/lib/auth"
// eslint-disable-next-line import/first
import type { Metadata } from "@/lib/fileCache"

const BASE_DIR = "file:///shared/group.io.filen.app/fileCache/v1"

function makeFileItem(uuid: string, name: string): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
			decryptedMeta: {
				name,
				size: 100n,
				modified: 1000,
				created: 900,
				mime: "application/octet-stream"
			},
			size: 100n
		}
	} as unknown as DriveItem
}

function makeDirItem(uuid: string, name: string): DriveItem {
	return {
		type: "directory",
		data: {
			uuid,
			decryptedMeta: { name, size: 0n, modified: 1000, created: 900 }
		}
	} as unknown as DriveItem
}

function writeFile(uuid: string, data: Uint8Array = new Uint8Array([1, 2, 3])): void {
	const dir = `${BASE_DIR}/${uuid}`

	fs.set(dir, "dir")
	fs.set(`${dir}/${uuid}`, data)
}

function writeMetadata(uuid: string, item: DriveItem): void {
	const dir = `${BASE_DIR}/${uuid}`

	fs.set(dir, "dir")
	fs.set(`${dir}/${uuid}.filenmeta`, new Uint8Array(pack({ ...item, cachedAt: Date.now() })))
}

async function createFileCache(): Promise<InstanceType<typeof import("@/lib/fileCache").FileCache>> {
	const mod = await import("@/lib/fileCache")

	return new (mod.FileCache as new () => InstanceType<typeof mod.FileCache>)()
}

beforeEach(() => {
	fs.clear()
	vi.clearAllMocks()
})

describe("FileCache", () => {
	describe("constructor", () => {
		it("creates the parent directory on construction", async () => {
			const cache = await createFileCache()

			expect(cache).toBeDefined()
			expect(fs.has(BASE_DIR)).toBe(true)
			expect(fs.get(BASE_DIR)).toBe("dir")
		})

		it("does not throw if directory already exists", async () => {
			fs.set(BASE_DIR, "dir")

			const cache = await createFileCache()

			expect(cache).toBeDefined()
			expect(fs.get(BASE_DIR)).toBe("dir")
		})
	})

	describe("getFiles", () => {
		it("returns file, metadata, and parentDirectory for a valid item", async () => {
			const cache = await createFileCache()
			const item = makeFileItem("abc-123", "test.txt")

			const result = cache.getFiles(item)

			expect(result.file.uri).toBe(`${BASE_DIR}/abc-123/abc-123`)
			expect(result.metadata.uri).toBe(`${BASE_DIR}/abc-123/abc-123.filenmeta`)
			expect(result.parentDirectory.uri).toBe(`${BASE_DIR}/abc-123`)
		})

		it("throws when item has no decryptedMeta", async () => {
			const cache = await createFileCache()
			const item = { type: "file", data: { uuid: "no-meta" } } as unknown as DriveItem

			expect(() => cache.getFiles(item)).toThrow("Item does not have decrypted metadata")
		})

		it("creates UUID subdirectory if it doesn't exist", async () => {
			const cache = await createFileCache()
			const item = makeFileItem("new-uuid", "doc.pdf")

			expect(fs.has(`${BASE_DIR}/new-uuid`)).toBe(false)

			cache.getFiles(item)

			expect(fs.has(`${BASE_DIR}/new-uuid`)).toBe(true)
			expect(fs.get(`${BASE_DIR}/new-uuid`)).toBe("dir")
		})
	})

	describe("has", () => {
		it("returns true when file and metadata exist and match", async () => {
			const cache = await createFileCache()
			const item = makeFileItem("has-uuid", "photo.jpg")

			writeFile("has-uuid")
			writeMetadata("has-uuid", item)

			const result = await cache.has(item)

			expect(result).toBe(true)
		})

		it("returns false for non-file items", async () => {
			const cache = await createFileCache()
			const item = makeDirItem("dir-uuid", "my-folder")

			const result = await cache.has(item)

			expect(result).toBe(false)
		})

		it("returns false when file doesn't exist", async () => {
			const cache = await createFileCache()
			const item = makeFileItem("missing-uuid", "gone.txt")

			writeMetadata("missing-uuid", item)

			const result = await cache.has(item)

			expect(result).toBe(false)
		})

		it("returns false when metadata doesn't exist", async () => {
			const cache = await createFileCache()
			const item = makeFileItem("no-meta-uuid", "data.bin")

			writeFile("no-meta-uuid")

			const result = await cache.has(item)

			expect(result).toBe(false)
		})

		it("returns false when metadata is empty", async () => {
			const cache = await createFileCache()
			const item = makeFileItem("empty-meta", "file.txt")

			writeFile("empty-meta")

			const dir = `${BASE_DIR}/empty-meta`

			fs.set(dir, "dir")
			fs.set(`${dir}/empty-meta.filenmeta`, new Uint8Array(pack({})))

			const result = await cache.has(item)

			expect(result).toBe(false)
		})

		it("returns false when metadata doesn't match item", async () => {
			const cache = await createFileCache()
			const item = makeFileItem("mismatch-uuid", "v2.txt")
			const staleItem = makeFileItem("mismatch-uuid", "v1.txt")

			writeFile("mismatch-uuid")
			writeMetadata("mismatch-uuid", staleItem)

			const result = await cache.has(item)

			expect(result).toBe(false)
		})
	})

	describe("get", () => {
		it("returns cached file when metadata matches (cache hit)", async () => {
			const cache = await createFileCache()
			const item = makeFileItem("cached-uuid", "cached.txt")

			writeFile("cached-uuid", new Uint8Array([99]))
			writeMetadata("cached-uuid", item)

			const file = await cache.get({ item })

			expect(file).toBeInstanceOf(File)
			expect(file.uri).toBe(`${BASE_DIR}/cached-uuid/cached-uuid`)
		})

		it("downloads file via SDK when not cached (cache miss)", async () => {
			const cache = await createFileCache()
			const item = makeFileItem("dl-uuid", "download.bin")

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					downloadFileToPath: vi.fn().mockImplementation(async (_anyFile: unknown, path: string) => {
						const uri = "file://" + path

						fs.set(uri, new Uint8Array([10, 20, 30]))
					})
				}
			} as never)

			const file = await cache.get({ item })

			expect(file).toBeInstanceOf(File)
			expect(file.uri).toBe(`${BASE_DIR}/dl-uuid/dl-uuid`)

			const metaFile = new File(`${BASE_DIR}/dl-uuid/dl-uuid.filenmeta`)

			expect(metaFile.exists).toBe(true)

			const meta = unpack(await metaFile.bytes()) as Metadata

			expect(meta.cachedAt).toBeGreaterThan(0)
		})

		it("throws for non-file items", async () => {
			const cache = await createFileCache()
			const item = makeDirItem("dir-uuid", "folder")

			await expect(cache.get({ item })).rejects.toThrow("Item must be a file or shared file")
		})

		it("cleans up on download failure", async () => {
			const cache = await createFileCache()
			const item = makeFileItem("fail-uuid", "fail.bin")

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					downloadFileToPath: vi.fn().mockRejectedValue(new Error("Network error"))
				}
			} as never)

			await expect(cache.get({ item })).rejects.toThrow("Network error")
			expect(fs.has(`${BASE_DIR}/fail-uuid`)).toBe(false)
		})

		it("re-downloads when metadata doesn't match", async () => {
			const cache = await createFileCache()
			const staleItem = makeFileItem("redownload-uuid", "old.txt")
			const newItem = makeFileItem("redownload-uuid", "new.txt")

			writeFile("redownload-uuid", new Uint8Array([1]))
			writeMetadata("redownload-uuid", staleItem)

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					downloadFileToPath: vi.fn().mockImplementation(async (_anyFile: unknown, path: string) => {
						const uri = "file://" + path

						fs.set(uri, new Uint8Array([50, 60]))
					})
				}
			} as never)

			const file = await cache.get({ item: newItem })

			expect(file.uri).toBe(`${BASE_DIR}/redownload-uuid/redownload-uuid`)
		})

		it("deletes existing file before re-downloading", async () => {
			const cache = await createFileCache()
			const item = makeFileItem("replace-uuid", "replace.txt")

			writeFile("replace-uuid", new Uint8Array([1, 2, 3]))

			// Metadata doesn't match (different item to force re-download)
			const otherItem = makeFileItem("replace-uuid", "other.txt")

			writeMetadata("replace-uuid", otherItem)

			let fileExistedDuringDownload = true

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					downloadFileToPath: vi.fn().mockImplementation(async (_anyFile: unknown, path: string) => {
						const uri = "file://" + path
						const oldFileUri = `${BASE_DIR}/replace-uuid/replace-uuid`

						fileExistedDuringDownload = fs.has(oldFileUri)
						fs.set(uri, new Uint8Array([7, 8, 9]))
					})
				}
			} as never)

			await cache.get({ item })

			expect(fileExistedDuringDownload).toBe(false)
		})

		it("writes metadata after successful download", async () => {
			const cache = await createFileCache()
			const item = makeFileItem("meta-write-uuid", "result.dat")

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					downloadFileToPath: vi.fn().mockImplementation(async (_anyFile: unknown, path: string) => {
						const uri = "file://" + path

						fs.set(uri, new Uint8Array([42]))
					})
				}
			} as never)

			await cache.get({ item })

			const metaFile = new File(`${BASE_DIR}/meta-write-uuid/meta-write-uuid.filenmeta`)

			expect(metaFile.exists).toBe(true)

			const meta = unpack(await metaFile.bytes()) as Metadata

			expect(meta.type).toBe("file")
			expect(meta.cachedAt).toBeTypeOf("number")
		})
	})

	describe("remove", () => {
		it("removes file, metadata, and parent directory", async () => {
			const cache = await createFileCache()
			const item = makeFileItem("rm-uuid", "remove-me.txt")

			writeFile("rm-uuid")
			writeMetadata("rm-uuid", item)

			await cache.remove(item)

			expect(fs.has(`${BASE_DIR}/rm-uuid/rm-uuid`)).toBe(false)
			expect(fs.has(`${BASE_DIR}/rm-uuid/rm-uuid.filenmeta`)).toBe(false)
			expect(fs.has(`${BASE_DIR}/rm-uuid`)).toBe(false)
		})

		it("throws for non-file items", async () => {
			const cache = await createFileCache()
			const item = makeDirItem("dir-uuid", "folder")

			await expect(cache.remove(item)).rejects.toThrow("Item must be a file or shared file")
		})

		it("does not throw when files don't exist", async () => {
			const cache = await createFileCache()
			const item = makeFileItem("ghost-uuid", "phantom.txt")

			await expect(cache.remove(item)).resolves.toBeUndefined()
		})
	})

	describe("gc", () => {
		it("deletes expired entries", async () => {
			const cache = await createFileCache()
			const uuid = "expired-uuid"
			const dir = `${BASE_DIR}/${uuid}`
			const expiredTime = Date.now() - 86400 * 1000 - 1

			fs.set(dir, "dir")
			fs.set(`${dir}/${uuid}`, new Uint8Array([1]))
			fs.set(`${dir}/${uuid}.filenmeta`, new Uint8Array(pack({ cachedAt: expiredTime })))

			await cache.gc()

			expect(fs.has(dir)).toBe(false)
			expect(fs.has(`${dir}/${uuid}`)).toBe(false)
			expect(fs.has(`${dir}/${uuid}.filenmeta`)).toBe(false)
		})

		it("keeps fresh entries", async () => {
			const cache = await createFileCache()
			const uuid = "fresh-uuid"
			const item = makeFileItem(uuid, "fresh.txt")
			const dir = `${BASE_DIR}/${uuid}`

			fs.set(dir, "dir")
			fs.set(`${dir}/${uuid}`, new Uint8Array([1]))
			fs.set(`${dir}/${uuid}.filenmeta`, new Uint8Array(pack({ ...item, cachedAt: Date.now() })))

			await cache.gc()

			expect(fs.has(dir)).toBe(true)
			expect(fs.has(`${dir}/${uuid}`)).toBe(true)
		})

		it("deletes entries with missing metadata", async () => {
			const cache = await createFileCache()
			const uuid = "orphan-uuid"
			const dir = `${BASE_DIR}/${uuid}`

			fs.set(dir, "dir")
			fs.set(`${dir}/${uuid}`, new Uint8Array([1]))

			await cache.gc()

			expect(fs.has(dir)).toBe(false)
			expect(fs.has(`${dir}/${uuid}`)).toBe(false)
		})
	})
})

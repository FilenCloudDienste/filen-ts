import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

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

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

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

vi.mock("@/lib/offline", () => ({
	default: {
		getLocalFile: vi.fn().mockResolvedValue(null)
	}
}))

vi.mock("react-fast-compare", () => ({
	default: (a: unknown, b: unknown) =>
		JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? `__bigint__${v.toString()}` : v)) ===
		JSON.stringify(b, (_k, v) => (typeof v === "bigint" ? `__bigint__${v.toString()}` : v))
}))

import { serialize, deserialize } from "@/lib/serializer"
import { fs, File } from "@/tests/mocks/expoFileSystem"
import { type DriveItem, type CacheItem } from "@/types"
import auth from "@/lib/auth"
import { type Metadata } from "@/lib/fileCache"
import { xxHash32 } from "js-xxhash"

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

function wrapDrive(item: DriveItem): CacheItem {
	return {
		type: "drive",
		data: item
	}
}

function makeExternalItem(url: string, name: string): CacheItem {
	return {
		type: "external",
		data: {
			url,
			name
		}
	}
}

function externalId(url: string): string {
	return xxHash32(url).toString(16)
}

function extname(filename: string): string {
	const dot = filename.lastIndexOf(".")

	return dot === -1 ? "" : filename.slice(dot)
}

function writeFile(uuid: string, name: string, data: Uint8Array = new Uint8Array([1, 2, 3])): void {
	const dir = `${BASE_DIR}/${uuid}`

	fs.set(dir, "dir")
	fs.set(`${dir}/${uuid}${extname(name)}`, data)
}

function writeMetadata(uuid: string, item: CacheItem): void {
	const dir = `${BASE_DIR}/${uuid}`

	fs.set(dir, "dir")
	fs.set(`${dir}/${uuid}.filenmeta`, new Uint8Array(new TextEncoder().encode(serialize({ ...item, cachedAt: Date.now() }))))
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
			const item = wrapDrive(makeFileItem("abc-123", "test.txt"))

			const result = cache.getFiles(item)

			expect(result.file.uri).toBe(`${BASE_DIR}/abc-123/abc-123.txt`)
			expect(result.metadata.uri).toBe(`${BASE_DIR}/abc-123/abc-123.filenmeta`)
			expect(result.parentDirectory.uri).toBe(`${BASE_DIR}/abc-123`)
		})

		it("throws when item has no decryptedMeta", async () => {
			const cache = await createFileCache()
			const item: CacheItem = {
				type: "drive",
				data: { type: "file", data: { uuid: "no-meta" } } as unknown as DriveItem
			}

			expect(() => cache.getFiles(item)).toThrow("Item does not have decrypted metadata")
		})

		it("creates UUID subdirectory if it doesn't exist", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("new-uuid", "doc.pdf"))

			expect(fs.has(`${BASE_DIR}/new-uuid`)).toBe(false)

			cache.getFiles(item)

			expect(fs.has(`${BASE_DIR}/new-uuid`)).toBe(true)
			expect(fs.get(`${BASE_DIR}/new-uuid`)).toBe("dir")
		})

		it("returns file, metadata, and parentDirectory for an external item", async () => {
			const cache = await createFileCache()
			const url = "https://example.com/asset.png"
			const item = makeExternalItem(url, "asset.png")
			const id = externalId(url)

			const result = cache.getFiles(item)

			expect(result.file.uri).toBe(`${BASE_DIR}/${id}/${id}.png`)
			expect(result.metadata.uri).toBe(`${BASE_DIR}/${id}/${id}.filenmeta`)
			expect(result.parentDirectory.uri).toBe(`${BASE_DIR}/${id}`)
		})
	})

	describe("has", () => {
		it("returns true when file and metadata exist and match", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("has-uuid", "photo.jpg"))

			writeFile("has-uuid", "photo.jpg")
			writeMetadata("has-uuid", item)

			const result = await cache.has(item)

			expect(result).toBe(true)
		})

		it("returns false for non-file items", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeDirItem("dir-uuid", "my-folder"))

			const result = await cache.has(item)

			expect(result).toBe(false)
		})

		it("returns false when file doesn't exist", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("missing-uuid", "gone.txt"))

			writeMetadata("missing-uuid", item)

			const result = await cache.has(item)

			expect(result).toBe(false)
		})

		it("returns false when metadata doesn't exist", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("no-meta-uuid", "data.bin"))

			writeFile("no-meta-uuid", "data.bin")

			const result = await cache.has(item)

			expect(result).toBe(false)
		})

		it("returns false when metadata is empty", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("empty-meta", "file.txt"))

			writeFile("empty-meta", "file.txt")

			const dir = `${BASE_DIR}/empty-meta`

			fs.set(dir, "dir")
			fs.set(`${dir}/empty-meta.filenmeta`, new Uint8Array(new TextEncoder().encode(serialize({}))))

			const result = await cache.has(item)

			expect(result).toBe(false)
		})

		it("returns false when metadata doesn't match item", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("mismatch-uuid", "v2.txt"))
			const staleItem = wrapDrive(makeFileItem("mismatch-uuid", "v1.txt"))

			writeFile("mismatch-uuid", "v1.txt")
			writeMetadata("mismatch-uuid", staleItem)

			const result = await cache.has(item)

			expect(result).toBe(false)
		})
	})

	describe("get", () => {
		it("returns cached file when metadata matches (cache hit)", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("cached-uuid", "cached.txt"))

			writeFile("cached-uuid", "cached.txt", new Uint8Array([99]))
			writeMetadata("cached-uuid", item)

			const file = await cache.get({ item })

			expect(file).toBeInstanceOf(File)
			expect(file.uri).toBe(`${BASE_DIR}/cached-uuid/cached-uuid.txt`)
		})

		it("downloads file via SDK when not cached (cache miss)", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("dl-uuid", "download.bin"))

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
			expect(file.uri).toBe(`${BASE_DIR}/dl-uuid/dl-uuid.bin`)

			const metaFile = new File(`${BASE_DIR}/dl-uuid/dl-uuid.filenmeta`)

			expect(metaFile.exists).toBe(true)

			const meta = deserialize(new TextDecoder().decode(await metaFile.bytes())) as Metadata

			expect(meta.cachedAt).toBeGreaterThan(0)
		})

		it("throws for non-file items", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeDirItem("dir-uuid", "folder"))

			await expect(cache.get({ item })).rejects.toThrow("Item must be a file or shared file")
		})

		it("cleans up on download failure", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("fail-uuid", "fail.bin"))

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
			const staleItem = wrapDrive(makeFileItem("redownload-uuid", "old.txt"))
			const newItem = wrapDrive(makeFileItem("redownload-uuid", "new.txt"))

			writeFile("redownload-uuid", "old.txt", new Uint8Array([1]))
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

			expect(file.uri).toBe(`${BASE_DIR}/redownload-uuid/redownload-uuid.txt`)
		})

		it("deletes existing file before re-downloading", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("replace-uuid", "replace.txt"))

			writeFile("replace-uuid", "replace.txt", new Uint8Array([1, 2, 3]))

			// Metadata doesn't match (different item to force re-download)
			const otherItem = wrapDrive(makeFileItem("replace-uuid", "other.txt"))

			writeMetadata("replace-uuid", otherItem)

			let fileExistedDuringDownload = true

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					downloadFileToPath: vi.fn().mockImplementation(async (_anyFile: unknown, path: string) => {
						const uri = "file://" + path
						const oldFileUri = `${BASE_DIR}/replace-uuid/replace-uuid.txt`

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
			const item = wrapDrive(makeFileItem("meta-write-uuid", "result.dat"))

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

			const meta = deserialize(new TextDecoder().decode(await metaFile.bytes())) as Metadata

			expect(meta.type).toBe("drive")
			expect(meta.cachedAt).toBeTypeOf("number")
		})

		it("downloads external item via FileSystem.File.downloadFileAsync", async () => {
			const cache = await createFileCache()
			const url = "https://example.com/picture.jpg"
			const item = makeExternalItem(url, "picture.jpg")
			const id = externalId(url)

			const file = await cache.get({ item })

			expect(file).toBeInstanceOf(File)
			expect(file.uri).toBe(`${BASE_DIR}/${id}/${id}.jpg`)
			expect(file.exists).toBe(true)

			const metaFile = new File(`${BASE_DIR}/${id}/${id}.filenmeta`)

			expect(metaFile.exists).toBe(true)

			const meta = deserialize(new TextDecoder().decode(await metaFile.bytes())) as Metadata

			expect(meta.type).toBe("external")
			expect(meta.cachedAt).toBeTypeOf("number")
		})
	})

	describe("remove", () => {
		it("removes file, metadata, and parent directory", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("rm-uuid", "remove-me.txt"))

			writeFile("rm-uuid", "remove-me.txt")
			writeMetadata("rm-uuid", item)

			await cache.remove(item)

			expect(fs.has(`${BASE_DIR}/rm-uuid/rm-uuid.txt`)).toBe(false)
			expect(fs.has(`${BASE_DIR}/rm-uuid/rm-uuid.filenmeta`)).toBe(false)
			expect(fs.has(`${BASE_DIR}/rm-uuid`)).toBe(false)
		})

		it("throws for non-file items", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeDirItem("dir-uuid", "folder"))

			await expect(cache.remove(item)).rejects.toThrow("Item must be a file or shared file")
		})

		it("does not throw when files don't exist", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("ghost-uuid", "phantom.txt"))

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
			fs.set(`${dir}/${uuid}.filenmeta`, new Uint8Array(new TextEncoder().encode(serialize({ cachedAt: expiredTime }))))

			await cache.gc()

			expect(fs.has(dir)).toBe(false)
			expect(fs.has(`${dir}/${uuid}`)).toBe(false)
			expect(fs.has(`${dir}/${uuid}.filenmeta`)).toBe(false)
		})

		it("keeps fresh entries", async () => {
			const cache = await createFileCache()
			const uuid = "fresh-uuid"
			const item = wrapDrive(makeFileItem(uuid, "fresh.txt"))
			const dir = `${BASE_DIR}/${uuid}`

			fs.set(dir, "dir")
			fs.set(`${dir}/${uuid}`, new Uint8Array([1]))
			fs.set(`${dir}/${uuid}.filenmeta`, new Uint8Array(new TextEncoder().encode(serialize({ ...item, cachedAt: Date.now() }))))

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

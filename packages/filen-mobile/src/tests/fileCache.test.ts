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

vi.mock("@/lib/utils", () => ({}))

vi.mock("@/lib/paths", () => ({
	normalizeFilePathForSdk: (p: string) =>
		p
			.trim()
			.replace(/^file:\/+/, "/")
			.replace(/\/+/g, "/")
			.replace(/\/$/, "")
}))

vi.mock("@/lib/signals", () => ({
	wrapAbortSignalForSdk: vi.fn(s => s)
}))

vi.mock("@/features/offline/offline", () => ({
	VERSION: 1,
	default: {
		getLocalFile: vi.fn().mockResolvedValue(null)
	}
}))

// fsUtils (imported by fileCache.ts) now pulls VERSION from sibling lib modules.
// Mock them with just the VERSION export so their full transitive deps don't load.
vi.mock("@/features/audio/audioCache", () => ({ VERSION: 1 }))
vi.mock("@/lib/thumbnails", () => ({ VERSION: 2 }))

import { serialize, deserialize } from "@/lib/serializer"
import { fs, File } from "@/tests/mocks/expoFileSystem"
import { type DriveItem, type CacheItem } from "@/types"
import auth from "@/lib/auth"
import { wrapAbortSignalForSdk } from "@/lib/signals"
import { type Metadata } from "@/lib/fileCache"
import offline from "@/features/offline/offline"
import { xxHash32 } from "js-xxhash"

const BASE_DIR = "file:///shared/group.io.filen.app/fileCache/v1"

function makeFileItem(uuid: string, name: string, size: bigint = 100n, favorited: boolean = false): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
			decryptedMeta: {
				name,
				size,
				modified: 1000,
				created: 900,
				mime: "application/octet-stream"
			},
			undecryptable: false,
			size,
			favorited
		}
	} as unknown as DriveItem
}

function makeSharedFileItem(uuid: string, name: string): DriveItem {
	return {
		type: "sharedFile",
		data: {
			uuid,
			decryptedMeta: {
				name,
				size: 100n,
				modified: 1000,
				created: 900,
				mime: "application/octet-stream"
			},
			undecryptable: false,
			size: 100n
		}
	} as unknown as DriveItem
}

function makeSharedRootFileItem(uuid: string, name: string): DriveItem {
	return {
		type: "sharedRootFile",
		data: {
			uuid,
			decryptedMeta: {
				name,
				size: 100n,
				modified: 1000,
				created: 900,
				mime: "application/octet-stream"
			},
			undecryptable: false,
			size: 100n
		}
	} as unknown as DriveItem
}

function makeDirItem(uuid: string, name: string): DriveItem {
	return {
		type: "directory",
		data: {
			uuid,
			decryptedMeta: { name, size: 0n, modified: 1000, created: 900 },
			undecryptable: false
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
				data: { type: "file", data: { uuid: "no-meta", undecryptable: true } } as unknown as DriveItem
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

		it("returns false when metadata sidecar is zero bytes (skips deserialization entirely)", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("zerobyte-meta", "photo.jpg"))

			// Write the actual file
			writeFile("zerobyte-meta", "photo.jpg")

			// Write a zero-byte sidecar (simulates an interrupted atomic write)
			const dir = `${BASE_DIR}/zerobyte-meta`

			fs.set(dir, "dir")
			fs.set(`${dir}/zerobyte-meta.filenmeta`, new Uint8Array([]))

			// Spy on deserialize to confirm it is NOT called for a zero-byte sidecar
			const deserializeSpy = vi.spyOn(await import("@/lib/serializer"), "deserialize")

			const result = await cache.has(item)

			expect(result).toBe(false)
			// The metadata.size === 0 guard must short-circuit before any deserialization
			expect(deserializeSpy).not.toHaveBeenCalled()

			deserializeSpy.mockRestore()
		})

		it("two independent false branches: zero-byte sidecar hits size===0 guard; serialize({}) hits Object.keys guard", async () => {
			const cache = await createFileCache()

			// Branch 1: zero-byte sidecar — metadata.size === 0 (line 137 in fileCache.ts)
			const zeroItem = wrapDrive(makeFileItem("zero-branch", "img.png"))

			writeFile("zero-branch", "img.png")

			const zeroDir = `${BASE_DIR}/zero-branch`

			fs.set(zeroDir, "dir")
			fs.set(`${zeroDir}/zero-branch.filenmeta`, new Uint8Array([]))

			const zeroResult = await cache.has(zeroItem)

			expect(zeroResult).toBe(false)

			// Branch 2: non-zero sidecar containing serialize({}) — hits Object.keys().length===0 check (line 143)
			const emptyItem = wrapDrive(makeFileItem("empty-branch", "img.png"))
			const emptyBytes = new Uint8Array(new TextEncoder().encode(serialize({})))

			writeFile("empty-branch", "img.png")

			const emptyDir = `${BASE_DIR}/empty-branch`

			fs.set(emptyDir, "dir")
			fs.set(`${emptyDir}/empty-branch.filenmeta`, emptyBytes)

			// Confirm the bytes are genuinely non-zero so this test is meaningful
			expect(emptyBytes.length).toBeGreaterThan(0)

			const emptyResult = await cache.has(emptyItem)

			expect(emptyResult).toBe(false)
		})

		it("returns false when the cached size doesn't match (content-identity sanity check)", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("mismatch-uuid", "doc.txt", 200n))
			const staleItem = wrapDrive(makeFileItem("mismatch-uuid", "doc.txt", 100n))

			writeFile("mismatch-uuid", "doc.txt")
			writeMetadata("mismatch-uuid", staleItem)

			const result = await cache.has(item)

			expect(result).toBe(false)
		})

		it("returns false when the sidecar claims a different uuid", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("uuid-a", "doc.txt"))
			// A sidecar in uuid-a's directory whose embedded item carries uuid-b
			// (cross-write / corruption) must never validate uuid-a's bytes.
			const foreignItem = wrapDrive(makeFileItem("uuid-b", "doc.txt"))

			writeFile("uuid-a", "doc.txt")
			writeMetadata("uuid-a", foreignItem)

			const result = await cache.has(item)

			expect(result).toBe(false)
		})

		it("returns true for a renamed + refavorited same-uuid item (metadata-only changes must not invalidate cached bytes)", async () => {
			const cache = await createFileCache()
			// uuid rotates on every content change — same uuid means identical bytes,
			// so a rename/favorite (uuid unchanged) must still HIT.
			const cachedItem = wrapDrive(makeFileItem("rename-uuid", "old-name.txt", 100n, false))
			const renamedItem = wrapDrive(makeFileItem("rename-uuid", "new-name.txt", 100n, true))

			writeFile("rename-uuid", "old-name.txt")
			writeMetadata("rename-uuid", cachedItem)

			const result = await cache.has(renamedItem)

			expect(result).toBe(true)
		})

		it("hits for a live-shaped item whose serializer round-trip differs structurally (uuid identity, not deep equality)", async () => {
			const cache = await createFileCache()

			// Live SDK items carry UniffiEnum-style variant CLASS instances and
			// present-but-undefined keys — shapes a serializer round-trip can never
			// reproduce (plain objects, missing keys). Deep equality always failed for
			// these; uuid identity must hit.
			class FakeVariant {
				public readonly tag = "Normal"
				public readonly inner: unknown[]

				public constructor(inner: unknown) {
					this.inner = [inner]
				}
			}

			const liveItem = {
				type: "drive",
				data: {
					type: "file",
					data: {
						uuid: "live-uuid",
						decryptedMeta: {
							name: "live.txt",
							size: 100n,
							modified: 1000,
							created: 900,
							mime: "application/octet-stream"
						},
						undecryptable: false,
						size: 100n,
						parent: new FakeVariant("parent-uuid"),
						canMakeThumbnail: undefined
					}
				}
			} as unknown as CacheItem

			writeFile("live-uuid", "live.txt")

			// The on-disk sidecar is what a serializer round-trip produces: plain objects,
			// no class instances, no present-but-undefined keys.
			const dir = `${BASE_DIR}/live-uuid`

			fs.set(dir, "dir")
			fs.set(
				`${dir}/live-uuid.filenmeta`,
				new Uint8Array(
					new TextEncoder().encode(
						serialize({
							type: "drive",
							data: {
								type: "file",
								data: {
									uuid: "live-uuid",
									decryptedMeta: {
										name: "live.txt",
										size: 100n,
										modified: 1000,
										created: 900,
										mime: "application/octet-stream"
									},
									undecryptable: false,
									size: 100n,
									parent: {
										tag: "Normal",
										inner: ["parent-uuid"]
									}
								}
							},
							cachedAt: Date.now()
						})
					)
				)
			)

			const result = await cache.has(liveItem)

			expect(result).toBe(true)
		})

		it("returns false and self-heals (deletes the sidecar) when the sidecar is torn JSON", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("torn-uuid", "torn.txt"))
			const dir = `${BASE_DIR}/torn-uuid`
			const metaPath = `${dir}/torn-uuid.filenmeta`

			writeFile("torn-uuid", "torn.txt")
			fs.set(dir, "dir")
			// A crash mid-write (pre-atomic sidecars) leaves truncated JSON.
			fs.set(metaPath, new Uint8Array(new TextEncoder().encode('{"type":"drive","data"')))

			// Must NOT throw — torn sidecar is a miss, and the entry self-heals.
			await expect(cache.has(item)).resolves.toBe(false)
			expect(fs.has(metaPath)).toBe(false)
		})

		it("returns true via offline fast path when offline file exists", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("offline-uuid", "offline.txt"))

			// Simulate an offline file on disk and return it from getLocalFile
			const offlinePath = "file:///document/offline/v1/files/offline-uuid/offline.txt"

			fs.set(offlinePath, new Uint8Array([1, 2, 3]))

			const offlineFile = new File(offlinePath)

			vi.mocked(offline.getLocalFile).mockResolvedValue(offlineFile as never)

			// No fileCache entry written — the offline path must short-circuit to true
			const result = await cache.has(item)

			expect(result).toBe(true)
			// Offline short-circuit must have been taken — getLocalFile was called with the DriveItem (item.data)
			expect(vi.mocked(offline.getLocalFile)).toHaveBeenCalledWith(item.data)
		})

		it("returns true for sharedFile type when file and metadata exist and match", async () => {
			const cache = await createFileCache()
			const driveItem = makeSharedFileItem("shared-uuid", "shared.jpg")
			const item = wrapDrive(driveItem)

			writeFile("shared-uuid", "shared.jpg")
			writeMetadata("shared-uuid", item)

			const result = await cache.has(item)

			expect(result).toBe(true)
		})

		it("returns true for sharedRootFile type when file and metadata exist and match", async () => {
			const cache = await createFileCache()
			const driveItem = makeSharedRootFileItem("sharedroot-uuid", "root.png")
			const item = wrapDrive(driveItem)

			writeFile("sharedroot-uuid", "root.png")
			writeMetadata("sharedroot-uuid", item)

			const result = await cache.has(item)

			expect(result).toBe(true)
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

		it("returns the cached file for a renamed same-uuid item without re-downloading", async () => {
			const cache = await createFileCache()
			const cachedItem = wrapDrive(makeFileItem("renamed-hit-uuid", "before.txt"))
			const renamedItem = wrapDrive(makeFileItem("renamed-hit-uuid", "after.txt"))

			writeFile("renamed-hit-uuid", "before.txt", new Uint8Array([42]))
			writeMetadata("renamed-hit-uuid", cachedItem)

			const file = await cache.get({ item: renamedItem })

			expect(file.uri).toBe(`${BASE_DIR}/renamed-hit-uuid/renamed-hit-uuid.txt`)
			// Same uuid means identical bytes — no SDK download may happen.
			expect(auth.getSdkClients).not.toHaveBeenCalled()
		})

		it("writes the metadata sidecar atomically (temp file + single overwriting move)", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("atomic-uuid", "atomic.bin"))

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					downloadFileToPath: vi.fn().mockImplementation(async (_anyFile: unknown, path: string) => {
						fs.set("file://" + path, new Uint8Array([1]))
					})
				}
			} as never)

			const moveSpy = vi.spyOn(File.prototype, "moveSync")
			let moveCalls: unknown[][] = []

			try {
				await cache.get({ item })
			} finally {
				// mockRestore clears the recorded calls — snapshot them first.
				moveCalls = [...moveSpy.mock.calls]

				moveSpy.mockRestore()
			}

			// The sidecar landed via an overwriting move of a temp sibling, never a direct write.
			const metaUri = `${BASE_DIR}/atomic-uuid/atomic-uuid.filenmeta`
			const sidecarMove = moveCalls.find(call => (call[0] as File).uri === metaUri)

			expect(sidecarMove).toBeDefined()
			expect(sidecarMove?.[1]).toEqual({ overwrite: true })

			// Final sidecar is valid and no temp file leaked into filen-tmp.
			const meta = deserialize(new TextDecoder().decode(await new File(metaUri).bytes())) as Metadata

			expect(meta.type).toBe("drive")
			expect(meta.cachedAt).toBeTypeOf("number")

			for (const key of fs.keys()) {
				expect(key.includes("/filen-tmp/.tmp-")).toBe(false)
			}
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

		it("recovers from a corrupt fast-path metadata sidecar instead of throwing", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("corrupt-fast-uuid", "song.txt"))
			const dir = `${BASE_DIR}/corrupt-fast-uuid`

			// File + non-empty metadata sidecar both exist (passes the fast-path guard),
			// but the sidecar contains invalid JSON so deserialize() throws.
			fs.set(dir, "dir")
			fs.set(`${dir}/corrupt-fast-uuid.txt`, new Uint8Array([1, 2, 3]))
			fs.set(`${dir}/corrupt-fast-uuid.filenmeta`, new Uint8Array(new TextEncoder().encode("{this is not valid json}")))

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					downloadFileToPath: vi.fn().mockImplementation(async (_anyFile: unknown, path: string) => {
						const uri = "file://" + path

						fs.set(uri, new Uint8Array([4, 5, 6]))
					})
				}
			} as never)

			const file = await cache.get({ item })

			expect(file).toBeInstanceOf(File)
			expect(file.uri).toBe(`${BASE_DIR}/corrupt-fast-uuid/corrupt-fast-uuid.txt`)

			// The corrupt sidecar was replaced with valid metadata during recovery.
			const metaFile = new File(`${BASE_DIR}/corrupt-fast-uuid/corrupt-fast-uuid.filenmeta`)

			expect(metaFile.exists).toBe(true)

			const meta = deserialize(new TextDecoder().decode(await metaFile.bytes())) as Metadata

			expect(meta.type).toBe("drive")
			expect(meta.cachedAt).toBeTypeOf("number")
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

		it("re-downloads when the cached size doesn't match", async () => {
			const cache = await createFileCache()
			const staleItem = wrapDrive(makeFileItem("redownload-uuid", "doc.txt", 50n))
			const newItem = wrapDrive(makeFileItem("redownload-uuid", "doc.txt", 100n))

			writeFile("redownload-uuid", "doc.txt", new Uint8Array([1]))
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

			// Metadata doesn't match (different size to force re-download)
			const otherItem = wrapDrive(makeFileItem("replace-uuid", "replace.txt", 999n))

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

		it("returns offline file directly without downloading when offline file exists", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("offline-get-uuid", "offline.bin"))

			const offlinePath = "file:///document/offline/v1/files/offline-get-uuid/offline.bin"

			fs.set(offlinePath, new Uint8Array([55, 66, 77]))

			const offlineFile = new File(offlinePath)

			vi.mocked(offline.getLocalFile).mockResolvedValue(offlineFile as never)

			const file = await cache.get({ item })

			// Must return the offline file, not a fileCache path
			expect(file.uri).toBe(offlinePath)
			// SDK download must NOT have been called
			expect(auth.getSdkClients).not.toHaveBeenCalled()
		})

		it("passes the AbortSignal through wrapAbortSignalForSdk when provided", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("signal-uuid", "signal.bin"))
			const controller = new AbortController()

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					downloadFileToPath: vi.fn().mockImplementation(async (_anyFile: unknown, path: string) => {
						fs.set("file://" + path, new Uint8Array([1]))
					})
				}
			} as never)

			await cache.get({ item, signal: controller.signal })

			expect(vi.mocked(wrapAbortSignalForSdk)).toHaveBeenCalledWith(controller.signal)
		})

		it("does not call wrapAbortSignalForSdk when no signal is provided", async () => {
			const cache = await createFileCache()
			const item = wrapDrive(makeFileItem("nosignal-uuid", "nosignal.bin"))

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					downloadFileToPath: vi.fn().mockImplementation(async (_anyFile: unknown, path: string) => {
						fs.set("file://" + path, new Uint8Array([1]))
					})
				}
			} as never)

			await cache.get({ item })

			expect(vi.mocked(wrapAbortSignalForSdk)).not.toHaveBeenCalled()
		})

		it("downloads sharedFile type via SDK and caches metadata correctly", async () => {
			const cache = await createFileCache()
			const driveItem = makeSharedFileItem("sf-uuid", "shared.bin")
			const item = wrapDrive(driveItem)

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					downloadFileToPath: vi.fn().mockImplementation(async (_anyFile: unknown, path: string) => {
						fs.set("file://" + path, new Uint8Array([11, 22]))
					})
				}
			} as never)

			const file = await cache.get({ item })

			expect(file.uri).toBe(`${BASE_DIR}/sf-uuid/sf-uuid.bin`)

			const metaFile = new File(`${BASE_DIR}/sf-uuid/sf-uuid.filenmeta`)
			const meta = deserialize(new TextDecoder().decode(await metaFile.bytes())) as Metadata

			expect(meta.type).toBe("drive")
			expect((meta as Extract<Metadata, { type: "drive" }>).data.type).toBe("sharedFile")
		})

		it("downloads sharedRootFile type via SDK and caches metadata correctly", async () => {
			const cache = await createFileCache()
			const driveItem = makeSharedRootFileItem("srf-uuid", "rootshared.bin")
			const item = wrapDrive(driveItem)

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					downloadFileToPath: vi.fn().mockImplementation(async (_anyFile: unknown, path: string) => {
						fs.set("file://" + path, new Uint8Array([33, 44]))
					})
				}
			} as never)

			const file = await cache.get({ item })

			expect(file.uri).toBe(`${BASE_DIR}/srf-uuid/srf-uuid.bin`)

			const metaFile = new File(`${BASE_DIR}/srf-uuid/srf-uuid.filenmeta`)
			const meta = deserialize(new TextDecoder().decode(await metaFile.bytes())) as Metadata

			expect(meta.type).toBe("drive")
			expect((meta as Extract<Metadata, { type: "drive" }>).data.type).toBe("sharedRootFile")
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

		it("removes sharedFile entries without throwing", async () => {
			const cache = await createFileCache()
			const driveItem = makeSharedFileItem("rmshared-uuid", "rmshared.txt")
			const item = wrapDrive(driveItem)

			writeFile("rmshared-uuid", "rmshared.txt")
			writeMetadata("rmshared-uuid", item)

			await cache.remove(item)

			expect(fs.has(`${BASE_DIR}/rmshared-uuid`)).toBe(false)
		})

		it("removes sharedRootFile entries without throwing", async () => {
			const cache = await createFileCache()
			const driveItem = makeSharedRootFileItem("rmsharedroot-uuid", "rmsharedroot.txt")
			const item = wrapDrive(driveItem)

			writeFile("rmsharedroot-uuid", "rmsharedroot.txt")
			writeMetadata("rmsharedroot-uuid", item)

			await cache.remove(item)

			expect(fs.has(`${BASE_DIR}/rmsharedroot-uuid`)).toBe(false)
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

		it("tolerates a corrupted metadata sidecar and still sweeps the rest", async () => {
			const cache = await createFileCache()
			const goodUuid = "good-uuid"
			const goodItem = wrapDrive(makeFileItem(goodUuid, "good.txt"))
			const goodDir = `${BASE_DIR}/${goodUuid}`
			const expiredTime = Date.now() - 86400 * 1000 - 1

			fs.set(goodDir, "dir")
			fs.set(`${goodDir}/${goodUuid}.txt`, new Uint8Array([1]))
			fs.set(
				`${goodDir}/${goodUuid}.filenmeta`,
				new Uint8Array(new TextEncoder().encode(serialize({ ...goodItem, cachedAt: expiredTime })))
			)

			const corruptUuid = "corrupt-uuid"
			const corruptDir = `${BASE_DIR}/${corruptUuid}`

			fs.set(corruptDir, "dir")
			fs.set(`${corruptDir}/${corruptUuid}`, new Uint8Array([1]))
			fs.set(`${corruptDir}/${corruptUuid}.filenmeta`, new Uint8Array(new TextEncoder().encode("{this is not valid msgpackr}")))

			await expect(cache.gc()).resolves.toBeUndefined()

			expect(fs.has(goodDir)).toBe(false)
			expect(fs.has(corruptDir)).toBe(false)
		})

		it("wipes everything when called with age=0", async () => {
			const cache = await createFileCache()
			const uuid = "fresh-uuid"
			const item = wrapDrive(makeFileItem(uuid, "fresh.txt"))
			const dir = `${BASE_DIR}/${uuid}`

			fs.set(dir, "dir")
			fs.set(`${dir}/${uuid}.txt`, new Uint8Array([1]))
			fs.set(`${dir}/${uuid}.filenmeta`, new Uint8Array(new TextEncoder().encode(serialize({ ...item, cachedAt: Date.now() }))))

			await cache.gc(0)

			expect(fs.has(dir)).toBe(false)
		})

		it("returns immediately without reading entries when parent directory does not exist", async () => {
			const cache = await createFileCache()

			// Remove the parent directory that the constructor created
			fs.delete(BASE_DIR)

			// Should return without throwing even though there is nothing to list
			await expect(cache.gc()).resolves.toBeUndefined()
		})

		it("deletes an entry whose cachedAt is exactly at the expiry boundary (>=)", async () => {
			const cache = await createFileCache()
			const uuid = "boundary-uuid"
			const item = wrapDrive(makeFileItem(uuid, "boundary.txt"))
			const dir = `${BASE_DIR}/${uuid}`
			const age = 86400 * 1000
			const now = Date.now()
			// cachedAt + age === now  →  the >= check must treat this as expired
			const exactBoundaryTime = now - age

			fs.set(dir, "dir")
			fs.set(`${dir}/${uuid}.txt`, new Uint8Array([1]))
			fs.set(
				`${dir}/${uuid}.filenmeta`,
				new Uint8Array(new TextEncoder().encode(serialize({ ...item, cachedAt: exactBoundaryTime })))
			)

			await cache.gc(age)

			expect(fs.has(dir)).toBe(false)
		})

		it("skips deletion when the metadata becomes fresh between Phase 1 and the mutex re-check", async () => {
			const cache = await createFileCache()
			const uuid = "race-uuid"
			const item = wrapDrive(makeFileItem(uuid, "race.txt"))
			const dir = `${BASE_DIR}/${uuid}`
			const filePath = `${dir}/${uuid}.txt`
			const metaPath = `${dir}/${uuid}.filenmeta`
			const expiredTime = Date.now() - 86400 * 1000 - 1
			const staleBytes = new Uint8Array(new TextEncoder().encode(serialize({ ...item, cachedAt: expiredTime })))
			const freshBytes = new Uint8Array(new TextEncoder().encode(serialize({ ...item, cachedAt: Date.now() })))

			fs.set(dir, "dir")
			fs.set(filePath, new Uint8Array([1, 2, 3]))
			fs.set(metaPath, staleBytes)

			// Simulate a concurrent get() that finishes writing a fresh sidecar
			// between Phase 1's unprotected read and Phase 2's mutex-guarded re-read.
			// The first .text() on the target sidecar returns the stale bytes
			// (captured before the swap), then the fs entry is swapped to fresh
			// for any subsequent read.
			let metaReads = 0
			const spy = vi.spyOn(File.prototype, "text").mockImplementation(async function (this: File): Promise<string> {
				const bytes = fs.get(this.uri)

				if (!(bytes instanceof Uint8Array)) {
					throw new Error(`File not found: ${this.uri}`)
				}

				const result = new TextDecoder().decode(bytes)

				if (this.uri === metaPath) {
					metaReads++

					if (metaReads === 1) {
						fs.set(metaPath, freshBytes)
					}
				}

				return result
			})

			try {
				await cache.gc()
			} finally {
				spy.mockRestore()
			}

			// The mutex re-check must have fired (at least two reads) and the
			// directory must survive — the entry was fresh by the time the
			// deletion phase committed.
			expect(metaReads).toBeGreaterThanOrEqual(2)
			expect(fs.has(dir)).toBe(true)
			expect(fs.has(metaPath)).toBe(true)
			expect(fs.has(filePath)).toBe(true)
		})
	})

	describe("clear", () => {
		it("removes every entry under the parent directory and recreates it empty", async () => {
			const cache = await createFileCache()
			const uuid = "to-clear"
			const dir = `${BASE_DIR}/${uuid}`

			fs.set(dir, "dir")
			fs.set(`${dir}/${uuid}.txt`, new Uint8Array([1, 2, 3]))
			fs.set(`${dir}/${uuid}.filenmeta`, new Uint8Array([4, 5, 6]))

			await cache.clear()

			expect(fs.has(BASE_DIR)).toBe(true)
			expect(fs.get(BASE_DIR)).toBe("dir")
			expect(fs.has(dir)).toBe(false)
			expect(fs.has(`${dir}/${uuid}.txt`)).toBe(false)
			expect(fs.has(`${dir}/${uuid}.filenmeta`)).toBe(false)
		})

		it("is idempotent — calling twice does not throw", async () => {
			const cache = await createFileCache()

			await cache.clear()
			await expect(cache.clear()).resolves.toBeUndefined()
			expect(fs.has(BASE_DIR)).toBe(true)
		})

		it("waits for an in-flight get() before wiping the directory", async () => {
			const cache = await createFileCache()
			const uuid = "racing-uuid"
			const item = wrapDrive(makeFileItem(uuid, "racing.txt"))

			let releaseDownload!: () => void
			const downloadGate = new Promise<void>(resolve => {
				releaseDownload = resolve
			})

			// downloadStarted resolves as soon as downloadFileToPath begins executing,
			// which guarantees that get() has already entered the ClearBarrier by that point.
			let resolveDownloadStarted!: () => void
			const downloadStarted = new Promise<void>(resolve => {
				resolveDownloadStarted = resolve
			})

			vi.mocked(auth.getSdkClients).mockResolvedValue({
				authedSdkClient: {
					downloadFileToPath: vi.fn().mockImplementation(async (_anyFile: unknown, path: string) => {
						// Signal that we are now inside the barrier, then wait for the test to proceed
						resolveDownloadStarted()
						await downloadGate
						fs.set("file://" + path, new Uint8Array([7, 8, 9]))
					})
				}
			} as never)

			const getPromise = cache.get({ item })

			// Wait until the download has actually started — at this point get() is
			// inside the ClearBarrier, so clear() must block.
			await downloadStarted

			let clearResolved = false
			const clearPromise = cache.clear().then(() => {
				clearResolved = true
			})

			// Give clear() a chance to run — it must not have finished because the
			// barrier is still held by the in-flight get().
			await Promise.resolve()
			await Promise.resolve()

			expect(clearResolved).toBe(false)

			releaseDownload()

			await getPromise
			await clearPromise

			expect(clearResolved).toBe(true)
			// After clear, the entry written by get is gone.
			expect(fs.has(`${BASE_DIR}/${uuid}`)).toBe(false)
		})
	})

	describe("size", () => {
		it("returns 0 when the parent directory is empty", async () => {
			const cache = await createFileCache()

			expect(cache.size()).toBe(0)
		})

		it("sums file sizes one level deep (uuid subdirs)", async () => {
			const cache = await createFileCache()

			fs.set(`${BASE_DIR}/a`, "dir")
			fs.set(`${BASE_DIR}/a/a.txt`, new Uint8Array([1, 2, 3, 4]))
			fs.set(`${BASE_DIR}/a/a.filenmeta`, new Uint8Array([1, 2]))
			fs.set(`${BASE_DIR}/b`, "dir")
			fs.set(`${BASE_DIR}/b/b.png`, new Uint8Array(new Array(10).fill(0)))

			expect(cache.size()).toBe(4 + 2 + 10)
		})

		it("includes every file under the parent directory recursively", async () => {
			const cache = await createFileCache()

			fs.set(`${BASE_DIR}/stray-file`, new Uint8Array([9]))
			fs.set(`${BASE_DIR}/a`, "dir")
			fs.set(`${BASE_DIR}/a/data`, new Uint8Array([1, 2]))
			fs.set(`${BASE_DIR}/a/nested`, "dir")
			fs.set(`${BASE_DIR}/a/nested/deep`, new Uint8Array([3, 4, 5, 6]))

			expect(cache.size()).toBe(1 + 2 + 4)
		})
	})
})

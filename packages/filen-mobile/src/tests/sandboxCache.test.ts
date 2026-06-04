import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

// fsUtils (imported by sandboxCache.ts) now pulls VERSION from sibling lib
// modules. Mock them so their full transitive deps (SDK, auth, etc.) don't load.
vi.mock("@/features/offline/offline", () => ({ VERSION: 1 }))
vi.mock("@/lib/fileCache", () => ({ VERSION: 1 }))
vi.mock("@/lib/audioCache", () => ({ VERSION: 1 }))
vi.mock("@/lib/thumbnails", () => ({ VERSION: 2 }))

import { fs } from "@/tests/mocks/expoFileSystem"

const CACHE_DIR = "file:///cache"

async function createSandboxCache(): Promise<InstanceType<typeof import("@/lib/sandboxCache").SandboxCache>> {
	const mod = await import("@/lib/sandboxCache")

	return new (mod.SandboxCache as new () => InstanceType<typeof mod.SandboxCache>)()
}

beforeEach(() => {
	fs.clear()
	vi.clearAllMocks()
})

describe("SandboxCache", () => {
	describe("clear", () => {
		it("removes every direct child of Paths.cache but not the directory itself", async () => {
			const sandbox = await createSandboxCache()

			fs.set(CACHE_DIR, "dir")
			fs.set(`${CACHE_DIR}/stray-file`, new Uint8Array([1, 2]))
			fs.set(`${CACHE_DIR}/another.bin`, new Uint8Array([3]))
			fs.set(`${CACHE_DIR}/some-dir`, "dir")
			fs.set(`${CACHE_DIR}/some-dir/nested`, new Uint8Array([9]))

			await sandbox.clear()

			expect(fs.get(CACHE_DIR)).toBe("dir")
			expect(fs.has(`${CACHE_DIR}/stray-file`)).toBe(false)
			expect(fs.has(`${CACHE_DIR}/another.bin`)).toBe(false)
			expect(fs.has(`${CACHE_DIR}/some-dir`)).toBe(false)
			expect(fs.has(`${CACHE_DIR}/some-dir/nested`)).toBe(false)
		})

		it("does nothing when Paths.cache does not exist", async () => {
			const sandbox = await createSandboxCache()

			await expect(sandbox.clear()).resolves.toBeUndefined()
			expect(fs.has(CACHE_DIR)).toBe(false)
		})

		it("tolerates a single delete failure and finishes sweeping the rest", async () => {
			const sandbox = await createSandboxCache()

			fs.set(CACHE_DIR, "dir")
			fs.set(`${CACHE_DIR}/locked`, new Uint8Array([1]))
			fs.set(`${CACHE_DIR}/normal`, new Uint8Array([2]))

			const mod = await import("expo-file-system")
			const FileClass = mod.File as unknown as { prototype: { delete: () => void } }
			const originalDelete = FileClass.prototype.delete

			FileClass.prototype.delete = function (this: { uri: string }): void {
				if (this.uri.endsWith("/locked")) {
					throw new Error("EBUSY")
				}

				originalDelete.call(this)
			}

			try {
				await expect(sandbox.clear()).resolves.toBeUndefined()
			} finally {
				FileClass.prototype.delete = originalDelete
			}

			expect(fs.has(`${CACHE_DIR}/locked`)).toBe(true)
			expect(fs.has(`${CACHE_DIR}/normal`)).toBe(false)
		})

		it("preserves the filen-tmp directory and its contents during clear", async () => {
			const sandbox = await createSandboxCache()

			fs.set(CACHE_DIR, "dir")
			fs.set(`${CACHE_DIR}/filen-tmp`, "dir")
			fs.set(`${CACHE_DIR}/filen-tmp/staging.bin`, new Uint8Array([7, 8, 9]))
			fs.set(`${CACHE_DIR}/stray.bin`, new Uint8Array([1]))

			await sandbox.clear()

			expect(fs.get(`${CACHE_DIR}/filen-tmp`)).toBe("dir")
			expect(fs.has(`${CACHE_DIR}/filen-tmp/staging.bin`)).toBe(true)
			expect(fs.has(`${CACHE_DIR}/stray.bin`)).toBe(false)
		})

		it("returns early without deleting anything when directory.list() throws", async () => {
			const sandbox = await createSandboxCache()

			fs.set(CACHE_DIR, "dir")
			fs.set(`${CACHE_DIR}/a.bin`, new Uint8Array([1]))
			fs.set(`${CACHE_DIR}/b.bin`, new Uint8Array([2]))

			const mod = await import("expo-file-system")
			const DirClass = mod.Directory as unknown as { prototype: { list: () => (typeof mod.File | typeof mod.Directory)[] } }
			const originalList = DirClass.prototype.list

			DirClass.prototype.list = function (): never {
				throw new Error("EACCES: list failed")
			}

			try {
				await expect(sandbox.clear()).resolves.toBeUndefined()
			} finally {
				DirClass.prototype.list = originalList
			}

			// Neither file should be deleted — clear() bailed out before iterating
			expect(fs.has(`${CACHE_DIR}/a.bin`)).toBe(true)
			expect(fs.has(`${CACHE_DIR}/b.bin`)).toBe(true)
		})

		it("skips an entry that disappears between list() and the run() callback", async () => {
			const sandbox = await createSandboxCache()

			// "persistent" exists in the backing store and will be deleted normally.
			// "phantom" is returned by list() but is absent from fs, so entry.exists
			// returns false inside the run() callback — exercising the TOCTOU guard.
			fs.set(CACHE_DIR, "dir")
			fs.set(`${CACHE_DIR}/persistent`, new Uint8Array([2]))
			// Deliberately do NOT add `${CACHE_DIR}/phantom` to fs

			const mod = await import("expo-file-system")
			const DirClass = mod.Directory as unknown as {
				prototype: { list: () => (InstanceType<typeof mod.File> | InstanceType<typeof mod.Directory>)[] }
			}
			const originalList = DirClass.prototype.list

			// Override list() to inject a File entry whose uri is not in fs
			DirClass.prototype.list = function (this: InstanceType<typeof mod.Directory>) {
				const real = originalList.call(this) as (InstanceType<typeof mod.File> | InstanceType<typeof mod.Directory>)[]
				// Append a File handle pointing at a path that does not exist in fs
				real.push(new mod.File(`${CACHE_DIR}/phantom`))

				return real
			}

			const deleteCallUris: string[] = []
			const FileClass = mod.File as unknown as { prototype: { delete: () => void } }
			const originalDelete = FileClass.prototype.delete

			FileClass.prototype.delete = function (this: { uri: string }): void {
				deleteCallUris.push(this.uri)
				originalDelete.call(this)
			}

			try {
				await expect(sandbox.clear()).resolves.toBeUndefined()
			} finally {
				DirClass.prototype.list = originalList
				FileClass.prototype.delete = originalDelete
			}

			// "persistent" was deleted normally
			expect(fs.has(`${CACHE_DIR}/persistent`)).toBe(false)
			// delete() was never called for "phantom" — the exists guard short-circuited
			expect(deleteCallUris.some(u => u.endsWith("/phantom"))).toBe(false)
		})
	})

	describe("size", () => {
		it("returns 0 when Paths.cache is empty", async () => {
			const sandbox = await createSandboxCache()

			fs.set(CACHE_DIR, "dir")

			expect(sandbox.size()).toBe(0)
		})

		it("returns 0 when Paths.cache does not exist", async () => {
			const sandbox = await createSandboxCache()

			expect(sandbox.size()).toBe(0)
		})

		it("recursively sums all file sizes", async () => {
			const sandbox = await createSandboxCache()

			fs.set(CACHE_DIR, "dir")
			fs.set(`${CACHE_DIR}/a.bin`, new Uint8Array(new Array(4).fill(0)))
			fs.set(`${CACHE_DIR}/nested`, "dir")
			fs.set(`${CACHE_DIR}/nested/b.bin`, new Uint8Array(new Array(8).fill(0)))
			fs.set(`${CACHE_DIR}/nested/deeper`, "dir")
			fs.set(`${CACHE_DIR}/nested/deeper/c.bin`, new Uint8Array(new Array(16).fill(0)))

			expect(sandbox.size()).toBe(4 + 8 + 16)
		})

		it("excludes files inside filen-tmp from the byte total", async () => {
			const sandbox = await createSandboxCache()

			fs.set(CACHE_DIR, "dir")
			fs.set(`${CACHE_DIR}/a.bin`, new Uint8Array(new Array(10).fill(0)))
			fs.set(`${CACHE_DIR}/filen-tmp`, "dir")
			fs.set(`${CACHE_DIR}/filen-tmp/staging.bin`, new Uint8Array(new Array(999).fill(0)))

			expect(sandbox.size()).toBe(10)
		})
	})

	describe("default export singleton", () => {
		it("exports a pre-constructed SandboxCache instance as the default export", async () => {
			const mod = await import("@/lib/sandboxCache")

			// The default export is the module-level singleton — not a class, but an instance
			expect(mod.default).toBeDefined()
			expect(typeof mod.default.clear).toBe("function")
			expect(typeof mod.default.size).toBe("function")
			// It is an instance of the exported SandboxCache class
			expect(mod.default).toBeInstanceOf(mod.SandboxCache)
		})

		it("singleton size() and clear() work identically to a fresh instance", async () => {
			const mod = await import("@/lib/sandboxCache")
			const singleton = mod.default

			fs.set(CACHE_DIR, "dir")
			fs.set(`${CACHE_DIR}/x.bin`, new Uint8Array(new Array(7).fill(0)))

			expect(singleton.size()).toBe(7)

			await singleton.clear()

			expect(fs.has(`${CACHE_DIR}/x.bin`)).toBe(false)
			expect(singleton.size()).toBe(0)
		})
	})
})

import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

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
	})
})

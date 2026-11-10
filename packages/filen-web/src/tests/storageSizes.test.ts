import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { opfsTreeBytes } from "@/lib/storage/opfs"
import { storageUsage } from "@/features/settings/lib/storageUsage.logic"

function notFound(): DOMException {
	return new DOMException("no such entry", "NotFoundError")
}

interface Tree {
	[name: string]: number | Tree
}

// A read-only OPFS directory over a plain tree: file sizes as numbers, directories as objects. Records every
// getDirectoryHandle so a walk that would create something shows.
function fakeDirectory(tree: Tree, created: string[], gone = new Set<string>()): FileSystemDirectoryHandle {
	return {
		kind: "directory",
		getDirectoryHandle: (name: string, options?: FileSystemGetDirectoryOptions) => {
			if (options?.create === true) {
				created.push(name)
			}

			const child = tree[name]

			return typeof child === "object" ? Promise.resolve(fakeDirectory(child, created, gone)) : Promise.reject(notFound())
		},
		values: async function* () {
			await Promise.resolve()

			for (const [name, child] of Object.entries(tree)) {
				yield typeof child === "number"
					? {
							kind: "file",
							name,
							getFile: () => (gone.has(name) ? Promise.reject(notFound()) : Promise.resolve({ size: child }))
						}
					: fakeDirectory(child, created, gone)
			}
		}
	} as unknown as FileSystemDirectoryHandle
}

describe("opfsTreeBytes", () => {
	let created: string[]

	beforeEach(() => {
		created = []
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	function stubRoot(tree: Tree, gone?: Set<string>): void {
		vi.stubGlobal("navigator", { storage: { getDirectory: () => Promise.resolve(fakeDirectory(tree, created, gone)) } })
	}

	it("sums every file under the tree, nested directories and every generation included", async () => {
		const many = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`t${String(index)}.webp`, 2]))

		stubRoot({ thumbnails: { v1: { "a.webp": 10 }, v2: { ...many, nested: { "b.webp": 5 } } }, other: { "x.bin": 1000 } })

		expect(await opfsTreeBytes(["thumbnails"])).toBe(10 + 300 + 5)
	})

	it("answers 0 for a tree that does not exist, without creating it", async () => {
		stubRoot({ videos: {} })

		expect(await opfsTreeBytes(["videos", "art"])).toBe(0)
		expect(await opfsTreeBytes(["models"])).toBe(0)
		expect(created).toEqual([])
	})

	it("counts a file removed during the walk as nothing", async () => {
		stubRoot({ models: { m1: { "a.gguf": 100, "b.gguf": 50 } } }, new Set(["b.gguf"]))

		expect(await opfsTreeBytes(["models"])).toBe(100)
	})

	it("stops when its signal aborts", async () => {
		stubRoot({ thumbnails: { "a.webp": 1 } })

		const controller = new AbortController()

		controller.abort(new Error("unmounted"))

		await expect(opfsTreeBytes(["thumbnails"], controller.signal)).rejects.toThrow("unmounted")
	})
})

describe("storageUsage", () => {
	it("puts what no row names into Other, and the disk caches outside the origin on top", () => {
		const usage = storageUsage({
			rows: [
				["thumbnails", 300],
				["videos", 0],
				["music", null],
				["queryCache", 100],
				["browserCache", 50],
				["networkDrive", 25]
			],
			origin: 1000
		})

		expect(usage).toEqual({ total: 1075, other: 600 })
	})

	it("floors Other at 0 when the browser's figure lags behind a clear", () => {
		const usage = storageUsage({ rows: [["thumbnails", 500]], origin: 200 })

		expect(usage).toEqual({ total: 500, other: 0 })
	})

	it("has no total until every figure is in", () => {
		expect(storageUsage({ rows: [["thumbnails", 1]], origin: undefined })).toEqual({ total: undefined, other: undefined })
		expect(storageUsage({ rows: [["thumbnails", undefined]], origin: 10 })).toEqual({ total: undefined, other: undefined })
		expect(storageUsage({ rows: [["thumbnails", 4]], origin: null })).toEqual({ total: 4, other: 0 })
	})
})

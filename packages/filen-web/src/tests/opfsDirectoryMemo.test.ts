import { beforeEach, describe, expect, it, vi } from "vitest"
import { deleteThumbnail, readThumbnailBlob, wipeThumbnailStore } from "@/features/drive/lib/thumbCache"
import { THUMB_DIR, THUMB_EXT } from "@/features/drive/lib/thumbnails.logic"
import { cachedOpfsDirectory, forgetOpfsDirectory } from "@/lib/storage/opfs"
import { writeThumb } from "@/workers/thumbStore"

function notFound(): DOMException {
	return new DOMException("no such entry", "NotFoundError")
}

// Id-based handles, as Firefox and WebKit have them: a handle to a removed directory keeps failing with
// NotFoundError even after a directory of the same name is created again.
class FakeDirectory {
	removed = false
	readonly directories = new Map<string, FakeDirectory>()
	readonly files = new Map<string, Uint8Array<ArrayBuffer>>()

	getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<FakeDirectory> {
		const existing = this.directories.get(name)

		if (this.removed || (existing === undefined && options?.create !== true)) {
			return Promise.reject(notFound())
		}

		const directory = existing ?? new FakeDirectory()

		this.directories.set(name, directory)

		return Promise.resolve(directory)
	}

	getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<unknown> {
		if (this.removed || (!this.files.has(name) && options?.create !== true)) {
			return Promise.reject(notFound())
		}

		if (!this.files.has(name)) {
			this.files.set(name, new Uint8Array())
		}

		return Promise.resolve({
			getFile: () => Promise.resolve(new Blob([this.files.get(name) ?? new Uint8Array()])),
			createSyncAccessHandle: () =>
				Promise.resolve({
					truncate: () => undefined,
					write: (bytes: Uint8Array) => {
						this.files.set(name, bytes.slice())
					},
					flush: () => undefined,
					close: () => undefined
				})
		})
	}

	removeEntry(name: string): Promise<void> {
		const directory = this.directories.get(name)

		if (directory !== undefined) {
			directory.markRemoved()
			this.directories.delete(name)

			return Promise.resolve()
		}

		return this.files.delete(name) ? Promise.resolve() : Promise.reject(notFound())
	}

	markRemoved(): void {
		this.removed = true

		for (const child of this.directories.values()) {
			child.markRemoved()
		}
	}
}

function installRoot(): { root: FakeDirectory; getDirectory: ReturnType<typeof vi.fn> } {
	const root = new FakeDirectory()
	const getDirectory = vi.fn(() => Promise.resolve(root))

	vi.stubGlobal("navigator", { storage: { getDirectory } })

	return { root, getDirectory }
}

async function leaf(root: FakeDirectory): Promise<FakeDirectory> {
	let directory = root

	for (const segment of THUMB_DIR) {
		directory = await directory.getDirectoryHandle(segment, { create: true })
	}

	return directory
}

beforeEach(() => {
	forgetOpfsDirectory(THUMB_DIR)
})

describe("cachedOpfsDirectory", () => {
	it("walks once per realm and hands every later call the same handle", async () => {
		const { getDirectory } = installRoot()
		const first = await cachedOpfsDirectory(THUMB_DIR)

		expect(await cachedOpfsDirectory(THUMB_DIR)).toBe(first)
		expect(getDirectory).toHaveBeenCalledTimes(1)
	})

	it("drops a walk that failed, so the next call walks again", async () => {
		const { root, getDirectory } = installRoot()

		getDirectory.mockRejectedValueOnce(new DOMException("denied", "SecurityError"))

		await expect(cachedOpfsDirectory(THUMB_DIR)).rejects.toThrow("denied")
		expect(await cachedOpfsDirectory(THUMB_DIR)).toBe(await leaf(root))
		expect(getDirectory).toHaveBeenCalledTimes(2)
	})
})

describe("thumbnail store over the memoized directory", () => {
	it("reads a hit without walking again, and a miss or a delete of a missing entry as before", async () => {
		const { root, getDirectory } = installRoot()

		;(await leaf(root)).files.set(`a${THUMB_EXT}`, new Uint8Array([1, 2, 3]))

		expect(new Uint8Array(await ((await readThumbnailBlob("a")) ?? new Blob()).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
		expect(await readThumbnailBlob("a")).not.toBeNull()
		expect(getDirectory).toHaveBeenCalledTimes(1)

		expect(await readThumbnailBlob("missing")).toBeNull()
		await expect(deleteThumbnail("missing")).resolves.toBeUndefined()
		await deleteThumbnail("a")
		expect(await readThumbnailBlob("a")).toBeNull()
	})

	it("writes into a directory removed under the memoized handle by re-creating it", async () => {
		const { root } = installRoot()

		await writeThumb("a", new Uint8Array([1]))
		await root.removeEntry(THUMB_DIR[0] ?? "")
		await writeThumb("b", new Uint8Array([2]))

		expect([...(await leaf(root)).files.keys()]).toEqual([`b${THUMB_EXT}`])
	})

	it("reads what was written after the directory was removed and re-created elsewhere", async () => {
		const { root } = installRoot()

		;(await leaf(root)).files.set(`x${THUMB_EXT}`, new Uint8Array([1]))
		expect(await readThumbnailBlob("x")).not.toBeNull()
		await root.removeEntry(THUMB_DIR[0] ?? "")
		;(await leaf(root)).files.set(`a${THUMB_EXT}`, new Uint8Array([1]))

		// The stale handle reports the gone directory as a miss, then the next read walks afresh.
		expect(await readThumbnailBlob("a")).toBeNull()
		expect(await readThumbnailBlob("a")).not.toBeNull()
	})

	it("forgets the directory on logout wipe", async () => {
		const { root, getDirectory } = installRoot()

		await readThumbnailBlob("a")
		await wipeThumbnailStore(Promise.resolve(root as unknown as FileSystemDirectoryHandle))
		;(await leaf(root)).files.set(`a${THUMB_EXT}`, new Uint8Array([1]))

		expect(await readThumbnailBlob("a")).not.toBeNull()
		expect(getDirectory).toHaveBeenCalledTimes(2)
	})
})

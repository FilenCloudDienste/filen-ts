import { beforeEach, describe, expect, it, vi } from "vitest"
import { THUMB_DIR, THUMB_EXT } from "@/features/drive/lib/thumbnails.logic"
import { ART_CACHE_CAP, ART_DIR, ART_STORE, artKey } from "@/features/videos/lib/artStore.logic"
import { forgetOpfsDirectory } from "@/lib/storage/opfs"
import { deleteStoreEntry, readStoreBlob, wipeOpfsTree } from "@/lib/storage/opfsBlobStore"
import { DRIVE_THUMB_STORE, storeCapSweeper, sweepStore, sweepThumbs, writeStoreEntry, writeThumb } from "@/workers/thumbStore"

function notFound(): DOMException {
	return new DOMException("no such entry", "NotFoundError")
}

interface FakeFile {
	bytes: Uint8Array<ArrayBuffer>
	lastModified: number
}

let clock = 0

// Enough of OPFS for the stores: nested directories, files with a sync access handle, listing, removal.
class FakeDirectory {
	readonly directories = new Map<string, FakeDirectory>()
	readonly files = new Map<string, FakeFile>()

	getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<FakeDirectory> {
		const existing = this.directories.get(name)

		if (existing === undefined && options?.create !== true) {
			return Promise.reject(notFound())
		}

		const directory = existing ?? new FakeDirectory()

		this.directories.set(name, directory)

		return Promise.resolve(directory)
	}

	getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<unknown> {
		if (!this.files.has(name) && options?.create !== true) {
			return Promise.reject(notFound())
		}

		if (!this.files.has(name)) {
			this.files.set(name, { bytes: new Uint8Array(), lastModified: clock++ })
		}

		return Promise.resolve(this.fileHandle(name))
	}

	private fileHandle(name: string) {
		return {
			kind: "file" as const,
			name,
			getFile: () => {
				const file = this.files.get(name)

				return Promise.resolve(
					Object.assign(new Blob([file?.bytes ?? new Uint8Array()]), { lastModified: file?.lastModified ?? 0 })
				)
			},
			createSyncAccessHandle: () =>
				Promise.resolve({
					truncate: () => undefined,
					write: (bytes: Uint8Array) => {
						this.files.set(name, { bytes: bytes.slice(), lastModified: clock++ })
					},
					flush: () => undefined,
					close: () => undefined
				})
		}
	}

	values(): AsyncIterable<unknown> {
		const entries: unknown[] = [
			...[...this.files.keys()].map(name => this.fileHandle(name)),
			...[...this.directories.keys()].map(name => ({ kind: "directory", name }))
		]

		return (async function* () {
			for (const entry of entries) {
				yield await Promise.resolve(entry)
			}
		})()
	}

	removeEntry(name: string): Promise<void> {
		if (this.directories.delete(name) || this.files.delete(name)) {
			return Promise.resolve()
		}

		return Promise.reject(notFound())
	}
}

async function at(root: FakeDirectory, segments: readonly string[]): Promise<FakeDirectory | null> {
	let directory: FakeDirectory | undefined = root

	for (const segment of segments) {
		directory = directory.directories.get(segment)

		if (directory === undefined) {
			return null
		}
	}

	return Promise.resolve(directory)
}

let root: FakeDirectory

beforeEach(() => {
	root = new FakeDirectory()
	clock = 0
	forgetOpfsDirectory(THUMB_DIR)
	forgetOpfsDirectory(ART_DIR)
	vi.stubGlobal("navigator", { storage: { getDirectory: () => Promise.resolve(root) } })
})

describe("OPFS blob stores", () => {
	it("keeps drive thumbnails where they were and Videos art in its own tree", async () => {
		await writeThumb("video-uuid", new Uint8Array([1]))
		await writeStoreEntry(ART_STORE, artKey("video-uuid", "p"), new Uint8Array([2]))

		expect([...((await at(root, THUMB_DIR))?.files.keys() ?? [])]).toEqual([`video-uuid${THUMB_EXT}`])
		expect([...((await at(root, ["videos", "art", "v1"]))?.files.keys() ?? [])]).toEqual(["video-uuid.p.webp"])
		expect(DRIVE_THUMB_STORE).toEqual({ dir: THUMB_DIR, ext: THUMB_EXT })
	})

	it("reads and deletes an art entry from the main-thread side", async () => {
		await writeStoreEntry(ART_STORE, "a.s", new Uint8Array([7, 8]))

		expect(new Uint8Array(await ((await readStoreBlob(ART_STORE, "a.s")) ?? new Blob()).arrayBuffer())).toEqual(new Uint8Array([7, 8]))

		await deleteStoreEntry(ART_STORE, "a.s")
		expect(await readStoreBlob(ART_STORE, "a.s")).toBeNull()
		await expect(deleteStoreEntry(ART_STORE, "missing")).resolves.toBeUndefined()
	})

	it("sweeps each store against its own cap, oldest first", async () => {
		await writeThumb("t1", new Uint8Array(10))
		await writeStoreEntry(ART_STORE, "a.p", new Uint8Array(10))
		await writeStoreEntry(ART_STORE, "b.p", new Uint8Array(10))
		await writeStoreEntry(ART_STORE, "c.p", new Uint8Array(10))

		await sweepStore(ART_STORE, 20)

		expect([...((await at(root, ART_DIR))?.files.keys() ?? [])]).toEqual(["b.p.webp", "c.p.webp"])
		expect([...((await at(root, THUMB_DIR))?.files.keys() ?? [])]).toEqual([`t1${THUMB_EXT}`])

		await sweepThumbs(0)
		expect((await at(root, THUMB_DIR))?.files.size).toBe(0)
		expect((await at(root, ART_DIR))?.files.size).toBe(2)
		expect(ART_CACHE_CAP).toBe(128 * 1_048_576)
	})

	it("sweeps on the first use of a session and then every so many writes", async () => {
		const firstArm = vi.fn()
		const sweeper = storeCapSweeper(ART_STORE, 10, 2, firstArm)

		await writeStoreEntry(ART_STORE, "a.p", new Uint8Array(10))
		await writeStoreEntry(ART_STORE, "b.p", new Uint8Array(10))
		sweeper.arm()
		sweeper.arm()
		await vi.waitFor(async () => {
			expect((await at(root, ART_DIR))?.files.size).toBe(1)
		})
		expect(firstArm).toHaveBeenCalledTimes(1)

		await writeStoreEntry(ART_STORE, "c.p", new Uint8Array(10))
		sweeper.noteWrites(1)
		expect((await at(root, ART_DIR))?.files.size).toBe(2)
		sweeper.noteWrites(1)
		await vi.waitFor(async () => {
			expect((await at(root, ART_DIR))?.files.size).toBe(1)
		})
	})

	it("wipes a whole tree", async () => {
		await writeStoreEntry(ART_STORE, "a.p", new Uint8Array(1))
		await wipeOpfsTree(["videos", "art"], [ART_DIR], Promise.resolve(root as unknown as FileSystemDirectoryHandle))

		expect(await at(root, ["videos", "art"])).toBeNull()
		expect(await readStoreBlob(ART_STORE, "a.p")).toBeNull()
	})

	it("creates a store only a write creates on its first write, never on a read, delete or sweep", async () => {
		const store = { dir: ["writeOnly", "t"], ext: ".x", createOnWriteOnly: true }

		expect(await readStoreBlob(store, "a")).toBeNull()
		await deleteStoreEntry(store, "a")
		await sweepStore(store, 1)
		expect(await at(root, ["writeOnly"])).toBeNull()

		await writeStoreEntry(store, "a", new Uint8Array(2))
		expect((await at(root, store.dir))?.files.size).toBe(1)
		forgetOpfsDirectory(store.dir)
	})
})

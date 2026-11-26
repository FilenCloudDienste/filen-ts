import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	LINK_THUMB_DIR_ROOT,
	generateLinkThumbKey,
	isLinkThumbTab,
	linkThumbLock,
	openLinkThumb,
	sealLinkThumb
} from "@/features/publicLinks/lib/thumbCache.logic"

// A public link's sealed thumbnail store: AES-GCM under a key each tab generates and holds only in memory, in the
// tab's own OPFS directory, swept at the next visit once the tab that wrote it is gone. WebCrypto is Node's own; OPFS
// and Web Locks are fakes, and the SDK worker's write is the real writeStoreEntry over the fake.

function notFound(): DOMException {
	return new DOMException("no such entry", "NotFoundError")
}

// Enough of OPFS for a store: nested directories, files written through a sync access handle, listing, removal.
class FakeDirectory {
	readonly directories = new Map<string, FakeDirectory>()
	readonly files = new Map<string, Uint8Array<ArrayBuffer>>()

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
		if (!this.files.has(name)) {
			if (options?.create !== true) {
				return Promise.reject(notFound())
			}

			this.files.set(name, new Uint8Array())
		}

		return Promise.resolve({
			kind: "file",
			name,
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

	values(): AsyncIterable<{ kind: string; name: string }> {
		const entries = [
			...[...this.files.keys()].map(name => ({ kind: "file", name })),
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

// Web Locks as far as the store uses them: a request that holds its lock while its callback's promise is pending, and
// a query of what is held. `release` ends a tab.
class FakeLocks {
	readonly held = new Set<string>()

	request(name: string, callback: () => Promise<unknown>): Promise<unknown> {
		this.held.add(name)

		return callback()
	}

	query(): Promise<{ held: { name: string }[] }> {
		return Promise.resolve({ held: [...this.held].map(name => ({ name })) })
	}
}

let root: FakeDirectory
let locks: FakeLocks

const { storeLinkedThumbnail } = vi.hoisted(() => ({
	storeLinkedThumbnail: vi.fn<(tab: string, uuid: string, sealed: Uint8Array) => Promise<void>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { storeLinkedThumbnail } }))
vi.mock("comlink", () => ({ transfer: <T>(value: T) => value }))

type CacheModule = typeof import("@/features/publicLinks/lib/thumbCache")

// A new visit: a fresh module (a new tab's key and directory) over the same disk.
async function visit(): Promise<CacheModule> {
	vi.resetModules()

	const { writeStoreEntry } = await import("@/workers/thumbStore")
	const { linkThumbStore } = await import("@/features/publicLinks/lib/thumbCache.logic")

	storeLinkedThumbnail.mockImplementation((tab, uuid, sealed) => writeStoreEntry(linkThumbStore(tab), uuid, sealed))

	return await import("@/features/publicLinks/lib/thumbCache")
}

function tabDirectories(): string[] {
	return [...(root.directories.get(LINK_THUMB_DIR_ROOT[0] ?? "")?.directories.keys() ?? [])]
}

// Lets the sweep a first use starts in the background finish.
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve()
	}

	await new Promise(resolve => setTimeout(resolve, 0))
}

const BYTES = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])

beforeEach(() => {
	root = new FakeDirectory()
	locks = new FakeLocks()
	vi.stubGlobal("navigator", { storage: { getDirectory: () => Promise.resolve(root) }, locks })
	storeLinkedThumbnail.mockReset()
})

describe("sealLinkThumb / openLinkThumb", () => {
	it("round-trips under its key and uuid, and writes no plaintext", async () => {
		const key = await generateLinkThumbKey()
		const sealed = await sealLinkThumb(key, "u1", BYTES.slice())

		expect(sealed.length).toBe(12 + BYTES.length + 16)
		expect(Buffer.from(sealed).includes(Buffer.from(BYTES))).toBe(false)
		expect(await openLinkThumb(key, "u1", sealed)).toEqual(BYTES)
	})

	it("opens nothing under another key, another uuid, or torn", async () => {
		const key = await generateLinkThumbKey()
		const sealed = await sealLinkThumb(key, "u1", BYTES.slice())

		expect(await openLinkThumb(await generateLinkThumbKey(), "u1", sealed)).toBeNull()
		expect(await openLinkThumb(key, "u2", sealed)).toBeNull()
		expect(await openLinkThumb(key, "u1", sealed.slice(0, sealed.length - 1))).toBeNull()
		expect(await openLinkThumb(key, "u1", sealed.slice(0, 20))).toBeNull()
	})

	it("holds its key unexportable", async () => {
		const key = await generateLinkThumbKey()

		expect(key.extractable).toBe(false)
		await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow()
	})
})

describe("the tab's sealed store", () => {
	it("reads back what it stored, sealed on disk in this tab's own directory under its held lock", async () => {
		const cache = await visit()

		await cache.storeLinkThumbnail("u1", BYTES)

		const [tab] = tabDirectories()

		expect(tab !== undefined && isLinkThumbTab(tab)).toBe(true)
		expect(locks.held.has(linkThumbLock(tab ?? ""))).toBe(true)

		const onDisk = root.directories
			.get("linkThumbnails")
			?.directories.get(tab ?? "")
			?.files.get("u1.thumb")

		expect(onDisk?.length).toBe(12 + BYTES.length + 16)
		expect(Buffer.from(onDisk ?? new Uint8Array()).includes(Buffer.from(BYTES))).toBe(false)

		const blob = await cache.readLinkThumbnail("u1")

		expect(new Uint8Array((await blob?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(BYTES)
	})

	it("misses what it never stored, and drops an entry that does not open", async () => {
		const cache = await visit()

		expect(await cache.readLinkThumbnail("u1")).toBeNull()

		await cache.storeLinkThumbnail("u1", BYTES)

		const [tab] = tabDirectories()
		const dir = root.directories.get("linkThumbnails")?.directories.get(tab ?? "")

		dir?.files.set("u1.thumb", new Uint8Array(40))

		expect(await cache.readLinkThumbnail("u1")).toBeNull()
		await settle()
		expect(dir?.files.has("u1.thumb")).toBe(false)
	})

	it("is swept at the next visit's first use once its tab is gone, and the new tab cannot read it", async () => {
		const first = await visit()

		await first.storeLinkThumbnail("u1", BYTES)

		const [gone] = tabDirectories()

		locks.held.clear()

		const second = await visit()

		expect(await second.readLinkThumbnail("u1")).toBeNull()
		await settle()
		expect(tabDirectories()).not.toContain(gone)
		expect(tabDirectories()).toHaveLength(1)
	})

	it("leaves a tab that is still open alone", async () => {
		const first = await visit()

		await first.storeLinkThumbnail("u1", BYTES)

		const [open] = tabDirectories()
		const second = await visit()

		await second.storeLinkThumbnail("u2", BYTES)
		await settle()

		expect(tabDirectories()).toContain(open)
		expect(new Uint8Array((await (await first.readLinkThumbnail("u1"))?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(BYTES)
	})

	it("removes what is no tab's at all", async () => {
		await root.getDirectoryHandle("linkThumbnails", { create: true }).then(dir => dir.getDirectoryHandle("stray", { create: true }))

		const cache = await visit()

		await cache.storeLinkThumbnail("u1", BYTES)
		await settle()

		expect(tabDirectories()).not.toContain("stray")
	})

	it("is wiped whole, every tab's, by sign-out or a clear", async () => {
		const cache = await visit()

		await cache.storeLinkThumbnail("u1", BYTES)
		await cache.wipeLinkThumbnailStore()

		expect(root.directories.has("linkThumbnails")).toBe(false)
		expect(await cache.readLinkThumbnail("u1")).toBeNull()
	})

	it("keeps nothing on disk where the browser has no Web Locks", async () => {
		vi.stubGlobal("navigator", { storage: { getDirectory: () => Promise.resolve(root) } })

		const cache = await visit()

		await cache.storeLinkThumbnail("u1", BYTES)

		expect(storeLinkedThumbnail).not.toHaveBeenCalled()
		expect(await cache.readLinkThumbnail("u1")).toBeNull()
	})
})

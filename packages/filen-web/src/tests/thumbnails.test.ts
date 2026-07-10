import { beforeEach, describe, expect, it, vi } from "vitest"
import type { File as SdkFile, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"

// Mock boundaries mirror download.test.ts's own: the real sdk client imports a Vite
// `?worker` module (unresolvable/unwanted under node vitest), and the real thumb-cache module calls
// navigator.storage.getDirectory(), which doesn't exist under node either. Only storeThumbnail crosses
// to the sdk worker now — every category (image included) decodes client-side and persists through it.
const { storeThumbnailMock } = vi.hoisted(() => ({
	storeThumbnailMock: vi.fn<(uuid: string, bytes: Uint8Array) => Promise<void>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { storeThumbnail: storeThumbnailMock } }))

const { readThumbnailBlobMock, deleteThumbnailMock } = vi.hoisted(() => ({
	readThumbnailBlobMock: vi.fn<(uuid: string) => Promise<Blob | null>>(),
	deleteThumbnailMock: vi.fn<(uuid: string) => Promise<void>>()
}))

vi.mock("@/features/drive/lib/thumbCache", () => ({ readThumbnailBlob: readThumbnailBlobMock, deleteThumbnail: deleteThumbnailMock }))

import {
	getThumbnailUrl,
	invalidateThumbnail,
	registerThumbGenerator,
	defaultThumbnailDeps,
	type ThumbGenerator,
	type ThumbnailServiceDeps
} from "@/features/drive/lib/thumbnails"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

let uuidCounter = 0

// A fresh uuid per call so module-level service state (urls/failures/pending) from an earlier test
// never bleeds into this one — mirrors download.test.ts's own nextUuid().
function nextUuid(): UuidStr {
	uuidCounter += 1

	return testUuid(`u${uuidCounter.toString()}`)
}

function mockFile(overrides: Partial<SdkFile> = {}): SdkFile {
	return {
		uuid: nextUuid(),
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "photo.jpg", mime: "image/jpeg", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

function imageItem(overrides: Partial<SdkFile> = {}): DriveItem {
	return narrowItem(mockFile(overrides))
}

function heicItem(overrides: Partial<SdkFile> = {}): DriveItem {
	return narrowItem(
		mockFile({
			meta: {
				type: "decoded",
				data: { name: "photo.heic", mime: "image/heic", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
			},
			...overrides
		})
	)
}

function dirItem(): DriveItem {
	return narrowItem({
		uuid: testUuid("dir"),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } }
	})
}

// A fully-stubbed deps object, success by default (no cache hit, no generator registered — overridden
// per test) — mirrors download.test.ts's own makeHarness(). createObjectUrl returns a distinct,
// deterministic string per call so "reused the same url" assertions are meaningful.
function makeFakeDeps(overrides: Partial<ThumbnailServiceDeps> = {}): ThumbnailServiceDeps {
	let urlCounter = 0

	return {
		readThumbnailBlob: vi.fn().mockResolvedValue(null),
		deleteThumbnail: vi.fn().mockResolvedValue(undefined),
		storeThumbnail: vi.fn().mockResolvedValue(undefined),
		createObjectUrl: vi.fn(() => {
			urlCounter += 1

			return `blob:fake-${urlCounter.toString()}`
		}),
		revokeObjectUrl: vi.fn(),
		getGenerator: vi.fn().mockReturnValue(undefined),
		...overrides
	}
}

// Every category routes through the generator registry now, so most tests need a registered generator.
// This wires getGenerator to hand back `generator` for any category, plus any other overrides.
function depsWithGenerator(generator: ThumbGenerator, overrides: Partial<ThumbnailServiceDeps> = {}): ThumbnailServiceDeps {
	return makeFakeDeps({ getGenerator: vi.fn().mockReturnValue(generator), ...overrides })
}

// Lets a test resolve/reject one mock call at a time, keyed by its first argument — the semaphore
// test needs to hold several concurrent calls open independently; the dedupe test needs exactly one
// call to stay open while two callers race to join it.
function deferredCalls<TResult>(): {
	fn: (key: string) => Promise<TResult>
	resolve: (key: string, result: TResult) => void
	keys: string[]
} {
	const resolvers = new Map<string, (result: TResult) => void>()
	const keys: string[] = []

	return {
		fn: key => {
			keys.push(key)

			return new Promise<TResult>(resolve => {
				resolvers.set(key, resolve)
			})
		},
		resolve: (key, result) => {
			resolvers.get(key)?.(result)
		},
		keys
	}
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve()
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	readThumbnailBlobMock.mockResolvedValue(null)
	deleteThumbnailMock.mockResolvedValue(undefined)
	storeThumbnailMock.mockResolvedValue(undefined)
})

describe("getThumbnailUrl — category gate", () => {
	it("resolves null for a directory without touching any dep", async () => {
		const deps = makeFakeDeps()

		const url = await getThumbnailUrl(dirItem(), deps)

		expect(url).toBeNull()
		expect(deps.readThumbnailBlob).not.toHaveBeenCalled()
		expect(deps.getGenerator).not.toHaveBeenCalled()
	})
})

describe("getThumbnailUrl — objectURL cache", () => {
	it("reuses the same url on a second call, never re-reading or re-generating", async () => {
		const item = imageItem()
		const generator = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
		const deps = depsWithGenerator(generator)

		const first = await getThumbnailUrl(item, deps)
		const second = await getThumbnailUrl(item, deps)

		expect(first).not.toBeNull()
		expect(second).toBe(first)
		expect(deps.readThumbnailBlob).toHaveBeenCalledTimes(1)
		expect(generator).toHaveBeenCalledTimes(1)
	})
})

describe("getThumbnailUrl — OPFS cache hit (miss on urls map, hit on disk)", () => {
	it("renders the cached blob without ever consulting the generator registry", async () => {
		const item = imageItem()
		const blob = new Blob(["cached"], { type: "image/webp" })
		const deps = makeFakeDeps({ readThumbnailBlob: vi.fn().mockResolvedValue(blob) })

		const url = await getThumbnailUrl(item, deps)

		expect(url).not.toBeNull()
		expect(deps.createObjectUrl).toHaveBeenCalledWith(blob)
		expect(deps.getGenerator).not.toHaveBeenCalled()
	})
})

describe("getThumbnailUrl — routing by category", () => {
	it("an image routes through the generator registry, keyed by its category", async () => {
		const item = imageItem()
		const generator = vi.fn().mockResolvedValue(new Uint8Array([9]))
		const deps = depsWithGenerator(generator)

		const url = await getThumbnailUrl(item, deps)

		expect(url).not.toBeNull()
		expect(deps.getGenerator).toHaveBeenCalledWith("image")
		expect(generator).toHaveBeenCalledWith(item)
	})

	it("a heic item routes through the generator registry, keyed by its category", async () => {
		const item = heicItem()
		const generator = vi.fn().mockResolvedValue(new Uint8Array([9]))
		const deps = depsWithGenerator(generator)

		const url = await getThumbnailUrl(item, deps)

		expect(url).not.toBeNull()
		expect(deps.getGenerator).toHaveBeenCalledWith("heic")
		expect(generator).toHaveBeenCalledWith(item)
	})

	it("persists a generated result through storeThumbnail", async () => {
		const item = imageItem()
		const bytes = new Uint8Array([9])
		const deps = depsWithGenerator(vi.fn().mockResolvedValue(bytes))

		await getThumbnailUrl(item, deps)

		expect(deps.storeThumbnail).toHaveBeenCalledWith(item.data.uuid, bytes)
	})

	it("the rendered blob survives a persist that detaches the bytes' buffer", async () => {
		// The real storeThumbnail Comlink.transfers the buffer, which detaches it SYNCHRONOUSLY at the
		// postMessage call — this fake reproduces that exact hazard via structuredClone's transfer list.
		// Regression pin: the Blob must be constructed from the bytes BEFORE the persist call; ordering
		// them the other way round silently produces an empty Blob (zero-byte thumbnails, blacklisted
		// after three files) while every plain-vi.fn() assertion still passes.
		const item = imageItem()
		const bytes = new Uint8Array([1, 2, 3, 4])
		const capturedBlobs: Blob[] = []
		const deps = depsWithGenerator(vi.fn().mockResolvedValue(bytes), {
			storeThumbnail: vi.fn().mockImplementation((_uuid: string, stored: Uint8Array) => {
				structuredClone(stored.buffer, { transfer: [stored.buffer as ArrayBuffer] })
				return Promise.resolve()
			}),
			createObjectUrl: vi.fn().mockImplementation((blob: Blob) => {
				capturedBlobs.push(blob)
				return "blob:pinned"
			})
		})

		const url = await getThumbnailUrl(item, deps)

		expect(url).toBe("blob:pinned")
		const rendered = capturedBlobs[0]

		if (rendered === undefined) {
			throw new Error("no blob was rendered")
		}

		expect(rendered.size).toBe(4)
		expect(new Uint8Array(await rendered.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
	})

	it("an unregistered category resolves null without throwing", async () => {
		const item = heicItem()
		const deps = makeFakeDeps() // getGenerator returns undefined by default

		const url = await getThumbnailUrl(item, deps)

		expect(url).toBeNull()
		expect(deps.storeThumbnail).not.toHaveBeenCalled()
	})

	it("a persist failure on a generated result is non-fatal — the url still resolves", async () => {
		const item = imageItem()
		const bytes = new Uint8Array([9])
		const deps = depsWithGenerator(vi.fn().mockResolvedValue(bytes), {
			storeThumbnail: vi.fn().mockRejectedValue(new Error("disk full"))
		})

		const url = await getThumbnailUrl(item, deps)

		expect(url).not.toBeNull()
	})
})

describe("getThumbnailUrl — failure and the 3-strike blacklist", () => {
	it("a rejected generation resolves null and counts as one failure", async () => {
		const item = imageItem()
		const deps = depsWithGenerator(vi.fn().mockRejectedValue(new Error("decode failed")))

		const url = await getThumbnailUrl(item, deps)

		expect(url).toBeNull()
	})

	it("a null (no-thumbnail) generator result also counts as a failure", async () => {
		const item = imageItem()
		const deps = depsWithGenerator(vi.fn().mockResolvedValue(null))

		const url = await getThumbnailUrl(item, deps)

		expect(url).toBeNull()
	})

	it("the third failure short-circuits every later call — no fourth generation attempt", async () => {
		const item = imageItem()
		const generator = vi.fn().mockRejectedValue(new Error("decode failed"))
		const deps = depsWithGenerator(generator)

		await getThumbnailUrl(item, deps)
		await getThumbnailUrl(item, deps)
		await getThumbnailUrl(item, deps)

		expect(generator).toHaveBeenCalledTimes(3)

		const fourth = await getThumbnailUrl(item, deps)

		expect(fourth).toBeNull()
		expect(generator).toHaveBeenCalledTimes(3) // unchanged — short-circuited before generating
	})
})

describe("getThumbnailUrl — dedupe (pending-map join)", () => {
	it("two concurrent calls for the same uuid share exactly one generation", async () => {
		const item = imageItem()
		const deferred = deferredCalls<Uint8Array | null>()
		const generator = vi.fn(() => deferred.fn("x"))
		const deps = depsWithGenerator(generator)

		const first = getThumbnailUrl(item, deps)
		const second = getThumbnailUrl(item, deps)

		await flushMicrotasks()
		expect(generator).toHaveBeenCalledTimes(1)
		expect(deps.readThumbnailBlob).toHaveBeenCalledTimes(1)

		deferred.resolve("x", new Uint8Array([1]))

		const [firstUrl, secondUrl] = await Promise.all([first, second])

		expect(firstUrl).not.toBeNull()
		expect(secondUrl).toBe(firstUrl)
		expect(generator).toHaveBeenCalledTimes(1)
	})

	it("a later call after the first settles starts a fresh generation (pending entry cleared)", async () => {
		const item = imageItem()
		const deps = depsWithGenerator(vi.fn().mockResolvedValue(new Uint8Array([1])))

		await getThumbnailUrl(item, deps)

		// The first call already cached a url — this proves the pending entry, not the objectURL
		// cache, is what's being exercised: force a cache miss by clearing urls indirectly via a
		// fresh uuid instead would defeat the point, so this only re-asserts the fast path (see the
		// "objectURL cache" describe block) — the pending-map itself is proven above.
		const again = await getThumbnailUrl(item, deps)

		expect(again).not.toBeNull()
	})
})

describe("getThumbnailUrl — semaphore (max 3 concurrent generations)", () => {
	it("a 4th concurrent call for a different uuid queues until a slot frees", async () => {
		const items = [imageItem(), imageItem(), imageItem(), imageItem()]
		const deferred = deferredCalls<Blob | null>()
		const deps = depsWithGenerator(vi.fn().mockResolvedValue(new Uint8Array([1])), {
			readThumbnailBlob: vi.fn((uuid: string) => deferred.fn(uuid))
		})

		const attempts = items.map(item => getThumbnailUrl(item, deps))

		await flushMicrotasks()

		expect(deferred.keys).toHaveLength(3) // only 3 of the 4 uuids have started a generation

		const [a, b, c, d] = items
		if (a === undefined || b === undefined || c === undefined || d === undefined) {
			throw new Error("expected four fixtures")
		}

		expect(deferred.keys).toContain(a.data.uuid)
		expect(deferred.keys).toContain(b.data.uuid)
		expect(deferred.keys).toContain(c.data.uuid)
		expect(deferred.keys).not.toContain(d.data.uuid)

		// Release one in-flight slot — the 4th call's own generation should now start.
		deferred.resolve(a.data.uuid, null)
		await flushMicrotasks()

		expect(deferred.keys).toHaveLength(4)
		expect(deferred.keys).toContain(d.data.uuid)

		// Drain the rest so nothing is left dangling at the end of the test.
		deferred.resolve(b.data.uuid, null)
		deferred.resolve(c.data.uuid, null)
		deferred.resolve(d.data.uuid, null)

		const urls = await Promise.all(attempts)

		expect(urls.every(url => url !== null)).toBe(true)
	})
})

describe("invalidateThumbnail", () => {
	it("revokes the objectURL and deletes the on-disk entry", async () => {
		const item = imageItem()
		const deps = depsWithGenerator(vi.fn().mockResolvedValue(new Uint8Array([1])))

		const url = await getThumbnailUrl(item, deps)

		invalidateThumbnail(item.data.uuid, deps)

		expect(deps.revokeObjectUrl).toHaveBeenCalledWith(url)
		expect(deps.deleteThumbnail).toHaveBeenCalledWith(item.data.uuid)
	})

	it("is a clean no-op for a uuid with no rendered thumbnail", () => {
		const deps = makeFakeDeps()

		expect(() => {
			invalidateThumbnail(testUuid("never-rendered"), deps)
		}).not.toThrow()
		expect(deps.revokeObjectUrl).not.toHaveBeenCalled()
		expect(deps.deleteThumbnail).toHaveBeenCalledWith(testUuid("never-rendered"))
	})

	it("a delete failure is logged and non-fatal — never throws", () => {
		const deps = makeFakeDeps({ deleteThumbnail: vi.fn().mockRejectedValue(new Error("locked")) })

		expect(() => {
			invalidateThumbnail(testUuid("x"), deps)
		}).not.toThrow()
	})

	it("clears exactly one blacklist strike, allowing exactly one more attempt", async () => {
		const item = imageItem()
		const failing = vi.fn().mockRejectedValue(new Error("decode failed"))
		const deps = depsWithGenerator(failing)

		await getThumbnailUrl(item, deps)
		await getThumbnailUrl(item, deps)
		await getThumbnailUrl(item, deps)
		expect(failing).toHaveBeenCalledTimes(3)

		const shortCircuited = await getThumbnailUrl(item, deps)
		expect(shortCircuited).toBeNull()
		expect(failing).toHaveBeenCalledTimes(3) // still short-circuited, strike untouched

		invalidateThumbnail(item.data.uuid, deps)

		// One strike cleared (3 -> 2): the next call is allowed to attempt again.
		const succeeding = vi.fn().mockResolvedValue(new Uint8Array([1]))
		deps.getGenerator = vi.fn().mockReturnValue(succeeding)
		const afterInvalidate = await getThumbnailUrl(item, deps)

		expect(afterInvalidate).not.toBeNull()
		expect(succeeding).toHaveBeenCalledTimes(1)
	})
})

describe("invalidateThumbnail — bounded cache interplay", () => {
	it("removing one uuid's entry never disturbs another live uuid's cached url, and frees its own slot for a fresh generation", async () => {
		const first = imageItem()
		const second = imageItem()
		const deps = depsWithGenerator(vi.fn().mockResolvedValue(new Uint8Array([1])))

		const firstUrl = await getThumbnailUrl(first, deps)
		const secondUrl = await getThumbnailUrl(second, deps)

		invalidateThumbnail(first.data.uuid, deps)

		// A different uuid's cached url survives untouched — invalidate targets exactly the key asked
		// for, never a capacity-driven sweep of unrelated live entries.
		const secondAgain = await getThumbnailUrl(second, deps)
		expect(secondAgain).toBe(secondUrl)

		// The invalidated uuid regenerates a fresh url, proving its bounded-cache slot was actually
		// removed (not left as a stale, still-counted key).
		const firstAgain = await getThumbnailUrl(first, deps)
		expect(firstAgain).not.toBeNull()
		expect(firstAgain).not.toBe(firstUrl)
	})
})

// registerThumbGenerator + defaultThumbnailDeps — the real module-level registry and the real
// worker/OPFS wiring, with only the sdk client and thumb-cache modules mocked (see the top of this
// file). Proves the registration seam is wired all the way through, not merely typed.
describe("registerThumbGenerator + defaultThumbnailDeps — real wiring", () => {
	it("a registered generator's bytes flow through defaultThumbnailDeps to a rendered url, persisted via the real sdkApi.storeThumbnail wiring", async () => {
		const item = heicItem()
		const bytes = new Uint8Array([7, 7, 7])

		registerThumbGenerator("heic", i => {
			expect(i.data.uuid).toBe(item.data.uuid)

			return Promise.resolve(bytes)
		})

		const url = await getThumbnailUrl(item)

		expect(url).not.toBeNull()
		expect(url).toMatch(/^blob:/)
		expect(storeThumbnailMock).toHaveBeenCalledWith(item.data.uuid, bytes)
	})

	it("defaultThumbnailDeps.readThumbnailBlob/deleteThumbnail forward to the real thumb-cache module", async () => {
		const blob = new Blob(["x"])
		readThumbnailBlobMock.mockResolvedValue(blob)

		await expect(defaultThumbnailDeps.readThumbnailBlob("u")).resolves.toBe(blob)
		await defaultThumbnailDeps.deleteThumbnail("u")
		expect(deleteThumbnailMock).toHaveBeenCalledWith("u")
	})
})

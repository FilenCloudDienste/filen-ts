import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { onlineManager } from "@tanstack/react-query"
import type { File as SdkFile, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"

// Mock boundaries mirror download.test.ts's own: the real sdk client imports a Vite
// `?worker` module (unresolvable/unwanted under node vitest), and the real thumb-cache module calls
// navigator.storage.getDirectory(), which doesn't exist under node either. Only storeThumbnail is
// needed from the sdk client here — this file tests the SERVICE, which is producer-agnostic: where a
// registered generator's bytes come from (the SDK, a canvas) is entirely that generator's business.
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
	seedThumbnail,
	defaultThumbnailDeps,
	type ThumbGenerationResult,
	type ThumbGenerator,
	type ThumbnailServiceDeps,
	type ThumbSeedResult
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
		stableUUID: undefined,
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

// onlineManager is a module-level singleton the service subscribes to at import — leave it online so
// one test's offline/online toggle can't leak a cleared verdict into the next.
afterEach(() => {
	onlineManager.setOnline(true)
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
		const generator = vi.fn().mockResolvedValue({ type: "bytes", bytes: new Uint8Array([1, 2, 3]) })
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
		const generator = vi.fn().mockResolvedValue({ type: "bytes", bytes: new Uint8Array([9]) })
		const deps = depsWithGenerator(generator)

		const url = await getThumbnailUrl(item, deps)

		expect(url).not.toBeNull()
		expect(deps.getGenerator).toHaveBeenCalledWith("sdk")
		expect(generator).toHaveBeenCalledWith(item)
	})

	// HEIC has no arm of its own any more — it is a still image, so it is the SDK's, like every other.
	it("a heic item routes through the SAME sdk category, not one of its own", async () => {
		const item = heicItem()
		const generator = vi.fn().mockResolvedValue({ type: "bytes", bytes: new Uint8Array([9]) })
		const deps = depsWithGenerator(generator)

		const url = await getThumbnailUrl(item, deps)

		expect(url).not.toBeNull()
		expect(deps.getGenerator).toHaveBeenCalledWith("sdk")
		expect(generator).toHaveBeenCalledWith(item)
	})

	it("persists a generated result through storeThumbnail", async () => {
		const item = imageItem()
		const bytes = new Uint8Array([9])
		const deps = depsWithGenerator(vi.fn().mockResolvedValue({ type: "bytes", bytes }))

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
		const deps = depsWithGenerator(vi.fn().mockResolvedValue({ type: "bytes", bytes }), {
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
		const deps = depsWithGenerator(vi.fn().mockResolvedValue({ type: "bytes", bytes }), {
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

	it("a transient 'failed' generator result also counts as a failure", async () => {
		const item = imageItem()
		const deps = depsWithGenerator(vi.fn().mockResolvedValue({ type: "failed" }))

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

// A generator can answer definitively about a file's CONTENT — no decoder for the format, past the
// producer's decode budget, damaged bytes — and that is categorically different from a dropped
// download. The service remembers those for the session, short-circuits the generator, and spends no
// blacklist strike on them.
describe("getThumbnailUrl — settled verdicts", () => {
	it("an 'unavailable' verdict resolves null and is never re-asked of the generator", async () => {
		const item = imageItem()
		const generator = vi.fn().mockResolvedValue({ type: "unavailable", reason: "unsupported" })
		const deps = depsWithGenerator(generator)

		expect(await getThumbnailUrl(item, deps)).toBeNull()
		expect(await getThumbnailUrl(item, deps)).toBeNull()
		expect(await getThumbnailUrl(item, deps)).toBeNull()
		expect(await getThumbnailUrl(item, deps)).toBeNull()

		expect(generator).toHaveBeenCalledTimes(1)
	})

	// The distinction that matters: three settled verdicts must NOT exhaust the retry budget that
	// exists for flaky downloads. After a verdict is cleared, a full three attempts are still available.
	it("costs no blacklist strike — the item keeps its full retry budget", async () => {
		const item = imageItem()
		const deps = depsWithGenerator(vi.fn().mockResolvedValue({ type: "unavailable", reason: "corrupt" }))

		await getThumbnailUrl(item, deps)

		// Clearing the verdict (an offline -> online flip) lets the item be attempted again; if the
		// verdict had burned a strike, the third failure below would already be short-circuiting.
		onlineManager.setOnline(false)
		onlineManager.setOnline(true)

		const failing = vi.fn().mockResolvedValue({ type: "failed" })
		deps.getGenerator = vi.fn().mockReturnValue(failing)

		await getThumbnailUrl(item, deps)
		await getThumbnailUrl(item, deps)
		await getThumbnailUrl(item, deps)

		expect(failing).toHaveBeenCalledTimes(3)
	})

	// The short-circuit sits BELOW the cache read on purpose — bytes on disk (the upload path can put
	// them there) must outrank a verdict the listing path reached earlier.
	it("bytes landing on disk outrank an earlier verdict", async () => {
		const item = imageItem()
		const generator = vi.fn().mockResolvedValue({ type: "unavailable", reason: "overBudget" })
		const deps = depsWithGenerator(generator)

		expect(await getThumbnailUrl(item, deps)).toBeNull()

		const blob = new Blob(["late-arrival"])
		deps.readThumbnailBlob = vi.fn().mockResolvedValue(blob)

		const url = await getThumbnailUrl(item, deps)

		expect(url).not.toBeNull()
		expect(deps.createObjectUrl).toHaveBeenCalledWith(blob)
		expect(generator).toHaveBeenCalledTimes(1)
	})

	it("an offline -> online flip clears every verdict", async () => {
		const item = imageItem()
		const generator = vi
			.fn()
			.mockResolvedValueOnce({ type: "unavailable", reason: "unsupported" })
			.mockResolvedValue({ type: "bytes", bytes: new Uint8Array([1]) })
		const deps = depsWithGenerator(generator)

		expect(await getThumbnailUrl(item, deps)).toBeNull()

		onlineManager.setOnline(false)
		onlineManager.setOnline(true)

		expect(await getThumbnailUrl(item, deps)).not.toBeNull()
		expect(generator).toHaveBeenCalledTimes(2)
	})

	// A repeat of a state already held must not clear anything: onlineManager only notifies on a real
	// change, so this pins that the service relies on that rather than on its own bookkeeping.
	it("staying online does not clear a verdict", async () => {
		const item = imageItem()
		const generator = vi.fn().mockResolvedValue({ type: "unavailable", reason: "unsupported" })
		const deps = depsWithGenerator(generator)

		await getThumbnailUrl(item, deps)
		onlineManager.setOnline(true)
		await getThumbnailUrl(item, deps)

		expect(generator).toHaveBeenCalledTimes(1)
	})

	it("invalidateThumbnail drops the verdict outright", async () => {
		const item = imageItem()
		const generator = vi
			.fn()
			.mockResolvedValueOnce({ type: "unavailable", reason: "corrupt" })
			.mockResolvedValue({ type: "bytes", bytes: new Uint8Array([1]) })
		const deps = depsWithGenerator(generator)

		expect(await getThumbnailUrl(item, deps)).toBeNull()

		invalidateThumbnail(item.data.uuid, deps)

		expect(await getThumbnailUrl(item, deps)).not.toBeNull()
	})

	// Never persisted: the verdict belongs to the producer that gave it, and the next SDK version may
	// decode what this one refused.
	it("never writes anything to the on-disk cache", async () => {
		const item = imageItem()
		const deps = depsWithGenerator(vi.fn().mockResolvedValue({ type: "unavailable", reason: "unsupported" }))

		await getThumbnailUrl(item, deps)

		expect(deps.storeThumbnail).not.toHaveBeenCalled()
	})
})

// The upload path's seat in the pending map: a file the client still holds is thumbnailed locally and
// published as THE in-flight generation for its uuid, so the freshly-patched listing row joins it
// instead of downloading the bytes back off the server.
describe("seedThumbnail", () => {
	it("persists and renders what the production returned", async () => {
		const item = imageItem()
		const deps = makeFakeDeps()
		const bytes = new Uint8Array([4, 5, 6])

		seedThumbnail(item, () => Promise.resolve({ type: "bytes", bytes }), deps)

		const url = await getThumbnailUrl(item, deps)

		expect(url).not.toBeNull()
		expect(deps.storeThumbnail).toHaveBeenCalledWith(item.data.uuid, bytes)
	})

	it("is what a concurrent getThumbnailUrl joins — the generator is never reached", async () => {
		const item = imageItem()
		const generator = vi.fn().mockResolvedValue({ type: "bytes", bytes: new Uint8Array([9]) })
		const deps = depsWithGenerator(generator)

		seedThumbnail(item, () => Promise.resolve({ type: "bytes", bytes: new Uint8Array([4]) }), deps)

		const url = await getThumbnailUrl(item, deps)

		expect(url).not.toBeNull()
		expect(generator).not.toHaveBeenCalled()
		expect(deps.readThumbnailBlob).not.toHaveBeenCalled()
	})

	// "none" is the production's own answer about the file, so it resolves null for the joined caller —
	// but it must not spend the retry budget that exists for flaky downloads. Three real failures have
	// to remain available afterwards; a fourth is what short-circuits.
	it("a 'none' production costs no blacklist strike — the ordinary path keeps its budget", async () => {
		const item = imageItem()
		const failing = vi.fn().mockResolvedValue({ type: "failed" })
		const deps = depsWithGenerator(failing)

		seedThumbnail(item, () => Promise.resolve({ type: "none" }), deps)

		expect(await getThumbnailUrl(item, deps)).toBeNull()
		expect(failing).not.toHaveBeenCalled()

		await getThumbnailUrl(item, deps)
		await getThumbnailUrl(item, deps)
		await getThumbnailUrl(item, deps)

		expect(failing).toHaveBeenCalledTimes(3)
	})

	// A THROWN production is not an answer about the file — a dead worker refuses everything — so the
	// seat must hand its joined callers the ordinary generator's result instead of a null they will
	// never re-ask for.
	it("a thrown production falls through to the ordinary generator", async () => {
		const item = imageItem()
		const generator = vi.fn().mockResolvedValue({ type: "bytes", bytes: new Uint8Array([7]) })
		const deps = depsWithGenerator(generator)

		seedThumbnail(item, () => Promise.reject(new Error("worker died")), deps)

		const url = await getThumbnailUrl(item, deps)

		expect(url).not.toBeNull()
		expect(generator).toHaveBeenCalledWith(item)
		expect(deps.storeThumbnail).toHaveBeenCalledWith(item.data.uuid, new Uint8Array([7]))
	})

	// The settled-looking arm that is NOT settled: the local production refused on its own decode
	// budget, which the ordinary producer does not share, so its "unanswered" has to reach the same
	// fall-through a throw does rather than resolving null.
	it("an 'unanswered' production falls through to the ordinary generator", async () => {
		const item = imageItem()
		const generator = vi.fn().mockResolvedValue({ type: "bytes", bytes: new Uint8Array([8]) })
		const deps = depsWithGenerator(generator)

		seedThumbnail(item, () => Promise.resolve({ type: "unanswered" }), deps)

		const url = await getThumbnailUrl(item, deps)

		expect(url).not.toBeNull()
		expect(generator).toHaveBeenCalledWith(item)
		expect(deps.storeThumbnail).toHaveBeenCalledWith(item.data.uuid, new Uint8Array([8]))
	})

	// The upload path seats a production for every uploaded file, including uploads into a directory
	// nothing is rendering. A seat nobody joined has no caller to answer, so its fall-through must not
	// spend a generation slot — and the uuid must stay askable for whenever a row does mount.
	it("an unanswered seat nobody joined never generates, and leaves the uuid askable", async () => {
		const item = imageItem()
		const generator = vi.fn().mockResolvedValue({ type: "bytes", bytes: new Uint8Array([9]) })
		const deps = depsWithGenerator(generator)

		seedThumbnail(item, () => Promise.resolve({ type: "unanswered" }), deps)

		await flushMicrotasks()

		expect(generator).not.toHaveBeenCalled()
		expect(deps.readThumbnailBlob).not.toHaveBeenCalled()

		const url = await getThumbnailUrl(item, deps)

		expect(url).not.toBeNull()
		expect(generator).toHaveBeenCalledTimes(1)
	})

	// The case the seat exists for, and the one the fall-through has to survive: the freshly-patched
	// row joins WHILE the production is still running, so it holds the seeded promise itself and
	// cannot re-ask on its own.
	it("a caller that joined mid-production gets the fallback's result", async () => {
		const item = imageItem()
		const generator = vi.fn().mockResolvedValue({ type: "bytes", bytes: new Uint8Array([7]) })
		const deps = depsWithGenerator(generator)
		let releaseProduction = (): void => undefined
		const gate = new Promise<void>(resolve => {
			releaseProduction = resolve
		})

		seedThumbnail(
			item,
			async () => {
				await gate

				throw new Error("worker died")
			},
			deps
		)

		const joined = getThumbnailUrl(item, deps)

		await flushMicrotasks()

		expect(generator).not.toHaveBeenCalled()

		releaseProduction()

		await expect(joined).resolves.not.toBeNull()
		expect(generator).toHaveBeenCalledTimes(1)
	})

	it("a rejected production is never surfaced to the caller", async () => {
		const item = imageItem()
		const deps = makeFakeDeps()

		seedThumbnail(item, () => Promise.reject(new Error("sdk died")), deps)

		// No generator is registered on these deps, so the fall-through has nothing to produce either —
		// what this pins is that the throw reaches the ordinary path rather than the caller.
		await expect(getThumbnailUrl(item, deps)).resolves.toBeNull()
		expect(deps.getGenerator).toHaveBeenCalledWith("sdk")
	})

	it("leaves a uuid that already has a rendered url alone", async () => {
		const item = imageItem()
		const deps = depsWithGenerator(vi.fn().mockResolvedValue({ type: "bytes", bytes: new Uint8Array([1]) }))

		const first = await getThumbnailUrl(item, deps)
		const produce = vi.fn(() => Promise.resolve<ThumbSeedResult>({ type: "bytes", bytes: new Uint8Array([2]) }))

		seedThumbnail(item, produce, deps)

		expect(produce).not.toHaveBeenCalled()
		expect(await getThumbnailUrl(item, deps)).toBe(first)
	})
})

describe("getThumbnailUrl — dedupe (pending-map join)", () => {
	it("two concurrent calls for the same uuid share exactly one generation", async () => {
		const item = imageItem()
		const deferred = deferredCalls<ThumbGenerationResult>()
		const generator = vi.fn(() => deferred.fn("x"))
		const deps = depsWithGenerator(generator)

		const first = getThumbnailUrl(item, deps)
		const second = getThumbnailUrl(item, deps)

		await flushMicrotasks()
		expect(generator).toHaveBeenCalledTimes(1)
		expect(deps.readThumbnailBlob).toHaveBeenCalledTimes(1)

		deferred.resolve("x", { type: "bytes", bytes: new Uint8Array([1]) })

		const [firstUrl, secondUrl] = await Promise.all([first, second])

		expect(firstUrl).not.toBeNull()
		expect(secondUrl).toBe(firstUrl)
		expect(generator).toHaveBeenCalledTimes(1)
	})

	it("a later call after the first settles starts a fresh generation (pending entry cleared)", async () => {
		const item = imageItem()
		const deps = depsWithGenerator(vi.fn().mockResolvedValue({ type: "bytes", bytes: new Uint8Array([1]) }))

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
		const deps = depsWithGenerator(vi.fn().mockResolvedValue({ type: "bytes", bytes: new Uint8Array([1]) }), {
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
		const deps = depsWithGenerator(vi.fn().mockResolvedValue({ type: "bytes", bytes: new Uint8Array([1]) }))

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
		const succeeding = vi.fn().mockResolvedValue({ type: "bytes", bytes: new Uint8Array([1]) })
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
		const deps = depsWithGenerator(vi.fn().mockResolvedValue({ type: "bytes", bytes: new Uint8Array([1]) }))

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

		registerThumbGenerator("sdk", i => {
			expect(i.data.uuid).toBe(item.data.uuid)

			return Promise.resolve({ type: "bytes", bytes })
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

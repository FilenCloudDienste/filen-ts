import { describe, expect, it, vi } from "vitest"
import { CoverArtCache, COVER_CACHE_MAX_ENTRIES } from "@/features/audio/lib/coverCache"

function picture(tag: string): { data: Uint8Array; format: string } {
	return { data: new Uint8Array([tag.charCodeAt(0)]), format: "image/jpeg" }
}

function makeFns(): {
	createObjectUrl: ReturnType<typeof vi.fn<(blob: Blob) => string>>
	revokeObjectUrl: ReturnType<typeof vi.fn<(url: string) => void>>
	calls: string[]
} {
	const calls: string[] = []
	let counter = 0

	return {
		calls,
		createObjectUrl: vi.fn<(blob: Blob) => string>(() => {
			counter += 1

			return `blob:${String(counter)}`
		}),
		revokeObjectUrl: vi.fn<(url: string) => void>(url => {
			calls.push(url)
		})
	}
}

describe("CoverArtCache", () => {
	it("mints a fresh blob url per uuid and returns it from get", () => {
		const fns = makeFns()
		const cache = new CoverArtCache(fns)

		const url = cache.set("a", picture("a"))

		expect(url).toBe("blob:1")
		expect(cache.get("a")).toBe("blob:1")
		expect(cache.get("missing")).toBeNull()
	})

	it("revokes and re-mints on a re-set for the same uuid", () => {
		const fns = makeFns()
		const cache = new CoverArtCache(fns)

		cache.set("a", picture("a"))
		const second = cache.set("a", picture("b"))

		expect(second).toBe("blob:2")
		expect(fns.revokeObjectUrl).toHaveBeenCalledWith("blob:1")
		expect(cache.get("a")).toBe("blob:2")
	})

	it("evicts the oldest entry, revoking it, once the cap is exceeded", () => {
		const fns = makeFns()
		const cache = new CoverArtCache(fns)

		for (let i = 0; i < COVER_CACHE_MAX_ENTRIES + 3; i++) {
			cache.set(`t${String(i)}`, picture(String(i)))
		}

		expect(Object.keys(cache.snapshot())).toHaveLength(COVER_CACHE_MAX_ENTRIES)
		// The first 3 minted (oldest) were evicted.
		expect(cache.get("t0")).toBeNull()
		expect(cache.get("t1")).toBeNull()
		expect(cache.get("t2")).toBeNull()
		expect(cache.get(`t${String(COVER_CACHE_MAX_ENTRIES + 2)}`)).not.toBeNull()
		expect(fns.revokeObjectUrl).toHaveBeenCalledWith("blob:1")
		expect(fns.revokeObjectUrl).toHaveBeenCalledWith("blob:2")
		expect(fns.revokeObjectUrl).toHaveBeenCalledWith("blob:3")
	})

	it("snapshot reflects the live key set for the reactive store mirror", () => {
		const fns = makeFns()
		const cache = new CoverArtCache(fns)

		cache.set("a", picture("a"))
		cache.set("b", picture("b"))

		expect(cache.snapshot()).toEqual({ a: "blob:1", b: "blob:2" })
	})

	it("revokeAll revokes every live url and clears the cache", () => {
		const fns = makeFns()
		const cache = new CoverArtCache(fns)

		cache.set("a", picture("a"))
		cache.set("b", picture("b"))
		cache.revokeAll()

		expect(fns.revokeObjectUrl).toHaveBeenCalledWith("blob:1")
		expect(fns.revokeObjectUrl).toHaveBeenCalledWith("blob:2")
		expect(cache.snapshot()).toEqual({})
	})
})

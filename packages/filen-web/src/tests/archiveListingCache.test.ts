import { beforeEach, describe, expect, it } from "vitest"
import { createEntryStore } from "@/features/archive/lib/entryStore"
import { clearArchiveListings, createListingCache, type CachedListing, type ListingCache } from "@/features/archive/lib/listingCache"
import type { ListSummary } from "@/features/archive/lib/listingSession"

const SUMMARY: ListSummary = {
	format: { type: "zip" },
	password: "notNeeded",
	totals: { entries: 0, dirs: 0, files: 0, bytes: 0, skipped: 0, bytesSkipped: 0 },
	undelivered: 0,
	duplicates: null,
	unaccountedBytes: 0,
	verifying: false,
	verifyWaiting: false,
	verifyError: null
}

function listing(entries: number): CachedListing {
	return { store: createEntryStore(), summary: SUMMARY, password: undefined, lastDirPath: "", entries }
}

let cache: ListingCache

beforeEach(() => {
	cache = createListingCache()
	cache.open()
})

describe("listingCache", () => {
	it("keeps the three most recently used listings", () => {
		const a = listing(10)

		cache.put("a", a)
		cache.put("b", listing(10))
		cache.put("c", listing(10))

		// Using "a" makes "b" the oldest.
		expect(cache.get("a")).toBe(a)

		cache.put("d", listing(10))

		expect(cache.get("b")).toBeUndefined()
		expect(cache.get("a")).toBe(a)
		expect(cache.get("c")).toBeDefined()
		expect(cache.get("d")).toBeDefined()
	})

	it("keeps the entries within 300k, evicting the oldest", () => {
		cache.put("a", listing(200_000))
		cache.put("b", listing(50_000))
		cache.put("c", listing(100_000))

		expect(cache.get("a")).toBeUndefined()
		expect(cache.get("b")).toBeDefined()
		expect(cache.get("c")).toBeDefined()
	})

	it("never caches a listing over the budget on its own", () => {
		cache.put("a", listing(10))
		cache.put("huge", listing(300_001))

		expect(cache.get("huge")).toBeUndefined()
		expect(cache.get("a")).toBeDefined()
	})

	it("replaces a listing put again, counting it once", () => {
		const newer = { ...listing(150_000), lastDirPath: "docs" }

		cache.put("a", listing(150_000))
		cache.put("a", newer)
		cache.put("b", listing(150_000))

		expect(cache.get("a")).toBe(newer)
		expect(cache.get("b")).toBeDefined()
	})

	it("empties on close and refuses what a browser disposed later puts", () => {
		cache.put("a", listing(10))
		cache.close()

		expect(cache.get("a")).toBeUndefined()

		cache.put("b", listing(10))

		expect(cache.get("b")).toBeUndefined()
	})

	it("takes puts again once its host mounts again, the budget started over", () => {
		cache.put("a", listing(10))
		cache.close()
		cache.open()
		cache.put("b", listing(300_000))

		expect(cache.get("a")).toBeUndefined()
		expect(cache.get("b")).toBeDefined()
	})

	it("is closed by sign-out while its host is mounted", () => {
		cache.put("a", listing(10))
		clearArchiveListings()

		expect(cache.get("a")).toBeUndefined()

		cache.put("a", listing(10))

		expect(cache.get("a")).toBeUndefined()
	})

	it("keeps caches apart", () => {
		const other = createListingCache()

		cache.put("a", listing(10))

		expect(other.get("a")).toBeUndefined()
	})
})

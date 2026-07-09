import { beforeEach, describe, expect, it } from "vitest"
// Whole-statement `import type` (not the usual inline `type` keyword — see queries/drive.ts): the
// inline form doesn't reliably elide under vitest for this package, and a non-elided import drags
// in the wasm-bindgen worker glue (references `self`, undefined under Node).
import type { Dir, UuidStr, SharedRootDir, SharingRole } from "@filen/sdk-rs"
import {
	cacheDirs,
	cacheSharedDirContext,
	clearDirectoryCache,
	evictDirs,
	getCachedDir,
	getCachedName,
	getSharedDirContext
} from "@/features/drive/lib/cache"

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a short
// readable test label into a shape that satisfies it, mirroring drive.test.ts's own uuid fixtures.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: testUuid("dir"),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } },
		...overrides
	}
}

// Every test starts from an empty cache — this doubles as coverage for clearDirectoryCache itself
// rather than reaching for vi.resetModules() (the module has no import-time side effects to reset
// around, unlike keymap/registry.ts's async overrides load).
beforeEach(() => {
	clearDirectoryCache()
})

describe("directory cache", () => {
	it("returns undefined for a uuid that was never cached", () => {
		expect(getCachedDir(testUuid("missing"))).toBeUndefined()
		expect(getCachedName(testUuid("missing"))).toBeUndefined()
	})

	it("caches a dir and its decrypted name from a single cacheDirs call", () => {
		const uuid = testUuid("a")
		cacheDirs([mockDir({ uuid, meta: { type: "decoded", data: { name: "Photos" } } })])

		expect(getCachedDir(uuid)).toEqual(expect.objectContaining({ uuid, meta: { type: "decoded", data: { name: "Photos" } } }))
		expect(getCachedName(uuid)).toBe("Photos")
	})

	it("caches every dir from one listing in a single call", () => {
		const uuidA = testUuid("a")
		const uuidB = testUuid("b")
		cacheDirs([mockDir({ uuid: uuidA }), mockDir({ uuid: uuidB, meta: { type: "decoded", data: { name: "Videos" } } })])

		expect(getCachedDir(uuidA)).toBeDefined()
		expect(getCachedDir(uuidB)).toBeDefined()
		expect(getCachedName(uuidA)).toBe("Documents")
		expect(getCachedName(uuidB)).toBe("Videos")
	})

	it("cacheDirs([]) is a safe no-op", () => {
		expect(() => {
			cacheDirs([])
		}).not.toThrow()
	})

	it("re-caching the same uuid overwrites the stale dir and name (e.g. a rename)", () => {
		const uuid = testUuid("a")
		cacheDirs([mockDir({ uuid, meta: { type: "decoded", data: { name: "Old" } } })])
		cacheDirs([mockDir({ uuid, timestamp: 1_800_000_000_000n, meta: { type: "decoded", data: { name: "New" } } })])

		expect(getCachedName(uuid)).toBe("New")
		expect(getCachedDir(uuid)?.timestamp).toBe(1_800_000_000_000n)
	})

	it("caches the Dir even when its meta is undecryptable, without clobbering an earlier known name", () => {
		const uuid = testUuid("a")
		cacheDirs([mockDir({ uuid, meta: { type: "decoded", data: { name: "Known" } } })])
		cacheDirs([mockDir({ uuid, meta: { type: "encrypted", data: "ciphertext" } })])

		expect(getCachedDir(uuid)?.meta.type).toBe("encrypted")
		expect(getCachedName(uuid)).toBe("Known")
	})

	it("never caches a name for a dir whose meta was never decodable", () => {
		const uuid = testUuid("a")
		cacheDirs([mockDir({ uuid, meta: { type: "encrypted", data: "ciphertext" } })])

		expect(getCachedDir(uuid)).toBeDefined()
		expect(getCachedName(uuid)).toBeUndefined()
	})

	it("clearDirectoryCache empties both the dir and name maps", () => {
		const uuid = testUuid("a")
		cacheDirs([mockDir({ uuid })])

		clearDirectoryCache()

		expect(getCachedDir(uuid)).toBeUndefined()
		expect(getCachedName(uuid)).toBeUndefined()
	})
})

describe("evictDirs", () => {
	it("removes a single uuid from both the dir and name maps", () => {
		const uuid = testUuid("a")
		cacheDirs([mockDir({ uuid })])

		evictDirs([uuid])

		expect(getCachedDir(uuid)).toBeUndefined()
		expect(getCachedName(uuid)).toBeUndefined()
	})

	it("evicts a whole batch in one call", () => {
		const uuidA = testUuid("a")
		const uuidB = testUuid("b")
		cacheDirs([mockDir({ uuid: uuidA }), mockDir({ uuid: uuidB, meta: { type: "decoded", data: { name: "Videos" } } })])

		evictDirs([uuidA, uuidB])

		expect(getCachedDir(uuidA)).toBeUndefined()
		expect(getCachedDir(uuidB)).toBeUndefined()
		expect(getCachedName(uuidA)).toBeUndefined()
		expect(getCachedName(uuidB)).toBeUndefined()
	})

	it("leaves every other cached uuid untouched", () => {
		const evicted = testUuid("evicted")
		const kept = testUuid("kept")
		cacheDirs([mockDir({ uuid: evicted }), mockDir({ uuid: kept, meta: { type: "decoded", data: { name: "Kept" } } })])

		evictDirs([evicted])

		expect(getCachedDir(kept)).toBeDefined()
		expect(getCachedName(kept)).toBe("Kept")
	})

	it("evictDirs([]) is a safe no-op", () => {
		const uuid = testUuid("a")
		cacheDirs([mockDir({ uuid })])

		expect(() => {
			evictDirs([])
		}).not.toThrow()
		expect(getCachedDir(uuid)).toBeDefined()
	})

	it("evicting a uuid that was never cached is a safe no-op", () => {
		expect(() => {
			evictDirs([testUuid("never-cached")])
		}).not.toThrow()
	})
})

function sharerRole(id: number, email: string): SharingRole {
	return { Sharer: { email, id } }
}

function mockSharedRootDir(uuid: UuidStr, role: SharingRole): SharedRootDir {
	return {
		inner: { uuid, color: "default", timestamp: 1_700_000_000_000n, meta: { type: "decoded", data: { name: "SharedRoot" } } },
		sharingRole: role,
		writeAccess: true
	}
}

describe("shared-dir context cache", () => {
	it("returns undefined for a uuid that was never cached", () => {
		expect(getSharedDirContext(testUuid("missing"))).toBeUndefined()
	})

	it("stores the dir handle and role, retrievable by uuid", () => {
		const uuid = testUuid("shared")
		const role = sharerRole(42, "sharer@filen.io")
		const dir = mockSharedRootDir(uuid, role)

		cacheSharedDirContext(uuid, { dir, role })

		expect(getSharedDirContext(uuid)).toEqual({ dir, role })
	})

	it("re-caching the same uuid overwrites the stale context", () => {
		const uuid = testUuid("shared")
		const roleA = sharerRole(1, "a@filen.io")
		const roleB = sharerRole(2, "b@filen.io")

		cacheSharedDirContext(uuid, { dir: mockSharedRootDir(uuid, roleA), role: roleA })
		cacheSharedDirContext(uuid, { dir: mockSharedRootDir(uuid, roleB), role: roleB })

		expect(getSharedDirContext(uuid)?.role).toEqual(roleB)
	})

	it("clearDirectoryCache empties the shared-dir context map too (session isolation)", () => {
		const uuid = testUuid("shared")
		const role = sharerRole(42, "sharer@filen.io")
		cacheSharedDirContext(uuid, { dir: mockSharedRootDir(uuid, role), role })

		clearDirectoryCache()

		expect(getSharedDirContext(uuid)).toBeUndefined()
	})
})

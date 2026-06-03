import { vi, describe, it, expect } from "vitest"

// driveSortPreference.ts uses useSecureStore (react hook), but we only test the
// pure exported helpers here — no hook rendering is needed.

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@/lib/secureStore", () => ({
	useSecureStore: vi.fn()
}))

import { isSortable, getPerDirectoryKey, resolveEffectiveSort, DEFAULT_SORT_PREFERENCES } from "@/lib/driveSortPreference"
import type { SortPreferences } from "@/lib/driveSortPreference"
import type { DrivePath, DrivePathType } from "@/hooks/useDrivePath"

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function makePath(type: DrivePathType | null, uuid: string | null = null): DrivePath {
	if (type === null) {
		return { type: null, uuid: null }
	}

	return { type, uuid }
}

function makePrefs(overrides: Partial<SortPreferences> = {}): SortPreferences {
	return { ...DEFAULT_SORT_PREFERENCES, ...overrides }
}

// ------------------------------------------------------------------
// isSortable
// ------------------------------------------------------------------

describe("isSortable", () => {
	it("returns false for null", () => {
		expect(isSortable(null)).toBe(false)
	})

	it("returns false for 'recents'", () => {
		expect(isSortable("recents")).toBe(false)
	})

	it("returns true for 'drive'", () => {
		expect(isSortable("drive")).toBe(true)
	})

	it("returns true for 'favorites'", () => {
		expect(isSortable("favorites")).toBe(true)
	})

	it("returns true for 'trash'", () => {
		expect(isSortable("trash")).toBe(true)
	})

	it("returns true for 'sharedIn'", () => {
		expect(isSortable("sharedIn")).toBe(true)
	})

	it("returns true for 'sharedOut'", () => {
		expect(isSortable("sharedOut")).toBe(true)
	})

	it("returns true for 'links'", () => {
		expect(isSortable("links")).toBe(true)
	})

	it("returns true for 'offline'", () => {
		expect(isSortable("offline")).toBe(true)
	})

	it("acts as a type-guard — value narrowed to DrivePathType when true", () => {
		// TypeScript compile-time check: if isSortable returns true, `type` must be DrivePathType
		const type: DrivePathType | null = "drive"

		if (isSortable(type)) {
			// If this compiles, narrowing works. The value must not be null.
			const narrowed: DrivePathType = type

			expect(narrowed).toBe("drive")
		} else {
			throw new Error("Expected isSortable('drive') to return true")
		}
	})
})

// ------------------------------------------------------------------
// getPerDirectoryKey
// ------------------------------------------------------------------

describe("getPerDirectoryKey", () => {
	it("concatenates type and uuid with ':' separator", () => {
		expect(getPerDirectoryKey(makePath("drive", "abc-123"))).toBe("drive:abc-123")
	})

	it("produces distinct keys for same uuid but different types", () => {
		const key1 = getPerDirectoryKey(makePath("drive", "abc-123"))
		const key2 = getPerDirectoryKey(makePath("trash", "abc-123"))

		expect(key1).not.toBe(key2)
	})

	it("produces distinct keys for same type but different uuids", () => {
		const key1 = getPerDirectoryKey(makePath("drive", "abc-123"))
		const key2 = getPerDirectoryKey(makePath("drive", "xyz-999"))

		expect(key1).not.toBe(key2)
	})

	it("handles null type: returns ':uuid'", () => {
		// DrivePath with type=null has uuid=null per the union, but we can still call
		// getPerDirectoryKey with a DrivePath whose type is null
		const path: DrivePath = { type: null, uuid: null }

		// The function coerces null to "" via template literal: `${null ?? ""}:${null ?? ""}`
		expect(getPerDirectoryKey(path)).toBe(":")
	})

	it("handles null uuid: returns 'type:'", () => {
		// trash always has uuid: null per useDrivePath
		expect(getPerDirectoryKey(makePath("trash", null))).toBe("trash:")
	})

	it("handles both null: returns ':'", () => {
		expect(getPerDirectoryKey({ type: null, uuid: null })).toBe(":")
	})

	it("key does not collide between type='drive:abc' uuid='' vs type='drive' uuid='abc'", () => {
		// This exploits the ':' separator: "drive:abc:" vs "drive:abc"
		// We can't pass type='drive:abc' since it's not a valid DrivePathType, but we
		// can verify the separator prevents collisions between valid keys with different splits
		const key1 = getPerDirectoryKey(makePath("drive", "abc:extra"))
		const key2 = getPerDirectoryKey(makePath("offline", "abc"))

		expect(key1).toBe("drive:abc:extra")
		expect(key2).toBe("offline:abc")
		expect(key1).not.toBe(key2)
	})
})

// ------------------------------------------------------------------
// resolveEffectiveSort
// ------------------------------------------------------------------

describe("resolveEffectiveSort", () => {
	it("returns 'uploadDateDesc' unconditionally when type is 'recents', regardless of prefs", () => {
		const prefs = makePrefs({ mode: "global", global: "nameAsc" })

		expect(resolveEffectiveSort(prefs, makePath("recents", null))).toBe("uploadDateDesc")
	})

	it("returns 'uploadDateDesc' for recents even when perDirectory has an entry", () => {
		const key = getPerDirectoryKey(makePath("recents", null))
		const prefs = makePrefs({
			mode: "perDirectory",
			perDirectory: { [key]: "sizeAsc" }
		})

		expect(resolveEffectiveSort(prefs, makePath("recents", null))).toBe("uploadDateDesc")
	})

	it("returns 'nameAsc' when type is null (non-sortable path)", () => {
		const prefs = makePrefs({ mode: "global", global: "sizeDesc" })

		expect(resolveEffectiveSort(prefs, { type: null, uuid: null })).toBe("nameAsc")
	})

	it("in global mode: returns prefs.global for any sortable type", () => {
		const prefs = makePrefs({ mode: "global", global: "sizeAsc" })

		expect(resolveEffectiveSort(prefs, makePath("drive", "some-uuid"))).toBe("sizeAsc")
		expect(resolveEffectiveSort(prefs, makePath("favorites", "some-uuid"))).toBe("sizeAsc")
		expect(resolveEffectiveSort(prefs, makePath("trash", null))).toBe("sizeAsc")
	})

	it("in global mode: ignores perDirectory entry and returns prefs.global", () => {
		const key = getPerDirectoryKey(makePath("drive", "some-uuid"))
		const prefs = makePrefs({
			mode: "global",
			global: "lastModifiedDesc",
			perDirectory: { [key]: "mimeAsc" }
		})

		expect(resolveEffectiveSort(prefs, makePath("drive", "some-uuid"))).toBe("lastModifiedDesc")
	})

	it("in perDirectory mode: returns the stored value when an entry exists for the path", () => {
		const path = makePath("drive", "dir-uuid-1")
		const key = getPerDirectoryKey(path)
		const prefs = makePrefs({
			mode: "perDirectory",
			perDirectory: { [key]: "lastModifiedAsc" }
		})

		expect(resolveEffectiveSort(prefs, path)).toBe("lastModifiedAsc")
	})

	it("in perDirectory mode: returns 'nameAsc' as fallback when no entry exists (NOT prefs.global)", () => {
		const prefs = makePrefs({
			mode: "perDirectory",
			global: "sizeDesc",
			perDirectory: {}
		})

		// prefs.global is 'sizeDesc', but perDirectory fallback must be 'nameAsc'
		expect(resolveEffectiveSort(prefs, makePath("drive", "missing-uuid"))).toBe("nameAsc")
	})

	it("recents short-circuit fires before isSortable check", () => {
		// 'recents' returns uploadDateDesc — the isSortable guard would also return false
		// for 'recents', but the recents check must run first (returning uploadDateDesc, not
		// the nameAsc that the isSortable fallback would produce)
		const prefs = makePrefs({ mode: "global", global: "nameAsc" })
		const result = resolveEffectiveSort(prefs, makePath("recents", null))

		expect(result).toBe("uploadDateDesc")
		// If the order were wrong, result would be 'nameAsc' (isSortable path) — distinct enough
		expect(result).not.toBe("nameAsc")
	})

	it("returns correct sort after simulating setSort perDirectory update", () => {
		const path = makePath("drive", "dir-for-update")
		const key = getPerDirectoryKey(path)

		const initialPrefs = makePrefs({ mode: "perDirectory", perDirectory: {} })

		// Simulate what setSort does: update the perDirectory map
		const updatedPrefs: SortPreferences = {
			...initialPrefs,
			perDirectory: {
				...initialPrefs.perDirectory,
				[key]: "creationDesc"
			}
		}

		expect(resolveEffectiveSort(initialPrefs, path)).toBe("nameAsc")
		expect(resolveEffectiveSort(updatedPrefs, path)).toBe("creationDesc")
	})
})

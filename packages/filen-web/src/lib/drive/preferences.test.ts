import { beforeEach, describe, expect, it, vi } from "vitest"
import { type } from "arktype"

// Mock boundary is `@/lib/storage/adapter` itself — preferences.ts's only two calls into storage —
// mirroring @/lib/keymap/registry.test.ts: kvGetJson/kvSetJson's own envelope+schema contract is
// already covered by adapter.test.ts, not re-tested through this mock. This module holds no
// module-level singleton state (unlike the keymap registry), so a plain top-level import + a
// per-test Map reset is enough — no vi.resetModules() dance needed.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))

import {
	DEFAULT_SORT_PREFERENCES,
	DEFAULT_VIEW_MODE_PREFERENCES,
	getPerDirectoryKey,
	getSortPreferences,
	getViewModePreferences,
	isSortableVariant,
	resolveEffectiveSort,
	resolveEffectiveViewMode,
	setSortPreferences,
	setViewModePreferences,
	sortPreferencesSchema,
	viewModePreferencesSchema,
	withSortSelection,
	withViewModeSelection,
	type DriveLocation,
	type DrivePreferences,
	type DriveViewMode
} from "@/lib/drive/preferences"
import { type DriveSortBy } from "@/lib/drive/sort"

function location(variant: DriveLocation["variant"], uuid: string | null = null): DriveLocation {
	return { variant, uuid }
}

beforeEach(() => {
	kvStore.clear()
})

describe("isSortableVariant", () => {
	it("is false only for recents", () => {
		expect(isSortableVariant("recents")).toBe(false)
		expect(isSortableVariant("drive")).toBe(true)
		expect(isSortableVariant("favorites")).toBe(true)
		expect(isSortableVariant("trash")).toBe(true)
	})
})

describe("getPerDirectoryKey", () => {
	it("joins variant and uuid with ':'", () => {
		expect(getPerDirectoryKey(location("drive", "abc-123"))).toBe("drive:abc-123")
	})

	it("uses an empty string for a null uuid", () => {
		expect(getPerDirectoryKey(location("trash", null))).toBe("trash:")
	})

	it("produces distinct keys for the same uuid under different variants", () => {
		expect(getPerDirectoryKey(location("drive", "abc"))).not.toBe(getPerDirectoryKey(location("favorites", "abc")))
	})

	it("produces distinct keys for different uuids under the same variant", () => {
		expect(getPerDirectoryKey(location("drive", "abc"))).not.toBe(getPerDirectoryKey(location("drive", "xyz")))
	})
})

describe("sort preferences: get/set", () => {
	it("returns the default when nothing is persisted", async () => {
		await expect(getSortPreferences()).resolves.toEqual(DEFAULT_SORT_PREFERENCES)
	})

	it("roundtrips a stored value through set/get", async () => {
		const stored: DrivePreferences<DriveSortBy> = { mode: "perDirectory", global: "sizeDesc", perDirectory: { "drive:abc": "typeAsc" } }

		await setSortPreferences(stored)

		await expect(getSortPreferences()).resolves.toEqual(stored)
	})

	it("self-heals to the default when the persisted value is missing/invalid (kvGetJson already collapses both to null)", async () => {
		// adapter.test.ts covers kvGetJson's own schema-rejection behavior; this only checks that
		// THIS module falls back to its default on the null it would receive either way.
		await expect(getSortPreferences()).resolves.toEqual(DEFAULT_SORT_PREFERENCES)
	})
})

describe("sortPreferencesSchema", () => {
	it("accepts a well-formed value", () => {
		const result = sortPreferencesSchema({ mode: "global", global: "nameAsc", perDirectory: {} })

		expect(result).not.toBeInstanceOf(type.errors)
	})

	it("accepts a populated perDirectory map", () => {
		const result = sortPreferencesSchema({ mode: "perDirectory", global: "nameAsc", perDirectory: { "drive:abc": "sizeDesc" } })

		expect(result).not.toBeInstanceOf(type.errors)
	})

	it("rejects an unknown sort-by literal in global", () => {
		expect(sortPreferencesSchema({ mode: "global", global: "bogus", perDirectory: {} })).toBeInstanceOf(type.errors)
	})

	it("rejects an unknown sort-by literal inside perDirectory", () => {
		expect(sortPreferencesSchema({ mode: "global", global: "nameAsc", perDirectory: { "drive:abc": "bogus" } })).toBeInstanceOf(
			type.errors
		)
	})

	it("rejects an unknown mode", () => {
		expect(sortPreferencesSchema({ mode: "sideways", global: "nameAsc", perDirectory: {} })).toBeInstanceOf(type.errors)
	})

	it("rejects a non-object value", () => {
		expect(sortPreferencesSchema("nope")).toBeInstanceOf(type.errors)
		expect(sortPreferencesSchema(null)).toBeInstanceOf(type.errors)
	})
})

describe("resolveEffectiveSort", () => {
	it("returns uploadDateDesc for recents unconditionally, even with a global override", () => {
		const prefs: DrivePreferences<DriveSortBy> = { mode: "global", global: "nameAsc", perDirectory: {} }

		expect(resolveEffectiveSort(prefs, location("recents"))).toBe("uploadDateDesc")
	})

	it("returns uploadDateDesc for recents even when a perDirectory entry exists for it", () => {
		const key = getPerDirectoryKey(location("recents"))
		const prefs: DrivePreferences<DriveSortBy> = { mode: "perDirectory", global: "nameAsc", perDirectory: { [key]: "sizeAsc" } }

		expect(resolveEffectiveSort(prefs, location("recents"))).toBe("uploadDateDesc")
	})

	it("global mode returns prefs.global for any sortable variant", () => {
		const prefs: DrivePreferences<DriveSortBy> = { mode: "global", global: "sizeAsc", perDirectory: {} }

		expect(resolveEffectiveSort(prefs, location("drive", "some-uuid"))).toBe("sizeAsc")
		expect(resolveEffectiveSort(prefs, location("favorites"))).toBe("sizeAsc")
		expect(resolveEffectiveSort(prefs, location("trash"))).toBe("sizeAsc")
	})

	it("global mode ignores a matching perDirectory entry", () => {
		const key = getPerDirectoryKey(location("drive", "some-uuid"))
		const prefs: DrivePreferences<DriveSortBy> = { mode: "global", global: "lastModifiedDesc", perDirectory: { [key]: "typeAsc" } }

		expect(resolveEffectiveSort(prefs, location("drive", "some-uuid"))).toBe("lastModifiedDesc")
	})

	it("perDirectory mode returns the stored value for that directory", () => {
		const loc = location("drive", "dir-1")
		const prefs: DrivePreferences<DriveSortBy> = {
			mode: "perDirectory",
			global: "sizeDesc",
			perDirectory: { [getPerDirectoryKey(loc)]: "lastModifiedAsc" }
		}

		expect(resolveEffectiveSort(prefs, loc)).toBe("lastModifiedAsc")
	})

	it("perDirectory mode falls back to nameAsc (not prefs.global) when no entry exists for the directory", () => {
		const prefs: DrivePreferences<DriveSortBy> = { mode: "perDirectory", global: "sizeDesc", perDirectory: {} }

		expect(resolveEffectiveSort(prefs, location("drive", "missing-uuid"))).toBe("nameAsc")
	})
})

describe("withSortSelection", () => {
	it("updates global in global mode", () => {
		const prefs: DrivePreferences<DriveSortBy> = { mode: "global", global: "nameAsc", perDirectory: {} }
		const next = withSortSelection(prefs, location("drive", "any"), "sizeDesc")

		expect(next).toEqual({ mode: "global", global: "sizeDesc", perDirectory: {} })
	})

	it("updates only the target key in perDirectory mode, leaving other entries untouched", () => {
		const key = getPerDirectoryKey(location("drive", "dir-1"))
		const otherKey = getPerDirectoryKey(location("drive", "dir-2"))
		const prefs: DrivePreferences<DriveSortBy> = { mode: "perDirectory", global: "nameAsc", perDirectory: { [otherKey]: "sizeAsc" } }
		const next = withSortSelection(prefs, location("drive", "dir-1"), "typeDesc")

		expect(next.perDirectory).toEqual({ [otherKey]: "sizeAsc", [key]: "typeDesc" })
	})

	it("is a no-op for recents", () => {
		const prefs: DrivePreferences<DriveSortBy> = { mode: "global", global: "nameAsc", perDirectory: {} }

		expect(withSortSelection(prefs, location("recents"), "sizeDesc")).toBe(prefs)
	})
})

describe("view-mode preferences: get/set", () => {
	it("returns the default when nothing is persisted", async () => {
		await expect(getViewModePreferences()).resolves.toEqual(DEFAULT_VIEW_MODE_PREFERENCES)
	})

	it("roundtrips a stored value through set/get", async () => {
		const stored: DrivePreferences<DriveViewMode> = { mode: "perDirectory", global: "grid", perDirectory: { "drive:abc": "list" } }

		await setViewModePreferences(stored)

		await expect(getViewModePreferences()).resolves.toEqual(stored)
	})
})

describe("viewModePreferencesSchema", () => {
	it("accepts a well-formed value", () => {
		expect(viewModePreferencesSchema({ mode: "global", global: "list", perDirectory: {} })).not.toBeInstanceOf(type.errors)
	})

	it("rejects an unknown view-mode literal", () => {
		expect(viewModePreferencesSchema({ mode: "global", global: "table", perDirectory: {} })).toBeInstanceOf(type.errors)
	})

	it("rejects a non-object value", () => {
		expect(viewModePreferencesSchema(42)).toBeInstanceOf(type.errors)
	})
})

describe("resolveEffectiveViewMode", () => {
	it("global mode returns the global value regardless of directory", () => {
		const prefs: DrivePreferences<DriveViewMode> = { mode: "global", global: "grid", perDirectory: { "drive:abc": "list" } }

		expect(resolveEffectiveViewMode(prefs, location("drive", "abc"))).toBe("grid")
	})

	it("perDirectory mode returns the per-directory value when present", () => {
		const prefs: DrivePreferences<DriveViewMode> = { mode: "perDirectory", global: "list", perDirectory: { "drive:abc": "grid" } }

		expect(resolveEffectiveViewMode(prefs, location("drive", "abc"))).toBe("grid")
	})

	it("perDirectory mode falls back to prefs.global (not a hardcoded default) when absent", () => {
		const prefs: DrivePreferences<DriveViewMode> = { mode: "perDirectory", global: "grid", perDirectory: {} }

		expect(resolveEffectiveViewMode(prefs, location("drive", "xyz"))).toBe("grid")
	})

	it("applies uniformly to recents — no read-only carve-out like sort", () => {
		const prefs: DrivePreferences<DriveViewMode> = { mode: "perDirectory", global: "list", perDirectory: { "recents:": "grid" } }

		expect(resolveEffectiveViewMode(prefs, location("recents"))).toBe("grid")
	})
})

describe("withViewModeSelection", () => {
	it("updates global in global mode", () => {
		const prefs: DrivePreferences<DriveViewMode> = { mode: "global", global: "list", perDirectory: {} }

		expect(withViewModeSelection(prefs, location("drive", "any"), "grid")).toEqual({ mode: "global", global: "grid", perDirectory: {} })
	})

	it("updates only the target key in perDirectory mode", () => {
		const prefs: DrivePreferences<DriveViewMode> = { mode: "perDirectory", global: "list", perDirectory: { "drive:other": "grid" } }
		const next = withViewModeSelection(prefs, location("drive", "dir-1"), "grid")

		expect(next.perDirectory).toEqual({ "drive:other": "grid", "drive:dir-1": "grid" })
	})

	it("has no recents carve-out — a selection while viewing recents persists normally", () => {
		const prefs: DrivePreferences<DriveViewMode> = { mode: "global", global: "list", perDirectory: {} }

		expect(withViewModeSelection(prefs, location("recents"), "grid")).toEqual({ mode: "global", global: "grid", perDirectory: {} })
	})
})

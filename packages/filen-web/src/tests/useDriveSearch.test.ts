import { describe, expect, it } from "vitest"
import { buildSearchResults, resolveSearchTransition, searchHitNavigationTarget } from "@/features/drive/hooks/useDriveSearch.logic"
import { testUuid } from "@/tests/support/uuid"
import { mockDir, mockFile } from "@/tests/fixtures/sdk"

describe("resolveSearchTransition", () => {
	it("stays idle for a blank query before the engine has ever been engaged", () => {
		expect(resolveSearchTransition(false, false)).toBe("idle")
	})

	it("opens on the first non-empty input, when never engaged before", () => {
		expect(resolveSearchTransition(false, true)).toBe("open")
	})

	it("stays idle once the input empties back out — never closes an engaged engine on blank", () => {
		expect(resolveSearchTransition(true, false)).toBe("idle")
	})

	it("retunes on a further change while already active and engaged", () => {
		expect(resolveSearchTransition(true, true)).toBe("retune")
	})
})

describe("buildSearchResults", () => {
	it("returns empty items and an empty map for no hits", () => {
		expect(buildSearchResults([])).toEqual({ items: [], parentPaths: new Map() })
	})

	it("narrows a directory hit's item through the same mapper the listing query uses", () => {
		const dir = mockDir({ uuid: testUuid("hit-dir") })
		const { items } = buildSearchResults([{ parentPath: "Projects", item: dir }])

		expect(items).toEqual([
			{ type: "directory", data: { ...dir, size: 0n, undecryptable: false, decryptedMeta: { name: "Documents" } } }
		])
	})

	it("narrows a file hit the same way", () => {
		const file = mockFile({ uuid: testUuid("hit-file") })
		const { items } = buildSearchResults([{ parentPath: "", item: file }])

		expect(items[0]?.type).toBe("file")
		expect(items[0]?.data.uuid).toBe(file.uuid)
	})

	it("preserves the SDK-delivered hit order (no re-sort)", () => {
		const first = mockDir({ uuid: testUuid("a") })
		const second = mockFile({ uuid: testUuid("b") })
		const { items } = buildSearchResults([
			{ parentPath: "", item: second },
			{ parentPath: "", item: first }
		])

		expect(items.map(item => item.data.uuid)).toEqual([second.uuid, first.uuid])
	})

	it("keys the parentPath map by the narrowed item's own uuid, one entry per hit", () => {
		const dir = mockDir({ uuid: testUuid("nested-dir") })
		const file = mockFile({ uuid: testUuid("nested-file") })
		const { parentPaths } = buildSearchResults([
			{ parentPath: "Projects/2024", item: dir },
			{ parentPath: "", item: file }
		])

		expect(parentPaths.get(dir.uuid)).toBe("Projects/2024")
		expect(parentPaths.get(file.uuid)).toBe("")
		expect(parentPaths.size).toBe(2)
	})
})

describe("searchHitNavigationTarget", () => {
	it("lands a directory hit at a fresh, single-segment splat equal to its own uuid", () => {
		const dir = {
			type: "directory" as const,
			data: { ...mockDir({ uuid: testUuid("hit") }), size: 0n, undecryptable: false, decryptedMeta: null }
		}

		expect(searchHitNavigationTarget(dir, "drive")).toEqual({ to: "/drive/$", params: { _splat: testUuid("hit") } })
	})

	it("never appends to any current position — only the hit's own uuid ever appears in the splat", () => {
		// searchHitNavigationTarget takes no "current splat" input at all, unlike the in-place
		// resolveDriveNavigationTarget it wraps — this pins that a search-driven open is always
		// root-relative, never nested under wherever the toolbar happened to be when the hit was found.
		const dir = {
			type: "directory" as const,
			data: { ...mockDir({ uuid: testUuid("root-child") }), size: 0n, undecryptable: false, decryptedMeta: null }
		}
		const target = searchHitNavigationTarget(dir, "drive")

		expect(target?.params._splat).toBe(testUuid("root-child"))
		expect(target?.params._splat.includes("/")).toBe(false)
	})

	it("returns null for a file hit — files open a preview, never a navigation", () => {
		const file = {
			type: "file" as const,
			data: { ...mockFile({ uuid: testUuid("hit-file") }), size: 1_024n, undecryptable: false, decryptedMeta: null }
		}

		expect(searchHitNavigationTarget(file, "drive")).toBeNull()
	})

	it("returns null in the trash variant, mirroring resolveDriveNavigationTarget's own rule", () => {
		const dir = {
			type: "directory" as const,
			data: { ...mockDir({ uuid: testUuid("trashed") }), size: 0n, undecryptable: false, decryptedMeta: null }
		}

		expect(searchHitNavigationTarget(dir, "trash")).toBeNull()
	})
})

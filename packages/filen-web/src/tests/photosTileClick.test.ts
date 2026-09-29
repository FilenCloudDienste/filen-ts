import { describe, expect, it } from "vitest"
import type { File } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { type ClickModifiers } from "@/features/drive/lib/listbox"
import { resolveTileClickIntent, previewOpenTarget, photosRangeSelection } from "@/features/photos/components/photoGrid.logic"
import { testUuid } from "@/tests/support/uuid"

function photoItem(uuid: string): PhotoItem {
	const item = narrowItem({
		uuid: testUuid(uuid),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: { type: "decoded", data: { name: `${uuid}.jpg`, mime: "image/jpeg", modified: 1n, size: 1n, key: "k", version: 2 } }
	} satisfies File)

	if (item.type !== "file") {
		throw new Error("test fixture narrowed to a non-file arm")
	}

	return item
}

function modifiers(overrides: Partial<ClickModifiers> = {}): ClickModifiers {
	return { shiftKey: false, metaKey: false, ctrlKey: false, ...overrides }
}

describe("resolveTileClickIntent", () => {
	it("opens on a plain click when nothing is selected", () => {
		expect(resolveTileClickIntent(modifiers(), false)).toEqual({ kind: "open" })
	})

	it("selects (never opens) on a plain click once a selection is already active", () => {
		expect(resolveTileClickIntent(modifiers(), true)).toEqual({ kind: "select" })
	})

	it("always selects on a shift-click, selection empty or not", () => {
		expect(resolveTileClickIntent(modifiers({ shiftKey: true }), false)).toEqual({ kind: "select" })
		expect(resolveTileClickIntent(modifiers({ shiftKey: true }), true)).toEqual({ kind: "select" })
	})

	it("always selects on a ctrl/cmd-click, selection empty or not", () => {
		expect(resolveTileClickIntent(modifiers({ ctrlKey: true }), false)).toEqual({ kind: "select" })
		expect(resolveTileClickIntent(modifiers({ metaKey: true }), true)).toEqual({ kind: "select" })
	})
})

describe("previewOpenTarget", () => {
	const a = photoItem("a")
	const b = photoItem("b")
	const c = photoItem("c")
	const items = [a, b, c]

	it("hands the WHOLE current items array over as the pager's list, at the clicked index", () => {
		const target = previewOpenTarget(items, 1)

		expect(target).not.toBeNull()
		expect(target?.index).toBe(1)
		expect(target?.sources).toBe(items)
	})

	it("opens at index 0 for the first tile", () => {
		expect(previewOpenTarget(items, 0)?.index).toBe(0)
	})

	it("opens at the last index for the last tile", () => {
		expect(previewOpenTarget(items, 2)?.index).toBe(2)
	})

	it("returns null for a negative index", () => {
		expect(previewOpenTarget(items, -1)).toBeNull()
	})

	it("returns null for an out-of-range index (a stale click past a shrunk list)", () => {
		expect(previewOpenTarget(items, 3)).toBeNull()
	})

	it("returns null against an empty list", () => {
		expect(previewOpenTarget([], 0)).toBeNull()
	})
})

describe("photosRangeSelection", () => {
	const items = [photoItem("a"), photoItem("b"), photoItem("c"), photoItem("d")]

	function uuidsOf(selected: PhotoItem[]): string[] {
		return selected.map(item => item.data.uuid)
	}

	it("covers a forward range from the anchor, inclusive", () => {
		expect(uuidsOf(photosRangeSelection(items, testUuid("a"), 2))).toEqual([testUuid("a"), testUuid("b"), testUuid("c")])
	})

	it("covers a backward range when the anchor sits after the index", () => {
		expect(uuidsOf(photosRangeSelection(items, testUuid("d"), 1))).toEqual([testUuid("b"), testUuid("c"), testUuid("d")])
	})

	it("selects just the target when there is no live anchor", () => {
		expect(uuidsOf(photosRangeSelection(items, null, 2))).toEqual([testUuid("c")])
	})

	it("selects just the target when the anchor uuid is no longer in items", () => {
		expect(uuidsOf(photosRangeSelection(items, testUuid("gone"), 1))).toEqual([testUuid("b")])
	})
})

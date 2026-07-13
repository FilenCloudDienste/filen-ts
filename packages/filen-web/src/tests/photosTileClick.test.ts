import { describe, expect, it } from "vitest"
import type { File, UuidStr } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { resolveTileClickIntent, previewOpenTarget, type ClickModifiers } from "@/features/photos/components/photoGrid.logic"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function photoItem(uuid: string): PhotoItem {
	const item = narrowItem({
		uuid: testUuid(uuid),
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

	it("wraps the WHOLE current items array as the pager's source list, at the clicked index", () => {
		const target = previewOpenTarget(items, 1)

		expect(target).not.toBeNull()
		expect(target?.index).toBe(1)
		expect(target?.sources).toEqual([
			{ type: "drive", item: a },
			{ type: "drive", item: b },
			{ type: "drive", item: c }
		])
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

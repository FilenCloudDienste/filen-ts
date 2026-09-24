import { describe, expect, it, vi } from "vitest"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import {
	assembleDragPayload,
	canDragVariant,
	dragDropMode,
	isSameParentTarget,
	isValidCopyTarget,
	isValidMoveTarget
} from "@/features/drive/lib/dnd.logic"

// UuidStr is a template-literal brand requiring at least 3 dashes (mirrors moveTargetDialog.test.ts) —
// a padded label doubles as both an item's `data.uuid` and a matching ancestry entry.
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

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid("file"),
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
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

function dirItem(uuid: string, parent: string): DriveItem {
	return narrowItem(mockDir({ uuid: testUuid(uuid), parent: testUuid(parent) }))
}

function fileItem(uuid: string, parent: string): DriveItem {
	return narrowItem(mockFile({ uuid: testUuid(uuid), parent: testUuid(parent) }))
}

const ROOT = testUuid("root")

describe("canDragVariant", () => {
	it("permits only the drive variant", () => {
		expect(canDragVariant("drive")).toBe(true)
	})

	it("rejects recents/favorites/trash/shared — no owned tree to drop into", () => {
		for (const variant of ["recents", "favorites", "trash", "sharedIn", "sharedOut", "links"] as const) {
			expect(canDragVariant(variant)).toBe(false)
		}
	})
})

describe("assembleDragPayload", () => {
	it("dragging a SELECTED item drags the whole selection (same references)", () => {
		const a = fileItem("a", "parent")
		const b = fileItem("b", "parent")
		const selection = [a, b]
		const selectedUuids = new Set(selection.map(item => item.data.uuid))

		const payload = assembleDragPayload(a, selectedUuids, selection)

		expect(payload).toBe(selection)
	})

	it("dragging an UNSELECTED item drags just it", () => {
		const a = fileItem("a", "parent")
		const b = fileItem("b", "parent")
		const selection = [b]
		const selectedUuids = new Set(selection.map(item => item.data.uuid))

		const payload = assembleDragPayload(a, selectedUuids, selection)

		expect(payload).toHaveLength(1)
		expect(payload[0]).toBe(a)
	})

	it("empty selection drags the single item", () => {
		const a = fileItem("a", "parent")

		expect(assembleDragPayload(a, new Set(), [])).toEqual([a])
	})
})

describe("isSameParentTarget", () => {
	it("true when every payload item already sits in the target directory", () => {
		const payload = [fileItem("a", "home"), fileItem("b", "home")]

		expect(isSameParentTarget(testUuid("home"), payload, ROOT)).toBe(true)
	})

	it("false when any payload item has a different parent", () => {
		const payload = [fileItem("a", "home"), fileItem("b", "other")]

		expect(isSameParentTarget(testUuid("home"), payload, ROOT)).toBe(false)
	})

	it("normalizes the null root target against a root-level item's parent (no-op)", () => {
		const payload = [fileItem("a", "root")]

		expect(isSameParentTarget(null, payload, ROOT)).toBe(true)
	})

	it("an empty payload is never a same-parent no-op", () => {
		expect(isSameParentTarget(testUuid("home"), [], ROOT)).toBe(false)
	})
})

describe("isValidMoveTarget", () => {
	it("permits moving a file into a sibling directory", () => {
		const payload = [fileItem("a", "home")]

		expect(
			isValidMoveTarget({
				targetUuid: testUuid("sub"),
				targetAncestry: [testUuid("home"), testUuid("sub")],
				payload,
				rootUuid: ROOT
			})
		).toBe(true)
	})

	it("rejects an empty payload", () => {
		expect(isValidMoveTarget({ targetUuid: testUuid("sub"), targetAncestry: [testUuid("sub")], payload: [], rootUuid: ROOT })).toBe(
			false
		)
	})

	it("rejects dropping a directory onto itself (self)", () => {
		const payload = [dirItem("a", "home")]

		expect(
			isValidMoveTarget({
				targetUuid: testUuid("a"),
				targetAncestry: [testUuid("home"), testUuid("a")],
				payload,
				rootUuid: ROOT
			})
		).toBe(false)
	})

	it("rejects dropping a directory into its own descendant", () => {
		const payload = [dirItem("a", "home")]

		expect(
			isValidMoveTarget({
				targetUuid: testUuid("deep"),
				targetAncestry: [testUuid("home"), testUuid("a"), testUuid("deep")],
				payload,
				rootUuid: ROOT
			})
		).toBe(false)
	})

	it("rejects a no-op onto the payload's current parent", () => {
		const payload = [fileItem("a", "home"), fileItem("b", "home")]

		expect(
			isValidMoveTarget({
				targetUuid: testUuid("home"),
				targetAncestry: [testUuid("home")],
				payload,
				rootUuid: ROOT
			})
		).toBe(false)
	})

	it("permits a valid drop onto the root even while a moved directory is present", () => {
		const payload = [dirItem("a", "home")]

		expect(isValidMoveTarget({ targetUuid: null, targetAncestry: [], payload, rootUuid: ROOT })).toBe(true)
	})
})

describe("dragDropMode", () => {
	it("copies with Option on macOS, and Ctrl held there still moves", () => {
		expect(dragDropMode({ altKey: true, ctrlKey: false }, true)).toBe("copy")
		expect(dragDropMode({ altKey: false, ctrlKey: true }, true)).toBe("move")
		expect(dragDropMode({ altKey: false, ctrlKey: false }, true)).toBe("move")
	})

	it("copies with Ctrl on Windows and Linux, and Alt held there still moves", () => {
		expect(dragDropMode({ altKey: false, ctrlKey: true }, false)).toBe("copy")
		expect(dragDropMode({ altKey: true, ctrlKey: false }, false)).toBe("move")
	})
})

describe("isValidCopyTarget", () => {
	it("accepts the payload's own parent, which a move refuses", () => {
		const payload = [fileItem("a", "home")]

		expect(isValidCopyTarget({ targetUuid: testUuid("home"), targetAncestry: [testUuid("home")], payload })).toBe(true)
		expect(isValidMoveTarget({ targetUuid: testUuid("home"), targetAncestry: [testUuid("home")], payload, rootUuid: ROOT })).toBe(false)
	})

	it("refuses an empty payload and a copied directory as its own destination or below it", () => {
		const payload = [dirItem("a", "home")]

		expect(isValidCopyTarget({ targetUuid: testUuid("home"), targetAncestry: [testUuid("home")], payload: [] })).toBe(false)
		expect(isValidCopyTarget({ targetUuid: testUuid("a"), targetAncestry: [testUuid("home"), testUuid("a")], payload })).toBe(false)
		expect(
			isValidCopyTarget({
				targetUuid: testUuid("inner"),
				targetAncestry: [testUuid("home"), testUuid("a"), testUuid("inner")],
				payload
			})
		).toBe(false)
	})
})

// Search results list hits from anywhere below the search root, and a hit's route chain is the search
// root's plus the hit: the directories between the two are missing from it.
describe("drops onto a search hit below the search root's children", () => {
	// search root > a > b > hit, with `a` and `hit` both among the results.
	const parents = new Map<string, string | null>([
		[testUuid("hit"), testUuid("b")],
		[testUuid("b"), testUuid("a")],
		[testUuid("a"), null]
	])
	const readParents = () => (uuid: string) => parents.get(uuid)
	const hitTarget = { targetUuid: testUuid("hit"), targetAncestry: [testUuid("hit")], rootUuid: ROOT }

	it("refuses a directory the walk finds above the hit, for a move and a copy", () => {
		const payload = [dirItem("a", "root")]

		expect(isValidMoveTarget({ ...hitTarget, payload, readParents })).toBe(false)
		expect(isValidCopyTarget({ ...hitTarget, payload, readParents })).toBe(false)
	})

	it("refuses a directory where the walk can't reach the search root", () => {
		const payload = [dirItem("elsewhere", "root")]

		expect(isValidMoveTarget({ ...hitTarget, payload, readParents: () => () => undefined })).toBe(false)
	})

	it("takes a directory the walk proves is not above the hit, and any file", () => {
		expect(isValidMoveTarget({ ...hitTarget, payload: [dirItem("elsewhere", "root")], readParents })).toBe(true)
		expect(isValidCopyTarget({ ...hitTarget, payload: [fileItem("f", "root")], readParents: () => () => undefined })).toBe(true)
	})

	// Every dragover asks, and reading the parents scans every cached listing.
	it("reads the parents only while the payload holds a directory", () => {
		const reader = vi.fn(readParents)
		const files = [fileItem("f", "root")]

		expect(isValidMoveTarget({ ...hitTarget, payload: files, readParents: reader })).toBe(true)
		expect(isValidCopyTarget({ ...hitTarget, payload: files, readParents: reader })).toBe(true)
		expect(reader).not.toHaveBeenCalled()

		expect(isValidMoveTarget({ ...hitTarget, payload: [dirItem("elsewhere", "root")], readParents: reader })).toBe(true)
		expect(reader).toHaveBeenCalledOnce()
	})
})

import { describe, expect, it } from "vitest"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/lib/drive/item"
import {
	isMoveConfirmDisabled,
	isMoveDestinationForbidden,
	isMoveNoOp,
	isMoveRowDisabled
} from "@/components/drive/move-target-dialog.logic"

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a short
// readable test label into a shape that satisfies it, mirroring actions.test.ts's own fixture. The
// picker's own ancestry chains are plain `string[]` (no brand), so a padded label doubles as both a
// fixture's `data.uuid` and a matching ancestry entry with no further conversion.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// Local fixtures mirror item-menu.test.ts's own per-file convention (each test file owns its minimal
// Dir/File shape rather than sharing one across files).
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

function dirItem(uuid: string, overrides: Partial<Dir> = {}): DriveItem {
	return narrowItem(mockDir({ uuid: testUuid(uuid), ...overrides }))
}

function fileItem(uuid: string, overrides: Partial<File> = {}): DriveItem {
	return narrowItem(mockFile({ uuid: testUuid(uuid), ...overrides }))
}

describe("isMoveDestinationForbidden", () => {
	it("root (empty ancestry) is never forbidden, even with moved items present", () => {
		const moved = dirItem("a")
		expect(isMoveDestinationForbidden([], [moved])).toBe(false)
	})

	it("forbids the moved directory itself as a target (self)", () => {
		const moved = dirItem("a")
		expect(isMoveDestinationForbidden([testUuid("a")], [moved])).toBe(true)
	})

	it("forbids a descendant of the moved directory, even several levels deep", () => {
		const moved = dirItem("a")
		expect(isMoveDestinationForbidden([testUuid("a"), testUuid("child"), testUuid("grandchild")], [moved])).toBe(true)
	})

	it("allows an unrelated directory not in the moved subtree", () => {
		const moved = dirItem("a")
		expect(isMoveDestinationForbidden([testUuid("other"), testUuid("unrelated")], [moved])).toBe(false)
	})

	it("a moved FILE never forbids navigation (files have no subtree, and can't be a stack entry)", () => {
		const moved = fileItem("f")
		expect(isMoveDestinationForbidden([testUuid("f")], [moved])).toBe(false)
	})

	it("checks every moved item, not just the first", () => {
		const movedA = dirItem("a")
		const movedB = dirItem("b")
		expect(isMoveDestinationForbidden([testUuid("unrelated"), testUuid("b")], [movedA, movedB])).toBe(true)
	})
})

describe("isMoveNoOp", () => {
	it("is false for an empty selection", () => {
		expect(isMoveNoOp([], [dirItem("a")])).toBe(false)
	})

	it("is true when every moved item is already listed in the target", () => {
		const moved = dirItem("a")
		expect(isMoveNoOp([moved], [moved, dirItem("sibling")])).toBe(true)
	})

	it("is false when the target listing is empty", () => {
		const moved = dirItem("a")
		expect(isMoveNoOp([moved], [])).toBe(false)
	})

	it("is false when only some moved items are already in the target (partial overlap)", () => {
		const movedA = dirItem("a")
		const movedB = dirItem("b")
		expect(isMoveNoOp([movedA, movedB], [movedA])).toBe(false)
	})

	it("is true only when ALL moved items are present, for a multi-item selection", () => {
		const movedA = dirItem("a")
		const movedB = fileItem("b")
		expect(isMoveNoOp([movedA, movedB], [movedA, movedB, dirItem("other")])).toBe(true)
	})
})

describe("isMoveRowDisabled", () => {
	it("disables an undecryptable row regardless of ancestry", () => {
		const undecryptable = narrowItem({ ...mockDir({ uuid: testUuid("x") }), meta: { type: "encrypted", data: "cipher" } })
		expect(isMoveRowDisabled(undecryptable, [], [])).toBe(true)
	})

	it("disables the row matching a moved directory itself", () => {
		const moved = dirItem("a")
		const row = dirItem("a")
		expect(isMoveRowDisabled(row, [], [moved])).toBe(true)
	})

	it("disables a row nested inside the moved directory's current ancestry", () => {
		const moved = dirItem("a")
		const row = dirItem("child")
		expect(isMoveRowDisabled(row, [testUuid("a")], [moved])).toBe(true)
	})

	it("allows a decryptable, unrelated row", () => {
		const moved = dirItem("a")
		const row = dirItem("unrelated")
		expect(isMoveRowDisabled(row, [], [moved])).toBe(false)
	})
})

describe("isMoveConfirmDisabled", () => {
	it("disabled when the current target is forbidden (self)", () => {
		const moved = dirItem("a")
		expect(isMoveConfirmDisabled([testUuid("a")], [moved], [])).toBe(true)
	})

	it("disabled when the current target would be a no-op, even though it's not forbidden", () => {
		const moved = dirItem("a")
		expect(isMoveConfirmDisabled([testUuid("target")], [moved], [moved])).toBe(true)
	})

	it("enabled for a legal, non-no-op target", () => {
		const moved = dirItem("a")
		expect(isMoveConfirmDisabled([testUuid("target")], [moved], [dirItem("sibling")])).toBe(false)
	})

	it("enabled at the root when nothing moved lives there yet", () => {
		const moved = dirItem("a")
		expect(isMoveConfirmDisabled([], [moved], [])).toBe(false)
	})
})

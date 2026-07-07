import { describe, expect, it } from "vitest"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/lib/drive/item"
import { type DriveVariant } from "@/lib/drive/preferences"
import { resolveDriveNavigationTarget, splatToUuids } from "@/lib/drive/navigate"

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a short
// readable test label into a shape that satisfies it, mirroring sort.test.ts's own uuid fixtures.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// Built through the real narrowItem (item.test.ts covers its own correctness) rather than
// hand-rolled DriveItem literals, so this fixture can't silently drift from the actual narrowed
// shape (e.g. a hand-rolled literal omitting `meta`, which Dir/File both require).
function directoryItem(uuid: UuidStr): DriveItem {
	const dir: Dir = {
		uuid,
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } }
	}
	return narrowItem(dir)
}

function fileItem(uuid: UuidStr): DriveItem {
	const file: File = {
		uuid,
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
		}
	}
	return narrowItem(file)
}

const NAVIGABLE_VARIANTS: DriveVariant[] = ["drive", "recents", "favorites"]
const ALL_VARIANTS: DriveVariant[] = ["drive", "recents", "favorites", "trash"]

describe("splatToUuids", () => {
	it("returns an empty array for the root splat", () => {
		expect(splatToUuids("")).toEqual([])
	})

	it("returns a single-element array for a one-level splat", () => {
		expect(splatToUuids("a")).toEqual(["a"])
	})

	it("splits a multi-level splat on '/', preserving order", () => {
		expect(splatToUuids("a/b/c")).toEqual(["a", "b", "c"])
	})
})

describe("resolveDriveNavigationTarget", () => {
	it.each(ALL_VARIANTS)("returns null for a file in the %s variant — file-open is a later slice", variant => {
		expect(resolveDriveNavigationTarget(fileItem(testUuid("file-1")), variant, "")).toBeNull()
	})

	it("a directory clicked at the drive root appends its own uuid to the empty splat", () => {
		const uuid = testUuid("dir-1")

		expect(resolveDriveNavigationTarget(directoryItem(uuid), "drive", "")).toEqual({
			to: "/drive/$",
			params: { _splat: uuid }
		})
	})

	it("a directory clicked inside a nested path appends its uuid onto the current splat", () => {
		const parentA = testUuid("parent-a")
		const parentB = testUuid("parent-b")
		const clicked = testUuid("dir-clicked")
		const currentSplat = `${parentA}/${parentB}`

		expect(resolveDriveNavigationTarget(directoryItem(clicked), "drive", currentSplat)).toEqual({
			to: "/drive/$",
			params: { _splat: `${parentA}/${parentB}/${clicked}` }
		})
	})

	it.each(["recents", "favorites"] as const)(
		"a directory clicked from the flat %s root (no splat of its own) starts a fresh one-level path",
		variant => {
			const uuid = testUuid("dir-1")

			expect(resolveDriveNavigationTarget(directoryItem(uuid), variant, "")).toEqual({
				to: "/drive/$",
				params: { _splat: uuid }
			})
		}
	)

	it("a directory in the trash variant returns null regardless of the current splat — mirrors mobile's rule (trashed directories are never browsable)", () => {
		expect(resolveDriveNavigationTarget(directoryItem(testUuid("dir-1")), "trash", "")).toBeNull()
		expect(resolveDriveNavigationTarget(directoryItem(testUuid("dir-1")), "trash", testUuid("some-parent"))).toBeNull()
	})

	it.each(NAVIGABLE_VARIANTS)("carries the clicked directory's own uuid through as the new splat's final segment (%s)", variant => {
		const uuid = testUuid("distinct-uuid")
		const target = resolveDriveNavigationTarget(directoryItem(uuid), variant, "")

		expect(target?.params._splat).toBe(uuid)
	})
})

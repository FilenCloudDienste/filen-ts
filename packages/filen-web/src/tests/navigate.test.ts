import { describe, expect, it } from "vitest"
import type { Dir, File, UuidStr, SharedDir, SharedFile, SharingRole } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { driveRouteIdFor, resolveDriveNavigationTarget, splatToUuids } from "@/features/drive/lib/navigate"

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

// A nested shared directory (SharedDir + a spread parent role), narrowed exactly as the shared
// listing fetcher builds it — narrows to a "sharedDirectory" arm that asDirectoryOrFile maps to a
// directory, so it navigates like one. Role identity is irrelevant to navigation; a plausible one is
// supplied so the fixture matches the real narrowed shape.
function sharedDirectoryItem(uuid: UuidStr): DriveItem {
	const sharedDir: SharedDir & { sharingRole: SharingRole } = {
		inner: {
			uuid,
			parent: testUuid("parent"),
			color: "default",
			timestamp: 1_700_000_000_000n,
			favorited: false,
			meta: { type: "decoded", data: { name: "Shared" } }
		},
		sharedTag: true,
		sharingRole: { Sharer: { email: "sharer@filen.io", id: 42 } }
	}
	return narrowItem(sharedDir)
}

// A shared file (narrows to a "sharedRootFile" arm) — asDirectoryOrFile maps it to a file, so it
// never navigates, mirroring the base-file rule.
function sharedFileItem(uuid: UuidStr): DriveItem {
	const sharedFile: SharedFile = {
		uuid,
		size: 2_048n,
		region: "de-1",
		bucket: "filen-1",
		chunks: 2n,
		timestamp: 1_700_000_000_000n,
		meta: {
			type: "decoded",
			data: { name: "shared.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 2_048n, key: "key", version: 2 }
		},
		sharingRole: { Receiver: { email: "receiver@filen.io", id: 7 } },
		sharedTag: true
	}
	return narrowItem(sharedFile)
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

describe("driveRouteIdFor", () => {
	it("routes the shared variants to their own splat routes and every other variant to /drive/$", () => {
		expect(driveRouteIdFor("drive")).toBe("/drive/$")
		expect(driveRouteIdFor("recents")).toBe("/drive/$")
		expect(driveRouteIdFor("favorites")).toBe("/drive/$")
		expect(driveRouteIdFor("trash")).toBe("/drive/$")
		expect(driveRouteIdFor("sharedIn")).toBe("/shared-in/$")
		expect(driveRouteIdFor("sharedOut")).toBe("/shared-out/$")
	})
})

describe("resolveDriveNavigationTarget", () => {
	it.each(ALL_VARIANTS)("returns null for a file in the %s variant — file-open is a later slice", variant => {
		expect(resolveDriveNavigationTarget(fileItem(testUuid("file-1")), variant, "")).toBeNull()
	})

	it.each(["sharedIn", "sharedOut"] as const)("returns null for a shared file in the %s variant (asDirectoryOrFile → file)", variant => {
		expect(resolveDriveNavigationTarget(sharedFileItem(testUuid("shared-file")), variant, "")).toBeNull()
	})

	it("descends a shared directory under sharedIn into the shared-in splat route", () => {
		const uuid = testUuid("shared-dir")

		expect(resolveDriveNavigationTarget(sharedDirectoryItem(uuid), "sharedIn", "")).toEqual({
			to: "/shared-in/$",
			params: { _splat: uuid }
		})
	})

	it("descends a shared directory under sharedOut into the shared-out splat route", () => {
		const uuid = testUuid("shared-dir")

		expect(resolveDriveNavigationTarget(sharedDirectoryItem(uuid), "sharedOut", "")).toEqual({
			to: "/shared-out/$",
			params: { _splat: uuid }
		})
	})

	it("appends onto the current splat when descending into a nested share (stays on the shared route)", () => {
		const parent = testUuid("shared-parent")
		const clicked = testUuid("shared-child")

		expect(resolveDriveNavigationTarget(sharedDirectoryItem(clicked), "sharedIn", parent)).toEqual({
			to: "/shared-in/$",
			params: { _splat: `${parent}/${clicked}` }
		})
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

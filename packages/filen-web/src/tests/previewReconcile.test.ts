import { describe, expect, it } from "vitest"
import type { Dir, DirMeta, File, FileMeta, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type PreviewSource } from "@/features/preview/lib/previewSource"
import { reconcilePreviewSources } from "@/features/preview/lib/previewReconcile"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
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
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "k", version: 2 }
		},
		...overrides
	}
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

function driveSource(item: DriveItem): PreviewSource {
	return { type: "drive", item }
}

function fileSourceAt(label: string): PreviewSource {
	return driveSource(narrowItem(mockFile({ uuid: testUuid(label) })))
}

describe("reconcilePreviewSources — removed", () => {
	it("drops the removed slot and keeps the current item visible when an earlier slot goes", () => {
		const sources = [fileSourceAt("a"), fileSourceAt("b"), fileSourceAt("c")]
		const next = reconcilePreviewSources({ sources, index: 2 }, { type: "removed", uuid: testUuid("a") })

		expect(next).not.toBeNull()
		expect(next?.sources.map(s => (s.type === "drive" ? s.item.data.uuid : ""))).toEqual([testUuid("b"), testUuid("c")])
		// index steps back one so the same item (c) stays under the anchor.
		expect(next?.index).toBe(1)
	})

	it("advances to the neighbour when the current slot is removed", () => {
		const sources = [fileSourceAt("a"), fileSourceAt("b"), fileSourceAt("c")]
		const next = reconcilePreviewSources({ sources, index: 1 }, { type: "removed", uuid: testUuid("b") })

		expect(next?.index).toBe(1)
		expect(next?.sources.map(s => (s.type === "drive" ? s.item.data.uuid : ""))).toEqual([testUuid("a"), testUuid("c")])
	})

	it("clamps to the new last slot when the removed current item was last", () => {
		const sources = [fileSourceAt("a"), fileSourceAt("b")]
		const next = reconcilePreviewSources({ sources, index: 1 }, { type: "removed", uuid: testUuid("b") })

		expect(next?.index).toBe(0)
	})

	it("returns null (close) when the only remaining slot is removed", () => {
		const sources = [fileSourceAt("a")]
		const next = reconcilePreviewSources({ sources, index: 0 }, { type: "removed", uuid: testUuid("a") })

		expect(next).toBeNull()
	})

	it("leaves state untouched when the uuid is not in the pager", () => {
		const state = { sources: [fileSourceAt("a")], index: 0 }
		const next = reconcilePreviewSources(state, { type: "removed", uuid: testUuid("z") })

		expect(next).toBe(state)
	})
})

describe("reconcilePreviewSources — replaced", () => {
	it("swaps the item on the matching slot and holds the index", () => {
		const sources = [fileSourceAt("old"), fileSourceAt("b")]
		const replacement = narrowItem(mockFile({ uuid: testUuid("new") }))
		const next = reconcilePreviewSources({ sources, index: 0 }, { type: "replaced", previousUuid: testUuid("old"), item: replacement })

		expect(next?.index).toBe(0)
		expect(next?.sources[0]?.type === "drive" ? next.sources[0].item.data.uuid : "").toBe(testUuid("new"))
	})
})

describe("reconcilePreviewSources — metadata", () => {
	it("re-derives an owned file's title from the fresh meta", () => {
		const sources = [driveSource(narrowItem(mockFile()))]
		const meta: FileMeta = {
			type: "decoded",
			data: { name: "renamed.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "k", version: 2 }
		}

		const next = reconcilePreviewSources({ sources, index: 0 }, { type: "fileMeta", uuid: testUuid("file"), meta })

		expect(next?.sources[0]?.type === "drive" ? next.sources[0].item.data.decryptedMeta?.name : "").toBe("renamed.pdf")
	})

	it("re-derives an owned directory's title from the fresh meta", () => {
		const sources = [driveSource(narrowItem(mockDir()))]
		const meta: DirMeta = { type: "decoded", data: { name: "Renamed" } }

		const next = reconcilePreviewSources({ sources, index: 0 }, { type: "folderMeta", uuid: testUuid("dir"), meta })

		expect(next?.sources[0]?.type === "drive" ? next.sources[0].item.data.decryptedMeta?.name : "").toBe("Renamed")
	})

	it("leaves an external source untouched on any event", () => {
		const external: PreviewSource = { type: "external", url: "https://example.com/x", name: "x" }
		const state = { sources: [external], index: 0 }
		const meta: DirMeta = { type: "decoded", data: { name: "Renamed" } }

		expect(reconcilePreviewSources(state, { type: "folderMeta", uuid: testUuid("dir"), meta })?.sources[0]).toBe(external)
	})
})

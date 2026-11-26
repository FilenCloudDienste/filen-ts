import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
	AnyLinkedDir,
	Dir,
	DirPublicLink,
	File,
	LinkedDir,
	LinkedDirsAndFiles,
	NormalDirsAndFiles,
	ParentUuid,
	SharedDir,
	SharingRole
} from "@filen/sdk-rs"
import type { SharedPathHint } from "@/features/drive/lib/sharedPath"
import type { SharedNestedListing } from "@/workers/sdk.worker"

const { listSlideshowOwned, listSlideshowShared, listSlideshowLinked } = vi.hoisted(() => ({
	listSlideshowOwned: vi.fn<(dirUuid: string) => Promise<NormalDirsAndFiles>>(),
	listSlideshowShared: vi.fn<(dirUuid: string, hint?: SharedPathHint) => Promise<SharedNestedListing>>(),
	listSlideshowLinked: vi.fn<(dir: AnyLinkedDir, link: DirPublicLink) => Promise<LinkedDirsAndFiles>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listSlideshowOwned, listSlideshowShared, listSlideshowLinked } }))

import { fetchSlideshowTree } from "@/features/preview/lib/slideshowTree"
import { driveItemName } from "@filen/shared"
import { testUuid } from "@/tests/support/uuid"

const ROOT = testUuid("root")

function mockDir(uuid: string, parent: ParentUuid, name: string): Dir {
	return {
		uuid: testUuid(uuid),
		parent,
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	}
}

function mockFile(uuid: string, parent: ParentUuid, name: string, mime = "image/jpeg"): File {
	return {
		uuid: testUuid(uuid),
		stableUUID: undefined,
		parent,
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: { type: "decoded", data: { name, mime, modified: 1n, size: 1_024n, key: "k", version: 2 } }
	}
}

function names(items: readonly { data: { uuid: string; decryptedMeta: { name: string } | null } }[]): string[] {
	return items.map(item => driveItemName(item))
}

function signal(): AbortSignal {
	return new AbortController().signal
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("fetchSlideshowTree", () => {
	it("owned: walks once and keeps only slideable files", async () => {
		listSlideshowOwned.mockResolvedValueOnce({
			dirs: [],
			files: [mockFile("a", ROOT, "a.jpg"), mockFile("b", ROOT, "b.mp4", "video/mp4")]
		})

		const items = await fetchSlideshowTree({ kind: "owned", uuid: ROOT, hideDotFiles: false, dotFilenRoot: null }, signal())

		expect(listSlideshowOwned).toHaveBeenCalledTimes(1)
		expect(listSlideshowOwned).toHaveBeenCalledWith(ROOT)
		expect(items.map(item => item.type)).toEqual(["file", "file"])
		expect(names(items)).toEqual(["a.jpg", "b.mp4"])
	})

	it("shared: tags files with the role before narrowing", async () => {
		const role: SharingRole = { type: "receiver", email: "a@example.com", id: 1n }
		const sub: SharedDir = { inner: mockDir("sub", testUuid("shared"), "Sub"), sharedTag: true }

		listSlideshowShared.mockResolvedValueOnce({ dirs: [sub], files: [mockFile("a", sub.inner.uuid, "a.jpg")], role })

		const items = await fetchSlideshowTree(
			{ kind: "shared", variant: "sharedIn", uuid: testUuid("shared"), path: [testUuid("shared")], hideDotFiles: true },
			signal()
		)

		expect(listSlideshowShared).toHaveBeenCalledWith(testUuid("shared"), { variant: "sharedIn", path: [testUuid("shared")] })
		expect(items).toHaveLength(1)
		expect(items[0]?.type).toBe("sharedFile")
		expect(items[0]?.type === "sharedFile" && items[0].data.sharingRole).toEqual(role)
	})

	it("linked: lists the link recursively", async () => {
		const link = { linkUuid: testUuid("link") } as unknown as DirPublicLink
		const root: LinkedDir = { inner: mockDir("lroot", testUuid("p"), "Public"), linkedTag: true }
		const sub: LinkedDir = { inner: mockDir("lsub", root.inner.uuid, ".hidden"), linkedTag: true }

		listSlideshowLinked.mockResolvedValueOnce({
			dirs: [sub],
			files: [mockFile("b", sub.inner.uuid, "b.jpg"), mockFile("a", root.inner.uuid, "a.jpg")]
		})

		const items = await fetchSlideshowTree({ kind: "linked", dir: root, link }, signal())

		expect(listSlideshowLinked).toHaveBeenCalledWith(root, link)
		expect(items.map(item => item.type)).toEqual(["file", "file"])
		// A link never hides: the file inside the dot-directory stays.
		expect(names(items)).toEqual(["a.jpg", "b.jpg"])
	})

	it("orders by directory path then natural name", async () => {
		const b = mockDir("b", ROOT, "B")
		const a = mockDir("a", ROOT, "A")
		const ab = mockDir("ab", a.uuid, "Inner")
		const a10 = mockDir("a10", ROOT, "A10")
		const a2 = mockDir("a2", ROOT, "A2")

		listSlideshowOwned.mockResolvedValueOnce({
			dirs: [b, ab, a10, a, a2],
			files: [
				mockFile("f1", b.uuid, "x.jpg"),
				mockFile("f2", ab.uuid, "x.jpg"),
				mockFile("f3", a.uuid, "img10.jpg"),
				mockFile("f4", a.uuid, "img2.jpg"),
				mockFile("f5", ROOT, "top.jpg"),
				mockFile("f6", a10.uuid, "x.jpg"),
				mockFile("f7", a2.uuid, "x.jpg")
			]
		})

		const items = await fetchSlideshowTree({ kind: "owned", uuid: ROOT, hideDotFiles: false, dotFilenRoot: null }, signal())

		expect(items.map(item => item.data.uuid)).toEqual(["f5", "f4", "f3", "f2", "f7", "f6", "f1"].map(testUuid))
	})

	it("drops dot-files and files inside dot-directories only when hideDotFiles", async () => {
		const dot = mockDir("dot", ROOT, ".git")
		const deep = mockDir("deep", dot.uuid, "objects")
		const listing = (): NormalDirsAndFiles => ({
			dirs: [dot, deep],
			files: [
				mockFile("a", ROOT, "a.jpg"),
				mockFile("b", ROOT, ".b.jpg"),
				mockFile("c", dot.uuid, "c.jpg"),
				mockFile("d", deep.uuid, "d.jpg")
			]
		})

		listSlideshowOwned.mockResolvedValueOnce(listing())

		const hidden = await fetchSlideshowTree({ kind: "owned", uuid: ROOT, hideDotFiles: true, dotFilenRoot: null }, signal())

		expect(names(hidden)).toEqual(["a.jpg"])

		listSlideshowOwned.mockResolvedValueOnce(listing())

		const shown = await fetchSlideshowTree({ kind: "owned", uuid: ROOT, hideDotFiles: false, dotFilenRoot: null }, signal())

		expect(names(shown)).toEqual([".b.jpg", "a.jpg", "c.jpg", "d.jpg"])
	})

	it("drops the root .filen when the listing hides it, and keeps it when the listing shows it", async () => {
		const dotFilen = mockDir("dotfilen", ROOT, ".filen")
		const photos = mockDir("photos", dotFilen.uuid, "photos")
		const other = mockDir("other", ROOT, "Other")
		const nested = mockDir("nested", other.uuid, ".filen")
		const listing = (): NormalDirsAndFiles => ({
			dirs: [dotFilen, photos, other, nested],
			files: [mockFile("a", photos.uuid, "a.jpg"), mockFile("b", nested.uuid, "b.jpg"), mockFile("c", ROOT, "c.jpg")]
		})

		listSlideshowOwned.mockResolvedValueOnce(listing())

		const hidden = await fetchSlideshowTree({ kind: "owned", uuid: ROOT, hideDotFiles: false, dotFilenRoot: ROOT }, signal())

		// Only the root's own `.filen`: one nested elsewhere stays.
		expect(names(hidden)).toEqual(["c.jpg", "b.jpg"])

		listSlideshowOwned.mockResolvedValueOnce(listing())

		const shown = await fetchSlideshowTree({ kind: "owned", uuid: ROOT, hideDotFiles: false, dotFilenRoot: null }, signal())

		expect(names(shown)).toEqual(["c.jpg", "a.jpg", "b.jpg"])
	})

	it("an aborted fetch resolves to nothing applied", async () => {
		const controller = new AbortController()

		listSlideshowOwned.mockImplementationOnce(() => {
			controller.abort()

			return Promise.resolve({ dirs: [], files: [mockFile("a", ROOT, "a.jpg")] })
		})

		await expect(
			fetchSlideshowTree({ kind: "owned", uuid: ROOT, hideDotFiles: false, dotFilenRoot: null }, controller.signal)
		).resolves.toEqual([])
	})

	it("never lists when already aborted", async () => {
		const controller = new AbortController()

		controller.abort()

		await expect(
			fetchSlideshowTree({ kind: "owned", uuid: ROOT, hideDotFiles: false, dotFilenRoot: null }, controller.signal)
		).resolves.toEqual([])
		expect(listSlideshowOwned).not.toHaveBeenCalled()
	})
})

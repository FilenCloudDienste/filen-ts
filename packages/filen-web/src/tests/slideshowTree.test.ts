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
import type { SlideshowOrderRules } from "@/features/preview/lib/slideshowOrder"

const { listSlideshowOwned, listSlideshowShared, listSlideshowLinked } = vi.hoisted(() => ({
	listSlideshowOwned: vi.fn<(dirUuid: string, rules: SlideshowOrderRules) => Promise<NormalDirsAndFiles>>(),
	listSlideshowShared: vi.fn<(dirUuid: string, rules: SlideshowOrderRules, hint?: SharedPathHint) => Promise<SharedNestedListing>>(),
	listSlideshowLinked: vi.fn<(dir: AnyLinkedDir, link: DirPublicLink) => Promise<LinkedDirsAndFiles>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listSlideshowOwned, listSlideshowShared, listSlideshowLinked } }))

import { fetchLinkedSlideshowTree, fetchSlideshowTree } from "@/features/preview/lib/slideshowTree"
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
		expect(listSlideshowOwned).toHaveBeenCalledWith(ROOT, { hideDotFiles: false, dotFilenRoot: null })
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

		expect(listSlideshowShared).toHaveBeenCalledWith(
			testUuid("shared"),
			{ hideDotFiles: true, dotFilenRoot: null },
			{ variant: "sharedIn", path: [testUuid("shared")] }
		)
		expect(items).toHaveLength(1)
		expect(items[0]?.type).toBe("sharedFile")
		expect(items[0]?.type === "sharedFile" && items[0].data.sharingRole).toEqual(role)
	})

	it("linked: lists the link recursively, in the worker's order", async () => {
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
		expect(names(items)).toEqual(["b.jpg", "a.jpg"])
	})

	it("linked: keeps the link's directories beside its files", async () => {
		const link = { linkUuid: testUuid("link") } as unknown as DirPublicLink
		const root: LinkedDir = { inner: mockDir("lroot", testUuid("p"), "Public"), linkedTag: true }
		const sub: LinkedDir = { inner: mockDir("lsub", root.inner.uuid, "Sub"), linkedTag: true }

		listSlideshowLinked.mockResolvedValueOnce({ dirs: [sub], files: [mockFile("b", sub.inner.uuid, "b.jpg")] })

		const tree = await fetchLinkedSlideshowTree({ kind: "linked", dir: root, link }, signal())

		expect(names(tree.items)).toEqual(["b.jpg"])
		expect(tree.dirs.get(sub.inner.uuid)).toBe(sub)
	})

	it("keeps the worker's order and hands it the listing's rules: the main thread sorts nothing", async () => {
		listSlideshowOwned.mockResolvedValueOnce({ dirs: [], files: [mockFile("b", ROOT, "b.jpg"), mockFile("a", ROOT, "a.jpg")] })

		const items = await fetchSlideshowTree({ kind: "owned", uuid: ROOT, hideDotFiles: true, dotFilenRoot: ROOT }, signal())

		expect(listSlideshowOwned).toHaveBeenCalledWith(ROOT, { hideDotFiles: true, dotFilenRoot: ROOT })
		expect(names(items)).toEqual(["b.jpg", "a.jpg"])
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

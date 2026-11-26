import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Remote } from "comlink"
import type {
	AnyDirWithContext,
	DirPublicLink,
	DirsAndFiles,
	File,
	LinkedDir,
	LinkedDirsAndFiles,
	ParentUuid,
	SharedRootDirsAndFiles,
	SharingRole,
	StringifiedClient
} from "@filen/sdk-rs"
import type { SdkWorkerApi } from "@/workers/sdk.worker"
import { testUuid } from "@/tests/support/uuid"

// The slideshow's recursive lists: one SDK listing each, and only slideable files come back.

const { exposed, fakeClient, fakeUnauth } = vi.hoisted(() => {
	const fakeUnauth = {
		listLinkedDirRecursive: vi.fn<(dir: unknown, link: DirPublicLink, cb: unknown) => Promise<LinkedDirsAndFiles>>(),
		free: vi.fn()
	}

	return {
		exposed: new Map<"api", unknown>(),
		fakeUnauth,
		fakeClient: {
			root: vi.fn(() => ({ uuid: "root-0000-0000-0000-000000000000" })),
			listDirRecursive: vi.fn<(dir: AnyDirWithContext, cb: unknown) => Promise<DirsAndFiles>>(),
			listInShared: vi.fn<() => Promise<SharedRootDirsAndFiles>>(),
			getUnauthed: vi.fn(() => fakeUnauth),
			free: vi.fn()
		}
	}
})

vi.mock("@filen/sdk-rs", () => ({
	default: vi.fn(),
	initThreadPool: vi.fn(),
	UnauthClient: { from_config: () => ({ free: vi.fn(), fromStringified: () => fakeClient }) }
}))

vi.mock("comlink", () => ({
	expose: (api: unknown) => {
		exposed.set("api", api)
	},
	proxy: (value: unknown) => value,
	transfer: (value: unknown) => value
}))

await import("@/workers/sdk.worker")

const api = exposed.get("api") as Remote<SdkWorkerApi>
const ROOT = testUuid("root")

function mockFile(uuid: string, parent: ParentUuid, name: string, mime: string): File {
	return {
		uuid: testUuid(uuid),
		stableUUID: undefined,
		parent,
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: { type: "decoded", data: { name, mime, modified: 1n, size: 1_024n, key: "k", version: 2 } }
	}
}

function mixedFiles(parent: ParentUuid): File[] {
	return [
		mockFile("img", parent, "a.jpg", "image/jpeg"),
		mockFile("vid", parent, "b.mp4", "video/mp4"),
		mockFile("doc", parent, "c.pdf", "application/pdf"),
		mockFile("aud", parent, "d.mp3", "audio/mpeg"),
		mockFile("wmv", parent, "e.wmv", "video/x-ms-wmv")
	]
}

const SLIDEABLE = [testUuid("img"), testUuid("vid")]

const dirBase = { color: "default", timestamp: 1n, favorited: false } as const

beforeEach(async () => {
	vi.clearAllMocks()
	await api.injectClient("session" as unknown as StringifiedClient)
})

describe("slideshow worker lists", () => {
	it("owned: walks the drive root once and returns every dir but only slideable files", async () => {
		const dir = {
			type: "normal" as const,
			uuid: testUuid("sub"),
			parent: ROOT,
			meta: { type: "decoded" as const, data: { name: "Sub" } },
			...dirBase
		}

		fakeClient.listDirRecursive.mockResolvedValueOnce({ dirs: [dir], files: mixedFiles(dir.uuid) })

		const result = await api.listSlideshowOwned(ROOT)

		expect(fakeClient.listDirRecursive).toHaveBeenCalledTimes(1)
		expect(result.dirs.map(d => d.uuid)).toEqual([dir.uuid])
		expect(result.files.map(f => f.uuid)).toEqual(SLIDEABLE)
	})

	it("shared: lists the cached shared root recursively with its role and filters the files", async () => {
		const role: SharingRole = { type: "receiver", email: "a@example.com", id: 1n }
		const sharedRoot = {
			inner: { uuid: testUuid("share"), meta: { type: "decoded" as const, data: { name: "Shared" } }, ...dirBase },
			sharingRole: role,
			writeAccess: false,
			sharedTag: true
		}
		const nested = {
			type: "shared" as const,
			inner: {
				uuid: testUuid("nested"),
				parent: testUuid("share"),
				meta: { type: "decoded" as const, data: { name: "N" } },
				...dirBase
			},
			sharedTag: true
		}

		fakeClient.listInShared.mockResolvedValueOnce({ dirs: [sharedRoot], files: [] })
		await api.listSharedInRoot()
		fakeClient.listDirRecursive.mockResolvedValueOnce({
			dirs: [nested],
			files: mixedFiles(nested.inner.uuid)
		})

		const result = await api.listSlideshowShared(testUuid("share"))

		expect(fakeClient.listDirRecursive).toHaveBeenCalledWith({ dir: sharedRoot, shareInfo: role }, expect.any(Function))
		expect(result.role).toEqual(role)
		expect(result.dirs.map(d => d.inner.uuid)).toEqual([nested.inner.uuid])
		expect(result.files.map(f => f.uuid)).toEqual(SLIDEABLE)
	})

	it("linked: lists the link recursively through an unauthed client and filters the files", async () => {
		const link = { linkUuid: testUuid("link") } as unknown as DirPublicLink
		const root: LinkedDir = {
			inner: { uuid: testUuid("lroot"), parent: ROOT, meta: { type: "decoded", data: { name: "Public" } }, ...dirBase },
			linkedTag: true
		}
		const sub: LinkedDir = {
			inner: { uuid: testUuid("lsub"), parent: root.inner.uuid, meta: { type: "decoded", data: { name: "Sub" } }, ...dirBase },
			linkedTag: true
		}

		fakeUnauth.listLinkedDirRecursive.mockResolvedValueOnce({ dirs: [sub], files: mixedFiles(sub.inner.uuid) })

		const result = await api.listSlideshowLinked(root, link)

		expect(fakeUnauth.listLinkedDirRecursive).toHaveBeenCalledWith(root, link, expect.any(Function))
		expect(fakeUnauth.free).toHaveBeenCalled()
		expect(result.dirs).toEqual([sub])
		expect(result.files.map(f => f.uuid)).toEqual(SLIDEABLE)
	})
})

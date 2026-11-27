import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Remote } from "comlink"
import type { DirPublicLink, File, LinkedDir, LinkedDirsAndFiles, LinkedRootDir, StringifiedClient } from "@filen/sdk-rs"
import type { SdkWorkerApi } from "@/workers/sdk.worker"
import type { LinkedSearchRange } from "@/workers/linkedSearch"
import { linkedItemName } from "@/features/publicLinks/lib/browse.logic"
import { testUuid } from "@/tests/support/uuid"

// The public link's search: one recursive listing held per directory, matched and windowed in the worker, and reused by
// the listings and the slideshow below it.

const { exposed, fakeClient, fakeUnauth, released } = vi.hoisted(() => {
	const fakeUnauth = {
		listLinkedDirRecursive:
			vi.fn<
				(
					dir: unknown,
					link: DirPublicLink,
					cb: (downloaded: number, total: number | undefined) => void
				) => Promise<LinkedDirsAndFiles>
			>(),
		listLinkedDir: vi.fn<(dir: unknown, link: DirPublicLink, cb: unknown) => Promise<LinkedDirsAndFiles>>(),
		free: vi.fn()
	}

	return {
		exposed: new Map<"api", unknown>(),
		fakeUnauth,
		released: vi.fn(),
		fakeClient: {
			root: vi.fn(() => ({ uuid: "root-0000-0000-0000-000000000000" })),
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
	transfer: (value: unknown) => value,
	releaseProxy: Symbol.for("comlink.releaseProxy")
}))

await import("@/workers/sdk.worker")

const api = exposed.get("api") as Remote<SdkWorkerApi>
const RELEASE = Symbol.for("comlink.releaseProxy")

const dirBase = { color: "default", timestamp: 1n, favorited: false } as const

function linkedDir(uuid: string, parent: string, name: string): LinkedDir {
	return {
		inner: { uuid: testUuid(uuid), parent: testUuid(parent), meta: { type: "decoded", data: { name } }, ...dirBase },
		linkedTag: true
	}
}

function file(uuid: string, parent: string, name: string, mime = "text/plain"): File {
	return {
		uuid: testUuid(uuid),
		stableUUID: undefined,
		parent: testUuid(parent),
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

const ROOT = {
	inner: { uuid: testUuid("root"), meta: { type: "decoded", data: { name: "Public" } }, ...dirBase },
	linkedTag: true
} as unknown as LinkedRootDir
const LINK = { linkUuid: testUuid("link"), linkKey: "key", password: { type: "none" } } as unknown as DirPublicLink
const PHOTOS = linkedDir("photos", "root", "Photos")
const TRIP = linkedDir("trip", "photos", "Trip Report")
const DOCS = linkedDir("docs", "root", "Docs")
// Decomposed, as a name typed on macOS can be stored.
const NFD_NAME = "Öl.txt".normalize("NFD")
const TREE: LinkedDirsAndFiles = {
	dirs: [PHOTOS, TRIP, DOCS],
	files: [
		file("readme", "root", "README.md"),
		file("beach", "trip", "beach.jpg", "image/jpeg"),
		file("report", "docs", "report.PDF", "application/pdf"),
		file("summary", "docs", NFD_NAME),
		file("clip", "trip", "clip.mp4", "video/mp4")
	]
}

function names(result: LinkedSearchRange): string[] {
	return result.hits.map(hit => linkedItemName(hit.item))
}

function trails(result: LinkedSearchRange): string[] {
	return result.hits.map(hit => hit.trail.map(linkedItemName).join("/"))
}

function query(
	name: string,
	extra: Partial<{ dirUuid: string; sort: "nameAsc" | "nameDesc"; start: number; end: number; link: DirPublicLink }> = {}
) {
	return api.searchLinkedRange({ dirUuid: ROOT.inner.uuid, link: LINK, name, sort: "nameAsc", start: 0, end: 1_000, ...extra })
}

beforeEach(async () => {
	vi.clearAllMocks()
	await api.injectClient("session" as unknown as StringifiedClient)
	await api.searchLinkedClose()
	fakeUnauth.listLinkedDirRecursive.mockResolvedValue(TREE)
})

describe("linked search: the held listing", () => {
	it("lists a directory's subtree once, and not again for it or a directory below it", async () => {
		await api.searchLinkedOpen(ROOT, LINK, vi.fn())
		await api.searchLinkedOpen(ROOT, LINK, vi.fn())
		await api.searchLinkedOpen(PHOTOS, LINK, vi.fn())

		expect(fakeUnauth.listLinkedDirRecursive).toHaveBeenCalledTimes(1)
		expect(fakeUnauth.listLinkedDirRecursive).toHaveBeenCalledWith(ROOT, LINK, expect.any(Function))
	})

	it("lists again for a directory the held one does not cover, or for another password of the link", async () => {
		fakeUnauth.listLinkedDirRecursive.mockResolvedValueOnce({ dirs: [TRIP], files: [] })
		await api.searchLinkedOpen(PHOTOS, LINK, vi.fn())
		await api.searchLinkedOpen(ROOT, LINK, vi.fn())
		await api.searchLinkedOpen(ROOT, { ...LINK, password: { type: "known", data: "other" } }, vi.fn())

		expect(fakeUnauth.listLinkedDirRecursive).toHaveBeenCalledTimes(3)
	})

	it("reports the listing's download to the page and releases its callback once the listing is in", async () => {
		fakeUnauth.listLinkedDirRecursive.mockImplementationOnce((_dir, _link, cb) => {
			cb(10, 100)
			cb(100, undefined)

			return Promise.resolve(TREE)
		})
		const onProgress = Object.assign(vi.fn(), { [RELEASE]: released })

		await api.searchLinkedOpen(ROOT, LINK, onProgress)

		expect(onProgress).toHaveBeenNthCalledWith(1, 10, 100)
		expect(onProgress).toHaveBeenLastCalledWith(100, null)
		expect(released).toHaveBeenCalledTimes(1)
	})

	it("drops a listing that lands after a newer open, and frees the held one on close", async () => {
		let land: (listing: LinkedDirsAndFiles) => void = () => undefined

		fakeUnauth.listLinkedDirRecursive.mockImplementationOnce(
			() =>
				new Promise(resolve => {
					land = resolve
				})
		)

		const stale = api.searchLinkedOpen(PHOTOS, LINK, vi.fn())

		await vi.waitFor(() => {
			expect(fakeUnauth.listLinkedDirRecursive).toHaveBeenCalledTimes(1)
		})
		await api.searchLinkedOpen(ROOT, LINK, vi.fn())
		land({ dirs: [], files: [] })
		await stale

		expect(names(await query("report"))).toEqual(["Trip Report", "report.PDF"])

		await api.searchLinkedClose()

		await expect(query("report")).rejects.toThrow()
	})
})

describe("linked search: matching and windows", () => {
	beforeEach(async () => {
		await api.searchLinkedOpen(ROOT, LINK, vi.fn())
	})

	it("matches the drive's way: trimmed, case-folded, composition-blind substrings of directories and files", async () => {
		expect(names(await query("  REPORT "))).toEqual(["Trip Report", "report.PDF"])
		expect(names(await query("öl"))).toEqual([NFD_NAME])
		expect(names(await query("ÖL".normalize("NFD")))).toEqual([NFD_NAME])
		expect(names(await query("each"))).toEqual(["beach.jpg"])
	})

	it("matches nothing for a blank query", async () => {
		expect(await query("   ")).toEqual({ total: 0, hits: [] })
	})

	it("returns each hit's path below the directory searched", async () => {
		const result = await query("e")

		expect(names(result)).toEqual(["Trip Report", "beach.jpg", "README.md", "report.PDF"])
		expect(trails(result)).toEqual(["Photos", "Photos/Trip Report", "", "Docs"])
	})

	it("orders by the page's sort, directories first, and crosses only the window asked for", async () => {
		expect(names(await query("p", { sort: "nameDesc" }))).toEqual(["Trip Report", "Photos", "report.PDF", "clip.mp4", "beach.jpg"])

		const window = await query("p", { sort: "nameDesc", start: 1, end: 3 })

		expect(window.total).toBe(5)
		expect(names(window)).toEqual(["Photos", "report.PDF"])
	})

	it("narrows the last query's matches as the query grows, in the same order", async () => {
		await query("r")

		expect(names(await query("re"))).toEqual(["Trip Report", "README.md", "report.PDF"])
		expect(names(await query("rep"))).toEqual(["Trip Report", "report.PDF"])
		// A different query is matched against the whole listing again.
		expect(names(await query("clip"))).toEqual(["clip.mp4"])
	})

	it("searches a directory below the held one from it, its paths from there", async () => {
		const result = await query("p", { dirUuid: PHOTOS.inner.uuid })

		expect(names(result)).toEqual(["Trip Report", "beach.jpg", "clip.mp4"])
		expect(trails(result)).toEqual(["", "Trip Report", "Trip Report"])
	})
})

describe("linked search: the held listing reused", () => {
	it("serves a covered directory's own listing with no request, and requests again once closed", async () => {
		await api.searchLinkedOpen(ROOT, LINK, vi.fn())

		const listing = await api.listLinkedDirAnon(TRIP, LINK)

		expect(listing.dirs).toEqual([])
		expect(listing.files.map(f => f.uuid)).toEqual([testUuid("beach"), testUuid("clip")])
		expect(fakeUnauth.listLinkedDir).not.toHaveBeenCalled()

		await api.searchLinkedClose()
		fakeUnauth.listLinkedDir.mockResolvedValueOnce({ dirs: [], files: [] })
		await api.listLinkedDirAnon(TRIP, LINK)

		expect(fakeUnauth.listLinkedDir).toHaveBeenCalledTimes(1)
	})

	it("derives a slideshow's subdirectories from the held listing: one SDK listing in all", async () => {
		await api.searchLinkedOpen(ROOT, LINK, vi.fn())

		const slides = await api.listSlideshowLinked(PHOTOS, LINK)

		expect(fakeUnauth.listLinkedDirRecursive).toHaveBeenCalledTimes(1)
		expect(slides.dirs).toEqual([TRIP])
		expect(slides.files.map(f => f.uuid)).toEqual([testUuid("beach"), testUuid("clip")])
	})

	it("walks for a slideshow as before when nothing is held", async () => {
		await api.listSlideshowLinked(PHOTOS, LINK)

		expect(fakeUnauth.listLinkedDirRecursive).toHaveBeenCalledWith(PHOTOS, LINK, expect.any(Function))
	})

	it("holds a slideshow's listing: subdirectories off and on again list nothing more", async () => {
		const first = await api.listSlideshowLinked(ROOT, LINK)
		const again = await api.listSlideshowLinked(ROOT, LINK)

		expect(fakeUnauth.listLinkedDirRecursive).toHaveBeenCalledTimes(1)
		expect(again).toEqual(first)
	})

	it("a slideshow's listing serves the search after it, and the listings and slideshows below it", async () => {
		await api.listSlideshowLinked(ROOT, LINK)
		await api.searchLinkedOpen(ROOT, LINK, vi.fn())

		expect(names(await query("beach"))).toEqual(["beach.jpg"])

		const listing = await api.listLinkedDirAnon(TRIP, LINK)
		const slides = await api.listSlideshowLinked(PHOTOS, LINK)

		expect(listing.files.map(f => f.uuid)).toEqual([testUuid("beach"), testUuid("clip")])
		expect(slides.files.map(f => f.uuid)).toEqual([testUuid("beach"), testUuid("clip")])
		expect(fakeUnauth.listLinkedDirRecursive).toHaveBeenCalledTimes(1)
		expect(fakeUnauth.listLinkedDir).not.toHaveBeenCalled()
	})

	it("a search opened while a slideshow's listing is under way waits on that one, its progress reported", async () => {
		let land: (listing: LinkedDirsAndFiles) => void = () => undefined
		let progress: (downloaded: number, total: number | undefined) => void = () => undefined

		fakeUnauth.listLinkedDirRecursive.mockImplementationOnce(
			(_dir, _link, cb) =>
				new Promise(resolve => {
					progress = cb
					land = resolve
				})
		)

		const onProgress = vi.fn()
		const slides = api.listSlideshowLinked(ROOT, LINK)
		const opened = api.searchLinkedOpen(ROOT, LINK, onProgress)

		await Promise.resolve()
		progress(10, 20)
		land(TREE)
		await Promise.all([slides, opened])

		expect(fakeUnauth.listLinkedDirRecursive).toHaveBeenCalledTimes(1)
		expect(onProgress).toHaveBeenCalledWith(10, 20)
		expect(names(await query("beach"))).toEqual(["beach.jpg"])
	})
})

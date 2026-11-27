import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File as SdkFile } from "@filen/sdk-rs"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { setProgressSink: vi.fn() } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }))
vi.mock("@/features/transfers/lib/transferStartToast", () => ({ toastTransferStarted: vi.fn() }))

import { runDirectoryUpload, type RunDirectoryUploadDeps } from "@/features/drive/lib/uploadDirectory"
import { heldNamesOf, type HeldNames, type NestedPolicy } from "@/features/drive/lib/nameConflicts"
import { nestedDirectoryDecision, nestedFileDecision, type RunDirectory } from "@/features/drive/lib/directoryMerge"
import { discardUploadClaims } from "@/features/drive/lib/uploadClaims"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { testUuid } from "@/tests/support/uuid"

function sdkDir(name: string, uuid = testUuid(name)): Dir {
	return { uuid, parent: testUuid("root"), color: "default", timestamp: 1n, favorited: false, meta: { type: "decoded", data: { name } } }
}

function sdkFile(name: string): SdkFile {
	return {
		uuid: testUuid(`file-${name}`),
		stableUUID: undefined,
		parent: testUuid("root"),
		size: 1n,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: 1n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "image/jpeg", modified: 1n, size: 1n, key: "k", version: 2 } }
	}
}

function item(entry: Dir | SdkFile): DriveItem {
	return narrowItem(entry)
}

function browserFile(name: string): File {
	return new File([new Uint8Array(4)], name)
}

const PHOTOS = testUuid("remote-photos")
const YEAR = testUuid("remote-2024")

// The remote tree a merge writes into: Photos/{a.jpg, 2024/{b.jpg}, Sub (a file)}.
const REMOTE: Record<string, HeldNames> = {
	[PHOTOS]: heldNamesOf([item(sdkFile("a.jpg")), item(sdkDir("2024", YEAR)), item(sdkFile("Sub"))]),
	[YEAR]: heldNamesOf([item(sdkFile("b.jpg"))])
}

// The local tree dropped: Photos/{a.jpg, new.jpg, 2024/{b.jpg, c.jpg}, Fresh/d.jpg, Sub/e.jpg}.
const LOCAL = {
	dirs: ["Photos", "Photos/2024", "Photos/Fresh", "Photos/Sub"],
	files: ["Photos/a.jpg", "Photos/new.jpg", "Photos/2024/b.jpg", "Photos/2024/c.jpg", "Photos/Fresh/d.jpg", "Photos/Sub/e.jpg"]
}

function harness() {
	const create = vi.fn((_parentUuid: string | null, name: string) => Promise.resolve(sdkDir(name)))
	const upload = vi.fn((_parentUuid: string | null, _id: string, file: File) => Promise.resolve(sdkFile(file.name)))
	const listDirectory = vi.fn((uuid: string) => Promise.resolve(new Map(REMOTE[uuid] ?? [])))
	const deps: RunDirectoryUploadDeps = {
		createDirectory: { createDirectory: create, patchListing: vi.fn() },
		upload: {
			upload,
			store: { add: vi.fn(), startRunFile: vi.fn(), settleRunFile: vi.fn(), settle: vi.fn(), setItem: vi.fn(), remove: vi.fn() },
			patchCreated: vi.fn()
		},
		heic: { convert: { transform: vi.fn() }, readPreference: () => Promise.resolve(false) },
		merge: { listDirectory }
	}

	return { deps, create, upload, listDirectory }
}

async function mergePhotos(policy: NestedPolicy) {
	const h = harness()

	await runDirectoryUpload(h.deps, {
		rootParentUuid: testUuid("root"),
		dirs: LOCAL.dirs,
		files: LOCAL.files.map(relPath => ({ file: browserFile(relPath.slice(relPath.lastIndexOf("/") + 1)), relPath })),
		merges: new Map([["Photos", item(sdkDir("Photos", PHOTOS))]]),
		nested: policy
	})

	const uploads = h.upload.mock.calls.map(([parent, , file]) => `${parent ?? "root"}/${file.name}`).sort()

	return { ...h, uploads }
}

beforeEach(() => {
	discardUploadClaims()
})

describe("runDirectoryUpload merging into an existing directory", () => {
	it("lists only the directories that already exist, and creates only the new ones", async () => {
		const { listDirectory, create, uploads } = await mergePhotos("replace")

		expect(listDirectory.mock.calls.map(([uuid]) => uuid).sort()).toEqual([PHOTOS, YEAR].sort())
		expect(create.mock.calls.map(([parent, name]) => `${parent ?? "root"}/${name}`).sort()).toEqual([
			`${PHOTOS}/Fresh`,
			`${PHOTOS}/Sub (1)`
		])
		expect(uploads).toEqual(
			[
				`${PHOTOS}/a.jpg`,
				`${PHOTOS}/new.jpg`,
				`${YEAR}/b.jpg`,
				`${YEAR}/c.jpg`,
				`${testUuid("Fresh")}/d.jpg`,
				`${testUuid("Sub (1)")}/e.jpg`
			].sort()
		)
	})

	it("leaves out what exists under Skip, a directory a file holds the name of included", async () => {
		const { create, uploads } = await mergePhotos("skip")

		expect(create.mock.calls.map(([, name]) => name)).toEqual(["Fresh"])
		expect(uploads).toEqual([`${PHOTOS}/new.jpg`, `${YEAR}/c.jpg`, `${testUuid("Fresh")}/d.jpg`].sort())
	})

	it("numbers what exists under Keep both", async () => {
		const { uploads } = await mergePhotos("keepBoth")

		expect(uploads).toContain(`${PHOTOS}/a (1).jpg`)
		expect(uploads).toContain(`${YEAR}/b (1).jpg`)
		expect(uploads).not.toContain(`${PHOTOS}/a.jpg`)
	})

	it("lists nothing and creates every directory without a merge", async () => {
		const h = harness()

		await runDirectoryUpload(h.deps, {
			rootParentUuid: testUuid("root"),
			dirs: ["Photos", "Photos/2024"],
			files: [{ file: browserFile("b.jpg"), relPath: "Photos/2024/b.jpg" }]
		})

		expect(h.listDirectory).not.toHaveBeenCalled()
		expect(h.create).toHaveBeenCalledTimes(2)
	})

	it("creates a merged directory a listing did not name (another upload claims it) and lists it then", async () => {
		const h = harness()

		h.create.mockImplementation((_parent, name) => Promise.resolve(sdkDir(name, PHOTOS)))

		await runDirectoryUpload(h.deps, {
			rootParentUuid: testUuid("root"),
			dirs: ["Photos"],
			files: [{ file: browserFile("a.jpg"), relPath: "Photos/a.jpg" }],
			merges: new Map([["Photos", undefined]]),
			nested: "skip"
		})

		expect(h.create).toHaveBeenCalledTimes(1)
		expect(h.listDirectory).toHaveBeenCalledWith(PHOTOS)
		expect(h.upload).not.toHaveBeenCalled()
	})
})

describe("nested decisions", () => {
	function directory(held: HeldNames | null): RunDirectory {
		return { uuid: "u", held, allocated: new Set() }
	}

	it("numbers a local case variant in a directory the run created, never versioning it", () => {
		const fresh = directory(null)

		expect(nestedFileDecision(fresh, "a.txt", "replace")).toEqual({ action: "upload", name: "a.txt" })
		expect(nestedFileDecision(fresh, "A.TXT", "skip")).toEqual({ action: "upload", name: "A (1).TXT" })
	})

	it("treats a file onto a remote directory as Keep both unless skipping", () => {
		const merged = directory(heldNamesOf([item(sdkDir("docs"))]))

		expect(nestedFileDecision(merged, "docs", "replace")).toEqual({ action: "upload", name: "docs (1)" })
		expect(nestedFileDecision(directory(heldNamesOf([item(sdkDir("docs"))])), "docs", "skip")).toEqual({ action: "skip" })
	})

	it("merges a sub-directory into the remote directory of its name", () => {
		const merged = directory(heldNamesOf([item(sdkDir("2024", YEAR))]))

		expect(nestedDirectoryDecision(merged, "2024", "skip")).toEqual({ action: "merge", uuid: YEAR })
		expect(nestedDirectoryDecision(merged, "2025", "skip")).toEqual({ action: "create", name: "2025" })
	})
})

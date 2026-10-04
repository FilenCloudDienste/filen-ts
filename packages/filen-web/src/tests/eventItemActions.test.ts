import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File } from "@filen/sdk-rs"

// The real sdk client module imports a Vite `?worker`, unresolvable under node vitest; every case injects
// its own deps.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { itemDestination, locationDestination, lookupEventItem, type EventItemLookupDeps } from "@/features/settings/lib/eventItemActions"
import { narrowItem } from "@/features/drive/lib/item"
import type { RevealDeps } from "@/features/drive/lib/reveal"
import { testUuid } from "@/tests/support/uuid"

const ROOT = testUuid("root")
const HOME = testUuid("home")
const DOCS = testUuid("docs")
const STABLE = testUuid("stable")

function rawFile(uuid: string, overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid(uuid),
		stableUUID: STABLE,
		parent: DOCS,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name: "a.txt", mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } },
		...overrides
	}
}

function rawDir(uuid: string, overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: testUuid(uuid),
		parent: HOME,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: uuid } },
		...overrides
	}
}

function deps(overrides: Partial<EventItemLookupDeps> = {}): EventItemLookupDeps {
	return {
		getFile: vi.fn(() => Promise.resolve(undefined)),
		getFileByStableUuid: vi.fn(() => Promise.resolve(undefined)),
		getDirectory: vi.fn(() => Promise.resolve(undefined)),
		...overrides
	}
}

function revealDeps(ancestors: Dir[]): RevealDeps {
	return { fetchPath: () => Promise.resolve({ path: "", ancestors }) }
}

describe("lookupEventItem", () => {
	it("follows a file's stable id to its current head", async () => {
		const head = rawFile("head")
		const d = deps({ getFileByStableUuid: vi.fn(() => Promise.resolve(head)) })

		expect((await lookupEventItem({ type: "file", uuid: testUuid("old"), stableUuid: STABLE }, d))?.data.uuid).toBe(head.uuid)
		expect(d.getFile).not.toHaveBeenCalled()
	})

	it("reads a uuid-only file, then its head when it has a stable id", async () => {
		const head = rawFile("head")
		const d = deps({ getFile: vi.fn(() => Promise.resolve(rawFile("old"))), getFileByStableUuid: vi.fn(() => Promise.resolve(head)) })

		expect((await lookupEventItem({ type: "file", uuid: testUuid("old") }, d))?.data.uuid).toBe(head.uuid)
		expect(d.getFileByStableUuid).toHaveBeenCalledWith(STABLE)
	})

	it("is null once the item is gone", async () => {
		expect(await lookupEventItem({ type: "file", stableUuid: STABLE }, deps())).toBeNull()
		expect(await lookupEventItem({ type: "directory", uuid: DOCS }, deps())).toBeNull()
	})

	it("reads a directory by its uuid", async () => {
		const d = deps({ getDirectory: vi.fn(() => Promise.resolve(rawDir("docs"))) })

		expect((await lookupEventItem({ type: "directory", uuid: DOCS }, d))?.type).toBe("directory")
	})
})

describe("itemDestination", () => {
	it("opens the containing directory and reveals the item", async () => {
		const item = narrowItem(rawFile("a"))

		expect(await itemDestination(item, revealDeps([rawDir("home"), rawDir("docs")]))).toEqual({
			type: "listing",
			target: { to: "/drive/$", params: { _splat: `${HOME}/${DOCS}` } },
			reveal: item.data.uuid
		})
	})

	it("sends a trashed item to the trash without walking its path", async () => {
		const fetchPath = vi.fn()

		expect(await itemDestination(narrowItem(rawFile("a", { parent: "trash" })), { fetchPath })).toEqual({
			type: "trash",
			reveal: testUuid("a")
		})
		expect(fetchPath).not.toHaveBeenCalled()
	})

	it("fails when the walk fails", async () => {
		const outcome = await itemDestination(narrowItem(rawFile("a")), { fetchPath: () => Promise.reject(new Error("boom")) })

		expect(outcome.type).toBe("error")
	})
})

describe("locationDestination", () => {
	it("opens the drive root without a lookup", async () => {
		const d = deps()

		expect(await locationDestination(ROOT, ROOT, d, revealDeps([]))).toEqual({
			type: "listing",
			target: { to: "/drive/$", params: { _splat: "" } }
		})
		expect(d.getDirectory).not.toHaveBeenCalled()
	})

	it("opens the directory itself: its parent's chain plus its own uuid", async () => {
		const d = deps({ getDirectory: vi.fn(() => Promise.resolve(rawDir("docs"))) })

		expect(await locationDestination(DOCS, ROOT, d, revealDeps([rawDir("home")]))).toEqual({
			type: "listing",
			target: { to: "/drive/$", params: { _splat: `${HOME}/${DOCS}` } }
		})
		expect(await locationDestination(DOCS, ROOT, d, revealDeps([]))).toEqual({
			type: "listing",
			target: { to: "/drive/$", params: { _splat: DOCS } }
		})
	})

	it("is gone, or in the trash", async () => {
		expect(await locationDestination(DOCS, ROOT, deps(), revealDeps([]))).toEqual({ type: "gone" })
		expect(
			await locationDestination(
				DOCS,
				ROOT,
				deps({ getDirectory: vi.fn(() => Promise.resolve(rawDir("docs", { parent: "trash" }))) }),
				revealDeps([])
			)
		).toEqual({ type: "trash", reveal: DOCS })
	})
})

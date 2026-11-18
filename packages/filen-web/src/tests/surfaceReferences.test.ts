import { describe, expect, it, vi } from "vitest"
import type { LinkedDir } from "@filen/sdk-rs"
import { storeOf } from "@/tests/support/archiveEntries"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import { linkedFileItem, mockLinkedFile } from "@/tests/fixtures/sdk"

// A public link's and an archive's references: their own listings as the walker reads them.

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { openEntryReader: vi.fn(), releaseEntryReader: vi.fn(), cancelPreviewDownload: vi.fn() } }))

const SOURCE = { uuid: "archive-0000-0000-0000-000000000000", name: "models.zip", size: 100 } as unknown as ArchiveSource
const DIRECT = { type: "direct", packedBytes: 10n } as const

describe("entryReferences", () => {
	it("finds an entry's siblings and the entries below its directory, and a member it cannot read alone as such", async () => {
		const { entryListing, entryReferences } = await import("@/features/archive/lib/entryReferences")
		const store = storeOf([
			{ path: "models/", index: 0 },
			{ path: "models/mesh.obj", index: 1, access: DIRECT, size: 10 },
			{ path: "models/mesh.mtl", index: 2, access: DIRECT, size: 20 },
			{ path: "models/textures/", index: 3 },
			{ path: "models/textures/wood.png", index: 4, access: DIRECT, size: 30 },
			{ path: "models/tarred.png", index: 5, access: { type: "sequential" }, size: 5 },
			{ path: "above.png", index: 6, access: DIRECT, size: 5 }
		])
		const resolve = entryReferences(SOURCE, store, 1, undefined, "authed")(linkedFileItem("mesh.obj"))

		expect(resolve).not.toBeNull()

		if (resolve === null) return

		expect(await resolve("mesh.mtl")).toMatchObject({ status: "found", size: 20 })
		expect(await resolve("Textures/WOOD.png")).toMatchObject({ status: "found", size: 30 })
		expect(await resolve("tarred.png")).toEqual({ status: "unreadable" })
		expect(await resolve("../above.png")).toEqual({ status: "refused" })
		expect(await resolve("above.png")).toEqual({ status: "missing" })

		const root = store.parent(store.slotOfIndex(1))

		expect(entryListing(SOURCE, store, root).files.map(([name]) => name)).toEqual(["mesh.obj", "mesh.mtl", "tarred.png"])
	})

	it("reads no texture a cost the user accepted does not cover: above E3's block, or before a solid cost was accepted", async () => {
		const { entryReferences } = await import("@/features/archive/lib/entryReferences")
		const solid = (skipped: number, block: number) =>
			({
				type: "solidBlock",
				skippedBytes: BigInt(skipped),
				estimatedPackedBytes: BigInt(skipped + 10),
				blockPackedBytes: BigInt(block)
			}) as const
		const store = storeOf([
			{ path: "mesh.obj", index: 0, access: solid(0, 100), size: 10 },
			{ path: "first.png", index: 1, access: solid(0, 100), size: 10 },
			{ path: "later.png", index: 2, access: solid(20, 100), size: 10 },
			{ path: "huge.png", index: 3, access: solid(0, 513 * 1024 * 1024), size: 10 }
		])
		const resolver = (accepted: boolean) => {
			const resolve = entryReferences(SOURCE, store, 0, undefined, "authed", () => accepted)(linkedFileItem("mesh.obj"))

			if (resolve === null) throw new Error("no resolver")

			return resolve
		}
		const asking = resolver(false)

		expect(await asking("first.png")).toMatchObject({ status: "found" })
		expect(await asking("later.png")).toEqual({ status: "unreadable" })
		expect(await asking("huge.png")).toEqual({ status: "unreadable" })

		const accepted = resolver(true)

		expect(await accepted("later.png")).toMatchObject({ status: "found" })
		expect(await accepted("huge.png")).toEqual({ status: "unreadable" })
	})

	it("resolves nothing for an entry no longer listed", async () => {
		const { entryReferences } = await import("@/features/archive/lib/entryReferences")

		expect(entryReferences(SOURCE, storeOf([]), 9, undefined, "authed")(linkedFileItem("mesh.obj"))).toBeNull()
	})
})

describe("linkListing", () => {
	it("lists a link level's files as unauthenticated reads and its directories by their handles", async () => {
		const { linkListing } = await import("@/features/publicLinks/lib/linkReferences")
		const file = mockLinkedFile({ name: { Decrypted: "mesh.mtl" } })
		const dir = { inner: { uuid: "d", meta: { type: "decoded", data: { name: "textures" } } } } as unknown as LinkedDir
		const listing = linkListing([
			{ kind: "dir", item: { type: "directory", data: { uuid: "d", decryptedMeta: { name: "textures" } } } as never, dir },
			{ kind: "file", item: linkedFileItem("mesh.mtl"), file: file as never }
		])

		expect(listing.dirs).toEqual([["textures", dir]])
		expect(listing.files).toEqual([["mesh.mtl", { kind: "linkedFile", file }]])
	})
})

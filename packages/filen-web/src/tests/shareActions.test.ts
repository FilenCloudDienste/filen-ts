import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Contact, Dir, File, SharedFile, SharedRootDir, SharingRole, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import type { ErrorDTO } from "@/lib/sdk/errors"

// The real sdk client module imports a Vite `?worker`, unresolvable under node vitest — mock it down
// to the ops this file exercises, mirroring driveActions.test.ts's mock boundary.
const { shareDirectory, shareFile, removeSharedItem } = vi.hoisted(() => ({
	shareDirectory: vi.fn(),
	shareFile: vi.fn(),
	removeSharedItem: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		shareDirectory,
		shareFile,
		removeSharedItem
	}
}))

// A bare, unconfigured QueryClient stands in for the real singleton — same rationale as
// driveActions.test.ts: this helper only needs genuine invalidateQueries mechanics, never the
// production client's OPFS-backed persistence pipeline.
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import { driveListingQueryKey } from "@/features/drive/queries/drive"
import { shareItems, unshareItems } from "@/features/drive/lib/share/actions"

beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
})

// UuidStr is a template-literal brand requiring at least 3 dashes — pad a short readable label into a
// shape that satisfies it, mirroring driveActions.test.ts's own fixture.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
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
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

function dirItem(overrides: Partial<Dir> = {}): Extract<DriveItem, { type: "directory" }> {
	const item = narrowItem(mockDir(overrides))
	if (item.type !== "directory") {
		throw new Error("expected a directory arm")
	}
	return item
}

function fileItem(overrides: Partial<File> = {}): Extract<DriveItem, { type: "file" }> {
	const item = narrowItem(mockFile(overrides))
	if (item.type !== "file") {
		throw new Error("expected a file arm")
	}
	return item
}

function sharerRole(id: number, email: string): SharingRole {
	return { Sharer: { email, id } }
}

function mockSharedRootDir(overrides: Partial<SharedRootDir> = {}): SharedRootDir {
	return {
		inner: {
			uuid: testUuid("sroot"),
			color: "default",
			timestamp: 1_700_000_000_000n,
			meta: { type: "decoded", data: { name: "SharedRoot" } }
		},
		sharingRole: sharerRole(42, "sharer@filen.io"),
		writeAccess: true,
		...overrides
	}
}

function mockSharedFile(overrides: Partial<SharedFile> = {}): SharedFile {
	return {
		uuid: testUuid("sfile"),
		size: 2_048n,
		region: "de-1",
		bucket: "filen-1",
		chunks: 2n,
		timestamp: 1_700_000_000_000n,
		meta: {
			type: "decoded",
			data: { name: "shared.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 2_048n, key: "k", version: 2 }
		},
		sharingRole: sharerRole(7, "receiver@filen.io"),
		sharedTag: true,
		...overrides
	}
}

// Returns the raw wasm fixture ALONGSIDE the narrowed item — unshareItems' whole point is that it
// forwards the untouched raw (`shareSource`), never the flattened `data`, so tests need the raw's own
// reference to assert against, not just what narrowItem derived from it.
function sharedRootDirFixture(overrides: Partial<SharedRootDir> = {}): {
	raw: SharedRootDir
	item: Extract<DriveItem, { type: "sharedRootDirectory" }>
} {
	const raw = mockSharedRootDir(overrides)
	const item = narrowItem(raw)

	if (item.type !== "sharedRootDirectory") {
		throw new Error("expected a sharedRootDirectory arm")
	}

	return { raw, item }
}

function sharedRootFileFixture(overrides: Partial<SharedFile> = {}): {
	raw: SharedFile
	item: Extract<DriveItem, { type: "sharedRootFile" }>
} {
	const raw = mockSharedFile(overrides)
	const item = narrowItem(raw)

	if (item.type !== "sharedRootFile") {
		throw new Error("expected a sharedRootFile arm")
	}

	return { raw, item }
}

function mockContact(label: string): Contact {
	return {
		uuid: testUuid(label),
		userId: 1n,
		email: `${label}@example.com`,
		nickName: undefined,
		lastActive: 0n,
		timestamp: 0n,
		publicKey: "pk"
	}
}

// Worker-boundary errors arrive as plain DTOs (the Comlink proxy throws toErrorDTO output) — mirrors
// driveActions.test.ts's sdkDto fixture.
function sdkDto(kind: string): ErrorDTO {
	return { species: "sdk", kind, message: `${kind} message`, label: `${kind} label` }
}

function sharedOutRoot() {
	return driveListingQueryKey({ variant: "sharedOut", uuid: null })
}

function sharedInRoot() {
	return driveListingQueryKey({ variant: "sharedIn", uuid: null })
}

describe("shareItems", () => {
	it("shares N items × M contacts = N×M calls, routing directories to shareDirectory and files to shareFile", async () => {
		const dir = dirItem({ uuid: testUuid("d") })
		const file = fileItem({ uuid: testUuid("f") })
		const alice = mockContact("alice")
		const bob = mockContact("bob")
		const carol = mockContact("carol")
		shareDirectory.mockResolvedValue(undefined)
		shareFile.mockResolvedValue(undefined)

		const outcome = await shareItems([dir, file], [alice, bob, carol])

		expect(outcome.succeeded).toEqual([dir, file])
		expect(outcome.failed).toEqual([])
		// 2 items × 3 contacts: the directory took all three via shareDirectory, the file all three via
		// shareFile.
		expect(shareDirectory).toHaveBeenCalledTimes(3)
		expect(shareFile).toHaveBeenCalledTimes(3)
		for (const contact of [alice, bob, carol]) {
			expect(shareDirectory).toHaveBeenCalledWith(dir.data, contact)
			expect(shareFile).toHaveBeenCalledWith(file.data, contact)
		}
	})

	it("shares each contact for one item in sequence (no concurrency machinery)", async () => {
		const dir = dirItem({ uuid: testUuid("d") })
		const contacts = [mockContact("a"), mockContact("b"), mockContact("c")]
		const seen: string[] = []
		shareDirectory.mockImplementation((_dir: Dir, contact: Contact) => {
			seen.push(contact.email)
			return Promise.resolve()
		})

		await shareItems([dir], contacts)

		expect(seen).toEqual(["a@example.com", "b@example.com", "c@example.com"])
	})

	it("partial failure: an item whose sibling fails still reports the succeeded one, both correctly split", async () => {
		const ok = dirItem({ uuid: testUuid("ok") })
		const bad = dirItem({ uuid: testUuid("bad") })
		const contact = mockContact("alice")
		const dto = sdkDto("Forbidden")
		// items.map dispatches synchronously in array order (each callback's first await is its
		// shareDirectory call), so [ok, bad] queues these two outcomes in order — same call-order
		// technique as driveActions.test.ts's moveItems partial-failure test.
		shareDirectory.mockResolvedValueOnce(undefined).mockRejectedValueOnce(dto)

		const outcome = await shareItems([ok, bad], [contact])

		expect(outcome.succeeded).toEqual([ok])
		expect(outcome.failed).toEqual([{ item: bad, error: dto }])
	})

	it("an item fails if ANY of its contacts fails, but every contact is still attempted", async () => {
		const dir = dirItem({ uuid: testUuid("d") })
		const good = mockContact("good")
		const bad = mockContact("bad")
		const alsoGood = mockContact("also-good")
		const dto = sdkDto("Forbidden")
		// One item, contacts share sequentially (good, then bad, then alsoGood) — bad's rejection is
		// caught per-contact instead of throwing out of the loop, so alsoGood still gets its turn.
		shareDirectory.mockResolvedValueOnce(undefined).mockRejectedValueOnce(dto).mockResolvedValueOnce(undefined)

		const outcome = await shareItems([dir], [good, bad, alsoGood])

		expect(outcome.succeeded).toEqual([])
		expect(outcome.failed).toEqual([{ item: dir, error: dto }])
		// all three contacts were attempted despite bad's mid-list rejection — the item still fails
		// overall, but alsoGood is never stranded behind bad the way it used to be.
		expect(shareDirectory).toHaveBeenCalledTimes(3)
		expect(shareDirectory).toHaveBeenNthCalledWith(1, dir.data, good)
		expect(shareDirectory).toHaveBeenNthCalledWith(2, dir.data, bad)
		expect(shareDirectory).toHaveBeenNthCalledWith(3, dir.data, alsoGood)
	})

	it("keeps the FIRST failing contact's error when multiple contacts fail (LABEL-FIRST)", async () => {
		const dir = dirItem({ uuid: testUuid("d") })
		const firstBad = mockContact("first-bad")
		const secondBad = mockContact("second-bad")
		const firstDto = sdkDto("Forbidden")
		const secondDto = sdkDto("RateLimited")
		shareDirectory.mockRejectedValueOnce(firstDto).mockRejectedValueOnce(secondDto)

		const outcome = await shareItems([dir], [firstBad, secondBad])

		expect(outcome.succeeded).toEqual([])
		// secondBad is still attempted (both calls fire), but the item's reported error stays pinned to
		// the first rejection rather than being overwritten by the second.
		expect(shareDirectory).toHaveBeenCalledTimes(2)
		expect(outcome.failed).toEqual([{ item: dir, error: firstDto }])
	})

	it("invalidates the shared-with-others root listing after at least one item succeeds", async () => {
		const dir = dirItem({ uuid: testUuid("d") })
		const invalidateSpy = vi.spyOn(testQueryClient, "invalidateQueries")
		shareDirectory.mockResolvedValue(undefined)

		await shareItems([dir], [mockContact("alice")])

		expect(invalidateSpy).toHaveBeenCalledExactlyOnceWith({ queryKey: sharedOutRoot() })
	})

	it("does NOT invalidate when every item failed (nothing changed server-side)", async () => {
		const dir = dirItem({ uuid: testUuid("d") })
		const invalidateSpy = vi.spyOn(testQueryClient, "invalidateQueries")
		shareDirectory.mockRejectedValue(sdkDto("Forbidden"))

		const outcome = await shareItems([dir], [mockContact("alice")])

		expect(outcome.succeeded).toEqual([])
		expect(invalidateSpy).not.toHaveBeenCalled()
	})

	it("resolves to an empty split on an empty selection without calling the worker or invalidating", async () => {
		const invalidateSpy = vi.spyOn(testQueryClient, "invalidateQueries")

		const outcome = await shareItems([], [mockContact("alice")])

		expect(outcome).toEqual({ succeeded: [], failed: [] })
		expect(shareDirectory).not.toHaveBeenCalled()
		expect(shareFile).not.toHaveBeenCalled()
		expect(invalidateSpy).not.toHaveBeenCalled()
	})
})

describe("unshareItems", () => {
	it("calls removeSharedItem with EXACTLY the retained shareSource raw (same reference) — directory arm", async () => {
		const { raw, item } = sharedRootDirFixture()
		removeSharedItem.mockResolvedValue(undefined)

		await unshareItems([item], "sharedOut")

		expect(removeSharedItem).toHaveBeenCalledExactlyOnceWith(raw)
		expect(removeSharedItem.mock.calls[0]?.[0]).toBe(raw) // same reference, not a reconstruction
		// The flattened `data` is a DIFFERENT shape (no `inner`) — never what crosses to the worker.
		expect(removeSharedItem).not.toHaveBeenCalledWith(item.data)
	})

	it("calls removeSharedItem with EXACTLY the retained shareSource raw (same reference) — file arm", async () => {
		const { raw, item } = sharedRootFileFixture()
		removeSharedItem.mockResolvedValue(undefined)

		await unshareItems([item], "sharedIn")

		expect(removeSharedItem).toHaveBeenCalledExactlyOnceWith(raw)
		expect(removeSharedItem.mock.calls[0]?.[0]).toBe(raw)
		expect(removeSharedItem).not.toHaveBeenCalledWith(item.data)
	})

	it("reports a per-item BulkOutcome across a mixed directory+file selection", async () => {
		// sharedRootDirFixture/sharedRootFileFixture default to distinct uuids (sroot/sfile) — no
		// override needed for these two to coexist.
		const { item: dir } = sharedRootDirFixture()
		const { item: file } = sharedRootFileFixture()
		removeSharedItem.mockResolvedValue(undefined)

		const outcome = await unshareItems([dir, file], "sharedOut")

		expect(outcome.succeeded).toEqual([dir, file])
		expect(outcome.failed).toEqual([])
		expect(removeSharedItem).toHaveBeenCalledTimes(2)
	})

	it("patches the sharedOut ROOT listing (removeByUuid) on success, leaving a sibling row intact", async () => {
		const { item: target } = sharedRootDirFixture()
		const { item: sibling } = sharedRootFileFixture()
		testQueryClient.setQueryData(sharedOutRoot(), [target, sibling])
		removeSharedItem.mockResolvedValue(undefined)

		await unshareItems([target], "sharedOut")

		expect(testQueryClient.getQueryData(sharedOutRoot())).toEqual([sibling])
	})

	it("patches the sharedIn ROOT listing (not sharedOut) when variant is sharedIn", async () => {
		const { item: target } = sharedRootFileFixture({ uuid: testUuid("in-target") })
		testQueryClient.setQueryData(sharedInRoot(), [target])
		removeSharedItem.mockResolvedValue(undefined)

		await unshareItems([target], "sharedIn")

		expect(testQueryClient.getQueryData(sharedInRoot())).toEqual([])
	})

	it("does NOT patch the listing when removeSharedItem rejects", async () => {
		const { item: target } = sharedRootDirFixture()
		testQueryClient.setQueryData(sharedOutRoot(), [target])
		const dto = sdkDto("Forbidden")
		removeSharedItem.mockRejectedValue(dto)

		const outcome = await unshareItems([target], "sharedOut")

		expect(outcome.failed).toEqual([{ item: target, error: dto }])
		expect(testQueryClient.getQueryData(sharedOutRoot())).toEqual([target])
	})

	it("a cache miss (nobody has viewed the listing yet) is a no-op patch, not a conjured empty array", async () => {
		const { item: target } = sharedRootFileFixture({ uuid: testUuid("nocache") })
		removeSharedItem.mockResolvedValue(undefined)

		await unshareItems([target], "sharedOut")

		expect(testQueryClient.getQueryData(sharedOutRoot())).toBeUndefined()
	})

	it("guards against a non-root item (defense-in-depth — the UI never gates one through): the item fails, removeSharedItem is never called", async () => {
		const plainDir = dirItem({ uuid: testUuid("plain") })

		const outcome = await unshareItems([plainDir], "sharedOut")

		expect(outcome.succeeded).toEqual([])
		expect(outcome.failed).toHaveLength(1)
		expect(outcome.failed[0]?.item).toBe(plainDir)
		expect(removeSharedItem).not.toHaveBeenCalled()
	})

	it("resolves to an empty split on an empty selection without calling the worker", async () => {
		const outcome = await unshareItems([], "sharedOut")

		expect(outcome).toEqual({ succeeded: [], failed: [] })
		expect(removeSharedItem).not.toHaveBeenCalled()
	})
})

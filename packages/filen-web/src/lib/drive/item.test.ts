import { describe, expect, it } from "vitest"
import type { Dir, File, UuidStr, SharedDir, SharedRootDir, SharedFile, SharingRole } from "@filen/sdk-rs"
import {
	asDirectoryOrFile,
	getSharerIdentity,
	keepAgainstIncomingDriveItem,
	narrowItem,
	upsertDriveItem,
	type DriveItem
} from "@/lib/drive/item"

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a short
// readable test label into a shape that satisfies it, mirroring queries/drive.test.ts's own fixture.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: "11111111-1111-1111-1111-111111111111",
		parent: "22222222-2222-2222-2222-222222222222",
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } },
		...overrides
	}
}

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: "33333333-3333-3333-3333-333333333333",
		parent: "22222222-2222-2222-2222-222222222222",
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

describe("narrowItem", () => {
	it("narrows a decoded directory: populated decryptedMeta, undecryptable false, synthetic 0n size", () => {
		const item = narrowItem(mockDir())

		if (item.type !== "directory") {
			throw new Error("expected a directory arm")
		}

		expect(item.data.decryptedMeta).toEqual({ name: "Documents" })
		expect(item.data.undecryptable).toBe(false)
		expect(item.data.size).toBe(0n) // synthetic — Dir has no native size field
		expect(item.data.uuid).toBe("11111111-1111-1111-1111-111111111111") // pass-through fields survive the spread
		expect(item.data.color).toBe("default")
	})

	it("narrows a decoded file: populated decryptedMeta, undecryptable false, native size preserved", () => {
		const item = narrowItem(mockFile())

		if (item.type !== "file") {
			throw new Error("expected a file arm")
		}

		expect(item.data.decryptedMeta).toEqual(expect.objectContaining({ name: "report.pdf", mime: "application/pdf", version: 2 }))
		expect(item.data.undecryptable).toBe(false)
		expect(item.data.size).toBe(1_024n) // native File.size, not synthesized
	})

	it("marks a non-decoded directory meta as undecryptable with a null decryptedMeta", () => {
		const item = narrowItem(mockDir({ meta: { type: "encrypted", data: "ciphertext" } }))

		if (item.type !== "directory") {
			throw new Error("expected a directory arm")
		}

		expect(item.data.decryptedMeta).toBeNull()
		expect(item.data.undecryptable).toBe(true)
	})

	it("marks a non-decoded file meta as undecryptable with a null decryptedMeta", () => {
		const item = narrowItem(mockFile({ meta: { type: "encrypted", data: "ciphertext" } }))

		if (item.type !== "file") {
			throw new Error("expected a file arm")
		}

		expect(item.data.decryptedMeta).toBeNull()
		expect(item.data.undecryptable).toBe(true)
	})

	it("preserves bigint fields exactly, including magnitudes beyond Number.MAX_SAFE_INTEGER", () => {
		const hugeSize = 9_007_199_254_740_993n // 2^53 + 1 — would lose precision through Number()
		const item = narrowItem(mockFile({ size: hugeSize, timestamp: 1_234_567_890_123n, chunks: 42n }))

		if (item.type !== "file") {
			throw new Error("expected a file arm")
		}

		expect(item.data.size).toBe(hugeSize)
		expect(item.data.timestamp).toBe(1_234_567_890_123n)
		expect(item.data.chunks).toBe(42n)
	})

	it("narrows DriveItem.data by type at compile time — a file arm exposes mime, a directory arm cannot", () => {
		const fileItem = narrowItem(mockFile())
		if (fileItem.type === "file") {
			expect(fileItem.data.decryptedMeta?.mime).toBe("application/pdf")
		}

		const dirItem = narrowItem(mockDir())
		if (dirItem.type === "directory") {
			// @ts-expect-error -- a directory's decryptedMeta (DecryptedDirMeta) has no mime field; this
			// line must stay a type error, or the union has stopped narrowing `data` by `type`.
			void dirItem.data.decryptedMeta?.mime
		}
	})
})

// Named after a short label (padded to a valid UuidStr) so failures read as "which fixture" rather
// than "some directory".
function namedDir(uuidLabel: string, name: string, overrides: Partial<Dir> = {}): DriveItem {
	return narrowItem(mockDir({ uuid: testUuid(uuidLabel), meta: { type: "decoded", data: { name } }, ...overrides }))
}

function undecryptableDir(uuidLabel: string): DriveItem {
	return narrowItem(mockDir({ uuid: testUuid(uuidLabel), meta: { type: "encrypted", data: "ciphertext" } }))
}

describe("keepAgainstIncomingDriveItem", () => {
	it("drops the existing row when its uuid matches the incoming item", () => {
		const existing = namedDir("same-uuid", "a.txt")
		const incoming = namedDir("same-uuid", "b.txt")

		expect(keepAgainstIncomingDriveItem(existing, incoming)).toBe(false)
	})

	it("drops an existing same-name (case/space-insensitive) duplicate with a different uuid", () => {
		const existing = namedDir("old-uuid", "  Notes ")
		const incoming = namedDir("new-uuid", "notes")

		expect(keepAgainstIncomingDriveItem(existing, incoming)).toBe(false)
	})

	it("keeps an unrelated decryptable row (different uuid AND different name)", () => {
		const existing = namedDir("old-uuid", "other")
		const incoming = namedDir("new-uuid", "notes")

		expect(keepAgainstIncomingDriveItem(existing, incoming)).toBe(true)
	})

	it("keeps an existing undecryptable sibling when the incoming item is also undecryptable", () => {
		// Both names undefined — must NOT be treated as a same-name collision.
		const existing = undecryptableDir("existing-uuid")
		const incoming = undecryptableDir("incoming-uuid")

		expect(keepAgainstIncomingDriveItem(existing, incoming)).toBe(true)
	})

	it("keeps an existing undecryptable sibling when the incoming item is decryptable", () => {
		const existing = undecryptableDir("existing-uuid")
		const incoming = namedDir("incoming-uuid", "notes")

		expect(keepAgainstIncomingDriveItem(existing, incoming)).toBe(true)
	})

	it("keeps a decryptable row when the incoming item is undecryptable (name undefined)", () => {
		const existing = namedDir("existing-uuid", "notes")
		const incoming = undecryptableDir("incoming-uuid")

		expect(keepAgainstIncomingDriveItem(existing, incoming)).toBe(true)
	})
})

describe("upsertDriveItem", () => {
	it("appends the incoming item when nothing collides", () => {
		const a = namedDir("uuid-a", "a")
		const b = namedDir("uuid-b", "b")

		expect(upsertDriveItem([a], b)).toEqual([a, b])
	})

	it("replaces (not duplicates) an existing row on a uuid match — the idempotent-create case", () => {
		// createDirectory's backend is idempotent: creating an already-existing name returns THAT
		// directory's own uuid. The returned item must replace its stale cached copy, never duplicate.
		const stale = namedDir("same-uuid", "Docs", { favorited: false })
		const other = namedDir("uuid-b", "b")
		const fresh = namedDir("same-uuid", "Docs", { favorited: true })

		const result = upsertDriveItem([stale, other], fresh)

		expect(result).toHaveLength(2)
		expect(result).toEqual([other, fresh])
	})

	it("replaces (not duplicates) an existing row on a case/space-insensitive name match, different uuid", () => {
		const stale = namedDir("old-uuid", " Docs ")
		const fresh = namedDir("new-uuid", "docs")

		const result = upsertDriveItem([stale], fresh)

		expect(result).toEqual([fresh])
	})

	it("never mutates the input array", () => {
		const a = namedDir("uuid-a", "a")
		const items = [a]

		upsertDriveItem(items, namedDir("uuid-b", "b"))

		expect(items).toEqual([a])
	})
})

// Drive action worker ops (sdk.worker.ts: renameDirectory, moveDirectory, trashFile, …) declare
// their held-item parameter as the plain wasm Dir/File shape, but every real caller only ever holds
// a DriveItem — Dir/File plus ExtraData plus decryptedMeta. These two assignments only need to
// TYPECHECK: if DriveItem's arms ever stopped being a structural superset of Dir/File, this file
// would fail `npm run typecheck` (no adapter/stripper exists anywhere, by design — see the worker's
// own comment on this). Runtime toleration of the extra own fields crossing the wasm boundary is a
// separate, already-verified concern (no serde deny_unknown_fields); confirming it against a live
// authed call is deferred to QA, since this environment has no session to log in with.
describe("DriveItem.data assignability to the plain SDK shapes the worker's action ops declare", () => {
	it("a narrowed directory's data satisfies Dir with no adapter", () => {
		const item = narrowItem(mockDir())
		if (item.type !== "directory") {
			throw new Error("expected a directory arm")
		}

		const asWorkerParam: Dir = item.data

		expect(asWorkerParam.uuid).toBe(item.data.uuid)
	})

	it("a narrowed file's data satisfies File with no adapter", () => {
		const item = narrowItem(mockFile())
		if (item.type !== "file") {
			throw new Error("expected a file arm")
		}

		const asWorkerParam: File = item.data

		expect(asWorkerParam.uuid).toBe(item.data.uuid)
	})
})

function sharerRole(id: number, email: string): SharingRole {
	return { Sharer: { email, id } }
}

function receiverRole(id: number, email: string): SharingRole {
	return { Receiver: { email, id } }
}

// The uniffi-style runtime shape the .d.ts doesn't model ({ tag, inner: [ShareInfo] }) — cast in so
// shareInfoFromRole's dual-surface read can be exercised against a SharingRole-typed value.
function runtimeRole(id: number, email: string): SharingRole {
	return { tag: "Sharer", inner: [{ email, id }] } as unknown as SharingRole
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

function mockSharedDir(overrides: Partial<SharedDir> = {}): SharedDir {
	return {
		inner: mockDir({ uuid: testUuid("sdir"), meta: { type: "decoded", data: { name: "SharedChild" } } }),
		sharedTag: true,
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
		sharingRole: receiverRole(7, "receiver@filen.io"),
		sharedTag: true,
		...overrides
	}
}

describe("narrowItem — shared arms", () => {
	it("narrows a SharedRootDir into a sharedRootDirectory with a Dir-shaped, role-carrying data", () => {
		const role = sharerRole(42, "sharer@filen.io")
		const item = narrowItem(mockSharedRootDir({ sharingRole: role }))

		if (item.type !== "sharedRootDirectory") {
			throw new Error("expected a sharedRootDirectory arm")
		}

		expect(item.data.uuid).toBe(testUuid("sroot")) // extracted from inner
		expect(item.data.decryptedMeta).toEqual({ name: "SharedRoot" })
		expect(item.data.size).toBe(0n)
		expect(item.data.sharingRole).toEqual(role)
		expect(item.data.writeAccess).toBe(true)
		expect(item.data.favorited).toBe(false) // synthesized inert
		expect(item.data.parent).toBe(testUuid("sroot")) // synthesized inert (self-uuid)
	})

	it("narrows a SharedFile into a sharedRootFile, preserving its native size and role", () => {
		const item = narrowItem(mockSharedFile())

		if (item.type !== "sharedRootFile") {
			throw new Error("expected a sharedRootFile arm")
		}

		expect(item.data.uuid).toBe(testUuid("sfile"))
		expect(item.data.size).toBe(2_048n) // native SharedFile.size, not synthesized
		expect(item.data.decryptedMeta?.mime).toBe("application/pdf")
		expect(item.data.sharingRole).toEqual(receiverRole(7, "receiver@filen.io"))
		expect(item.data.favorited).toBe(false)
		expect(item.data.canMakeThumbnail).toBe(false)
	})

	it("context-tags a nested SharedDir (parent role spread on) into a sharedDirectory", () => {
		const role = sharerRole(99, "owner@filen.io")
		const item = narrowItem({ ...mockSharedDir(), sharingRole: role })

		if (item.type !== "sharedDirectory") {
			throw new Error("expected a sharedDirectory arm")
		}

		expect(item.data.uuid).toBe(testUuid("sdir")) // extracted from inner Dir
		expect(item.data.decryptedMeta).toEqual({ name: "SharedChild" })
		expect(item.data.sharedTag).toBe(true)
		expect(item.data.sharingRole).toEqual(role) // spread from the parent
	})

	it("narrows a bare SharedDir (no spread role) into a sharedDirectory with an undefined role", () => {
		const item = narrowItem(mockSharedDir())

		if (item.type !== "sharedDirectory") {
			throw new Error("expected a sharedDirectory arm")
		}

		expect(item.data.sharingRole).toBeUndefined()
	})

	it("context-tags a nested File (parent role spread on) into a sharedFile", () => {
		const role = receiverRole(5, "peer@filen.io")
		const item = narrowItem({ ...mockFile({ uuid: testUuid("nested") }), sharingRole: role })

		if (item.type !== "sharedFile") {
			throw new Error("expected a sharedFile arm")
		}

		expect(item.data.uuid).toBe(testUuid("nested"))
		expect(item.data.sharingRole).toEqual(role)
		expect(item.data.sharedTag).toBe(true)
		expect(item.data.decryptedMeta?.mime).toBe("application/pdf")
	})
})

describe("asDirectoryOrFile", () => {
	it("passes a base directory/file arm through by reference", () => {
		const dir = narrowItem(mockDir())
		const file = narrowItem(mockFile())

		expect(asDirectoryOrFile(dir)).toBe(dir)
		expect(asDirectoryOrFile(file)).toBe(file)
	})

	it("maps both shared-directory arms to a directory view whose data satisfies Dir", () => {
		const nested = narrowItem({ ...mockSharedDir(), sharingRole: sharerRole(1, "a@filen.io") })
		const root = narrowItem(mockSharedRootDir())

		for (const item of [nested, root]) {
			const base = asDirectoryOrFile(item)

			if (base.type !== "directory") {
				throw new Error("expected a directory view")
			}

			const asDir: Dir = base.data // must satisfy the plain wasm Dir the worker's dir ops declare

			expect(asDir.uuid).toBe(item.data.uuid)
		}
	})

	it("maps both shared-file arms to a file view whose data satisfies File", () => {
		const nested = narrowItem({ ...mockFile({ uuid: testUuid("nf") }), sharingRole: receiverRole(2, "b@filen.io") })
		const root = narrowItem(mockSharedFile())

		for (const item of [nested, root]) {
			const base = asDirectoryOrFile(item)

			if (base.type !== "file") {
				throw new Error("expected a file view")
			}

			const asFile: File = base.data

			expect(asFile.uuid).toBe(item.data.uuid)
		}
	})
})

describe("getSharerIdentity", () => {
	it("returns null for the non-shared base arms", () => {
		expect(getSharerIdentity(narrowItem(mockDir()))).toBeNull()
		expect(getSharerIdentity(narrowItem(mockFile()))).toBeNull()
	})

	it("reads the role directly off a sharedRootFile", () => {
		expect(getSharerIdentity(narrowItem(mockSharedFile()))).toEqual({ userId: 7n, email: "receiver@filen.io" })
	})

	it("reads the role directly off a sharedRootDirectory", () => {
		const item = narrowItem(mockSharedRootDir({ sharingRole: sharerRole(42, "sharer@filen.io") }))
		expect(getSharerIdentity(item)).toEqual({ userId: 42n, email: "sharer@filen.io" })
	})

	it("reads the spread role off a nested sharedFile", () => {
		const item = narrowItem({ ...mockFile(), sharingRole: sharerRole(11, "owner@filen.io") })
		expect(getSharerIdentity(item)).toEqual({ userId: 11n, email: "owner@filen.io" })
	})

	it("reads the spread role off a nested sharedDirectory", () => {
		const item = narrowItem({ ...mockSharedDir(), sharingRole: receiverRole(13, "peer@filen.io") })
		expect(getSharerIdentity(item)).toEqual({ userId: 13n, email: "peer@filen.io" })
	})

	it("falls back to the injected resolver for a sharedDirectory with no spread role", () => {
		const item = narrowItem(mockSharedDir()) // no role spread → data.sharingRole undefined
		if (item.type !== "sharedDirectory") {
			throw new Error("expected a sharedDirectory arm")
		}

		const resolve = (uuid: string): SharingRole | undefined => (uuid === item.data.uuid ? sharerRole(21, "cached@filen.io") : undefined)

		expect(getSharerIdentity(item, resolve)).toEqual({ userId: 21n, email: "cached@filen.io" })
	})

	it("returns null for a roleless sharedDirectory when no resolver is given", () => {
		expect(getSharerIdentity(narrowItem(mockSharedDir()))).toBeNull()
	})

	it("normalizes ShareInfo.id (a number) to a bigint userId — never a raw number", () => {
		const identity = getSharerIdentity(narrowItem(mockSharedFile({ sharingRole: sharerRole(123456, "x@filen.io") })))

		expect(identity).not.toBeNull()
		expect(typeof identity?.userId).toBe("bigint")
		expect(identity?.userId).toBe(123456n)
	})

	it("reads the Sharer, the Receiver, and the uniffi-runtime {inner:[…]} SharingRole shapes alike", () => {
		const sharer = narrowItem(mockSharedFile({ sharingRole: sharerRole(1, "s@filen.io") }))
		const receiver = narrowItem(mockSharedFile({ sharingRole: receiverRole(2, "r@filen.io") }))
		const runtime = narrowItem(mockSharedFile({ sharingRole: runtimeRole(3, "u@filen.io") }))

		expect(getSharerIdentity(sharer)).toEqual({ userId: 1n, email: "s@filen.io" })
		expect(getSharerIdentity(receiver)).toEqual({ userId: 2n, email: "r@filen.io" })
		expect(getSharerIdentity(runtime)).toEqual({ userId: 3n, email: "u@filen.io" })
	})
})

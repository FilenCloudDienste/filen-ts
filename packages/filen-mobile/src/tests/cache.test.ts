import { vi, describe, it, expect } from "vitest"

// Stub SDK runtime values referenced by the cacheNew* helpers — without this mock the
// real SDK module would load its WASM bridge, which references `self` (undefined in node).
vi.mock("@filen/sdk-rs", () => {
	// Stub SDK wrapper constructors used by the cacheNew* helpers. Each records its tag and the
	// constructor arg(s) under `inner` so tests can assert what was wrapped, without loading the real
	// WASM bridge (which references `self`, undefined in node).
	const makeStub = (tag: string) =>
		class {
			public readonly tag = tag
			public readonly inner: unknown[]

			public constructor(...args: unknown[]) {
				this.inner = args
			}
		}

	return {
		AnyNormalDir: { Dir: makeStub("Dir") },
		AnySharedDir: { Dir: makeStub("SharedDir"), Root: makeStub("SharedRoot") },
		AnyLinkedDir: { Dir: makeStub("LinkedDir") },
		AnyDirWithContext: { Normal: makeStub("Normal"), Shared: makeStub("Shared"), Linked: makeStub("Linked") },
		AnySharedDirWithContext: { new: (arg: unknown) => ({ tag: "SharedDirWithContext", inner: [arg] }) },
		AnyLinkedDirWithContext: { new: (arg: unknown) => ({ tag: "LinkedDirWithContext", inner: [arg] }) }
	}
})

import { Cache } from "@/lib/cache"
import { type DriveItem } from "@/types"

function createCache(): Cache {
	return new Cache()
}

// Minimal DriveItem factories —————————————————————————————————————————————————

function makeFileDriveItem(uuid: string): Extract<DriveItem, { type: "file" }> {
	return {
		type: "file",
		data: {
			uuid,
			size: 1024n,
			undecryptable: false,
			decryptedMeta: { name: "test.txt", mime: "text/plain", key: "", created: 0n, modified: 0n },
			parent: "parent-uuid",
			region: "eu-west-1",
			bucket: "filen-1",
			chunks: 1,
			version: 2,
			key: "",
			rm: "",
			timestamp: 0n,
			favorited: false,
			tagged: false
		} as any
	}
}

function makeDirectoryDriveItem(uuid: string, name?: string): Extract<DriveItem, { type: "directory" }> {
	return {
		type: "directory",
		data: {
			uuid,
			size: 0n,
			undecryptable: false,
			decryptedMeta: name ? { name, color: null } : null,
			parent: "parent-uuid",
			timestamp: 0n,
			favorited: false,
			color: null
		} as any
	}
}

function makeSdkFile(uuid: string): any {
	return {
		uuid,
		parent: "parent-uuid",
		region: "eu-west-1",
		bucket: "filen-1",
		chunks: 1,
		version: 2,
		key: "",
		rm: "",
		timestamp: 0n,
		favorited: false,
		tagged: false
	}
}

function makeSdkDir(uuid: string): any {
	return {
		uuid,
		parent: "parent-uuid",
		timestamp: 0n,
		favorited: false,
		color: null
	}
}

// Shared / shared-root / linked SDK + DriveItem factories for the cacheNewShared*/Linked helpers.
function makeSdkSharedDir(uuid: string): any {
	return { uuid, sharingRole: "owner", inner: makeSdkDir(uuid), parent: "parent-uuid", timestamp: 0n, favorited: false }
}

function makeSdkSharedRootDir(uuid: string): any {
	return { uuid, sharingRole: "owner", parent: "parent-uuid", timestamp: 0n, favorited: false }
}

function makeSdkSharedFile(uuid: string): any {
	return { ...makeSdkFile(uuid), sharingRole: "owner" }
}

function makeSdkLinkedDir(uuid: string): any {
	return { uuid, inner: makeSdkDir(uuid) }
}

function makeSharedDirDriveItem(uuid: string, name?: string): any {
	return {
		type: "sharedDirectory",
		data: { uuid, size: 0n, undecryptable: false, decryptedMeta: name ? { name, color: null } : null, sharingRole: "owner" }
	}
}

function makeSharedRootDirDriveItem(uuid: string, name?: string): any {
	return {
		type: "sharedRootDirectory",
		data: { uuid, size: 0n, undecryptable: false, decryptedMeta: name ? { name, color: null } : null }
	}
}

function makeSharedFileDriveItem(uuid: string): any {
	return { type: "sharedFile", data: { uuid, size: 0n, undecryptable: false, decryptedMeta: null } }
}

function makeSharedRootFileDriveItem(uuid: string): any {
	return { type: "sharedRootFile", data: { uuid, size: 0n, undecryptable: false, decryptedMeta: null } }
}

function makeLinkMeta(): any {
	return { linkUuid: "l-uuid", linkKey: "key" }
}

// —————————————————————————————————————————————————————————————————————————————

describe("Cache", () => {
	describe("constructor", () => {
		it("starts with empty session-scoped maps", () => {
			const cache = createCache()

			expect(cache.uuidToAnyDriveItem.size).toBe(0)
			expect(cache.fileUuidToNormalFile.size).toBe(0)
			expect(cache.directoryUuidToAnySharedDirWithContext.size).toBe(0)
			expect(cache.directoryUuidToAnyNormalDir.size).toBe(0)
			expect(cache.directoryUuidToAnyLinkedDirWithMeta.size).toBe(0)
			expect(cache.chatAttachmentLayouts.size).toBe(0)
			expect(cache.secureStore.size).toBe(0)
			expect(cache.rootUuid).toBeNull()
		})
	})

	describe("clear", () => {
		it("empties the session-scoped metadata maps", () => {
			const cache = createCache()

			cache.uuidToAnyDriveItem.set("a", makeFileDriveItem("a"))
			cache.fileUuidToNormalFile.set("a", makeSdkFile("a"))
			cache.directoryUuidToAnySharedDirWithContext.set("a", {} as any)
			cache.directoryUuidToAnyNormalDir.set("a", {} as any)
			cache.directoryUuidToAnyLinkedDirWithMeta.set("a", { dir: {} as any, meta: {} as any })
			cache.chatAttachmentLayouts.set("a", { width: 1, height: 2 })

			cache.clear()

			expect(cache.uuidToAnyDriveItem.size).toBe(0)
			expect(cache.fileUuidToNormalFile.size).toBe(0)
			expect(cache.directoryUuidToAnySharedDirWithContext.size).toBe(0)
			expect(cache.directoryUuidToAnyNormalDir.size).toBe(0)
			expect(cache.directoryUuidToAnyLinkedDirWithMeta.size).toBe(0)
			expect(cache.chatAttachmentLayouts.size).toBe(0)
		})

		it("also clears secureStore", () => {
			const cache = createCache()

			cache.secureStore.set("secret-key", "secret-value")
			cache.secureStore.set("another-key", "another-value")

			expect(cache.secureStore.size).toBe(2)

			cache.clear()

			expect(cache.secureStore.size).toBe(0)
		})

		it("resets the session rootUuid to null", () => {
			const cache = createCache()

			cache.rootUuid = "root-uuid-session"

			cache.clear()

			expect(cache.rootUuid).toBeNull()
		})
	})

	describe("cacheNewFile", () => {
		it("inserts file into uuidToAnyDriveItem and fileUuidToNormalFile", () => {
			const cache = createCache()

			const uuid = "file-uuid-1"
			const sdkFile = makeSdkFile(uuid)
			const driveItem = makeFileDriveItem(uuid)

			cache.cacheNewFile(sdkFile, driveItem)

			expect(cache.uuidToAnyDriveItem.get(uuid)).toBe(driveItem)
			expect(cache.fileUuidToNormalFile.get(uuid)).toBe(sdkFile)
		})

		it("overwrites an existing file entry", () => {
			const cache = createCache()

			const uuid = "file-uuid-overwrite"
			const sdkFile1 = makeSdkFile(uuid)
			const sdkFile2 = { ...makeSdkFile(uuid), chunks: 99 }
			const driveItem1 = makeFileDriveItem(uuid)
			const driveItem2 = makeFileDriveItem(uuid)

			cache.cacheNewFile(sdkFile1, driveItem1)
			cache.cacheNewFile(sdkFile2, driveItem2)

			expect(cache.uuidToAnyDriveItem.get(uuid)).toBe(driveItem2)
			expect(cache.fileUuidToNormalFile.get(uuid)).toBe(sdkFile2)
		})
	})

	describe("cacheNewNormalDir", () => {
		it("inserts dir into uuidToAnyDriveItem and directoryUuidToAnyNormalDir", () => {
			const cache = createCache()

			const uuid = "dir-uuid-1"
			const sdkDir = makeSdkDir(uuid)
			const driveItem = makeDirectoryDriveItem(uuid, "My Documents")

			cache.cacheNewNormalDir(sdkDir, driveItem)

			expect(cache.uuidToAnyDriveItem.get(uuid)).toBe(driveItem)
			expect(cache.directoryUuidToAnyNormalDir.has(uuid)).toBe(true)
		})

		it("constructs an AnyNormalDir.Dir wrapper around the raw dir", () => {
			const cache = createCache()

			const uuid = "dir-uuid-wrapper"
			const sdkDir = makeSdkDir(uuid)
			const driveItem = makeDirectoryDriveItem(uuid, "Wrapped")

			cache.cacheNewNormalDir(sdkDir, driveItem)

			const normalDir = cache.directoryUuidToAnyNormalDir.get(uuid) as any

			// StubDir wraps the raw sdk dir
			expect(normalDir.tag).toBe("Dir")
			expect(normalDir.inner[0]).toBe(sdkDir)
		})
	})

	describe("cacheNewSharedDir", () => {
		it("seeds uuidToAnyDriveItem and the shared-context cache", () => {
			const cache = createCache()

			const uuid = "shared-dir-1"

			cache.cacheNewSharedDir(makeSdkSharedDir(uuid), makeSharedDirDriveItem(uuid, "Shared"), { sharedOut: false })

			expect(cache.uuidToAnyDriveItem.has(uuid)).toBe(true)
			expect(cache.directoryUuidToAnySharedDirWithContext.has(uuid)).toBe(true)
		})

		it("does NOT seed directoryUuidToAnyNormalDir for a shared-IN dir (sharedOut: false)", () => {
			const cache = createCache()

			const uuid = "shared-in-dir"

			cache.cacheNewSharedDir(makeSdkSharedDir(uuid), makeSharedDirDriveItem(uuid), { sharedOut: false })

			expect(cache.directoryUuidToAnyNormalDir.has(uuid)).toBe(false)
		})

		it("ALSO seeds directoryUuidToAnyNormalDir (from the inner dir) for a shared-OUT dir", () => {
			const cache = createCache()

			const uuid = "shared-out-dir"

			cache.cacheNewSharedDir(makeSdkSharedDir(uuid), makeSharedDirDriveItem(uuid), { sharedOut: true })

			expect(cache.directoryUuidToAnyNormalDir.has(uuid)).toBe(true)
		})
	})

	describe("cacheNewSharedRootDir", () => {
		it("seeds the shared-context cache for a shared root dir", () => {
			const cache = createCache()

			const uuid = "shared-root-dir"

			cache.cacheNewSharedRootDir(makeSdkSharedRootDir(uuid), makeSharedRootDirDriveItem(uuid, "Root"))

			expect(cache.uuidToAnyDriveItem.has(uuid)).toBe(true)
			expect(cache.directoryUuidToAnySharedDirWithContext.has(uuid)).toBe(true)
		})
	})

	describe("cacheNewSharedFile", () => {
		it("references a shared-IN file by uuid only (no fileUuidToNormalFile)", () => {
			const cache = createCache()

			const uuid = "shared-in-file"

			cache.cacheNewSharedFile(makeSdkSharedFile(uuid), makeSharedFileDriveItem(uuid), { sharedOut: false })

			expect(cache.uuidToAnyDriveItem.has(uuid)).toBe(true)
			expect(cache.fileUuidToNormalFile.has(uuid)).toBe(false)
		})

		it("ALSO seeds fileUuidToNormalFile with sharingRole stripped for a shared-OUT file", () => {
			const cache = createCache()

			const uuid = "shared-out-file"

			cache.cacheNewSharedFile(makeSdkSharedFile(uuid), makeSharedFileDriveItem(uuid), { sharedOut: true })

			expect(cache.fileUuidToNormalFile.has(uuid)).toBe(true)
			expect((cache.fileUuidToNormalFile.get(uuid) as { sharingRole?: unknown }).sharingRole).toBeUndefined()
		})
	})

	describe("cacheNewLinkedDir", () => {
		it("seeds the linked-meta cache when meta is present", () => {
			const cache = createCache()

			const uuid = "linked-dir"

			cache.cacheNewLinkedDir(makeSdkLinkedDir(uuid), makeDirectoryDriveItem(uuid, "Linked"), makeLinkMeta())

			expect(cache.uuidToAnyDriveItem.has(uuid)).toBe(true)
			expect(cache.directoryUuidToAnyLinkedDirWithMeta.has(uuid)).toBe(true)
		})

		it("seeds only uuid when meta is null (no linked-meta cache)", () => {
			const cache = createCache()

			const uuid = "linked-dir-nometa"

			cache.cacheNewLinkedDir(makeSdkLinkedDir(uuid), makeDirectoryDriveItem(uuid, "Linked"), null)

			expect(cache.uuidToAnyDriveItem.has(uuid)).toBe(true)
			expect(cache.directoryUuidToAnyLinkedDirWithMeta.has(uuid)).toBe(false)
		})
	})

	describe("cacheDriveItemReference", () => {
		it("seeds only uuidToAnyDriveItem, no derived caches", () => {
			const cache = createCache()

			const uuid = "ref-uuid"
			const item = makeSharedRootFileDriveItem(uuid)

			cache.cacheDriveItemReference(item)

			expect(cache.uuidToAnyDriveItem.get(uuid)).toBe(item)
			expect(cache.fileUuidToNormalFile.has(uuid)).toBe(false)
		})
	})

	describe("cacheDriveItem (dispatch by item type)", () => {
		it("dispatches a file to cacheNewFile (uuid + fileUuidToNormalFile)", () => {
			const cache = createCache()

			cache.cacheDriveItem(makeFileDriveItem("cdi-file"))

			expect(cache.uuidToAnyDriveItem.has("cdi-file")).toBe(true)
			expect(cache.fileUuidToNormalFile.has("cdi-file")).toBe(true)
		})

		it("dispatches a directory to the normal caches", () => {
			const cache = createCache()

			cache.cacheDriveItem(makeDirectoryDriveItem("cdi-dir", "D"))

			expect(cache.directoryUuidToAnyNormalDir.has("cdi-dir")).toBe(true)
		})

		it("dispatches a sharedDirectory WITH sharingRole to the shared caches (default sharedOut: false → no normal-dir view)", () => {
			const cache = createCache()

			cache.cacheDriveItem(makeSharedDirDriveItem("cdi-shared", "S"))

			expect(cache.directoryUuidToAnySharedDirWithContext.has("cdi-shared")).toBe(true)
			expect(cache.directoryUuidToAnyNormalDir.has("cdi-shared")).toBe(false)
		})

		it("passes opts.sharedOut through so a shared-OUT dir ALSO gets the normal-dir refinement", () => {
			const cache = createCache()

			cache.cacheDriveItem(makeSharedDirDriveItem("cdi-shared-out", "S"), { sharedOut: true })

			expect(cache.directoryUuidToAnySharedDirWithContext.has("cdi-shared-out")).toBe(true)
			expect(cache.directoryUuidToAnyNormalDir.has("cdi-shared-out")).toBe(true)
		})

		it("falls back to a uuid-only reference for a sharedDirectory WITHOUT sharingRole", () => {
			const cache = createCache()

			const item = makeSharedDirDriveItem("cdi-norole")

			delete (item.data as { sharingRole?: unknown }).sharingRole

			cache.cacheDriveItem(item)

			expect(cache.uuidToAnyDriveItem.has("cdi-norole")).toBe(true)
			expect(cache.directoryUuidToAnySharedDirWithContext.has("cdi-norole")).toBe(false)
		})

		it("dispatches a sharedRootDirectory to the shared caches", () => {
			const cache = createCache()

			cache.cacheDriveItem(makeSharedRootDirDriveItem("cdi-sharedroot", "R"))

			expect(cache.directoryUuidToAnySharedDirWithContext.has("cdi-sharedroot")).toBe(true)
		})

		it("references a sharedRootFile by uuid only", () => {
			const cache = createCache()

			cache.cacheDriveItem(makeSharedRootFileDriveItem("cdi-srf"))

			expect(cache.uuidToAnyDriveItem.has("cdi-srf")).toBe(true)
			expect(cache.fileUuidToNormalFile.has("cdi-srf")).toBe(false)
		})
	})

	describe("forgetItem", () => {
		it("removes uuid from all five session-scoped per-uuid maps", () => {
			const cache = createCache()

			const uuid = "forget-uuid-1"
			const sdkFile = makeSdkFile(uuid)
			const driveItem = makeFileDriveItem(uuid)

			cache.cacheNewFile(sdkFile, driveItem)

			// Manually seed the remaining maps
			cache.directoryUuidToAnyNormalDir.set(uuid, {} as any)
			cache.directoryUuidToAnySharedDirWithContext.set(uuid, {} as any)
			cache.directoryUuidToAnyLinkedDirWithMeta.set(uuid, { dir: {} as any, meta: {} as any })

			cache.forgetItem(uuid)

			expect(cache.uuidToAnyDriveItem.has(uuid)).toBe(false)
			expect(cache.fileUuidToNormalFile.has(uuid)).toBe(false)
			expect(cache.directoryUuidToAnyNormalDir.has(uuid)).toBe(false)
			expect(cache.directoryUuidToAnySharedDirWithContext.has(uuid)).toBe(false)
			expect(cache.directoryUuidToAnyLinkedDirWithMeta.has(uuid)).toBe(false)
		})

		it("removes directoryUuidToAnyLinkedDirWithMeta entry on forgetItem (regression: bug #12)", () => {
			const cache = createCache()

			const uuid = "linked-dir-forget-uuid"

			cache.directoryUuidToAnyLinkedDirWithMeta.set(uuid, { dir: { tag: "LinkedDir" } as any, meta: { uuid } as any })

			expect(cache.directoryUuidToAnyLinkedDirWithMeta.has(uuid)).toBe(true)

			cache.forgetItem(uuid)

			expect(cache.directoryUuidToAnyLinkedDirWithMeta.has(uuid)).toBe(false)
		})

		it("is a no-op for a uuid that was never cached", () => {
			const cache = createCache()

			// Should not throw even when uuid doesn't exist in any map
			expect(() => cache.forgetItem("nonexistent-uuid")).not.toThrow()
		})

		it("only removes the specific uuid, not other entries", () => {
			const cache = createCache()

			const uuid1 = "forget-specific-1"
			const uuid2 = "forget-specific-2"

			cache.cacheNewFile(makeSdkFile(uuid1), makeFileDriveItem(uuid1))
			cache.cacheNewFile(makeSdkFile(uuid2), makeFileDriveItem(uuid2))

			cache.forgetItem(uuid1)

			expect(cache.uuidToAnyDriveItem.has(uuid1)).toBe(false)
			expect(cache.uuidToAnyDriveItem.has(uuid2)).toBe(true)
			expect(cache.fileUuidToNormalFile.has(uuid1)).toBe(false)
			expect(cache.fileUuidToNormalFile.has(uuid2)).toBe(true)
		})
	})
})

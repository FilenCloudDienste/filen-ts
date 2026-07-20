import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockSharedDirCache } = vi.hoisted(() => ({
	mockSharedDirCache: new Map<string, { shareInfo: unknown }>()
}))

// Minimal tagged-class stubs: each records its tag + constructor args under `inner` so the wrapped
// shape can be asserted without loading the real WASM/uniffi bridge.
vi.mock("@filen/sdk-rs", () => {
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
		AnyDirWithContext: { Normal: makeStub("Normal"), Shared: makeStub("Shared") },
		AnySharedDirWithContext: { new: (arg: unknown) => ({ tag: "SharedDirWithContext", inner: [arg] }) },
		AnyDirWithContext_Tags: { Normal: "Normal", Shared: "Shared", Linked: "Linked" },
		AnySharedDir_Tags: { Dir: "Dir", Root: "Root" },
		AnyNormalDir_Tags: { Dir: "Dir", Root: "Root" },
		AnyLinkedDir_Tags: { Dir: "Dir", Root: "Root" }
	}
})

vi.mock("@/lib/cache", () => ({
	default: {
		directoryUuidToAnySharedDirWithContext: mockSharedDirCache
	}
}))

vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapParentUuid: (parent: unknown) => parent ?? null
}))

vi.mock("@/features/drive/driveSelectors", () => ({
	isDirectoryItem: (item: { type: string }) =>
		item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory"
}))

vi.mock("expo-file-system", () => ({
	File: class {}
}))

vi.mock("@/lib/storageRoots", () => ({
	OFFLINE_DIRECTORIES_DIRECTORY: { uri: "file:///offline" }
}))

vi.mock("@/lib/fsAtomic", () => ({
	atomicWrite: vi.fn()
}))

import { directoryDriveItemToAnyDirWithContext } from "@/features/offline/offlineHelpers"

describe("directoryDriveItemToAnyDirWithContext", () => {
	beforeEach(() => {
		mockSharedDirCache.clear()
	})

	it("returns null for a non-directory item", () => {
		const item = { type: "file", data: { uuid: "f1" } } as any

		expect(directoryDriveItemToAnyDirWithContext(item)).toBeNull()
	})

	it("wraps a normal directory into a Normal context", () => {
		const item = { type: "directory", data: { uuid: "d1" } } as any

		const result = directoryDriveItemToAnyDirWithContext(item) as any

		expect(result.tag).toBe("Normal")
		expect(result.inner[0].tag).toBe("Dir")
		expect(result.inner[0].inner[0]).toBe(item.data)
	})

	it("sharedDirectory with a cache hit uses the cached parent's shareInfo", () => {
		const cachedRole = { role: "cached" }
		const itemRole = { role: "item" }

		mockSharedDirCache.set("parent-uuid", { shareInfo: cachedRole })

		const item = {
			type: "sharedDirectory",
			data: { inner: { parent: "parent-uuid" }, sharingRole: itemRole }
		} as any

		const result = directoryDriveItemToAnyDirWithContext(item) as any

		expect(result.tag).toBe("Shared")
		expect(result.inner[0].tag).toBe("SharedDirWithContext")
		expect(result.inner[0].inner[0].dir.tag).toBe("SharedDir")
		// The cached parent wins over the item's own role.
		expect(result.inner[0].inner[0].shareInfo).toBe(cachedRole)
	})

	it("sharedDirectory with a cache MISS falls back to the item's own sharingRole", () => {
		const itemRole = { role: "item" }

		const item = {
			type: "sharedDirectory",
			data: { inner: { parent: "parent-uuid" }, sharingRole: itemRole }
		} as any

		const result = directoryDriveItemToAnyDirWithContext(item) as any

		expect(result.tag).toBe("Shared")
		expect(result.inner[0].inner[0].dir.tag).toBe("SharedDir")
		expect(result.inner[0].inner[0].shareInfo).toBe(itemRole)
	})

	it("sharedDirectory returns null when neither the cache nor the item carries a role", () => {
		const item = {
			type: "sharedDirectory",
			data: { inner: { parent: "parent-uuid" }, sharingRole: undefined }
		} as any

		expect(directoryDriveItemToAnyDirWithContext(item)).toBeNull()
	})

	it("sharedRootDirectory builds a Shared root context from the item's own role", () => {
		const rootRole = { role: "root" }

		const item = {
			type: "sharedRootDirectory",
			data: { uuid: "root-1", sharingRole: rootRole }
		} as any

		const result = directoryDriveItemToAnyDirWithContext(item) as any

		expect(result.tag).toBe("Shared")
		expect(result.inner[0].inner[0].dir.tag).toBe("SharedRoot")
		expect(result.inner[0].inner[0].shareInfo).toBe(rootRole)
	})
})

import { vi, describe, it, expect, beforeEach } from "vitest"

// offlineSync decision-table tests. The offline singleton (storage layer) is fully mocked — these
// tests exercise the orchestrator's DECISIONS (what gets removed/renamed/re-anchored/re-downloaded
// and what merely records an error), not filesystem behavior (covered by offline.test.ts). The
// <OfflineSync /> host component tests live in offlineSyncHost.test.ts.

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("@/features/offline/offline", () => ({
	default: {
		listFiles: vi.fn(),
		listDirectories: vi.fn(),
		listBrokenStandaloneUuids: vi.fn(),
		updateIndex: vi.fn(),
		reconcileTree: vi.fn(),
		updateTreeRootMeta: vi.fn(),
		renameStandaloneFile: vi.fn(),
		redownloadStandaloneFile: vi.fn(),
		removeItem: vi.fn(),
		storeFile: vi.fn(),
		getLocalFile: vi.fn(),
		removeStandaloneDirectory: vi.fn()
	}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: vi.fn()
	}
}))

vi.mock("@/lib/secureStore", () => ({ default: { get: vi.fn() } }))

vi.mock("@react-native-community/netinfo", () => ({ default: { fetch: vi.fn() } }))

vi.mock("@tanstack/react-query", () => ({
	onlineManager: {
		isOnline: vi.fn()
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		directoryUuidToAnySharedDirWithContext: new Map()
	}
}))

// Plain functions (NOT vi.fn) so vi.resetAllMocks() in primeDefaults never strips them.
// Test errors carry a `__kind` marker that unwrapSdkError surfaces as the SDK error kind.
vi.mock("@/lib/sdkErrors", () => ({
	unwrapSdkError: (error: unknown) => {
		const kind = (error as { __kind?: string } | null)?.__kind

		return kind
			? {
					kind: () => kind
				}
			: null
	}
}))

// Minimal sdkUnwrap stubs (plain functions — immune to resetAllMocks). They only handle the
// concrete synthetic shapes these tests feed in: SDK objects with meta {tag:"Decoded",inner:[...]}
// and parent {tag:"Uuid",inner:[uuid]} | {tag:"Trash"}.
vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapFileMeta: (file: unknown) => {
		const f = file as {
			uuid?: string
			parent?: unknown
			meta?: {
				tag?: string
				inner?: unknown[]
			}
		}
		const decoded = f?.meta?.tag === "Decoded" ? (f.meta.inner?.[0] ?? null) : null

		return {
			file: f,
			meta: decoded,
			undecryptable: decoded === null,
			shared: false,
			root: false
		}
	},
	unwrapDirMeta: (dir: unknown) => {
		const d = dir as {
			uuid?: string
			parent?: unknown
			meta?: {
				tag?: string
				inner?: unknown[]
			}
		}
		const decoded = d?.meta?.tag === "Decoded" ? (d.meta.inner?.[0] ?? null) : null

		return {
			dir: d,
			uuid: d?.uuid ?? "unknown",
			meta: decoded,
			undecryptable: decoded === null,
			shared: false
		}
	},
	unwrappedFileIntoDriveItem: (unwrapped: {
		file: {
			uuid?: string
			parent?: unknown
		}
		meta: {
			name: string
			size?: bigint
		} | null
	}) => ({
		type: "file" as const,
		data: {
			uuid: unwrapped.file?.uuid ?? "file-uuid",
			parent: unwrapped.file?.parent,
			decryptedMeta: unwrapped.meta
				? {
						name: unwrapped.meta.name,
						size: unwrapped.meta.size ?? 100n,
						modified: 1000,
						created: 900
					}
				: null,
			undecryptable: unwrapped.meta === null
		}
	}),
	unwrappedDirIntoDriveItem: (unwrapped: {
		dir: {
			uuid?: string
			parent?: unknown
		}
		uuid: string
		meta: {
			name: string
		} | null
	}) => ({
		type: "directory" as const,
		data: {
			uuid: unwrapped.uuid ?? unwrapped.dir?.uuid ?? "dir-uuid",
			parent: unwrapped.dir?.parent,
			decryptedMeta: unwrapped.meta
				? {
						name: unwrapped.meta.name,
						size: 0n,
						modified: 1000,
						created: 900
					}
				: null,
			undecryptable: unwrapped.meta === null
		}
	}),
	unwrapParentUuid: (parent: unknown) => {
		const p = parent as {
			tag?: string
			inner?: string[]
		} | null

		return p?.tag === "Uuid" ? (p.inner?.[0] ?? null) : null
	}
}))

vi.mock("@filen/sdk-rs", () => ({
	AnyDirWithContext: {
		Normal: class {
			tag = "Normal"
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		},
		Shared: class {
			tag = "Shared"
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		}
	},
	AnyNormalDir: {
		Dir: class {
			tag = "Dir"
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		},
		Root: class {
			tag = "Root"
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		}
	},
	AnySharedDir: {
		Dir: class {
			tag = "Dir"
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		},
		Root: class {
			tag = "Root"
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		}
	},
	AnySharedDirWithContext: {
		new: (opts: unknown) => opts
	},
	AnyDirWithContext_Tags: {
		Normal: "Normal",
		Shared: "Shared",
		Linked: "Linked"
	},
	AnyNormalDir_Tags: {
		Dir: "Dir",
		Root: "Root"
	},
	AnySharedDir_Tags: {
		Dir: "Dir",
		Root: "Root"
	},
	AnyLinkedDir_Tags: {
		Dir: "Dir",
		Root: "Root"
	},
	ParentUuid_Tags: {
		Uuid: "Uuid",
		Trash: "Trash",
		Recents: "Recents",
		Favorites: "Favorites",
		Links: "Links"
	},
	ErrorKind: {
		FolderNotFound: "FolderNotFound",
		WrongPassword: "WrongPassword",
		Reqwest: "Reqwest"
	},
	NonRootDir_Tags: {
		Normal: "Normal",
		Shared: "Shared",
		Linked: "Linked"
	}
}))

import { OfflineSync } from "@/features/offline/offlineSync"
import offline from "@/features/offline/offline"
import auth from "@/lib/auth"
import secureStore from "@/lib/secureStore"
import NetInfo from "@react-native-community/netinfo"
import { onlineManager } from "@tanstack/react-query"
import useOfflineStore from "@/features/offline/store/useOffline.store"
import { type OfflineParent } from "@/features/offline/offlineHelpers"
import type { DriveItem } from "@/types"

const ROOT_UUID = "root-uuid"

type MockClient = {
	root: ReturnType<typeof vi.fn>
	getDirOptional: ReturnType<typeof vi.fn>
	getFileOptional: ReturnType<typeof vi.fn>
	listDir: ReturnType<typeof vi.fn>
	listSharedDir: ReturnType<typeof vi.fn>
	listInSharedRoot: ReturnType<typeof vi.fn>
}

function uuidParent(uuid: string): { tag: "Uuid"; inner: [string] } {
	return {
		tag: "Uuid",
		inner: [uuid]
	}
}

const trashParent = {
	tag: "Trash"
} as const

// Stored tree root (own cloud): DriveItem of type "directory" with a ParentUuid-shaped data.parent.
function makeTreeItem(uuid: string, name: string, parentUuid: string): DriveItem {
	return {
		type: "directory",
		data: {
			uuid,
			parent: uuidParent(parentUuid),
			decryptedMeta: {
				name,
				size: 0n,
				modified: 1000,
				created: 900
			},
			undecryptable: false
		}
	} as unknown as DriveItem
}

function makeSharedTreeItem(uuid: string, name: string): DriveItem {
	return {
		type: "sharedDirectory",
		data: {
			uuid,
			decryptedMeta: {
				name,
				size: 0n,
				modified: 1000,
				created: 900
			},
			undecryptable: false
		}
	} as unknown as DriveItem
}

function makeFileItem(uuid: string, name: string, size: bigint = 100n): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
			parent: uuidParent("parent-1"),
			decryptedMeta: {
				name,
				size,
				modified: 1000,
				created: 900
			},
			undecryptable: false
		}
	} as unknown as DriveItem
}

// Parent contexts as the offline metas store them (plain tagged-union literals — parentCacheKey
// and the listing switch only read tags and inner fields).
function makeNormalParent(uuid: string): OfflineParent {
	return {
		tag: "Normal",
		inner: [
			{
				tag: "Dir",
				inner: [
					{
						uuid
					}
				]
			}
		]
	} as unknown as OfflineParent
}

function makeSharedParent(uuid: string): OfflineParent {
	return {
		tag: "Shared",
		inner: [
			{
				dir: {
					tag: "Dir",
					inner: [
						{
							inner: {
								uuid
							}
						}
					]
				},
				shareInfo: "Receiver"
			}
		]
	} as unknown as OfflineParent
}

// Remote SDK Dir shape as getDirOptional / listing dirs return it (consumed by the unwrapDirMeta stub).
function makeRemoteDir(uuid: string, name: string, parent: unknown): unknown {
	return {
		uuid,
		parent,
		meta: {
			tag: "Decoded",
			inner: [
				{
					name
				}
			]
		}
	}
}

// Remote SDK File shape as getFileOptional / listing files return it (consumed by the unwrapFileMeta stub).
function makeRemoteFile(uuid: string, name: string, parent: unknown, size: bigint = 100n): unknown {
	return {
		uuid,
		parent,
		meta: {
			tag: "Decoded",
			inner: [
				{
					name,
					size
				}
			]
		}
	}
}

function syncErrors() {
	return useOfflineStore.getState().syncErrors
}

let client: MockClient

function primeDefaults(): MockClient {
	vi.resetAllMocks()

	const freshClient: MockClient = {
		root: vi.fn(() => ({
			uuid: ROOT_UUID
		})),
		getDirOptional: vi.fn(async () => undefined),
		getFileOptional: vi.fn(async () => undefined),
		listDir: vi.fn(async () => ({
			dirs: [],
			files: []
		})),
		listSharedDir: vi.fn(async () => ({
			dirs: [],
			files: []
		})),
		listInSharedRoot: vi.fn(async () => ({
			dirs: [],
			files: []
		}))
	}

	vi.mocked(offline.listFiles).mockResolvedValue([])
	vi.mocked(offline.listDirectories).mockResolvedValue({
		files: [],
		directories: []
	})
	vi.mocked(offline.listBrokenStandaloneUuids).mockResolvedValue([])
	vi.mocked(offline.updateIndex).mockResolvedValue(undefined)
	vi.mocked(offline.reconcileTree).mockResolvedValue([])
	vi.mocked(offline.updateTreeRootMeta).mockResolvedValue(undefined)
	vi.mocked(offline.renameStandaloneFile).mockResolvedValue(undefined)
	vi.mocked(offline.redownloadStandaloneFile).mockResolvedValue(undefined)
	vi.mocked(offline.removeItem).mockResolvedValue(undefined)
	vi.mocked(offline.storeFile).mockResolvedValue(undefined)
	vi.mocked(offline.getLocalFile).mockResolvedValue(null)
	vi.mocked(offline.removeStandaloneDirectory).mockResolvedValue(undefined)
	vi.mocked(auth.getSdkClients).mockImplementation(
		async () =>
			({
				authedSdkClient: freshClient
			}) as never
	)
	vi.mocked(secureStore.get).mockResolvedValue(null)
	vi.mocked(NetInfo.fetch).mockResolvedValue({
		type: "wifi"
	} as never)
	vi.mocked(onlineManager.isOnline).mockReturnValue(true)

	useOfflineStore.setState({
		syncing: false,
		syncErrors: []
	})

	return freshClient
}

beforeEach(() => {
	client = primeDefaults()
})

function givenTrees(trees: { item: DriveItem; parent: OfflineParent }[]): void {
	vi.mocked(offline.listDirectories).mockResolvedValue({
		files: [],
		directories: trees
	})
}

function givenFiles(files: { item: DriveItem; parent: OfflineParent }[]): void {
	vi.mocked(offline.listFiles).mockResolvedValue(files)
}

async function runManualPass(): Promise<void> {
	await new OfflineSync().sync({
		manual: true
	})
}

describe("offlineSync — normal trees (own cloud)", () => {
	it("1. alive & unchanged → reconcileTree with stored uuid/parent, no removeItem, no meta update", async () => {
		const parent = makeNormalParent("parent-1")
		const item = makeTreeItem("tree-1", "Tree", "parent-1")

		givenTrees([
			{
				item,
				parent
			}
		])
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "tree-1" ? makeRemoteDir("tree-1", "Tree", uuidParent("parent-1")) : undefined
		)

		await runManualPass()

		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledTimes(1)

		const reconcileArgs = vi.mocked(offline.reconcileTree).mock.calls[0]?.[0]

		expect(reconcileArgs?.directory.data.uuid).toBe("tree-1")
		expect(reconcileArgs?.parent).toBe(parent)
		expect(reconcileArgs?.skipIndexUpdate).toBe(true)
		expect(reconcileArgs?.hideProgress).toBe(true)
		expect(vi.mocked(offline.updateTreeRootMeta)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.updateIndex)).toHaveBeenCalledTimes(1)
		expect(syncErrors()).toEqual([])
	})

	it("2. renamed → updateTreeRootMeta with updated item, then reconcileTree", async () => {
		const parent = makeNormalParent("parent-1")

		givenTrees([
			{
				item: makeTreeItem("tree-1", "Old name", "parent-1"),
				parent
			}
		])
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "tree-1" ? makeRemoteDir("tree-1", "New name", uuidParent("parent-1")) : undefined
		)

		await runManualPass()

		expect(vi.mocked(offline.updateTreeRootMeta)).toHaveBeenCalledTimes(1)

		const updateArgs = vi.mocked(offline.updateTreeRootMeta).mock.calls[0]?.[0]

		expect(updateArgs?.uuid).toBe("tree-1")
		expect(updateArgs?.item.data.decryptedMeta?.name).toBe("New name")
		expect(updateArgs?.parent).toBe(parent)

		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.reconcileTree).mock.calls[0]?.[0]?.directory.data.decryptedMeta?.name).toBe("New name")

		const updateOrder = vi.mocked(offline.updateTreeRootMeta).mock.invocationCallOrder[0] ?? Infinity
		const reconcileOrder = vi.mocked(offline.reconcileTree).mock.invocationCallOrder[0] ?? -Infinity

		expect(updateOrder).toBeLessThan(reconcileOrder)
		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
	})

	it("3. moved → parent re-anchored via getDirOptional(parentUuid), updateTreeRootMeta gets the new parent", async () => {
		givenTrees([
			{
				item: makeTreeItem("tree-1", "Tree", "parent-old"),
				parent: makeNormalParent("parent-old")
			}
		])
		client.getDirOptional.mockImplementation(async (uuid: string) => {
			if (uuid === "tree-1") {
				return makeRemoteDir("tree-1", "Tree", uuidParent("parent-new"))
			}

			if (uuid === "parent-new") {
				return makeRemoteDir("parent-new", "New parent", uuidParent(ROOT_UUID))
			}

			return undefined
		})

		await runManualPass()

		expect(client.getDirOptional).toHaveBeenCalledWith("parent-new", expect.anything())
		expect(vi.mocked(offline.updateTreeRootMeta)).toHaveBeenCalledTimes(1)

		const updateArgs = vi.mocked(offline.updateTreeRootMeta).mock.calls[0]?.[0] as unknown as {
			parent: {
				tag: string
				inner: [
					{
						tag: string
						inner: [
							{
								uuid: string
							}
						]
					}
				]
			}
		}

		expect(updateArgs.parent.tag).toBe("Normal")
		expect(updateArgs.parent.inner[0].tag).toBe("Dir")
		expect(updateArgs.parent.inner[0].inner[0].uuid).toBe("parent-new")

		// reconcileTree runs against the re-anchored parent too.
		expect(vi.mocked(offline.reconcileTree).mock.calls[0]?.[0]?.parent).toBe(
			vi.mocked(offline.updateTreeRootMeta).mock.calls[0]?.[0]?.parent
		)
		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
	})

	it("4. trashed (parent === trash) → removeItem, no reconcile", async () => {
		const item = makeTreeItem("tree-1", "Tree", "parent-1")

		givenTrees([
			{
				item,
				parent: makeNormalParent("parent-1")
			}
		])
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "tree-1" ? makeRemoteDir("tree-1", "Tree", trashParent) : undefined
		)

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledWith(item)
		expect(vi.mocked(offline.reconcileTree)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.updateTreeRootMeta)).not.toHaveBeenCalled()
	})

	it("5. deleted (getDirOptional → undefined) → removeItem", async () => {
		const item = makeTreeItem("tree-1", "Tree", "parent-1")

		givenTrees([
			{
				item,
				parent: makeNormalParent("parent-1")
			}
		])
		client.getDirOptional.mockResolvedValue(undefined)

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledWith(item)
		expect(vi.mocked(offline.reconcileTree)).not.toHaveBeenCalled()
	})

	it("6. lookup network-fails → listing error recorded, NO removeItem, NO reconcile", async () => {
		givenTrees([
			{
				item: makeTreeItem("tree-1", "Tree", "parent-1"),
				parent: makeNormalParent("parent-1")
			}
		])
		client.getDirOptional.mockRejectedValue(new Error("network down"))

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.reconcileTree)).not.toHaveBeenCalled()
		expect(syncErrors()).toHaveLength(1)
		expect(syncErrors()[0]?.kind).toBe("listing")
		expect(syncErrors()[0]?.itemUuid).toBe("tree-1")
		expect(syncErrors()[0]?.topLevelUuid).toBe("tree-1")
	})
})

describe("offlineSync — shared trees (listing-based)", () => {
	it("7. present → reconcileTree; absent → removeItem; WrongPassword → removeItem; other failure → listing error + skip", async () => {
		// Present in the shared parent listing → reconcileTree, no removal.
		const sharedParent = makeSharedParent("sparent-1")

		givenTrees([
			{
				item: makeSharedTreeItem("stree-1", "Shared tree"),
				parent: sharedParent
			}
		])
		client.listSharedDir.mockResolvedValue({
			dirs: [makeRemoteDir("stree-1", "Shared tree", uuidParent("sparent-1"))],
			files: []
		})

		await runManualPass()

		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.reconcileTree).mock.calls[0]?.[0]?.directory.data.uuid).toBe("stree-1")
		expect(vi.mocked(offline.reconcileTree).mock.calls[0]?.[0]?.parent).toBe(sharedParent)
		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()

		// Absent from a clean listing → removeItem.
		client = primeDefaults()

		const absentItem = makeSharedTreeItem("stree-1", "Shared tree")

		givenTrees([
			{
				item: absentItem,
				parent: makeSharedParent("sparent-1")
			}
		])
		client.listSharedDir.mockResolvedValue({
			dirs: [],
			files: []
		})

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledWith(absentItem)
		expect(vi.mocked(offline.reconcileTree)).not.toHaveBeenCalled()

		// WrongPassword (share revoked) → removeItem.
		client = primeDefaults()

		const revokedItem = makeSharedTreeItem("stree-1", "Shared tree")

		givenTrees([
			{
				item: revokedItem,
				parent: makeSharedParent("sparent-1")
			}
		])
		client.listSharedDir.mockRejectedValue({
			__kind: "WrongPassword"
		})

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledWith(revokedItem)
		expect(vi.mocked(offline.reconcileTree)).not.toHaveBeenCalled()

		// Any other listing failure → listing error, NOTHING removed.
		client = primeDefaults()

		givenTrees([
			{
				item: makeSharedTreeItem("stree-1", "Shared tree"),
				parent: makeSharedParent("sparent-1")
			}
		])
		client.listSharedDir.mockRejectedValue(new Error("boom"))

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.reconcileTree)).not.toHaveBeenCalled()
		expect(syncErrors()).toHaveLength(1)
		expect(syncErrors()[0]?.kind).toBe("listing")
		expect(syncErrors()[0]?.itemUuid).toBe("stree-1")
	})
})

describe("offlineSync — standalone files", () => {
	it("8. renamed remotely → renameStandaloneFile with the updated item", async () => {
		const normalParent = makeNormalParent("parent-1")

		givenFiles([
			{
				item: makeFileItem("file-1", "old.txt"),
				parent: normalParent
			}
		])
		client.listDir.mockResolvedValue({
			dirs: [],
			files: [makeRemoteFile("file-1", "new.txt", uuidParent("parent-1"))]
		})
		// Healthy on disk (size matches) so the heal path stays quiet.
		vi.mocked(offline.getLocalFile).mockResolvedValue({
			size: 100
		} as never)

		await runManualPass()

		expect(vi.mocked(offline.renameStandaloneFile)).toHaveBeenCalledTimes(1)

		const renameArgs = vi.mocked(offline.renameStandaloneFile).mock.calls[0]?.[0]

		expect(renameArgs?.item.data.uuid).toBe("file-1")
		expect(renameArgs?.item.data.decryptedMeta?.name).toBe("new.txt")
		expect(renameArgs?.parent).toBe(normalParent)
		expect(vi.mocked(offline.redownloadStandaloneFile)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
	})

	it("9. missing on disk while remote alive → redownloadStandaloneFile; heal failure → download error, nothing removed", async () => {
		givenFiles([
			{
				item: makeFileItem("file-1", "doc.txt"),
				parent: makeNormalParent("parent-1")
			}
		])
		client.listDir.mockResolvedValue({
			dirs: [],
			files: [makeRemoteFile("file-1", "doc.txt", uuidParent("parent-1"))]
		})
		vi.mocked(offline.getLocalFile).mockResolvedValue(null)

		await runManualPass()

		expect(vi.mocked(offline.redownloadStandaloneFile)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.redownloadStandaloneFile).mock.calls[0]?.[0]?.item.data.uuid).toBe("file-1")
		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
		expect(syncErrors()).toEqual([])

		// Heal failure → download error recorded, nothing removed.
		client = primeDefaults()
		givenFiles([
			{
				item: makeFileItem("file-1", "doc.txt"),
				parent: makeNormalParent("parent-1")
			}
		])
		client.listDir.mockResolvedValue({
			dirs: [],
			files: [makeRemoteFile("file-1", "doc.txt", uuidParent("parent-1"))]
		})
		vi.mocked(offline.getLocalFile).mockResolvedValue(null)
		vi.mocked(offline.redownloadStandaloneFile).mockRejectedValue(new Error("download failed"))

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
		expect(syncErrors()).toHaveLength(1)
		expect(syncErrors()[0]?.kind).toBe("download")
		expect(syncErrors()[0]?.itemUuid).toBe("file-1")
	})

	it("9b. size mismatch on disk counts as missing → redownloadStandaloneFile", async () => {
		givenFiles([
			{
				item: makeFileItem("file-1", "doc.txt"),
				parent: makeNormalParent("parent-1")
			}
		])
		client.listDir.mockResolvedValue({
			dirs: [],
			files: [makeRemoteFile("file-1", "doc.txt", uuidParent("parent-1"), 100n)]
		})
		vi.mocked(offline.getLocalFile).mockResolvedValue({
			size: 42
		} as never)

		await runManualPass()

		expect(vi.mocked(offline.redownloadStandaloneFile)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
	})

	it("10. versioned (byName match, different uuid) → storeFile(new) THEN removeItem(old); storeFile failure → old kept + download error", async () => {
		const oldItem = makeFileItem("file-old", "Doc.TXT")
		const order: string[] = []

		givenFiles([
			{
				item: oldItem,
				parent: makeNormalParent("parent-1")
			}
		])
		client.listDir.mockResolvedValue({
			dirs: [],
			// Same name (case-insensitive) under a NEW uuid — a new version of the file.
			files: [makeRemoteFile("file-new", "doc.txt", uuidParent("parent-1"))]
		})
		vi.mocked(offline.storeFile).mockImplementation(async () => {
			order.push("storeFile")
		})
		vi.mocked(offline.removeItem).mockImplementation(async () => {
			order.push("removeItem")
		})

		await runManualPass()

		expect(order).toEqual(["storeFile", "removeItem"])
		expect(vi.mocked(offline.storeFile).mock.calls[0]?.[0]?.file.data.uuid).toBe("file-new")
		expect(vi.mocked(offline.storeFile).mock.calls[0]?.[0]?.skipIndexUpdate).toBe(true)
		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledWith(oldItem)
		expect(client.getFileOptional).not.toHaveBeenCalled()

		// storeFile failure → old copy kept (no removeItem), download error recorded.
		client = primeDefaults()
		givenFiles([
			{
				item: makeFileItem("file-old", "doc.txt"),
				parent: makeNormalParent("parent-1")
			}
		])
		client.listDir.mockResolvedValue({
			dirs: [],
			files: [makeRemoteFile("file-new", "doc.txt", uuidParent("parent-1"))]
		})
		vi.mocked(offline.storeFile).mockRejectedValue(new Error("store failed"))

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
		expect(syncErrors()).toHaveLength(1)
		expect(syncErrors()[0]?.kind).toBe("download")
		expect(syncErrors()[0]?.itemUuid).toBe("file-old")
	})

	it("11. moved (absent, no name match, getFileOptional → other parent) → renameStandaloneFile re-anchor, NOT removed", async () => {
		givenFiles([
			{
				item: makeFileItem("file-1", "doc.txt"),
				parent: makeNormalParent("parent-1")
			}
		])
		client.listDir.mockResolvedValue({
			dirs: [],
			files: []
		})
		client.getFileOptional.mockImplementation(async (uuid: string) =>
			uuid === "file-1" ? makeRemoteFile("file-1", "doc.txt", uuidParent("parent-other")) : undefined
		)
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "parent-other" ? makeRemoteDir("parent-other", "Other", uuidParent(ROOT_UUID)) : undefined
		)

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.renameStandaloneFile)).toHaveBeenCalledTimes(1)

		const renameArgs = vi.mocked(offline.renameStandaloneFile).mock.calls[0]?.[0] as unknown as {
			item: DriveItem
			parent: {
				tag: string
				inner: [
					{
						tag: string
						inner: [
							{
								uuid: string
							}
						]
					}
				]
			}
		}

		expect(renameArgs.item.data.uuid).toBe("file-1")
		expect(renameArgs.parent.tag).toBe("Normal")
		expect(renameArgs.parent.inner[0].inner[0].uuid).toBe("parent-other")
	})

	it("12. trashed/deleted (getFileOptional → trash parent / undefined) → removeItem", async () => {
		const trashedItem = makeFileItem("file-trashed", "a.txt")
		const deletedItem = makeFileItem("file-deleted", "b.txt")

		givenFiles([
			{
				item: trashedItem,
				parent: makeNormalParent("parent-1")
			},
			{
				item: deletedItem,
				parent: makeNormalParent("parent-1")
			}
		])
		client.listDir.mockResolvedValue({
			dirs: [],
			files: []
		})
		client.getFileOptional.mockImplementation(async (uuid: string) =>
			uuid === "file-trashed" ? makeRemoteFile("file-trashed", "a.txt", trashParent) : undefined
		)

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledTimes(2)
		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledWith(trashedItem)
		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledWith(deletedItem)
		expect(vi.mocked(offline.renameStandaloneFile)).not.toHaveBeenCalled()
	})

	it("13. in a shared parent and absent → removeItem WITHOUT any getFileOptional call", async () => {
		const sharedRootItem = makeFileItem("file-1", "doc.txt")

		givenFiles([
			{
				item: sharedRootItem,
				parent: "sharedInRoot"
			}
		])
		client.listInSharedRoot.mockResolvedValue({
			dirs: [],
			files: []
		})

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledWith(sharedRootItem)
		expect(client.getFileOptional).not.toHaveBeenCalled()
	})

	it("14. parent listing fails (generic) → all that parent's standalones get listing errors, no removals", async () => {
		givenFiles([
			{
				item: makeFileItem("file-1", "a.txt"),
				parent: makeNormalParent("parent-1")
			},
			{
				item: makeFileItem("file-2", "b.txt"),
				parent: makeNormalParent("parent-1")
			}
		])
		client.listDir.mockRejectedValue(new Error("listing exploded"))

		await runManualPass()

		// ONE deduped listing call for the shared parent.
		expect(client.listDir).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
		expect(client.getFileOptional).not.toHaveBeenCalled()
		expect(syncErrors()).toHaveLength(2)
		expect(syncErrors().every(error => error.kind === "listing")).toBe(true)
		expect(
			syncErrors()
				.map(error => error.itemUuid)
				.sort()
		).toEqual(["file-1", "file-2"])
	})
})

describe("offlineSync — gates & coalescing", () => {
	it("15. Wi-Fi-only ON + cellular → bails before any listing (manual included)", async () => {
		vi.mocked(secureStore.get).mockResolvedValue(true as never)
		vi.mocked(NetInfo.fetch).mockResolvedValue({
			type: "cellular"
		} as never)

		await runManualPass()

		expect(vi.mocked(offline.listFiles)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.listDirectories)).not.toHaveBeenCalled()
		expect(client.listDir).not.toHaveBeenCalled()
		expect(vi.mocked(offline.updateIndex)).not.toHaveBeenCalled()
	})

	it("16. offline (onlineManager false) → bails", async () => {
		vi.mocked(onlineManager.isOnline).mockReturnValue(false)

		await runManualPass()

		expect(vi.mocked(offline.listFiles)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.updateIndex)).not.toHaveBeenCalled()
	})

	it("17. coalescing: concurrent sync() joins the in-flight pass; auto within 60s no-ops; manual bypasses", async () => {
		let release: () => void = () => undefined
		const gate = new Promise<void>(resolve => {
			release = resolve
		})

		vi.mocked(offline.listFiles).mockImplementation(async () => {
			await gate

			return []
		})

		const sync = new OfflineSync()
		const first = sync.sync({
			manual: true
		})
		const second = sync.sync({
			manual: true
		})

		release()

		await Promise.all([first, second])

		// One runPass for both calls.
		expect(vi.mocked(offline.listFiles)).toHaveBeenCalledTimes(1)

		// Auto sync right after a completed pass no-ops (min interval).
		vi.mocked(offline.listFiles).mockResolvedValue([])

		await sync.sync()

		expect(vi.mocked(offline.listFiles)).toHaveBeenCalledTimes(1)

		// Manual bypasses the interval.
		await sync.sync({
			manual: true
		})

		expect(vi.mocked(offline.listFiles)).toHaveBeenCalledTimes(2)
	})

	it("18. errors land in useOfflineStore.syncErrors and REPLACE the previous array", async () => {
		givenTrees([
			{
				item: makeTreeItem("tree-1", "Tree", "parent-1"),
				parent: makeNormalParent("parent-1")
			}
		])
		client.getDirOptional.mockRejectedValue(new Error("network down"))

		const sync = new OfflineSync()

		await sync.sync({
			manual: true
		})

		expect(syncErrors()).toHaveLength(1)
		expect(syncErrors()[0]?.kind).toBe("listing")

		// Next pass succeeds → the stale error is replaced by an empty array.
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "tree-1" ? makeRemoteDir("tree-1", "Tree", uuidParent("parent-1")) : undefined
		)

		await sync.sync({
			manual: true
		})

		expect(syncErrors()).toEqual([])
	})
})

describe("offlineSync — broken standalone metas", () => {
	it("19. own-cloud alive → renameStandaloneFile rebuild; undefined → removeStandaloneDirectory", async () => {
		vi.mocked(offline.listBrokenStandaloneUuids).mockResolvedValue(["broken-alive", "broken-gone"])
		client.getFileOptional.mockImplementation(async (uuid: string) =>
			uuid === "broken-alive" ? makeRemoteFile("broken-alive", "rescued.txt", uuidParent("parent-1")) : undefined
		)
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "parent-1" ? makeRemoteDir("parent-1", "Parent", uuidParent(ROOT_UUID)) : undefined
		)

		await runManualPass()

		expect(vi.mocked(offline.renameStandaloneFile)).toHaveBeenCalledTimes(1)

		const renameArgs = vi.mocked(offline.renameStandaloneFile).mock.calls[0]?.[0]

		expect(renameArgs?.item.data.uuid).toBe("broken-alive")
		expect(renameArgs?.item.data.decryptedMeta?.name).toBe("rescued.txt")
		expect(vi.mocked(offline.removeStandaloneDirectory)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.removeStandaloneDirectory)).toHaveBeenCalledWith("broken-gone")
		expect(syncErrors()).toEqual([])
	})

	it("19b. broken lookup failure → listing error, dir left for the next pass", async () => {
		vi.mocked(offline.listBrokenStandaloneUuids).mockResolvedValue(["broken-1"])
		client.getFileOptional.mockRejectedValue(new Error("network down"))

		await runManualPass()

		expect(vi.mocked(offline.removeStandaloneDirectory)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.renameStandaloneFile)).not.toHaveBeenCalled()
		expect(syncErrors()).toHaveLength(1)
		expect(syncErrors()[0]?.kind).toBe("listing")
		expect(syncErrors()[0]?.itemUuid).toBe("broken-1")
	})
})

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
		listBrokenTreeUuids: vi.fn(),
		updateIndex: vi.fn(),
		reconcileTree: vi.fn(),
		updateTreeRootMeta: vi.fn(),
		renameStandaloneFile: vi.fn(),
		redownloadStandaloneFile: vi.fn(),
		removeItem: vi.fn(),
		storeFile: vi.fn(),
		getLocalFile: vi.fn(),
		getStandaloneRecordedDiskSize: vi.fn(),
		removeStandaloneDirectory: vi.fn(),
		removeTreeDirectory: vi.fn()
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
	},
	isTrashParent: (parent: unknown) => (parent as { tag?: string } | null)?.tag === "Trash"
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

import { OfflineSync, AUTO_SYNC_MIN_INTERVAL_MS } from "@/features/offline/offlineSync"
import offline from "@/features/offline/offline"
import auth from "@/lib/auth"
import secureStore from "@/lib/secureStore"
import NetInfo from "@react-native-community/netinfo"
import { onlineManager } from "@tanstack/react-query"
import useOfflineStore from "@/features/offline/store/useOffline.store"
import { type OfflineParent, type OfflineSyncError } from "@/features/offline/offlineHelpers"
import type { DriveItem } from "@/types"
import { fs } from "@/tests/mocks/expoFileSystem"

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
	vi.mocked(offline.listBrokenTreeUuids).mockResolvedValue([])
	vi.mocked(offline.updateIndex).mockResolvedValue(undefined)
	vi.mocked(offline.reconcileTree).mockResolvedValue([])
	vi.mocked(offline.updateTreeRootMeta).mockResolvedValue(undefined)
	vi.mocked(offline.renameStandaloneFile).mockResolvedValue(undefined)
	vi.mocked(offline.redownloadStandaloneFile).mockResolvedValue(true)
	vi.mocked(offline.removeItem).mockResolvedValue(undefined)
	vi.mocked(offline.storeFile).mockResolvedValue(true)
	vi.mocked(offline.getLocalFile).mockResolvedValue(null)
	vi.mocked(offline.getStandaloneRecordedDiskSize).mockResolvedValue(null)
	vi.mocked(offline.removeStandaloneDirectory).mockResolvedValue(undefined)
	vi.mocked(offline.removeTreeDirectory).mockResolvedValue(undefined)
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

// Automatic trigger (app start / foreground / reconnect): no manual flag. A fresh instance has
// lastCompletedAt = 0, so the auto min-interval never blocks the pass here.
async function runAutoPass(): Promise<void> {
	await new OfflineSync().sync()
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

	// One-level trash containment (A1): trashed dirs vanish from listings but getDirOptional keeps
	// resolving their CHILDREN as alive with a normal Uuid parent-tag — only the parent dir's own
	// parent-tag reveals the trash. Without the gate such trees were kept (and reconciled) forever.
	it("6b. alive tree whose CONTAINING directory is trashed → removeItem, no reconcile, no meta update", async () => {
		const item = makeTreeItem("tree-1", "Tree", "parent-1")

		givenTrees([
			{
				item,
				parent: makeNormalParent("parent-1")
			}
		])
		client.getDirOptional.mockImplementation(async (uuid: string) => {
			if (uuid === "tree-1") {
				return makeRemoteDir("tree-1", "Tree", uuidParent("parent-1"))
			}

			if (uuid === "parent-1") {
				// The parent dir itself sits in trash.
				return makeRemoteDir("parent-1", "Parent", trashParent)
			}

			return undefined
		})

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledWith(item)
		expect(vi.mocked(offline.reconcileTree)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.updateTreeRootMeta)).not.toHaveBeenCalled()
		expect(syncErrors()).toEqual([])
	})

	it("6c. parent lookup network-fails → listing error, NOTHING removed, no reconcile", async () => {
		givenTrees([
			{
				item: makeTreeItem("tree-1", "Tree", "parent-1"),
				parent: makeNormalParent("parent-1")
			}
		])
		client.getDirOptional.mockImplementation(async (uuid: string) => {
			if (uuid === "tree-1") {
				return makeRemoteDir("tree-1", "Tree", uuidParent("parent-1"))
			}

			if (uuid === "parent-1") {
				throw new Error("network down")
			}

			return undefined
		})

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.reconcileTree)).not.toHaveBeenCalled()
		expect(syncErrors()).toHaveLength(1)
		expect(syncErrors()[0]?.kind).toBe("listing")
		expect(syncErrors()[0]?.itemUuid).toBe("tree-1")
		expect(syncErrors()[0]?.message).toBe("network down")
	})

	it("6d. account-root-parented tree → NO extra parent lookup (exactly one getDirOptional, for the tree itself)", async () => {
		givenTrees([
			{
				item: makeTreeItem("tree-1", "Tree", ROOT_UUID),
				parent: makeNormalParent(ROOT_UUID)
			}
		])
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "tree-1" ? makeRemoteDir("tree-1", "Tree", uuidParent(ROOT_UUID)) : undefined
		)

		await runManualPass()

		// The account root can never be trashed — the gate must not spend a request on it.
		expect(client.getDirOptional).toHaveBeenCalledTimes(1)
		expect(client.getDirOptional).toHaveBeenCalledWith("tree-1", expect.anything())
		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
		expect(syncErrors()).toEqual([])
	})

	it("6e. two trees sharing a trashed parent → ONE parent lookup (per-pass cache), both removed", async () => {
		givenTrees([
			{
				item: makeTreeItem("tree-1", "Tree one", "parent-shared"),
				parent: makeNormalParent("parent-shared")
			},
			{
				item: makeTreeItem("tree-2", "Tree two", "parent-shared"),
				parent: makeNormalParent("parent-shared")
			}
		])
		client.getDirOptional.mockImplementation(async (uuid: string) => {
			if (uuid === "tree-1") {
				return makeRemoteDir("tree-1", "Tree one", uuidParent("parent-shared"))
			}

			if (uuid === "tree-2") {
				return makeRemoteDir("tree-2", "Tree two", uuidParent("parent-shared"))
			}

			if (uuid === "parent-shared") {
				return makeRemoteDir("parent-shared", "Parent", trashParent)
			}

			return undefined
		})

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledTimes(2)
		expect(vi.mocked(offline.reconcileTree)).not.toHaveBeenCalled()
		expect(client.getDirOptional.mock.calls.filter(call => call[0] === "parent-shared")).toHaveLength(1)
		expect(syncErrors()).toEqual([])
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

	// Covers the deleted-data standalone too: listFiles is meta-keyed, so a standalone whose bytes
	// were deleted (meta intact) is listed here and getLocalFile → null routes it into this heal.
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

	// Meta sizes are client-supplied and can drift from the actual remote content. Bytes matching
	// the RECORDED delivered size (FileOrDirectoryOfflineMeta.diskSize) are blessed: re-downloading
	// can only reproduce the same shortfall, so the heal must NOT fire — that loop is exactly what
	// the record exists to break.
	it("9b2. meta-size mismatch matching the recorded delivered size is blessed → no redownload", async () => {
		const normalParent = makeNormalParent("parent-1")

		givenFiles([
			{
				item: makeFileItem("file-1", "doc.txt"),
				parent: normalParent
			}
		])
		client.listDir.mockResolvedValue({
			dirs: [],
			files: [makeRemoteFile("file-1", "doc.txt", uuidParent("parent-1"), 100n)]
		})
		vi.mocked(offline.getLocalFile).mockResolvedValue({
			size: 42
		} as never)
		vi.mocked(offline.getStandaloneRecordedDiskSize).mockResolvedValue(42)

		await runManualPass()

		expect(vi.mocked(offline.getStandaloneRecordedDiskSize)).toHaveBeenCalledWith("file-1")
		expect(vi.mocked(offline.redownloadStandaloneFile)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
	})

	// Pass modes (design §4.2): the standalone heal stat is disk verification — THOROUGH (manual)
	// passes only. Tests 9/9b above pin that it runs on manual; this pins that an automatic pass
	// skips it entirely while the listing-driven decisions (rename here) still apply.
	it("9c. AUTOMATIC pass skips the standalone heal stat (no getLocalFile, no redownload for a missing-on-disk file); listing-driven rename still applies", async () => {
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
		// Missing on disk — a thorough pass would heal this (test 9); the automatic pass must not
		// even stat.
		vi.mocked(offline.getLocalFile).mockResolvedValue(null)

		await runAutoPass()

		expect(vi.mocked(offline.getLocalFile)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.redownloadStandaloneFile)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.renameStandaloneFile)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.renameStandaloneFile).mock.calls[0]?.[0]?.item.data.decryptedMeta?.name).toBe("new.txt")
		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
		expect(syncErrors()).toEqual([])
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

			return true
		})
		vi.mocked(offline.removeItem).mockImplementation(async () => {
			order.push("removeItem")
		})

		await runManualPass()

		expect(order).toEqual(["storeFile", "removeItem"])
		expect(vi.mocked(offline.storeFile).mock.calls[0]?.[0]?.file.data.uuid).toBe("file-new")
		expect(vi.mocked(offline.storeFile).mock.calls[0]?.[0]?.skipIndexUpdate).toBe(true)
		// Background pass — the adoption download must not surface transfer UI progress.
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

	it("10b. version adoption ABORTED (storeFile resolves false) → old copy kept, NO removeItem, NO error", async () => {
		const oldItem = makeFileItem("file-old", "doc.txt")

		givenFiles([
			{
				item: oldItem,
				parent: makeNormalParent("parent-1")
			}
		])
		client.listDir.mockResolvedValue({
			dirs: [],
			files: [makeRemoteFile("file-new", "doc.txt", uuidParent("parent-1"))]
		})
		// storeFile resolves false = download aborted, nothing stored for the new uuid.
		vi.mocked(offline.storeFile).mockResolvedValue(false)

		await runManualPass()

		expect(vi.mocked(offline.storeFile)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
		// Abort is not an error — nothing lands in the error surface; the next pass retries.
		expect(syncErrors()).toEqual([])
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

	// One-level trash containment (A1): a file moved INTO a directory that itself sits in trash
	// must be removed like any trashed item — re-anchoring it to a trash-contained parent would
	// keep the copy (and the re-anchor) forever.
	it("11b. moved standalone whose NEW parent is trash-contained → removeItem, NOT re-anchored", async () => {
		const movedItem = makeFileItem("file-1", "doc.txt")

		givenFiles([
			{
				item: movedItem,
				parent: makeNormalParent("parent-1")
			}
		])
		client.listDir.mockResolvedValue({
			dirs: [],
			files: []
		})
		client.getFileOptional.mockImplementation(async (uuid: string) =>
			uuid === "file-1" ? makeRemoteFile("file-1", "doc.txt", uuidParent("parent-trashed")) : undefined
		)
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "parent-trashed" ? makeRemoteDir("parent-trashed", "Trashed dir", trashParent) : undefined
		)

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledWith(movedItem)
		expect(vi.mocked(offline.renameStandaloneFile)).not.toHaveBeenCalled()
		expect(syncErrors()).toEqual([])
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

	it("14b. own-cloud parent GONE but file moved elsewhere → by-uuid fallback re-anchors, NOT removed", async () => {
		givenFiles([
			{
				item: makeFileItem("file-1", "doc.txt"),
				parent: makeNormalParent("parent-gone")
			}
		])
		// The old parent directory itself is gone (FolderNotFound) — but the file was MOVED to
		// another own-cloud directory before that, so it must be re-anchored, not removed.
		client.listDir.mockRejectedValue({
			__kind: "FolderNotFound"
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
		expect(syncErrors()).toEqual([])
	})

	it("14c. own-cloud parent GONE and by-uuid says deleted/trashed → removeItem", async () => {
		const deletedItem = makeFileItem("file-deleted", "a.txt")
		const trashedItem = makeFileItem("file-trashed", "b.txt")

		givenFiles([
			{
				item: deletedItem,
				parent: makeNormalParent("parent-gone")
			},
			{
				item: trashedItem,
				parent: makeNormalParent("parent-gone")
			}
		])
		client.listDir.mockRejectedValue({
			__kind: "FolderNotFound"
		})
		client.getFileOptional.mockImplementation(async (uuid: string) =>
			uuid === "file-trashed" ? makeRemoteFile("file-trashed", "b.txt", trashParent) : undefined
		)

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledTimes(2)
		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledWith(deletedItem)
		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledWith(trashedItem)
		expect(vi.mocked(offline.renameStandaloneFile)).not.toHaveBeenCalled()
	})

	it("14d. own-cloud parent GONE and by-uuid lookup fails → listing error, nothing removed", async () => {
		givenFiles([
			{
				item: makeFileItem("file-1", "doc.txt"),
				parent: makeNormalParent("parent-gone")
			}
		])
		client.listDir.mockRejectedValue({
			__kind: "FolderNotFound"
		})
		client.getFileOptional.mockRejectedValue(new Error("network down"))

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).not.toHaveBeenCalled()
		expect(syncErrors()).toHaveLength(1)
		expect(syncErrors()[0]?.kind).toBe("listing")
		expect(syncErrors()[0]?.itemUuid).toBe("file-1")
	})

	it("14e. SHARED parent GONE → immediate removeItem, by-uuid fallback never attempted", async () => {
		const sharedItem = makeFileItem("file-1", "doc.txt")

		givenFiles([
			{
				item: sharedItem,
				parent: makeSharedParent("sparent-gone")
			}
		])
		client.listSharedDir.mockRejectedValue({
			__kind: "FolderNotFound"
		})

		await runManualPass()

		expect(vi.mocked(offline.removeItem)).toHaveBeenCalledWith(sharedItem)
		expect(client.getFileOptional).not.toHaveBeenCalled()
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

	// Documented coalescing trade (design §4.2 / offlineSync.ts): a manual sync() arriving while
	// an AUTO pass is in flight JOINS that index-only pass — no queued second pass, no mid-flight
	// thorough upgrade. The user's next explicit trigger gets its own thorough pass.
	it("17b. a MANUAL sync joining an in-flight AUTO pass awaits it WITHOUT upgrading it to thorough (one pass, thorough: false)", async () => {
		givenTrees([
			{
				item: makeTreeItem("tree-1", "Tree", "parent-1"),
				parent: makeNormalParent("parent-1")
			}
		])
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "tree-1" ? makeRemoteDir("tree-1", "Tree", uuidParent("parent-1")) : undefined
		)

		let release: () => void = () => undefined
		const gate = new Promise<void>(resolve => {
			release = resolve
		})

		vi.mocked(offline.listFiles).mockImplementation(async () => {
			await gate

			return []
		})

		const sync = new OfflineSync()
		const auto = sync.sync()
		const manual = sync.sync({
			manual: true
		})

		// The joiner is parked on the in-flight pass — not resolved early, not starting its own.
		let manualSettled = false
		const manualTracked = manual.then(() => {
			manualSettled = true
		})

		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()

		expect(manualSettled).toBe(false)

		release()

		await Promise.all([auto, manualTracked])

		// Exactly ONE pass ran for both callers…
		expect(vi.mocked(offline.listFiles)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledTimes(1)
		// …and the joined pass kept its AUTO mode — no mid-flight thorough upgrade.
		expect(vi.mocked(offline.reconcileTree).mock.calls[0]?.[0]?.thorough).toBe(false)
	})

	it("17c. cancel() mid-pass: an aborted AUTO pass leaves syncErrors untouched and does NOT stamp completion — the next auto sync runs immediately", async () => {
		givenTrees([
			{
				item: makeTreeItem("tree-1", "Tree", "parent-1"),
				parent: makeNormalParent("parent-1")
			}
		])
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "tree-1" ? makeRemoteDir("tree-1", "Tree", uuidParent("parent-1")) : undefined
		)

		// Stale error surface from a previous pass — an aborted pass must NOT replace it.
		const sentinel: OfflineSyncError = {
			id: "sentinel:listing",
			itemUuid: "sentinel",
			topLevelUuid: null,
			name: "sentinel",
			itemType: "file",
			kind: "listing",
			message: "stale",
			timestamp: Date.now()
		}

		useOfflineStore.setState({
			syncErrors: [sentinel]
		})

		const sync = new OfflineSync()

		vi.mocked(offline.listFiles).mockImplementationOnce(async () => {
			sync.cancel()

			return []
		})

		await sync.sync()

		// Aborted mid-pass: per-item work skipped, no index commit, error surface untouched.
		expect(vi.mocked(offline.reconcileTree)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.updateIndex)).not.toHaveBeenCalled()
		expect(syncErrors()).toEqual([sentinel])

		// No lastCompletedAt bump — an immediate AUTO retry is NOT blocked by the min-interval,
		// and the completed retry replaces the stale error surface as usual.
		await sync.sync()

		expect(vi.mocked(offline.listFiles)).toHaveBeenCalledTimes(2)
		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.updateIndex)).toHaveBeenCalledTimes(1)
		expect(syncErrors()).toEqual([])
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

	it("19b. foreground pass threads background: false into offline.reconcileTree", async () => {
		givenTrees([
			{
				item: makeTreeItem("tree-1", "Tree", "parent-1"),
				parent: makeNormalParent("parent-1")
			}
		])
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "tree-1" ? makeRemoteDir("tree-1", "Tree", uuidParent("parent-1")) : undefined
		)

		await runManualPass()

		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledWith(expect.objectContaining({ background: false }))
	})

	it("19c. background pass threads background: true into offline.reconcileTree", async () => {
		givenTrees([
			{
				item: makeTreeItem("tree-1", "Tree", "parent-1"),
				parent: makeNormalParent("parent-1")
			}
		])
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "tree-1" ? makeRemoteDir("tree-1", "Tree", uuidParent("parent-1")) : undefined
		)

		// Background budget selector uses getTreeMetaSize which stats the .filenmeta on disk.
		// Write a small placeholder so the tree passes the size gate and is selected.
		const metaPath = "file:///shared/group.io.filen.app/offline/v2/directories/tree-1/tree-1.filenmeta"

		fs.set(metaPath, new Uint8Array([1, 2, 3]))

		await new OfflineSync().sync({ background: true })

		fs.delete(metaPath)

		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledWith(expect.objectContaining({ background: true }))
	})

	it("19d. foreground pass threads background: false into offline.storeFile (version adoption)", async () => {
		givenFiles([
			{
				item: makeFileItem("file-old", "Doc.TXT"),
				parent: makeNormalParent("parent-1")
			}
		])
		client.listDir.mockResolvedValue({
			dirs: [],
			files: [makeRemoteFile("file-new", "doc.txt", uuidParent("parent-1"))]
		})

		await runManualPass()

		expect(vi.mocked(offline.storeFile)).toHaveBeenCalledWith(expect.objectContaining({ background: false }))
	})

	it("19e. background pass threads background: true into offline.storeFile (version adoption)", async () => {
		givenFiles([
			{
				item: makeFileItem("file-old", "Doc.TXT"),
				parent: makeNormalParent("parent-1")
			}
		])
		client.listDir.mockResolvedValue({
			dirs: [],
			files: [makeRemoteFile("file-new", "doc.txt", uuidParent("parent-1"))]
		})

		await new OfflineSync().sync({ background: true })

		expect(vi.mocked(offline.storeFile)).toHaveBeenCalledWith(expect.objectContaining({ background: true }))
	})
})

describe("offlineSync — broken standalone metas", () => {
	// makeRemoteFile defaults to size 100n — dataFileSize: 100 is the RIGHT-size case, so the
	// cheap meta rewrite is allowed to bless the existing bytes (A2).
	it("19. own-cloud alive WITH right-size data file → renameStandaloneFile rebuild; undefined → removeStandaloneDirectory", async () => {
		vi.mocked(offline.listBrokenStandaloneUuids).mockResolvedValue([
			{
				uuid: "broken-alive",
				hasDataFile: true,
				dataFileSize: 100
			},
			{
				uuid: "broken-gone",
				hasDataFile: true,
				dataFileSize: 100
			}
		])
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
		// Data file present — the cheap meta rewrite suffices, no download.
		expect(vi.mocked(offline.redownloadStandaloneFile)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.removeStandaloneDirectory)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.removeStandaloneDirectory)).toHaveBeenCalledWith("broken-gone")
		expect(syncErrors()).toEqual([])
	})

	it("19b. broken lookup failure → listing error, dir left for the next pass", async () => {
		vi.mocked(offline.listBrokenStandaloneUuids).mockResolvedValue([
			{
				uuid: "broken-1",
				hasDataFile: true,
				dataFileSize: 100
			}
		])
		client.getFileOptional.mockRejectedValue(new Error("network down"))

		await runManualPass()

		expect(vi.mocked(offline.removeStandaloneDirectory)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.renameStandaloneFile)).not.toHaveBeenCalled()
		expect(syncErrors()).toHaveLength(1)
		expect(syncErrors()[0]?.kind).toBe("listing")
		expect(syncErrors()[0]?.itemUuid).toBe("broken-1")
	})

	it("19c. broken dir WITHOUT data file + remote alive → redownloadStandaloneFile (bytes + meta), NOT rename", async () => {
		vi.mocked(offline.listBrokenStandaloneUuids).mockResolvedValue([
			{
				uuid: "broken-no-data",
				hasDataFile: false,
				dataFileSize: null
			}
		])
		client.getFileOptional.mockImplementation(async (uuid: string) =>
			uuid === "broken-no-data" ? makeRemoteFile("broken-no-data", "rescued.txt", uuidParent("parent-1")) : undefined
		)
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "parent-1" ? makeRemoteDir("parent-1", "Parent", uuidParent(ROOT_UUID)) : undefined
		)

		await runManualPass()

		// renameStandaloneFile no-ops without a data file — the dir would stay broken forever.
		expect(vi.mocked(offline.renameStandaloneFile)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.redownloadStandaloneFile)).toHaveBeenCalledTimes(1)

		const healArgs = vi.mocked(offline.redownloadStandaloneFile).mock.calls[0]?.[0] as unknown as {
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
			signal: AbortSignal
		}

		expect(healArgs.item.data.uuid).toBe("broken-no-data")
		expect(healArgs.item.data.decryptedMeta?.name).toBe("rescued.txt")
		expect(healArgs.parent.tag).toBe("Normal")
		expect(healArgs.parent.inner[0].inner[0].uuid).toBe("parent-1")
		expect(healArgs.signal).toBeInstanceOf(AbortSignal)
		expect(vi.mocked(offline.removeStandaloneDirectory)).not.toHaveBeenCalled()
		expect(syncErrors()).toEqual([])
	})

	// A2 — the heal must not bless wrong-size bytes: a meta rewrite around a partial/stale data
	// file would commit a standalone whose bytes never matched the remote meta.
	it("19d. broken dir with data file at the WRONG size → redownloadStandaloneFile, NOT rename-bless", async () => {
		vi.mocked(offline.listBrokenStandaloneUuids).mockResolvedValue([
			{
				uuid: "broken-wrong-size",
				hasDataFile: true,
				dataFileSize: 42
			}
		])
		client.getFileOptional.mockImplementation(async (uuid: string) =>
			uuid === "broken-wrong-size" ? makeRemoteFile("broken-wrong-size", "rescued.txt", uuidParent("parent-1"), 100n) : undefined
		)
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "parent-1" ? makeRemoteDir("parent-1", "Parent", uuidParent(ROOT_UUID)) : undefined
		)

		await runManualPass()

		expect(vi.mocked(offline.renameStandaloneFile)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.redownloadStandaloneFile)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.redownloadStandaloneFile).mock.calls[0]?.[0]?.item.data.uuid).toBe("broken-wrong-size")
		expect(vi.mocked(offline.removeStandaloneDirectory)).not.toHaveBeenCalled()
		expect(syncErrors()).toEqual([])
	})

	// A1 — one-level trash containment also applies to the broken-standalone rebuild: a parent dir
	// that itself sits in trash means the file is trash-contained — remove the leftover dir
	// instead of rebuilding a meta anchored inside trash.
	it("19e. broken dir whose resolved parent is trash-contained → removeStandaloneDirectory, no rebuild", async () => {
		vi.mocked(offline.listBrokenStandaloneUuids).mockResolvedValue([
			{
				uuid: "broken-trash-contained",
				hasDataFile: true,
				dataFileSize: 100
			}
		])
		client.getFileOptional.mockImplementation(async (uuid: string) =>
			uuid === "broken-trash-contained"
				? makeRemoteFile("broken-trash-contained", "doc.txt", uuidParent("parent-trashed"), 100n)
				: undefined
		)
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "parent-trashed" ? makeRemoteDir("parent-trashed", "Trashed dir", trashParent) : undefined
		)

		await runManualPass()

		expect(vi.mocked(offline.removeStandaloneDirectory)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.removeStandaloneDirectory)).toHaveBeenCalledWith("broken-trash-contained")
		expect(vi.mocked(offline.renameStandaloneFile)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.redownloadStandaloneFile)).not.toHaveBeenCalled()
		expect(syncErrors()).toEqual([])
	})
})

describe("offlineSync — broken tree metas", () => {
	it("20. own-cloud alive → ONE reconcileTree with the rebuilt root item and resolved parent; reconcile errors propagated", async () => {
		vi.mocked(offline.listBrokenTreeUuids).mockResolvedValue(["broken-tree"])
		client.getDirOptional.mockImplementation(async (uuid: string) => {
			if (uuid === "broken-tree") {
				return makeRemoteDir("broken-tree", "Rescued tree", uuidParent("parent-1"))
			}

			if (uuid === "parent-1") {
				return makeRemoteDir("parent-1", "Parent", uuidParent(ROOT_UUID))
			}

			return undefined
		})
		vi.mocked(offline.reconcileTree).mockResolvedValue([
			{
				id: "broken-tree:listing",
				itemUuid: "broken-tree",
				topLevelUuid: "broken-tree",
				name: "Rescued tree",
				itemType: "directory",
				kind: "listing",
				message: "degraded",
				degraded: true,
				timestamp: Date.now()
			}
		])

		await runManualPass()

		// The unreadable-meta reconcile path rebuilds the meta nearly free (hash-skips bytes).
		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledTimes(1)

		const reconcileArgs = vi.mocked(offline.reconcileTree).mock.calls[0]?.[0] as unknown as {
			directory: DriveItem
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
			skipIndexUpdate: boolean
			signal: AbortSignal
		}

		expect(reconcileArgs.directory.data.uuid).toBe("broken-tree")
		expect(reconcileArgs.directory.data.decryptedMeta?.name).toBe("Rescued tree")
		expect(reconcileArgs.parent.tag).toBe("Normal")
		expect(reconcileArgs.parent.inner[0].inner[0].uuid).toBe("parent-1")
		expect(reconcileArgs.skipIndexUpdate).toBe(true)
		expect(reconcileArgs.signal).toBeInstanceOf(AbortSignal)
		expect(vi.mocked(offline.removeTreeDirectory)).not.toHaveBeenCalled()

		// Reconcile errors bubble into the pass error surface.
		expect(syncErrors()).toHaveLength(1)
		expect(syncErrors()[0]?.id).toBe("broken-tree:listing")
	})

	it("20b. deleted (undefined) or trashed → removeTreeDirectory, no reconcile", async () => {
		vi.mocked(offline.listBrokenTreeUuids).mockResolvedValue(["broken-deleted", "broken-trashed"])
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "broken-trashed" ? makeRemoteDir("broken-trashed", "Trashed tree", trashParent) : undefined
		)

		await runManualPass()

		expect(vi.mocked(offline.removeTreeDirectory)).toHaveBeenCalledTimes(2)
		expect(vi.mocked(offline.removeTreeDirectory)).toHaveBeenCalledWith("broken-deleted")
		expect(vi.mocked(offline.removeTreeDirectory)).toHaveBeenCalledWith("broken-trashed")
		expect(vi.mocked(offline.reconcileTree)).not.toHaveBeenCalled()
		expect(syncErrors()).toEqual([])
	})

	it("20c. lookup failure → listing error only, dir left for the next pass", async () => {
		vi.mocked(offline.listBrokenTreeUuids).mockResolvedValue(["broken-tree"])
		client.getDirOptional.mockRejectedValue(new Error("network down"))

		await runManualPass()

		expect(vi.mocked(offline.removeTreeDirectory)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.reconcileTree)).not.toHaveBeenCalled()
		expect(syncErrors()).toHaveLength(1)
		expect(syncErrors()[0]?.kind).toBe("listing")
		expect(syncErrors()[0]?.itemUuid).toBe("broken-tree")
		expect(syncErrors()[0]?.topLevelUuid).toBe("broken-tree")
	})

	// A1 — one-level trash containment for the broken-tree rebuild: rebuilding a tree whose parent
	// dir sits in trash would re-download bytes for a trashed tree every pass.
	it("20d. broken tree whose resolved parent is trash-contained → removeTreeDirectory, no reconcile", async () => {
		vi.mocked(offline.listBrokenTreeUuids).mockResolvedValue(["broken-tree"])
		client.getDirOptional.mockImplementation(async (uuid: string) => {
			if (uuid === "broken-tree") {
				return makeRemoteDir("broken-tree", "Tree", uuidParent("parent-trashed"))
			}

			if (uuid === "parent-trashed") {
				return makeRemoteDir("parent-trashed", "Trashed dir", trashParent)
			}

			return undefined
		})

		await runManualPass()

		expect(vi.mocked(offline.removeTreeDirectory)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.removeTreeDirectory)).toHaveBeenCalledWith("broken-tree")
		expect(vi.mocked(offline.reconcileTree)).not.toHaveBeenCalled()
		expect(syncErrors()).toEqual([])
	})
})

describe("offlineSync — pass modes (manual ⟹ thorough, design §4.2)", () => {
	// Drives all three reconcileTree call sites in one pass: a normal own-cloud tree, a shared
	// (listed) tree, and a broken-meta tree heal.
	function givenAllThreeTreeKinds(): void {
		givenTrees([
			{
				item: makeTreeItem("tree-1", "Tree", "parent-1"),
				parent: makeNormalParent("parent-1")
			},
			{
				item: makeSharedTreeItem("stree-1", "Shared tree"),
				parent: makeSharedParent("sparent-1")
			}
		])
		client.listSharedDir.mockResolvedValue({
			dirs: [makeRemoteDir("stree-1", "Shared tree", uuidParent("sparent-1"))],
			files: []
		})
		vi.mocked(offline.listBrokenTreeUuids).mockResolvedValue(["broken-1"])
		client.getDirOptional.mockImplementation(async (uuid: string) => {
			if (uuid === "tree-1") {
				return makeRemoteDir("tree-1", "Tree", uuidParent("parent-1"))
			}

			if (uuid === "broken-1") {
				return makeRemoteDir("broken-1", "Broken tree", uuidParent("parent-1"))
			}

			if (uuid === "parent-1") {
				return makeRemoteDir("parent-1", "Parent", uuidParent(ROOT_UUID))
			}

			return undefined
		})
	}

	it("21. every reconcileTree call receives thorough: true on a manual pass and thorough: false on an automatic pass", async () => {
		givenAllThreeTreeKinds()

		await runManualPass()

		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledTimes(3)

		for (const call of vi.mocked(offline.reconcileTree).mock.calls) {
			expect(call[0]?.thorough).toBe(true)
		}

		expect(syncErrors()).toEqual([])

		// Same shape on an AUTOMATIC trigger → index-only.
		client = primeDefaults()
		givenAllThreeTreeKinds()

		await runAutoPass()

		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledTimes(3)

		for (const call of vi.mocked(offline.reconcileTree).mock.calls) {
			expect(call[0]?.thorough).toBe(false)
		}

		expect(syncErrors()).toEqual([])
	})

	// Escalation independence: `thorough` is derived per-call from the trigger (manual === true),
	// never from instance state — a completed MANUAL pass must not leak thorough-ness into the
	// next AUTOMATIC pass on the SAME OfflineSync instance. (Tmp-rescue crash escalation lives
	// INSIDE reconcileTree and is pinned by offline.test.ts.)
	it("22. thorough never sticks: an AUTO pass after a completed MANUAL pass on the same instance still gets thorough: false", async () => {
		givenTrees([
			{
				item: makeTreeItem("tree-1", "Tree", "parent-1"),
				parent: makeNormalParent("parent-1")
			}
		])
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "tree-1" ? makeRemoteDir("tree-1", "Tree", uuidParent("parent-1")) : undefined
		)

		const sync = new OfflineSync()

		await sync.sync({
			manual: true
		})

		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.reconcileTree).mock.calls[0]?.[0]?.thorough).toBe(true)

		// Jump past the auto min-interval so the AUTO pass actually runs on the SAME instance.
		const later = Date.now() + AUTO_SYNC_MIN_INTERVAL_MS + 1_000
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(later)

		await sync.sync()

		nowSpy.mockRestore()

		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledTimes(2)
		expect(vi.mocked(offline.reconcileTree).mock.calls[1]?.[0]?.thorough).toBe(false)
	})
})

describe("offlineSync — per-item failure isolation", () => {
	// runGuarded: an unexpected REJECTION from an offline method (lock/setup errors — distinct
	// from the OfflineSyncError arrays reconcileTree RETURNS) is converted into a `store` error
	// for that item, and the rest of the pass still completes and commits its index update.
	it("23. a reconcileTree rejection becomes a store error for that tree while the rest of the pass completes", async () => {
		givenTrees([
			{
				item: makeTreeItem("tree-1", "Tree", "parent-1"),
				parent: makeNormalParent("parent-1")
			},
			{
				item: makeTreeItem("tree-2", "Other tree", "parent-1"),
				parent: makeNormalParent("parent-1")
			}
		])
		client.getDirOptional.mockImplementation(async (uuid: string) => {
			if (uuid === "tree-1") {
				return makeRemoteDir("tree-1", "Tree", uuidParent("parent-1"))
			}

			if (uuid === "tree-2") {
				return makeRemoteDir("tree-2", "Other tree", uuidParent("parent-1"))
			}

			return undefined
		})
		vi.mocked(offline.reconcileTree).mockImplementation(async ({ directory }) => {
			if (directory.data.uuid === "tree-1") {
				throw new Error("lock acquisition failed")
			}

			return []
		})

		await runManualPass()

		// Both trees were attempted, the pass completed and committed its single index update.
		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledTimes(2)
		expect(vi.mocked(offline.updateIndex)).toHaveBeenCalledTimes(1)

		expect(syncErrors()).toHaveLength(1)
		expect(syncErrors()[0]?.kind).toBe("store")
		expect(syncErrors()[0]?.itemUuid).toBe("tree-1")
		expect(syncErrors()[0]?.topLevelUuid).toBe("tree-1")
		expect(syncErrors()[0]?.message).toBe("lock acquisition failed")
	})
})

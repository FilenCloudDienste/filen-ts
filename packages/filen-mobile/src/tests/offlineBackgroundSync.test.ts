/**
 * Tests for the BACKGROUND offline-sync mode (budgeted pass) added 2026-06-11:
 *
 * - selectBackgroundTrees / getTreeMetaSize (pure helpers): smallest-first selection
 *   under a per-tree meta-size cap and a cumulative budget; unknown sizes never
 *   selected; guaranteed forward progress (the first eligible tree is always taken).
 * - offlineSync.sync({ background: true }): oversized trees are EXCLUDED before any
 *   SDK traffic; standalone files are capped; the broken-item heals are skipped
 *   (foreground owns repair); the session error surface and lastCompletedAt are NOT
 *   touched (a partial pass must neither clear foreground-surfaced errors nor suppress
 *   the next foreground auto pass).
 *
 * Harness cloned from offlineSync.test.ts (offline.* fully mocked, REAL offlineHelpers,
 * canonical expo-file-system mock — tree meta sizes are seeded as real fs entries so
 * the REAL getTreeMetaSize stat path runs).
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

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
import {
	selectBackgroundTrees,
	getTreeMetaSize,
	OFFLINE_BACKGROUND_STANDALONE_FILE_CAP,
	type OfflineParent,
	type OfflineSyncError
} from "@/features/offline/offlineHelpers"
import { OFFLINE_DIRECTORIES_DIRECTORY } from "@/lib/storageRoots"
import { fs } from "@/tests/mocks/expoFileSystem"
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

function makeFileItem(uuid: string, name: string): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
			parent: uuidParent("parent-1"),
			decryptedMeta: {
				name,
				size: 100n,
				modified: 1000,
				created: 900
			},
			undecryptable: false
		}
	} as unknown as DriveItem
}

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

function seedTreeMeta(uuid: string, sizeBytes: number): void {
	fs.set(`${OFFLINE_DIRECTORIES_DIRECTORY.uri}/${uuid}/${uuid}.filenmeta`, new Uint8Array(sizeBytes))
}

let client: MockClient

function primeDefaults(): MockClient {
	vi.resetAllMocks()
	fs.clear()

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
	} as never)
	vi.mocked(offline.listBrokenStandaloneUuids).mockResolvedValue([])
	vi.mocked(offline.listBrokenTreeUuids).mockResolvedValue([])
	vi.mocked(offline.updateIndex).mockResolvedValue(undefined)
	vi.mocked(offline.reconcileTree).mockResolvedValue([] as never)
	vi.mocked(offline.updateTreeRootMeta).mockResolvedValue(undefined)
	vi.mocked(offline.renameStandaloneFile).mockResolvedValue(undefined)
	vi.mocked(offline.redownloadStandaloneFile).mockResolvedValue(true as never)
	vi.mocked(offline.removeItem).mockResolvedValue(undefined)
	vi.mocked(offline.storeFile).mockResolvedValue(true as never)
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
	} as never)
}

function givenFiles(files: { item: DriveItem; parent: OfflineParent }[]): void {
	vi.mocked(offline.listFiles).mockResolvedValue(files as never)
}

describe("selectBackgroundTrees (pure)", () => {
	it("selects smallest metas first under the cumulative budget", () => {
		const selected = selectBackgroundTrees(
			[
				{ uuid: "big", metaSize: 5 },
				{ uuid: "mid", metaSize: 3 },
				{ uuid: "small", metaSize: 1 }
			],
			{
				perTreeCapBytes: 10,
				cumulativeCapBytes: 4
			}
		)

		expect(selected).toEqual(new Set(["small", "mid"]))
	})

	it("excludes trees above the per-tree cap regardless of budget room", () => {
		const selected = selectBackgroundTrees(
			[
				{ uuid: "ok", metaSize: 10 },
				{ uuid: "over", metaSize: 11 }
			],
			{
				perTreeCapBytes: 10,
				cumulativeCapBytes: 1000
			}
		)

		expect(selected).toEqual(new Set(["ok"]))
	})

	it("never selects trees with unknown meta size (broken metas are foreground work)", () => {
		const selected = selectBackgroundTrees([
			{ uuid: "known", metaSize: 100 },
			{ uuid: "unknown", metaSize: null }
		])

		expect(selected.has("unknown")).toBe(false)
		expect(selected.has("known")).toBe(true)
	})

	it("always selects the first eligible tree even when it alone exceeds the cumulative budget (forward progress)", () => {
		const selected = selectBackgroundTrees(
			[
				{ uuid: "only", metaSize: 9 },
				{ uuid: "second", metaSize: 9 }
			],
			{
				perTreeCapBytes: 10,
				cumulativeCapBytes: 5
			}
		)

		expect(selected).toEqual(new Set(["only"]))
	})
})

describe("getTreeMetaSize", () => {
	it("returns the meta file's byte size, and null when absent", () => {
		seedTreeMeta("tree-1", 1234)

		expect(getTreeMetaSize("tree-1")).toBe(1234)
		expect(getTreeMetaSize("missing")).toBeNull()
	})
})

describe("offlineSync — background budgeted pass", () => {
	it("excludes an oversized tree BEFORE any SDK traffic; the small tree still reconciles", async () => {
		const parent = makeNormalParent("parent-1")
		const small = makeTreeItem("tree-small", "Small", "parent-1")
		const big = makeTreeItem("tree-big", "Big", "parent-1")

		seedTreeMeta("tree-small", 1024)
		seedTreeMeta("tree-big", 2 * 1024 * 1024)

		givenTrees([
			{ item: small, parent },
			{ item: big, parent }
		])
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "tree-small" ? makeRemoteDir("tree-small", "Small", uuidParent("parent-1")) : undefined
		)

		await new OfflineSync().sync({ background: true })

		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledTimes(1)

		const reconciled = vi.mocked(offline.reconcileTree).mock.calls[0]?.[0] as unknown as { directory: DriveItem }

		expect(reconciled.directory.data.uuid).toBe("tree-small")

		// The oversized tree generated ZERO SDK traffic — its root was never even probed.
		const probedUuids = client.getDirOptional.mock.calls.map(call => call[0])

		expect(probedUuids).not.toContain("tree-big")
	})

	it("a foreground pass still syncs both trees (the cap is background-only)", async () => {
		const parent = makeNormalParent("parent-1")
		const small = makeTreeItem("tree-small", "Small", "parent-1")
		const big = makeTreeItem("tree-big", "Big", "parent-1")

		seedTreeMeta("tree-small", 1024)
		seedTreeMeta("tree-big", 2 * 1024 * 1024)

		givenTrees([
			{ item: small, parent },
			{ item: big, parent }
		])
		client.getDirOptional.mockImplementation(async (uuid: string) =>
			uuid === "tree-small" || uuid === "tree-big"
				? makeRemoteDir(uuid, uuid, uuidParent("parent-1"))
				: undefined
		)

		await new OfflineSync().sync({ manual: true })

		expect(vi.mocked(offline.reconcileTree)).toHaveBeenCalledTimes(2)
	})

	it("caps standalone files at OFFLINE_BACKGROUND_STANDALONE_FILE_CAP", async () => {
		const parent = makeNormalParent("parent-1")
		const files: { item: DriveItem; parent: OfflineParent }[] = []

		for (let i = 0; i < OFFLINE_BACKGROUND_STANDALONE_FILE_CAP + 10; i++) {
			files.push({
				item: makeFileItem(`file-${i}`, `file-${i}.txt`),
				parent
			})
		}

		givenFiles(files)

		await new OfflineSync().sync({ background: true })

		// Every processed standalone (absent from the empty parent listing) reaches the
		// own-cloud getFileOptional probe — the call count IS the processed count.
		expect(client.getFileOptional.mock.calls.length).toBe(OFFLINE_BACKGROUND_STANDALONE_FILE_CAP)
	})

	it("skips the broken-item heals in background (foreground owns repair)", async () => {
		await new OfflineSync().sync({ background: true })

		expect(vi.mocked(offline.listBrokenStandaloneUuids)).not.toHaveBeenCalled()
		expect(vi.mocked(offline.listBrokenTreeUuids)).not.toHaveBeenCalled()

		await new OfflineSync().sync()

		expect(vi.mocked(offline.listBrokenStandaloneUuids)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(offline.listBrokenTreeUuids)).toHaveBeenCalledTimes(1)
	})

	it("does not replace the session error surface (partial pass must not clear foreground errors)", async () => {
		const sentinel: OfflineSyncError[] = [
			{
				id: "sentinel",
				itemUuid: "item-1",
				topLevelUuid: null,
				name: "item",
				itemType: "file",
				kind: "store",
				message: "kept"
			} as unknown as OfflineSyncError
		]

		useOfflineStore.setState({
			syncing: false,
			syncErrors: sentinel
		})

		await new OfflineSync().sync({ background: true })

		expect(useOfflineStore.getState().syncErrors).toEqual(sentinel)

		// Foreground control: an auto pass rebuilds (here: clears) the surface.
		await new OfflineSync().sync()

		expect(useOfflineStore.getState().syncErrors).toEqual([])
	})

	it("does not stamp lastCompletedAt (the next foreground auto pass must still run)", async () => {
		const instance = new OfflineSync()

		await instance.sync({ background: true })

		expect(vi.mocked(offline.listFiles)).toHaveBeenCalledTimes(1)

		// If the background pass had stamped completion, this auto pass would be
		// suppressed by the min-interval gate.
		await instance.sync()

		expect(vi.mocked(offline.listFiles)).toHaveBeenCalledTimes(2)
	})

	it("still commits the index rebuild (a partial pass produces a consistent index)", async () => {
		await new OfflineSync().sync({ background: true })

		expect(vi.mocked(offline.updateIndex)).toHaveBeenCalledTimes(1)
	})
})

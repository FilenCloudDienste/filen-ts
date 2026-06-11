/**
 * URI-encoding regression suite for the offline lib.
 *
 * Guards the class of bug where disk addressing bypasses expo-file-system's encoding
 * pipeline: the (patched — see patches/expo-file-system+56.0.7.patch) `encodePathChars`
 * runs ONLY on Paths.join / File-Directory-constructor REST arguments. Pre-joining a raw
 * decrypted name into a single string (`base + rawPath`) skips it, so names containing
 * `[ ] ^ |` (and friends) reach the native layer raw and every stat misses — the
 * on-device symptom is "Missing on disk after sync: …" for any such filename
 * (regression 2026-06-11, originally fixed in f855d5d).
 *
 * Uses the encoding-faithful strict mock (@/tests/mocks/strictUriExpoFileSystem), which
 * keys its backing store by the fully-encoded uri exactly like the native layer does —
 * a raw-bracket lookup can never match a properly-stored file.
 */
import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/strictUriExpoFileSystem"))

const H = vi.hoisted(() => {
	const holders: {
		// Raw root-relative paths (leading "/") the fake downloader materializes, with sizes.
		downloadPlan: { path: string; size: number }[]
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		listing: { files: any[]; dirs: any[] }
	} = {
		downloadPlan: [],
		listing: {
			files: [],
			dirs: []
		}
	}

	return holders
})

vi.mock("@/features/transfers/transfers", () => ({
	default: {
		// Mirrors the REAL SDK downloader: writes bytes to disk natively under their RAW
		// names — on device those land at the correctly-encoded native paths.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		download: async (args: any) => {
			const { strictFsHelpers } = await import("@/tests/mocks/strictUriExpoFileSystem")

			for (const planned of H.downloadPlan) {
				strictFsHelpers.writeFileAt(args.destination.uri, planned.path, new Uint8Array(planned.size))
			}

			return {
				files: [],
				directories: []
			}
		}
	}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: async () => ({
			authedSdkClient: {
				listDirRecursiveWithPaths: async () => H.listing
			}
		})
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		directoryUuidToAnySharedDirWithContext: new Map()
	}
}))

vi.mock("@/lib/fileCache", () => ({ VERSION: 1 }))
vi.mock("@/features/audio/audioCache", () => ({ VERSION: 1 }))
vi.mock("@/lib/thumbnails", () => ({ VERSION: 2 }))
vi.mock("@/lib/secureStore", () => ({ default: { get: vi.fn().mockResolvedValue(null) } }))
vi.mock("@react-native-community/netinfo", () => ({ default: { fetch: vi.fn().mockResolvedValue({ type: "wifi" }) } }))
vi.mock("@/lib/events", () => ({ default: { subscribe: vi.fn() } }))

vi.mock("@/features/drive/queries/useDriveItemStoredOffline.query", () => ({
	driveItemStoredOfflineQueryUpdate: vi.fn(),
	getStoredOfflineQueryCacheEntries: vi.fn(() => [])
}))

vi.mock("@/features/drive/queries/useDriveItems.query", () => ({
	driveItemsQueryUpdate: vi.fn()
}))

// Same stub shapes as the canonical offline.test.ts.
vi.mock("@/lib/sdkUnwrap", () => ({
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	unwrapFileMeta: (file: any) => {
		const decoded = file?.meta?.tag === "Decoded" ? (file.meta.inner?.[0] ?? null) : null

		return {
			file,
			meta: decoded ?? null,
			undecryptable: decoded === null,
			shared: false,
			root: false
		}
	},
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	unwrapAnyDirUuid: (dir: any) => dir?.inner?.[0]?.inner?.[0]?.uuid ?? null,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	unwrapDirMeta: (dir: any) => {
		const decoded = dir?.meta?.tag === "Decoded" ? (dir.meta.inner?.[0] ?? null) : null

		return {
			dir,
			uuid: dir?.uuid ?? "unknown",
			meta: decoded ?? null,
			undecryptable: decoded === null,
			shared: false
		}
	},
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	unwrappedFileIntoDriveItem: (unwrapped: any) => ({
		type: "file" as const,
		data: {
			uuid: unwrapped.file?.uuid ?? "file-uuid",
			decryptedMeta: unwrapped.meta
				? {
						name: unwrapped.meta.name,
						size: unwrapped.meta.size ?? 100n,
						modified: unwrapped.meta.modified ?? 1000,
						created: unwrapped.meta.created ?? 900
					}
				: null,
			undecryptable: unwrapped.meta === null
		}
	}),
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	unwrappedDirIntoDriveItem: (unwrapped: any) => ({
		type: "directory" as const,
		data: {
			uuid: unwrapped.uuid ?? "dir-uuid",
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
	unwrapParentUuid: () => null
}))

vi.mock("@/lib/sdkErrors", () => ({ unwrapSdkError: () => null }))

vi.mock("@filen/sdk-rs", () => ({
	AnyDirWithContext: {
		Normal: class {
			tag = "Normal"
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
		}
	},
	AnyDirWithContext_Tags: {
		Normal: "Normal",
		Shared: "Shared",
		Linked: "Linked"
	},
	AnySharedDir_Tags: {
		Dir: "Dir",
		Root: "Root"
	},
	AnyNormalDir_Tags: {
		Dir: "Dir",
		Root: "Root"
	},
	AnyLinkedDir_Tags: {
		Dir: "Dir",
		Root: "Root"
	},
	AnySharedDir: {},
	AnySharedDirWithContext: {
		new: (opts: unknown) => opts
	},
	NonRootDir_Tags: {
		Normal: "Normal",
		Shared: "Shared",
		Linked: "Linked"
	},
	ParentUuid_Tags: {
		Uuid: "Uuid",
		Trash: "Trash"
	},
	ErrorKind: {
		FolderNotFound: "FolderNotFound"
	}
}))

import { strictFsHelpers } from "@/tests/mocks/strictUriExpoFileSystem"
import { Offline, VERSION as OFFLINE_VERSION } from "@/features/offline/offline"
import { AnyDirWithContext, AnyNormalDir } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import type { OfflineParent } from "@/features/offline/offlineHelpers"

const TREE_UUID = "11111111-1111-4111-8111-111111111111"
const PARENT_UUID = "22222222-2222-4222-8222-222222222222"
const BASE_DIR_URI = `file:///shared/group.io.filen.app/offline/v${OFFLINE_VERSION}`
const TREE_DIR_URI = `${BASE_DIR_URI}/directories/${TREE_UUID}`

// The exact on-device regression filename plus the rest of the native-fatal /
// encoding-sensitive set.
const NASTY_NAMES = [
	"MusicBrainz - Beth Hart - Sinner's Prayer [id3v2.3].V2.mp3",
	"brackets [x] ^caret^ |pipe|.bin",
	"literal %20 percent.jpg",
	"plain spaces and 'quotes'.png",
	"umlauts äöü ß.txt",
	"braces {b} `tick` \"quotes\" <angle>.dat"
]

function makeDirItem(uuid: string, name: string): DriveItem {
	return {
		type: "directory",
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

function makeFileItem(uuid: string, name: string): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
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

function makeParent(uuid: string): OfflineParent {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return new (AnyDirWithContext as any).Normal(new (AnyNormalDir as any).Dir({ uuid })) as OfflineParent
}

// Listing entry shapes the mocked sdkUnwrap stubs consume; paths are RAW root-relative
// WITHOUT a leading slash (offline.ts prefixes "/").
function makeListingFile(uuid: string, path: string, name: string): { file: unknown; path: string } {
	return {
		file: {
			uuid,
			meta: {
				tag: "Decoded",
				inner: [
					{
						name,
						size: 100n,
						modified: 1000,
						created: 900
					}
				]
			}
		},
		path
	}
}

function fileUuid(index: number): string {
	const n = (index + 0x10).toString(16).padStart(8, "0")

	return `${n}-0000-4000-8000-${(index + 0x10).toString(16).padStart(12, "0")}`
}

function setupNastyTreeFixture(): { directory: DriveItem; parent: OfflineParent } {
	const files = NASTY_NAMES.map((name, index) => makeListingFile(fileUuid(index), name, name))

	H.listing = {
		files,
		dirs: []
	}
	H.downloadPlan = NASTY_NAMES.map(name => ({
		path: `/${name}`,
		size: 100
	}))

	return {
		directory: makeDirItem(TREE_UUID, "Nasty"),
		parent: makeParent(PARENT_UUID)
	}
}

describe("offline disk addressing survives URI-illegal filename characters", () => {
	beforeEach(() => {
		strictFsHelpers.reset()
		vi.clearAllMocks()
	})

	it("initial store of a tree with [ ] ^ | { } space % names commits without verify errors", async () => {
		const { directory, parent } = setupNastyTreeFixture()
		const offline = new Offline()

		// The regression threw "Missing on disk after sync: /MusicBrainz - … [id3v2.3].V2.mp3"
		// out of storeDirectory because the verify stat bypassed the encoding pipeline.
		const errors = await offline.storeDirectory({
			directory,
			parent
		})

		expect(errors).toEqual([])
		expect(strictFsHelpers.has(`${TREE_DIR_URI}/${TREE_UUID}.filenmeta`)).toBe(true)
	})

	it("a thorough (disk-verified) no-op pass over the committed tree reports zero errors", async () => {
		const { directory, parent } = setupNastyTreeFixture()
		const offline = new Offline()

		await offline.storeDirectory({
			directory,
			parent
		})

		const errors = await offline.reconcileTree({
			directory,
			parent,
			hideProgress: true,
			skipIndexUpdate: true,
			thorough: true
		})

		expect(errors).toEqual([])
	})

	it("getLocalFile resolves a nested file whose name contains brackets", async () => {
		const { directory, parent } = setupNastyTreeFixture()
		const offline = new Offline()

		await offline.storeDirectory({
			directory,
			parent
		})

		const nested = makeFileItem(fileUuid(0), NASTY_NAMES[0] as string)
		const localFile = await offline.getLocalFile(nested)

		expect(localFile).not.toBeNull()
		expect(localFile?.exists).toBe(true)
	})

	it("an index-only no-op pass over the committed tree is a true fixed point (no errors, meta untouched)", async () => {
		const { directory, parent } = setupNastyTreeFixture()
		const offline = new Offline()

		await offline.storeDirectory({
			directory,
			parent
		})

		const errors = await offline.reconcileTree({
			directory,
			parent,
			hideProgress: true,
			skipIndexUpdate: true
		})

		expect(errors).toEqual([])
	})
})

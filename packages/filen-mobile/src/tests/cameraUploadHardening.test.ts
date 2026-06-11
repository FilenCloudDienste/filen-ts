/**
 * HARDENING suite for the cameraUpload lib — contract tripwires added ahead of the perf
 * optimization campaign (2026-06-11), mirroring the lesson from the offline campaign: perf
 * rewrites exploit whatever the suite under-specifies.
 *
 * What this file pins that the main suite does not:
 *
 * 1. ENUMERATION-ORDER DETERMINISM at scale — the tree (and therefore the uploaded name set)
 *    must be identical regardless of the order the media library enumerates assets. This is
 *    the invariant that prevents eternal re-uploads; it dies if anyone "optimizes away" the
 *    pre-tree sort or weakens its comparator (raw-ms compare, dropped tiebreak, …).
 * 2. CONVERGENCE (mirror-quiet oracle) — after a full upload pass, a second pass against a
 *    remote that mirrors exactly what was uploaded produces ZERO deltas, with the md5 cache
 *    cleared (tree-level convergence, not md5 shielding). Doubles as the correctness oracle
 *    for the upcoming perf benchmark.
 * 3. The deltas() mtime comparison uses SECONDS-FLOORED normalization. The main suite mocks
 *    normalizeModificationTimestampForComparison as identity, so dropping/inlining the call
 *    incorrectly would pass there — here it is mocked with the REAL floor semantics.
 * 4. Iteration-1 collision at SYNC level (a literal `name_<seconds>.ext` file occupying the
 *    iteration-0 slot) incl. B2 suffix reproduction in the uploaded name at iteration 1.
 * 5. maxUploads selects the NEWEST-modified deltas, not just any N.
 * 6. Special-character filenames ([ ] ( ) %XX umlauts quotes) flow through the full upload
 *    pipeline: raw byte-identical upload name, uuid-based tmp staging (never the raw name),
 *    raw lowercased md5-cache key.
 */
import { vi, describe, it, expect, beforeEach } from "vitest"
import { xxHash32 } from "js-xxhash"

// @ts-expect-error __DEV__ is a React Native global
globalThis.__DEV__ = true

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-media-library/next", async () => await import("@/tests/mocks/expoMediaLibrary"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("@react-native-community/netinfo", () => ({
	default: {
		fetch: vi.fn(async () => ({
			type: "wifi",
			isInternetReachable: true,
			isConnected: true
		}))
	}
}))

vi.mock("expo-battery", () => ({
	isLowPowerModeEnabledAsync: vi.fn(async () => false)
}))

vi.mock("expo-media-library/legacy", async () => {
	const next = await import("@/tests/mocks/expoMediaLibrary")

	return {
		getPermissionsAsync: vi.fn(async () => ({
			granted: true,
			status: "granted",
			accessPrivileges: "all",
			expires: "never",
			canAskAgain: true
		})),
		requestPermissionsAsync: vi.fn(async () => ({
			granted: true,
			status: "granted",
			accessPrivileges: "all",
			expires: "never",
			canAskAgain: true
		})),
		getAlbumsAsync: vi.fn(async () => {
			return Array.from(next.ml.albums.values()).map(stored => ({
				id: stored.id,
				title: stored.title,
				type: "album",
				assetCount: stored.assetIds.length
			}))
		})
	}
})

vi.mock("@/hooks/useMediaPermissions", () => ({
	hasAllNeededMediaPermissions: vi.fn(async () => true)
}))

vi.mock("expo-image-manipulator", () => ({
	ImageManipulator: {
		manipulate: vi.fn()
	},
	SaveFormat: {
		JPEG: "jpeg"
	}
}))

vi.mock("@filen/sdk-rs", () => ({
	AnyNormalDir: {
		Dir: vi.fn()
	},
	AnyDirWithContext: {
		Normal: vi.fn()
	}
}))

vi.mock("@filen/utils", async () => {
	const sharedMock = await import("@/tests/mocks/filenUtils")

	return {
		...sharedMock,
		fastLocaleCompare: (a: string, b: string) => a.localeCompare(b)
	}
})

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: vi.fn()
	}
}))

vi.mock("@/features/transfers/transfers", () => ({
	default: {
		upload: vi.fn()
	}
}))

const mockSetSyncing = vi.fn()
const mockSetErrors = vi.fn()
const mockAddSkippedAsset = vi.fn()
const mockClearSkippedAssets = vi.fn()

vi.mock("@/features/cameraUpload/store/useCameraUpload.store", () => ({
	default: {
		getState: () => ({
			setSyncing: mockSetSyncing,
			setErrors: mockSetErrors,
			addSkippedAsset: mockAddSkippedAsset,
			clearSkippedAssets: mockClearSkippedAssets
		})
	}
}))

vi.mock("@/lib/secureStore", () => ({
	default: {
		get: vi.fn(),
		set: vi.fn()
	},
	useSecureStore: vi.fn()
}))

vi.mock("zustand/shallow", () => ({
	useShallow: (fn: Function) => fn
}))

vi.mock("@/lib/events", () => ({
	default: {
		subscribe: vi.fn()
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		cameraUploadHashes: new Map()
	}
}))

vi.mock("@/lib/i18n", () => ({
	default: {
		t: (key: string) => key
	}
}))

// REAL floor semantics (src/lib/utils.ts) — the main suite uses identity here, which cannot
// catch a perf rewrite dropping the normalization from the deltas() comparison.
vi.mock("@/lib/utils", () => ({
	normalizeModificationTimestampForComparison: (timestamp: number) => Math.floor(timestamp / 1000)
}))

vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapFileMeta: vi.fn()
}))

vi.mock("@/lib/paths", () => ({
	normalizeFilePathForSdk: (p: string) => p,
	normalizeFilePathForExpo: (p: string) => p
}))

vi.mock("@/lib/signals", () => ({
	PauseSignal: class {
		pause() {}
		resume() {}
		dispose() {}
	}
}))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

import cache from "@/lib/cache"
import cameraUpload, { type Config } from "@/features/cameraUpload/cameraUpload"
import secureStore from "@/lib/secureStore"
import auth from "@/lib/auth"
import transfers from "@/features/transfers/transfers"
import { unwrapFileMeta } from "@/lib/sdkUnwrap"
import { ml, MediaType } from "@/tests/mocks/expoMediaLibrary"
import { fs } from "@/tests/mocks/expoFileSystem"

const ENABLED_CONFIG: Config = {
	enabled: true,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	remoteDir: { inner: [{ uuid: "remote-uuid" }] } as any,
	albumIds: ["album-1"],
	activationTimestamp: 0,
	afterActivation: false,
	includeVideos: true,
	cellular: true,
	background: true,
	lowBattery: true,
	compress: false
}

type FixtureAsset = {
	id: string
	filename: string
	creationTime: number
	modificationTime: number
}

// Remote listing entry whose meta rides on the file object — unwrapFileMeta is mocked to
// read it back, so multi-file listings get correct per-file metas.
type RemoteFixtureFile = {
	path: string
	file: {
		uuid: string
		__meta: {
			name: string
			created: bigint
			modified: bigint | null
		} | null
	}
}

function installRemoteListing(files: RemoteFixtureFile[]): void {
	vi.mocked(auth.getSdkClients).mockResolvedValue({
		authedSdkClient: {
			listDirRecursiveWithPaths: vi.fn(async () => ({
				files
			})),
			createDir: vi.fn(async () => ({
				uuid: "created-dir"
			}))
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any)
}

function setupDefaultMocks(): void {
	vi.mocked(secureStore.get).mockResolvedValue(ENABLED_CONFIG)
	installRemoteListing([])
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	vi.mocked(transfers.upload).mockResolvedValue({ files: [] } as any)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	vi.mocked(unwrapFileMeta).mockImplementation((file: any) => ({ meta: file?.__meta ?? null }) as any)
}

function addAssets(assets: FixtureAsset[]): void {
	ml.addAlbum({
		id: "album-1",
		title: "Camera Roll",
		assetIds: assets.map(asset => asset.id)
	})

	for (const asset of assets) {
		const uri = `file:///media/${asset.id}`

		ml.addAsset({
			id: asset.id,
			filename: asset.filename,
			uri,
			mediaType: MediaType.IMAGE,
			creationTime: asset.creationTime,
			modificationTime: asset.modificationTime
		})

		fs.set(uri, new Uint8Array([1, 2, 3]))
	}
}

function uploadedArgs(): { name: string; created: number; modified: number | undefined }[] {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return vi.mocked(transfers.upload).mock.calls.map(call => call[0] as any)
}

function uploadedNamesSorted(): string[] {
	return uploadedArgs()
		.map(args => args.name)
		.sort()
}

function resetBetweenRuns(): void {
	cameraUpload.cancel()
	cache.cameraUploadHashes.clear()
	vi.mocked(transfers.upload).mockClear()
}

// 120 mixed assets: 40 plain unique, 20 same-name pairs at DISTINCT seconds, 10 same-name
// pairs in the SAME floored second (equal mtimes so mirror passes stay quiet regardless of
// which twin owns which slot), 20 special-char names.
function buildMixedFixture(): FixtureAsset[] {
	const assets: FixtureAsset[] = []
	let id = 0

	for (let i = 0; i < 40; i++) {
		assets.push({
			id: `plain-${id++}`,
			filename: `img_${i}.jpg`,
			creationTime: 1_000_000 + i * 1000,
			modificationTime: 2_000_000 + i * 1000
		})
	}

	for (let k = 0; k < 20; k++) {
		const base = 3_000_000 + k * 10_000

		assets.push({
			id: `dup-a-${id++}`,
			filename: `dup_${k}.jpg`,
			creationTime: base,
			modificationTime: base
		})
		assets.push({
			id: `dup-b-${id++}`,
			filename: `dup_${k}.jpg`,
			creationTime: base + 5000,
			modificationTime: base + 5000
		})
	}

	for (let k = 0; k < 10; k++) {
		const base = 4_000_000 + k * 10_000

		assets.push({
			id: `twin-a-${id++}`,
			filename: `twin_${k}.jpg`,
			creationTime: base + 100,
			modificationTime: base
		})
		assets.push({
			id: `twin-b-${id++}`,
			filename: `twin_${k}.jpg`,
			creationTime: base + 900,
			modificationTime: base
		})
	}

	const specialNames = [
		"MusicBrainz - Sinner's Prayer [id3v2.3].V2.jpg",
		"IMG [edited] (1).jpg",
		"literal %20 percent.jpg",
		"umlauts äöü ß.jpg",
		"quote's \"double\".jpg",
		"braces {b} caret ^ pipe ¦.jpg",
		"plus+and&amp.jpg",
		"trailing space .jpg",
		"emoji 📷 shot.jpg",
		"comma, semi; colon.jpg"
	]

	for (let s = 0; s < specialNames.length; s++) {
		for (let v = 0; v < 2; v++) {
			assets.push({
				id: `special-${id++}`,
				filename: `${v === 0 ? "" : "v2 "}${specialNames[s]}`,
				creationTime: 5_000_000 + (s * 2 + v) * 1000,
				modificationTime: 5_500_000 + (s * 2 + v) * 1000
			})
		}
	}

	return assets
}

beforeEach(() => {
	vi.clearAllMocks()
	ml.clear()
	fs.clear()
	cache.cameraUploadHashes.clear()
	cameraUpload.cancel()
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	;(cameraUpload as any).ensureParentDirectoryExistsCache.clear()
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	;(cameraUpload as any).ensureParentDirectoryExistsInFlight.clear()
	setupDefaultMocks()
})

describe("hardening — enumeration-order determinism (the eternal-re-upload guard)", () => {
	it("120 mixed assets: reversed enumeration order produces the IDENTICAL uploaded name multiset", async () => {
		const fixture = buildMixedFixture()

		addAssets(fixture)
		await cameraUpload.sync()

		const firstRunNames = uploadedNamesSorted()

		expect(firstRunNames).toHaveLength(fixture.length)

		// Full reset, then the SAME assets enumerated in reverse order.
		resetBetweenRuns()
		ml.clear()
		addAssets([...fixture].reverse())

		await cameraUpload.sync()

		expect(uploadedNamesSorted()).toEqual(firstRunNames)
	})

	it("3 same-named assets at distinct seconds occupy exactly {base, _sec1, _sec2} slots", async () => {
		addAssets([
			{
				id: "x1",
				filename: "x.jpg",
				creationTime: 10_000,
				modificationTime: 1000
			},
			{
				id: "x2",
				filename: "x.jpg",
				creationTime: 20_000,
				modificationTime: 1000
			},
			{
				id: "x3",
				filename: "x.jpg",
				creationTime: 30_000,
				modificationTime: 1000
			}
		])

		await cameraUpload.sync()

		expect(uploadedNamesSorted()).toEqual(["x.jpg", "x_20.jpg", "x_30.jpg"])
	})
})

describe("hardening — mirror-quiet convergence oracle", () => {
	it("a second pass against a remote mirroring the first pass's uploads produces ZERO deltas (md5 cache cleared)", async () => {
		const fixture = buildMixedFixture()

		addAssets(fixture)
		await cameraUpload.sync()

		const uploads = uploadedArgs()

		expect(uploads).toHaveLength(fixture.length)

		// Build the remote EXACTLY as the backend would list what was uploaded: the raw
		// uploaded name as the path segment, `created`/`modified` echoing the sent values.
		const mirror: RemoteFixtureFile[] = uploads.map((upload, index) => ({
			path: `/Camera Roll/${upload.name}`,
			file: {
				uuid: `remote-${index}`,
				__meta: {
					name: upload.name,
					created: BigInt(upload.created),
					modified: upload.modified !== undefined ? BigInt(upload.modified) : null
				}
			}
		}))

		resetBetweenRuns()
		installRemoteListing(mirror)

		await cameraUpload.sync()

		// Tree-level convergence: zero uploads with NO md5 shielding involved.
		expect(transfers.upload).not.toHaveBeenCalled()
	})
})

describe("hardening — deltas() uses seconds-floored mtime comparison (real normalize semantics)", () => {
	function remotePhoto(modifiedMs: number): RemoteFixtureFile[] {
		return [
			{
				path: "/Camera Roll/photo.jpg",
				file: {
					uuid: "remote-1",
					__meta: {
						name: "photo.jpg",
						created: 1000n,
						modified: BigInt(modifiedMs)
					}
				}
			}
		]
	}

	it("sub-second drift (local 2999ms vs remote 2000ms — same floored second) does NOT re-upload", async () => {
		addAssets([
			{
				id: "a1",
				filename: "photo.jpg",
				creationTime: 1000,
				modificationTime: 2999
			}
		])
		installRemoteListing(remotePhoto(2000))

		await cameraUpload.sync()

		expect(transfers.upload).not.toHaveBeenCalled()
	})

	it("a full second of drift (local 3001ms vs remote 2000ms) DOES upload", async () => {
		addAssets([
			{
				id: "a1",
				filename: "photo.jpg",
				creationTime: 1000,
				modificationTime: 3001
			}
		])
		installRemoteListing(remotePhoto(2000))

		await cameraUpload.sync()

		expect(transfers.upload).toHaveBeenCalledTimes(1)
	})
})

describe("hardening — iteration-1 collision at sync level (literal `name_<seconds>` squatter)", () => {
	it("a file literally named x_456.jpg occupies the iteration-0 slot; the colliding asset lands on the xxHash slot and uploads under that suffix (B2 at iteration 1)", async () => {
		addAssets([
			{
				id: "squatter",
				filename: "x_456.jpg",
				creationTime: 100_000,
				modificationTime: 1000
			},
			{
				id: "base",
				filename: "x.jpg",
				creationTime: 123_000,
				modificationTime: 1000
			},
			{
				id: "collider",
				filename: "x.jpg",
				creationTime: 456_000,
				modificationTime: 1000
			}
		])

		await cameraUpload.sync()

		// iteration 1 suffix: xxHash32(`${name}_${contentHash}`) hex of ("x.jpg" + "_456").
		const expectedHex = xxHash32("x.jpg_456").toString(16)

		expect(uploadedNamesSorted()).toEqual(["x.jpg", `x_${expectedHex}.jpg`, "x_456.jpg"].sort())
	})
})

describe("hardening — maxUploads selects the NEWEST-modified deltas", () => {
	it("maxUploads: 2 uploads exactly the two newest by modificationTime", async () => {
		addAssets([
			{
				id: "old",
				filename: "old.jpg",
				creationTime: 1000,
				modificationTime: 1000
			},
			{
				id: "newest",
				filename: "newest.jpg",
				creationTime: 2000,
				modificationTime: 9_000_000
			},
			{
				id: "middle",
				filename: "middle.jpg",
				creationTime: 3000,
				modificationTime: 5_000_000
			}
		])

		await cameraUpload.sync({
			maxUploads: 2
		})

		expect(uploadedNamesSorted()).toEqual(["middle.jpg", "newest.jpg"])
	})
})

describe("hardening — special-character filenames through the full upload pipeline", () => {
	const RAW_NAME = "MusicBrainz - Beth Hart - Sinner's Prayer [id3v2.3] %20 ä.jpg"

	it("uploads under the byte-identical raw name, stages via a uuid-named tmp file, and keys the md5 cache by the raw lowercased path", async () => {
		addAssets([
			{
				id: "nasty",
				filename: RAW_NAME,
				creationTime: 1000,
				modificationTime: 2000
			}
		])

		let stagedUri: string | undefined

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		vi.mocked(transfers.upload).mockImplementationOnce(async (args: any) => {
			stagedUri = args.localFileOrDir.uri

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return { files: [] } as any
		})

		await cameraUpload.sync()

		const uploads = uploadedArgs()

		expect(uploads).toHaveLength(1)
		// Raw, byte-identical — any encoding/sanitization of the upload name breaks the
		// remote key symmetry and causes eternal re-uploads.
		expect(uploads[0]?.name).toBe(RAW_NAME)

		// Staging NEVER uses the raw filename — uuid + source extension only (the raw name
		// in a tmp PATH would resurrect the URI-encoding regression class).
		expect(stagedUri).toBeDefined()
		const stagedBasename = (stagedUri as string).slice((stagedUri as string).lastIndexOf("/") + 1)

		expect(stagedBasename).toMatch(/^mock-uuid-\d+\.jpg$/)

		// md5-cache key: the raw lowercased composed tree path.
		expect(cache.cameraUploadHashes.has(`/camera roll/${RAW_NAME.toLowerCase()}`)).toBe(true)
	})
})

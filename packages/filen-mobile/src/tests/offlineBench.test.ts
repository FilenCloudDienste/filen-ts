/**
 * TEMP performance benchmark for the offline lib (offline.ts + offlineSync.ts +
 * offlineSyncPlanner.ts + offlineHelpers.ts).
 *
 * Gated behind OFFLINE_BENCH=1 so the normal test suite ("npm test" / verify)
 * skips it entirely. Run with:
 *
 *   OFFLINE_BENCH=1 npx vitest run src/tests/offlineBench.test.ts
 *
 * Knobs (env): OFFLINE_BENCH_SAMPLES (default 7), OFFLINE_BENCH_WARMUP (default 3),
 * OFFLINE_BENCH_SCALE (default 1 — multiplies all entry counts).
 *
 * Methodology: per scenario — untimed prepare, one untimed validation run that
 * asserts the intended code path actually executed and captures FS op counts
 * (every op is a JS→native hop on device — an efficiency metric of its own),
 * then WARMUP warmup runs + SAMPLES timed runs. State is restored between runs
 * outside the timed region. Reported: min / median / mean ms.
 *
 * Everything third-party is mocked (expo-file-system via the fast hierarchical
 * mock, SDK, transfers, queries); the REAL serializer, @filen/utils, uuid,
 * storageRoots, tmp, fsAtomic, fsUtils and driveSelectors are used — they are
 * part of the lib's measured JS.
 */
import { describe, it, afterAll, vi } from "vitest"
import { writeFileSync } from "node:fs"

const H = vi.hoisted(() => {
	const counts = {
		storedOfflineUpdates: 0,
		driveItemsUpdates: 0,
		downloads: 0
	}

	const holders: {
		counts: typeof counts
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		client: any
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		download: (args: any) => Promise<any>
		uuidCounter: number
	} = {
		counts,
		client: null,
		download: async () => ({
			files: [],
			directories: []
		}),
		uuidCounter: 0
	}

	return holders
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/fastExpoFileSystem"))

vi.mock("expo-crypto", () => ({
	randomUUID: () => `bench-tmp-${H.uuidCounter++}`
}))

vi.mock("@/features/transfers/transfers", () => ({
	default: {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		download: (args: any) => {
			H.counts.downloads++

			return H.download(args)
		}
	}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: async () => ({
			authedSdkClient: H.client
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

vi.mock("@/lib/secureStore", () => ({
	default: {
		get: async () => null
	}
}))

vi.mock("@react-native-community/netinfo", () => ({
	default: {
		fetch: async () => ({
			type: "wifi"
		})
	}
}))

vi.mock("@tanstack/react-query", () => ({
	onlineManager: {
		isOnline: () => true
	}
}))

vi.mock("@/lib/events", () => ({
	default: {
		subscribe: () => {}
	}
}))

vi.mock("@/features/offline/store/useOffline.store", () => ({
	default: {
		getState: () => ({
			setSyncing: () => {},
			setSyncErrors: () => {}
		})
	}
}))

const EMPTY_CACHE_ENTRIES: never[] = []

vi.mock("@/features/drive/queries/useDriveItemStoredOffline.query", () => ({
	driveItemStoredOfflineQueryUpdate: () => {
		H.counts.storedOfflineUpdates++
	},
	getStoredOfflineQueryCacheEntries: () => EMPTY_CACHE_ENTRIES
}))

vi.mock("@/features/drive/queries/useDriveItems.query", () => ({
	driveItemsQueryUpdate: () => {
		H.counts.driveItemsUpdates++
	}
}))

// Same stub shapes as the canonical offline.test.ts — plain functions (NOT vi.fn,
// whose call recording would distort timings at thousands of calls per run).
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
	unwrapAnyDirUuid: (dir: any) => {
		if (!dir || typeof dir !== "object") {
			return null
		}

		return dir.inner?.[0]?.inner?.[0]?.uuid ?? null
	},
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
			uuid: unwrapped.uuid ?? unwrapped.dir?.uuid ?? "dir-uuid",
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
	unwrapParentUuid: () => null,
	isTrashParent: (parent: unknown) => (parent as { tag?: string } | null)?.tag === "Trash"
}))

vi.mock("@/lib/sdkErrors", () => ({
	unwrapSdkError: () => null
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
	SharingRole_Tags: {
		Sharer: "Sharer",
		Receiver: "Receiver"
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
		FolderNotFound: "FolderNotFound",
		WrongPassword: "WrongPassword"
	}
}))

import { benchFs, resetFsOpCounts, snapshotFsOpCounts } from "@/tests/mocks/fastExpoFileSystem"
import offlineSingleton, { Offline } from "@/features/offline/offline"
import offlineSyncSingleton from "@/features/offline/offlineSync"
import { planTreeReconcile, type RemoteTreeEntry, type LocalTreeEntry } from "@/features/offline/offlineSyncPlanner"
import {
	parentCacheKey,
	makeSyncError,
	findStaleStoredOfflineEntries,
	type OfflineParent,
	type StoredOfflineQueryCacheEntry
} from "@/features/offline/offlineHelpers"
import { OFFLINE_FILES_DIRECTORY, OFFLINE_DIRECTORIES_DIRECTORY, OFFLINE_INDEX_FILE } from "@/lib/storageRoots"
import { AnyDirWithContext, AnyNormalDir } from "@filen/sdk-rs"
import { validateUuid } from "@/lib/uuid"
import type { DriveItem } from "@/types"

const BENCH = process.env["OFFLINE_BENCH"] === "1"
const SCALE = Number(process.env["OFFLINE_BENCH_SCALE"] ?? "1")
const SAMPLES = Number(process.env["OFFLINE_BENCH_SAMPLES"] ?? "7")
const WARMUP = Number(process.env["OFFLINE_BENCH_WARMUP"] ?? "3")

// Headline baselines (user-set): a realistic-big tree (10k entries) AND a brutal one (100k).
const TREE_SIZES = [
	{
		n: Math.round(10_000 * SCALE),
		label: "10k"
	},
	{
		n: Math.round(100_000 * SCALE),
		label: "100k"
	}
]
const STANDALONE_N = Math.round(2000 * SCALE)
const SYNC_TREES = 4
const SYNC_TREE_N = Math.round(10_000 * SCALE)

const FILES_URI = OFFLINE_FILES_DIRECTORY.uri
const DIRECTORIES_URI = OFFLINE_DIRECTORIES_DIRECTORY.uri
const INDEX_URI = OFFLINE_INDEX_FILE.uri

// ─── fixtures ────────────────────────────────────────────────────────────────

let uuidCounter = 0

function makeUuid(): string {
	const n = ++uuidCounter

	return `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
}

function makeFileItem(uuid: string, name: string, size = 100n): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
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

function makeParent(uuid: string): OfflineParent {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return new (AnyDirWithContext as any).Normal(new (AnyNormalDir as any).Dir({ uuid })) as OfflineParent
}

// Remote listing entry shapes consumed by the mocked sdkUnwrap stubs.
function makeListingFile(uuid: string, path: string, name: string, size = 100n): { file: unknown; path: string } {
	return {
		file: {
			uuid,
			meta: {
				tag: "Decoded",
				inner: [
					{
						name,
						size,
						modified: 1000,
						created: 900
					}
				]
			}
		},
		path
	}
}

function makeListingDir(uuid: string, path: string, name: string): { dir: unknown; path: string } {
	return {
		dir: {
			tag: "Normal",
			inner: [
				{
					uuid,
					meta: {
						tag: "Decoded",
						inner: [
							{
								name
							}
						]
					}
				}
			]
		},
		path
	}
}

type TreeFixture = {
	uuid: string
	item: DriveItem
	parent: OfflineParent
	// Relative paths with leading "/" (meta/entry form), aligned arrays.
	dirRelPaths: string[]
	dirUuids: string[]
	fileRelPaths: string[]
	fileUuids: string[]
	fileSizes: number[]
	listing: {
		files: { file: unknown; path: string }[]
		dirs: { dir: unknown; path: string }[]
	}
	rootUri: string
	metaText: string | null
	indexText: string | null
}

// Builds a tree of `n` total entries: `topDirs` top-level dirs each containing
// `subDirs` subdirs; files spread round-robin across all leaf dirs.
function buildTreeFixture(n: number, topDirs?: number, subDirs?: number): TreeFixture {
	topDirs = topDirs ?? Math.max(4, Math.min(50, Math.floor(n / 100)))
	subDirs = subDirs ?? Math.max(2, Math.min(10, Math.floor(n / 500)))

	const uuid = makeUuid()
	const item = makeDirItem(uuid, `tree-${uuid.slice(0, 8)}`)
	const parent = makeParent(makeUuid())
	const dirRelPaths: string[] = []
	const dirUuids: string[] = []
	const listingDirs: { dir: unknown; path: string }[] = []
	const leafPaths: string[] = []

	for (let i = 0; i < topDirs; i++) {
		const dUuid = makeUuid()
		const dPath = `d${i}`

		dirUuids.push(dUuid)
		dirRelPaths.push(`/${dPath}`)
		listingDirs.push(makeListingDir(dUuid, dPath, dPath))

		for (let j = 0; j < subDirs; j++) {
			const sUuid = makeUuid()
			const sPath = `d${i}/s${j}`

			dirUuids.push(sUuid)
			dirRelPaths.push(`/${sPath}`)
			listingDirs.push(makeListingDir(sUuid, sPath, `s${j}`))
			leafPaths.push(sPath)
		}
	}

	const fileCount = Math.max(0, n - dirUuids.length)
	const fileRelPaths = new Array<string>(fileCount)
	const fileUuids = new Array<string>(fileCount)
	const fileSizes = new Array<number>(fileCount)
	const listingFiles = new Array<{ file: unknown; path: string }>(fileCount)

	for (let k = 0; k < fileCount; k++) {
		const fUuid = makeUuid()
		const leaf = leafPaths[k % leafPaths.length] as string
		const name = `f${k}.bin`
		const fPath = `${leaf}/${name}`

		fileUuids[k] = fUuid
		fileRelPaths[k] = `/${fPath}`
		fileSizes[k] = 100
		listingFiles[k] = makeListingFile(fUuid, fPath, name)
	}

	return {
		uuid,
		item,
		parent,
		dirRelPaths,
		dirUuids,
		fileRelPaths,
		fileUuids,
		fileSizes,
		listing: {
			files: listingFiles,
			dirs: listingDirs
		},
		rootUri: `${DIRECTORIES_URI}/${uuid}`,
		metaText: null,
		indexText: null
	}
}

// Materializes a tree's bytes on the fast fs (roots + dirs + data files), plus
// meta/index text when captured.
function materializeTree(fx: TreeFixture): void {
	benchFs.mkdirp(fx.rootUri)

	for (let i = 0; i < fx.dirRelPaths.length; i++) {
		benchFs.mkdirp(fx.rootUri + (fx.dirRelPaths[i] as string))
	}

	for (let i = 0; i < fx.fileRelPaths.length; i++) {
		benchFs.writeFile(fx.rootUri + (fx.fileRelPaths[i] as string), fx.fileSizes[i] as number)
	}

	if (fx.metaText !== null) {
		benchFs.writeFile(`${fx.rootUri}/${fx.uuid}.filenmeta`, fx.metaText.length, fx.metaText)
	}
}

function ensureRoots(): void {
	benchFs.mkdirp(FILES_URI)
	benchFs.mkdirp(DIRECTORIES_URI)
	benchFs.mkdirp("file:///cache/filen-tmp")
}

// A transfers.download fake that materializes the given tree listing under the
// destination (hash-idempotent: skips files already present) — mirrors the Rust
// downloader's behavior for directory downloads. For file destinations, writes
// the file at its meta size.
function smartDownloadForTrees(fixtures: TreeFixture[]): (args: { item: DriveItem; destination: { uri: string } }) => Promise<unknown> {
	const byUuid = new Map<string, TreeFixture>()

	for (const fx of fixtures) {
		byUuid.set(fx.uuid, fx)
	}

	return async args => {
		const fx = byUuid.get(args.item.data.uuid)

		if (!fx) {
			// Standalone file download.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const size = Number((args.item.data as any).decryptedMeta?.size ?? 0)

			benchFs.writeFile(args.destination.uri, size)

			return {
				files: [],
				directories: []
			}
		}

		const base = args.destination.uri

		for (let i = 0; i < fx.dirRelPaths.length; i++) {
			benchFs.mkdirp(base + (fx.dirRelPaths[i] as string))
		}

		for (let i = 0; i < fx.fileRelPaths.length; i++) {
			const uri = base + (fx.fileRelPaths[i] as string)

			if (!benchFs.isFile(uri)) {
				benchFs.writeFile(uri, fx.fileSizes[i] as number)
			}
		}

		return {
			files: [],
			directories: []
		}
	}
}

// SDK client fake: recursive listings + lookups served from per-scenario maps.
function makeClient({
	treeListings,
	dirLookups,
	fileLookups,
	parentListing,
	scanErrors
}: {
	treeListings?: Map<string, TreeFixture>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	dirLookups?: Map<string, any>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	fileLookups?: Map<string, any>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	parentListing?: { files: any[]; dirs: any[] }
	scanErrors?: unknown[]
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
} = {}): any {
	return {
		root: () => ({
			uuid: "root-uuid"
		}),
		getDirOptional: async (uuid: string) => dirLookups?.get(uuid),
		getFileOptional: async (uuid: string) => fileLookups?.get(uuid),
		listDir: async () =>
			parentListing ?? {
				files: [],
				dirs: []
			},
		listSharedDir: async () => ({
			files: [],
			dirs: []
		}),
		listInSharedRoot: async () => ({
			files: [],
			dirs: []
		}),
		listDirRecursiveWithPaths: async (
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			ctx: any,
			_progress: unknown,
			errCbs?: { onErrors: (errs: unknown[]) => void }
		) => {
			const uuid: string | undefined = ctx?.inner?.[0]?.inner?.[0]?.uuid
			const fx = uuid !== undefined ? treeListings?.get(uuid) : undefined

			if (scanErrors && scanErrors.length > 0 && errCbs) {
				errCbs.onErrors(scanErrors)
			}

			if (!fx) {
				return {
					files: [],
					dirs: []
				}
			}

			return fx.listing
		}
	}
}

// ─── harness ─────────────────────────────────────────────────────────────────

type BenchRow = {
	name: string
	min: number
	median: number
	mean: number
	fsOps: ReturnType<typeof snapshotFsOpCounts>
	note: string
}

const rows: BenchRow[] = []

function assertBench(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(`[bench validation] ${message}`)
	}
}

async function runScenario({
	name,
	prepare,
	beforeSample,
	run,
	validate,
	note
}: {
	name: string
	prepare?: () => void | Promise<void>
	beforeSample?: () => void | Promise<void>
	run: () => unknown | Promise<unknown>
	validate?: (result: unknown) => void | Promise<void>
	note?: string
}): Promise<void> {
	if (prepare) {
		await prepare()
	}

	// Validation run — also captures FS op counts for the table.
	if (beforeSample) {
		await beforeSample()
	}

	resetFsOpCounts()

	const validationResult = await run()
	const fsOps = snapshotFsOpCounts()

	if (validate) {
		await validate(validationResult)
	}

	for (let i = 0; i < WARMUP; i++) {
		if (beforeSample) {
			await beforeSample()
		}

		await run()
	}

	const samples = new Array<number>(SAMPLES)

	for (let i = 0; i < SAMPLES; i++) {
		if (beforeSample) {
			await beforeSample()
		}

		const t0 = performance.now()

		await run()

		samples[i] = performance.now() - t0
	}

	samples.sort((a, b) => a - b)

	const min = samples[0] as number
	const median = samples[Math.floor(SAMPLES / 2)] as number
	let sum = 0

	for (let i = 0; i < SAMPLES; i++) {
		sum += samples[i] as number
	}

	rows.push({
		name,
		min,
		median,
		mean: sum / SAMPLES,
		fsOps,
		note: note ?? ""
	})
}

function resetSingletons(): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const o = offlineSingleton as any

	o.indexCache = null
	o.invalidateCaches()

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const s = offlineSyncSingleton as any

	s.lastCompletedAt = 0
}

function freshOffline(): Offline {
	return new Offline()
}

// ─── planner fixture builders ────────────────────────────────────────────────

type PlannerFixture = {
	remote: Map<string, RemoteTreeEntry>
	local: LocalTreeEntry[]
}

function buildPlannerBase(n: number, topDirs = 50, subDirs = 10): PlannerFixture {
	const remote = new Map<string, RemoteTreeEntry>()
	const local: LocalTreeEntry[] = []
	const leafPaths: string[] = []

	for (let i = 0; i < topDirs; i++) {
		const dUuid = makeUuid()
		const dPath = `/d${i}`

		remote.set(dUuid, {
			uuid: dUuid,
			path: dPath,
			isDirectory: true
		})
		local.push({
			uuid: dUuid,
			path: dPath,
			isDirectory: true,
			existsOnDisk: true
		})

		for (let j = 0; j < subDirs; j++) {
			const sUuid = makeUuid()
			const sPath = `/d${i}/s${j}`

			remote.set(sUuid, {
				uuid: sUuid,
				path: sPath,
				isDirectory: true
			})
			local.push({
				uuid: sUuid,
				path: sPath,
				isDirectory: true,
				existsOnDisk: true
			})
			leafPaths.push(sPath)
		}
	}

	const fileCount = Math.max(0, n - local.length)

	for (let k = 0; k < fileCount; k++) {
		const fUuid = makeUuid()
		const fPath = `${leafPaths[k % leafPaths.length] as string}/f${k}.bin`

		remote.set(fUuid, {
			uuid: fUuid,
			path: fPath,
			isDirectory: false
		})
		local.push({
			uuid: fUuid,
			path: fPath,
			isDirectory: false,
			existsOnDisk: true
		})
	}

	return {
		remote,
		local
	}
}

function cloneRemote(remote: Map<string, RemoteTreeEntry>): Map<string, RemoteTreeEntry> {
	const out = new Map<string, RemoteTreeEntry>()

	for (const [uuid, entry] of remote) {
		out.set(uuid, {
			uuid: entry.uuid,
			path: entry.path,
			isDirectory: entry.isDirectory
		})
	}

	return out
}

// ─── benchmark suites ────────────────────────────────────────────────────────

describe.runIf(BENCH)("offline lib benchmark", () => {
	afterAll(() => {
		rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

		const nameWidth = Math.max(...rows.map(r => r.name.length), 8) + 2
		const lines: string[] = []

		lines.push("")
		lines.push(`OFFLINE LIB BENCHMARK — scale=${SCALE} samples=${SAMPLES} warmup=${WARMUP}`)
		lines.push(
			`sizes: trees=${TREE_SIZES.map(size => size.n).join("/")} standalones=${STANDALONE_N} syncTrees=${SYNC_TREES}x${SYNC_TREE_N}`
		)
		lines.push("")
		lines.push(
			`${"scenario".padEnd(nameWidth)}${"min ms".padStart(10)}${"med ms".padStart(10)}${"mean ms".padStart(10)}  fs ops (st/li/rd/wr/cr/de/mv)`
		)
		lines.push("-".repeat(nameWidth + 30 + 40))

		for (const row of rows) {
			const ops = row.fsOps
			const totalOps = ops.stat + ops.list + ops.read + ops.write + ops.create + ops.delete + ops.move
			const opsText = `${totalOps} (${ops.stat}/${ops.list}/${ops.read}/${ops.write}/${ops.create}/${ops.delete}/${ops.move})`

			lines.push(
				`${row.name.padEnd(nameWidth)}${row.min.toFixed(2).padStart(10)}${row.median.toFixed(2).padStart(10)}${row.mean
					.toFixed(2)
					.padStart(10)}  ${opsText}${row.note ? `  [${row.note}]` : ""}`
			)
		}

		lines.push("")
		console.log(lines.join("\n"))

		// vitest can swallow afterAll console output on passing non-TTY runs — always
		// persist the table to a file as well.
		const outPath = process.env["OFFLINE_BENCH_OUT"] ?? "/tmp/offline-bench-latest.txt"

		try {
			writeFileSync(outPath, lines.join("\n"))
		} catch {
			// best-effort
		}
	})

	// ─── planner (pure) ──────────────────────────────────────────────────────

	async function runPlannerSuite(plannerN: number, label: string): Promise<void> {
		const base = buildPlannerBase(plannerN)

		await runScenario({
			name: `planner-${label}/01-noop`,
			run: () =>
				planTreeReconcile({
					remote: base.remote,
					local: base.local,
					allowDeletes: true
				}),
			validate: result => {
				const plan = result as ReturnType<typeof planTreeReconcile>

				assertBench(plan.ops.length === 0, `noop plan has ops: ${plan.ops.length}`)
				assertBench(plan.missingUuids.length === 0, "noop plan has missing")
			}
		})

		// One top-level dir renamed — every entry beneath it changes path, but the
		// reduction pass must collapse it to ONE explicit mover.
		{
			const remote = cloneRemote(base.remote)

			for (const entry of remote.values()) {
				if (entry.path === "/d7" || entry.path.startsWith("/d7/")) {
					entry.path = `/d7x${entry.path.slice(3)}`
				}
			}

			await runScenario({
				name: `planner-${label}/02-dir-rename`,
				run: () =>
					planTreeReconcile({
						remote,
						local: base.local,
						allowDeletes: true
					}),
				validate: result => {
					const plan = result as ReturnType<typeof planTreeReconcile>

					assertBench(plan.ops.length === 2, `dir rename should be 2 ops (extract+place), got ${plan.ops.length}`)
				}
			})
		}

		// 10% of files renamed in place (independent movers).
		{
			const remote = cloneRemote(base.remote)
			let renamed = 0
			let i = 0

			for (const entry of remote.values()) {
				if (!entry.isDirectory && i++ % 10 === 0) {
					const slash = entry.path.lastIndexOf("/")

					entry.path = `${entry.path.slice(0, slash)}/renamed-${renamed++}.bin`
				}
			}

			await runScenario({
				name: `planner-${label}/03-file-renames-10pct`,
				run: () =>
					planTreeReconcile({
						remote,
						local: base.local,
						allowDeletes: true
					}),
				validate: result => {
					const plan = result as ReturnType<typeof planTreeReconcile>

					assertBench(plan.ops.length === renamed * 2, `expected ${renamed * 2} ops, got ${plan.ops.length}`)
				}
			})
		}

		// 10% of files moved into a different top-level dir.
		{
			const remote = cloneRemote(base.remote)
			let moved = 0
			let i = 0

			for (const entry of remote.values()) {
				if (!entry.isDirectory && i++ % 10 === 0) {
					const name = entry.path.slice(entry.path.lastIndexOf("/") + 1)

					entry.path = `/d0/s0/moved-${moved++}-${name}`
				}
			}

			await runScenario({
				name: `planner-${label}/04-moves-10pct`,
				run: () =>
					planTreeReconcile({
						remote,
						local: base.local,
						allowDeletes: true
					})
			})
		}

		// 10% deleted remotely.
		{
			const remote = cloneRemote(base.remote)
			let i = 0
			let deleted = 0

			for (const entry of base.remote.values()) {
				if (!entry.isDirectory && i++ % 10 === 0) {
					remote.delete(entry.uuid)
					deleted++
				}
			}

			await runScenario({
				name: `planner-${label}/05-deletes-10pct`,
				run: () =>
					planTreeReconcile({
						remote,
						local: base.local,
						allowDeletes: true
					}),
				validate: result => {
					const plan = result as ReturnType<typeof planTreeReconcile>

					assertBench(
						plan.ops.filter(op => op.type === "delete").length === deleted,
						`expected ${deleted} deletes, got ${plan.ops.filter(op => op.type === "delete").length}`
					)
				}
			})
		}

		// 10% new files remotely (missing locally).
		{
			const remote = cloneRemote(base.remote)
			const extra = Math.round(plannerN / 10)

			for (let k = 0; k < extra; k++) {
				const uuid = makeUuid()

				remote.set(uuid, {
					uuid,
					path: `/d1/s1/new-${k}.bin`,
					isDirectory: false
				})
			}

			await runScenario({
				name: `planner-${label}/06-new-10pct`,
				run: () =>
					planTreeReconcile({
						remote,
						local: base.local,
						allowDeletes: true
					}),
				validate: result => {
					const plan = result as ReturnType<typeof planTreeReconcile>

					assertBench(plan.missingUuids.length === extra, `expected ${extra} missing, got ${plan.missingUuids.length}`)
				}
			})
		}

		// Mixed: a dir rename + file renames + moves + deletes + news (5% each-ish).
		{
			const remote = cloneRemote(base.remote)
			let i = 0

			for (const entry of remote.values()) {
				if (entry.path === "/d3" || entry.path.startsWith("/d3/")) {
					entry.path = `/d3x${entry.path.slice(3)}`

					continue
				}

				if (entry.isDirectory) {
					continue
				}

				const mod = i++ % 20

				if (mod === 0) {
					const slash = entry.path.lastIndexOf("/")

					entry.path = `${entry.path.slice(0, slash)}/mixre-${i}.bin`
				} else if (mod === 1) {
					entry.path = `/d2/s2/mixmv-${i}.bin`
				} else if (mod === 2) {
					remote.delete(entry.uuid)
				}
			}

			for (let k = 0; k < plannerN / 20; k++) {
				const uuid = makeUuid()

				remote.set(uuid, {
					uuid,
					path: `/d4/s0/mixnew-${k}.bin`,
					isDirectory: false
				})
			}

			await runScenario({
				name: `planner-${label}/07-mixed`,
				run: () =>
					planTreeReconcile({
						remote,
						local: base.local,
						allowDeletes: true
					})
			})
		}

		// Degraded fixpoint: chains of movers where each mover's destination is the
		// current path of the next mover, terminated by a remote-gone stay — forces
		// one deferral round per chain link.
		{
			const remote = cloneRemote(base.remote)
			const chainLength = 8
			const chains = 25
			let fileEntries: RemoteTreeEntry[] = []

			for (const entry of remote.values()) {
				if (!entry.isDirectory) {
					fileEntries.push(entry)
				}
			}

			fileEntries = fileEntries.slice(0, chains * chainLength)

			for (let c = 0; c < chains; c++) {
				for (let l = 0; l < chainLength; l++) {
					const mover = fileEntries[c * chainLength + l] as RemoteTreeEntry

					if (l < chainLength - 1) {
						// Destination = next link's CURRENT path.
						const next = fileEntries[c * chainLength + l + 1] as RemoteTreeEntry

						mover.path = next.path
					} else {
						// Last link wants the spot of a remote-gone local entry.
						const goneVictim = base.local[base.local.length - 1 - c] as LocalTreeEntry

						remote.delete(goneVictim.uuid)
						mover.path = goneVictim.path
					}
				}
			}

			await runScenario({
				name: `planner-${label}/08-degraded-deferred-chains`,
				run: () =>
					planTreeReconcile({
						remote,
						local: base.local,
						allowDeletes: false
					}),
				validate: result => {
					const plan = result as ReturnType<typeof planTreeReconcile>

					assertBench(plan.deferredMoves.length > 0, "expected deferred moves")
				}
			})
		}
	}

	it("planner scenarios", { timeout: 1_200_000 }, async () => {
		for (const size of TREE_SIZES) {
			await runPlannerSuite(size.n, size.label)
		}
	})

	// ─── reconcileTree ───────────────────────────────────────────────────────

	async function runReconcileSuite(treeN: number, label: string): Promise<void> {
		// Shared prepared tree: initial store captures committed meta + index text.
		const fx = buildTreeFixture(treeN)

		benchFs.reset()
		ensureRoots()
		H.client = makeClient({
			treeListings: new Map([[fx.uuid, fx]])
		})
		H.download = smartDownloadForTrees([fx])

		{
			const o = freshOffline()
			const errors = await o.storeDirectory({
				directory: fx.item,
				parent: fx.parent
			})

			assertBench(errors.length === 0, `initial store errors: ${JSON.stringify(errors)}`)

			fx.metaText = benchFs.readText(`${fx.rootUri}/${fx.uuid}.filenmeta`)
			fx.indexText = benchFs.readText(INDEX_URI)
			assertBench(fx.metaText !== null && fx.metaText.length > 0, "meta text missing after initial store")
			assertBench(fx.indexText !== null && (fx.indexText as string).length > 0, "index text missing after initial store")
		}

		const restoreCommitted = (): void => {
			benchFs.reset()
			ensureRoots()
			materializeTree(fx)
			benchFs.writeFile(INDEX_URI, (fx.indexText as string).length, fx.indexText)
		}

		let o = freshOffline()

		// TRUE no-op pass, index-only local view (the most common pass on device).
		await runScenario({
			name: `reconcile-${label}/01-noop-index-only`,
			beforeSample: () => {
				restoreCommitted()
				o = freshOffline()
			},
			run: () =>
				o.reconcileTree({
					directory: fx.item,
					parent: fx.parent,
					skipIndexUpdate: true
				}),
			validate: result => {
				assertBench((result as unknown[]).length === 0, "noop pass returned errors")
				assertBench(benchFs.readText(`${fx.rootUri}/${fx.uuid}.filenmeta`) === fx.metaText, "noop pass rewrote meta")
			},
			note: `${treeN} entries`
		})

		// Same no-op pass with a WARM instance (directoryMetaCache/indexCache populated) — the
		// device steady state: the singleton keeps its caches between passes, so no deserialize.
		await runScenario({
			name: `reconcile-${label}/01b-noop-warm-meta`,
			prepare: () => {
				restoreCommitted()
				o = freshOffline()
			},
			beforeSample: async () => {
				// Throwaway pass warms the meta cache; the timed pass is pure in-memory JS.
				await o.reconcileTree({
					directory: fx.item,
					parent: fx.parent,
					skipIndexUpdate: true
				})
			},
			run: () =>
				o.reconcileTree({
					directory: fx.item,
					parent: fx.parent,
					skipIndexUpdate: true
				}),
			validate: result => {
				assertBench((result as unknown[]).length === 0, "warm noop pass returned errors")
			},
			note: "meta cache warm (device steady state)"
		})

		// No-op pass, thorough (disk-verified) local view.
		await runScenario({
			name: `reconcile-${label}/02-noop-thorough`,
			beforeSample: () => {
				restoreCommitted()
				o = freshOffline()
			},
			run: () =>
				o.reconcileTree({
					directory: fx.item,
					parent: fx.parent,
					skipIndexUpdate: true,
					thorough: true
				}),
			validate: result => {
				assertBench((result as unknown[]).length === 0, "thorough noop pass returned errors")
			},
			note: `${treeN} entries`
		})

		// Remote dir rename: 1 explicit mover (2 move ops) + meta rewrite + overlap dedup.
		{
			const renamed = buildTreeFixture(treeN)

			// Same tree, but d5 renamed remotely.
			renamed.uuid = fx.uuid
			renamed.item = fx.item
			renamed.parent = fx.parent
			renamed.rootUri = fx.rootUri
			renamed.dirRelPaths = fx.dirRelPaths
			renamed.dirUuids = fx.dirUuids
			renamed.fileRelPaths = fx.fileRelPaths
			renamed.fileUuids = fx.fileUuids
			renamed.fileSizes = fx.fileSizes

			const listingDirs = fx.listing.dirs.map(entry => {
				if (entry.path === "d5" || entry.path.startsWith("d5/")) {
					return {
						dir: entry.dir,
						path: `d5x${entry.path.slice(2)}`
					}
				}

				return entry
			})
			const listingFiles = fx.listing.files.map(entry => {
				if (entry.path.startsWith("d5/")) {
					return {
						file: entry.file,
						path: `d5x${entry.path.slice(2)}`
					}
				}

				return entry
			})

			renamed.listing = {
				files: listingFiles,
				dirs: listingDirs
			}

			await runScenario({
				name: `reconcile-${label}/03-dir-rename-commit`,
				prepare: () => {
					H.client = makeClient({
						treeListings: new Map([[fx.uuid, renamed]])
					})
				},
				beforeSample: () => {
					restoreCommitted()
					o = freshOffline()
				},
				run: () =>
					o.reconcileTree({
						directory: fx.item,
						parent: fx.parent,
						skipIndexUpdate: true
					}),
				validate: result => {
					assertBench((result as unknown[]).length === 0, "rename pass returned errors")
					assertBench(benchFs.exists(`${fx.rootUri}/d5x`), "renamed dir missing on disk")
					assertBench(!benchFs.exists(`${fx.rootUri}/d5`), "old dir still on disk")
				},
				note: "1 dir mover"
			})
		}

		// Download pass: 10% new remote files materialized by the fake downloader,
		// full verify + commit + orphan sweep.
		{
			const grown = buildTreeFixture(treeN)

			grown.uuid = fx.uuid
			grown.item = fx.item
			grown.parent = fx.parent
			grown.rootUri = fx.rootUri

			const extraCount = Math.round(treeN / 10)
			const extraFiles: { file: unknown; path: string }[] = []
			const extraRel: string[] = []
			const extraSizes: number[] = []

			for (let k = 0; k < extraCount; k++) {
				const uuid = makeUuid()
				const path = `d1/s0/grown-${k}.bin`

				extraFiles.push(makeListingFile(uuid, path, `grown-${k}.bin`))
				extraRel.push(`/${path}`)
				extraSizes.push(100)
			}

			grown.dirRelPaths = fx.dirRelPaths
			grown.dirUuids = fx.dirUuids
			grown.fileRelPaths = [...fx.fileRelPaths, ...extraRel]
			grown.fileUuids = fx.fileUuids
			grown.fileSizes = [...fx.fileSizes, ...extraSizes]
			grown.listing = {
				files: [...fx.listing.files, ...extraFiles],
				dirs: fx.listing.dirs
			}

			await runScenario({
				name: `reconcile-${label}/04-download-10pct`,
				prepare: () => {
					H.client = makeClient({
						treeListings: new Map([[fx.uuid, grown]])
					})
					H.download = smartDownloadForTrees([grown])
				},
				beforeSample: () => {
					restoreCommitted()
					o = freshOffline()
				},
				run: () =>
					o.reconcileTree({
						directory: fx.item,
						parent: fx.parent,
						skipIndexUpdate: true
					}),
				validate: result => {
					assertBench((result as unknown[]).length === 0, `download pass errors: ${JSON.stringify(result)}`)
					assertBench(benchFs.isFile(`${fx.rootUri}/d1/s0/grown-0.bin`), "downloaded file missing")
				},
				note: `${Math.round(treeN / 10)} downloads + verify + sweep`
			})
		}

		// Degraded listing: scan errors → deletes skipped, verified-union commit path.
		{
			const partial = buildTreeFixture(treeN)

			partial.uuid = fx.uuid
			partial.item = fx.item
			partial.parent = fx.parent
			partial.rootUri = fx.rootUri
			partial.dirRelPaths = fx.dirRelPaths
			partial.fileRelPaths = fx.fileRelPaths
			partial.fileSizes = fx.fileSizes

			// Listing silently misses 10% of files (simulated unscanned subtree).
			const keptFiles = fx.listing.files.filter((_, i) => i % 10 !== 0)

			partial.listing = {
				files: keptFiles,
				dirs: fx.listing.dirs
			}

			await runScenario({
				name: `reconcile-${label}/05-degraded-union`,
				prepare: () => {
					H.client = makeClient({
						treeListings: new Map([[fx.uuid, partial]]),
						scanErrors: [new Error("bench scan error")]
					})
					H.download = smartDownloadForTrees([fx])
				},
				beforeSample: () => {
					restoreCommitted()
					o = freshOffline()
				},
				run: () =>
					o.reconcileTree({
						directory: fx.item,
						parent: fx.parent,
						skipIndexUpdate: true
					}),
				validate: result => {
					const errors = result as { degraded?: boolean }[]

					assertBench(errors.length === 1 && errors[0]?.degraded === true, "expected exactly the degraded marker")
				},
				note: "10pct unlisted, union restat"
			})
		}

		// Initial store of a whole tree (empty local state) incl. one updateIndex.
		{
			const storeFx = buildTreeFixture(treeN)

			await runScenario({
				name: `reconcile-${label}/06-initial-store`,
				prepare: () => {
					H.client = makeClient({
						treeListings: new Map([[storeFx.uuid, storeFx]])
					})
					H.download = smartDownloadForTrees([storeFx])
				},
				beforeSample: () => {
					benchFs.reset()
					ensureRoots()
					o = freshOffline()
				},
				run: () =>
					o.storeDirectory({
						directory: storeFx.item,
						parent: storeFx.parent
					}),
				validate: result => {
					assertBench((result as unknown[]).length === 0, "initial store returned errors")
					assertBench(benchFs.readText(`${storeFx.rootUri}/${storeFx.uuid}.filenmeta`) !== null, "meta not written")
				},
				note: `${treeN} entries, incl. updateIndex`
			})
		}

		// Restore default handlers for following suites.
		H.client = makeClient({
			treeListings: new Map([[fx.uuid, fx]])
		})
		H.download = smartDownloadForTrees([fx])
	}

	it("reconcile scenarios", { timeout: 1_200_000 }, async () => {
		for (const size of TREE_SIZES) {
			await runReconcileSuite(size.n, size.label)
		}
	})

	// ─── index / listing / lookup APIs ───────────────────────────────────────

	it("index and listing scenarios", { timeout: 600_000 }, async () => {
		// Mixed store: STANDALONE_N standalone files + SYNC_TREES trees x SYNC_TREE_N entries.
		const standaloneParent = makeParent(makeUuid())
		const standaloneUuids: string[] = []
		const standaloneItems: DriveItem[] = []
		const standaloneMetaTexts: string[] = []
		const trees: TreeFixture[] = []

		for (let i = 0; i < STANDALONE_N; i++) {
			const uuid = makeUuid()
			const item = makeFileItem(uuid, `sa-${i}.bin`)

			standaloneUuids.push(uuid)
			standaloneItems.push(item)
		}

		for (let t = 0; t < SYNC_TREES; t++) {
			trees.push(buildTreeFixture(SYNC_TREE_N))
		}

		// Build committed state once: store everything, snapshot meta/index texts.
		benchFs.reset()
		ensureRoots()
		H.client = makeClient({
			treeListings: new Map(trees.map(fx => [fx.uuid, fx]))
		})
		H.download = smartDownloadForTrees(trees)

		{
			const o = freshOffline()

			for (let i = 0; i < STANDALONE_N; i++) {
				const stored = await o.storeFile({
					file: standaloneItems[i] as DriveItem,
					parent: standaloneParent,
					skipIndexUpdate: true
				})

				assertBench(stored, `standalone ${i} not stored`)
			}

			for (const fx of trees) {
				const errors = await o.storeDirectory({
					directory: fx.item,
					parent: fx.parent,
					skipIndexUpdate: true
				})

				assertBench(errors.length === 0, "tree store errors")
				fx.metaText = benchFs.readText(`${fx.rootUri}/${fx.uuid}.filenmeta`)
				assertBench(fx.metaText !== null, "tree meta missing")
			}

			await o.updateIndex()

			for (let i = 0; i < STANDALONE_N; i++) {
				const uuid = standaloneUuids[i] as string
				const text = benchFs.readText(`${FILES_URI}/${uuid}/${uuid}.filenmeta`)

				assertBench(text !== null, `standalone meta ${i} missing`)
				standaloneMetaTexts.push(text as string)
			}
		}

		const indexText = benchFs.readText(INDEX_URI)

		assertBench(indexText !== null, "index missing after mixed store")

		const restoreMixed = (): void => {
			benchFs.reset()
			ensureRoots()

			for (let i = 0; i < STANDALONE_N; i++) {
				const uuid = standaloneUuids[i] as string
				const metaText = standaloneMetaTexts[i] as string

				benchFs.mkdirp(`${FILES_URI}/${uuid}`)
				benchFs.writeFile(`${FILES_URI}/${uuid}/sa-${i}.bin`, 100)
				benchFs.writeFile(`${FILES_URI}/${uuid}/${uuid}.filenmeta`, metaText.length, metaText)
			}

			for (const fx of trees) {
				materializeTree(fx)
			}

			benchFs.writeFile(INDEX_URI, (indexText as string).length, indexText)
		}

		let o = freshOffline()

		await runScenario({
			name: "index/01-updateIndex",
			beforeSample: () => {
				restoreMixed()
				o = freshOffline()
			},
			run: () => o.updateIndex(),
			note: `${STANDALONE_N} standalones + ${SYNC_TREES}x${SYNC_TREE_N} tree entries`
		})

		// Repeated updateIndex on a WARM instance (previous in-memory index present, nothing
		// changed) — the steady-state end-of-sync-pass shape: diff broadcasts + fixed-point write
		// skip.
		await runScenario({
			name: "index/01b-updateIndex-warm-noop",
			prepare: () => {
				restoreMixed()
				o = freshOffline()
			},
			beforeSample: async () => {
				await o.updateIndex()
			},
			run: () => o.updateIndex(),
			note: "previous index in memory, no changes"
		})

		await runScenario({
			name: "index/02-readIndex-cold",
			beforeSample: () => {
				restoreMixed()
				o = freshOffline()
			},
			run: () => o.isItemStored(standaloneItems[0] as DriveItem),
			validate: result => {
				assertBench(result === true, "expected stored standalone")
			},
			note: "cold readIndex + buildUuidToTopLevel"
		})

		await runScenario({
			name: "index/03-isItemStored-warm-1k",
			prepare: () => {
				restoreMixed()
				o = freshOffline()
			},
			beforeSample: async () => {
				// Warm the caches once; timed region is pure cache hits.
				await o.isItemStored(standaloneItems[0] as DriveItem)
			},
			run: async () => {
				let hits = 0

				for (let i = 0; i < 1000; i++) {
					if (await o.isItemStored(standaloneItems[i % STANDALONE_N] as DriveItem)) {
						hits++
					}
				}

				return hits
			},
			validate: result => {
				assertBench(result === 1000, `expected 1000 hits, got ${String(result)}`)
			}
		})

		await runScenario({
			name: "list/01-listFiles-cold",
			beforeSample: () => {
				restoreMixed()
				o = freshOffline()
			},
			run: () => o.listFiles(),
			validate: result => {
				assertBench((result as unknown[]).length === STANDALONE_N, "listFiles count mismatch")
			}
		})

		await runScenario({
			name: "list/02-listDirectoriesRecursive-cold",
			beforeSample: () => {
				restoreMixed()
				o = freshOffline()
			},
			run: () => o.listDirectoriesRecursive(),
			validate: result => {
				const lists = result as { files: unknown[]; directories: unknown[] }

				assertBench(lists.files.length > 0 && lists.directories.length > 0, "recursive list empty")
			}
		})

		await runScenario({
			name: "list/03-listDirectories-root-cold",
			beforeSample: () => {
				restoreMixed()
				o = freshOffline()
			},
			run: () => o.listDirectories(),
			validate: result => {
				assertBench((result as { directories: unknown[] }).directories.length === SYNC_TREES, "top-level tree count mismatch")
			}
		})

		await runScenario({
			name: "list/04-listDirectories-nested-cold",
			beforeSample: () => {
				restoreMixed()
				o = freshOffline()
			},
			run: () => {
				const fx = trees[0] as TreeFixture
				// Parent = the tree's first top-level dir (d0) → children are its subdirs + files.
				const nestedParent = makeParent(fx.dirUuids[0] as string)

				return o.listDirectories(nestedParent)
			},
			validate: result => {
				const lists = result as { files: unknown[]; directories: unknown[] }

				assertBench(lists.directories.length > 0, "nested listing empty")
			}
		})

		await runScenario({
			name: "size/01-itemSize-tree",
			beforeSample: () => {
				restoreMixed()
				o = freshOffline()
			},
			run: () => o.itemSize((trees[0] as TreeFixture).item),
			validate: result => {
				const size = result as { files: number; dirs: number; size: number }

				assertBench(size.files > 0, "itemSize found no files")
			}
		})

		await runScenario({
			name: "size/02-size-total",
			beforeSample: () => {
				restoreMixed()
				o = freshOffline()
			},
			run: () => o.size(),
			validate: result => {
				const size = result as { files: number; dirs: number; size: number }

				assertBench(size.size > 0, "size() zero")
			},
			note: "sumLocalDirectoryFileBytes over whole store"
		})

		await runScenario({
			name: "local/01-getLocalFile-nested-300",
			prepare: () => {
				restoreMixed()
				o = freshOffline()
			},
			beforeSample: async () => {
				o = freshOffline()
				await o.isItemStored(standaloneItems[0] as DriveItem)
			},
			run: async () => {
				const fx = trees[0] as TreeFixture
				let found = 0

				for (let i = 0; i < 300; i++) {
					const idx = i % fx.fileUuids.length
					const item = makeFileItem(fx.fileUuids[idx] as string, `f${idx}.bin`)
					const file = await o.getLocalFile(item)

					if (file) {
						found++
					}
				}

				return found
			},
			validate: result => {
				assertBench(result === 300, `expected 300 found, got ${String(result)}`)
			},
			note: "tree-nested lookups, fresh getLocalFileCache"
		})

		await runScenario({
			name: "broken/01-listBrokenStandaloneUuids",
			beforeSample: () => {
				restoreMixed()

				// Break 5% of standalone metas (delete the meta file, keep data).
				for (let i = 0; i < STANDALONE_N; i += 20) {
					const uuid = standaloneUuids[i] as string

					benchFs.deletePath(`${FILES_URI}/${uuid}/${uuid}.filenmeta`)
				}

				o = freshOffline()
			},
			run: () => o.listBrokenStandaloneUuids(),
			validate: result => {
				assertBench((result as unknown[]).length === Math.ceil(STANDALONE_N / 20), "broken standalone count mismatch")
			}
		})

		await runScenario({
			name: "broken/02-listBrokenTreeUuids",
			beforeSample: () => {
				restoreMixed()
				o = freshOffline()
			},
			run: () => o.listBrokenTreeUuids(),
			validate: result => {
				assertBench((result as unknown[]).length === 0, "no trees should be broken")
			},
			note: "reads every tree meta"
		})

		// Keep the mixed state + texts for the sync suite via module-scope stash.
		stash.standaloneParent = standaloneParent
		stash.standaloneUuids = standaloneUuids
		stash.standaloneItems = standaloneItems
		stash.standaloneMetaTexts = standaloneMetaTexts
		stash.trees = trees
		stash.indexText = indexText as string
		stash.restoreMixed = restoreMixed
	})

	// ─── offlineSync (full passes over the singletons) ───────────────────────

	it("sync scenarios", { timeout: 600_000 }, async () => {
		const { standaloneUuids, trees, restoreMixed } = stash

		assertBench(trees.length > 0 && standaloneUuids.length > 0, "stash not populated — index suite must run first")

		// Remote state: every tree alive + unchanged, every standalone present in its
		// parent's listing under the same name.
		const dirLookups = new Map<string, unknown>()

		for (const fx of trees) {
			dirLookups.set(fx.uuid, {
				uuid: fx.uuid,
				parent: {
					tag: "Uuid"
				},
				meta: {
					tag: "Decoded",
					inner: [
						{
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							name: (fx.item.data as any).decryptedMeta.name
						}
					]
				}
			})
		}

		const parentListingFiles = standaloneUuids.map((uuid, i) => ({
			uuid,
			meta: {
				tag: "Decoded",
				inner: [
					{
						name: `sa-${i}.bin`,
						size: 100n,
						modified: 1000,
						created: 900
					}
				]
			}
		}))

		const treeListings = new Map(trees.map(fx => [fx.uuid, fx]))

		const beforeSyncSample = (): void => {
			restoreMixed()
			resetSingletons()
		}

		await runScenario({
			name: "sync/01-pass-all-unchanged-auto",
			prepare: () => {
				H.client = makeClient({
					treeListings,
					dirLookups: dirLookups as Map<string, unknown>,
					parentListing: {
						files: parentListingFiles,
						dirs: []
					}
				})
				H.download = smartDownloadForTrees(trees)
			},
			beforeSample: beforeSyncSample,
			run: () => offlineSyncSingleton.sync(),
			note: `${SYNC_TREES} trees + ${STANDALONE_N} standalones, index-only`
		})

		await runScenario({
			name: "sync/02-pass-all-unchanged-thorough",
			beforeSample: beforeSyncSample,
			run: () =>
				offlineSyncSingleton.sync({
					manual: true
				}),
			note: "manual ⟹ disk-verified"
		})

		// Standalone rename storm: every standalone renamed remotely.
		{
			const renamedListingFiles = standaloneUuids.map((uuid, i) => ({
				uuid,
				meta: {
					tag: "Decoded",
					inner: [
						{
							name: `renamed-${i}.bin`,
							size: 100n,
							modified: 1000,
							created: 900
						}
					]
				}
			}))

			await runScenario({
				name: "sync/03-standalone-rename-storm",
				prepare: () => {
					H.client = makeClient({
						treeListings,
						dirLookups: dirLookups as Map<string, unknown>,
						parentListing: {
							files: renamedListingFiles,
							dirs: []
						}
					})
				},
				beforeSample: beforeSyncSample,
				run: () => offlineSyncSingleton.sync(),
				validate: () => {
					const uuid = standaloneUuids[0] as string

					assertBench(benchFs.isFile(`${FILES_URI}/${uuid}/renamed-0.bin`), "rename did not land on disk")
				},
				note: `${STANDALONE_N} renameStandaloneFile calls`
			})
		}

		// Restore the unchanged listing for any later suites.
		H.client = makeClient({
			treeListings,
			dirLookups: dirLookups as Map<string, unknown>,
			parentListing: {
				files: parentListingFiles,
				dirs: []
			}
		})
	})

	// ─── helpers (micro) ─────────────────────────────────────────────────────

	it("helper scenarios", { timeout: 600_000 }, async () => {
		const parents: OfflineParent[] = []

		for (let i = 0; i < 64; i++) {
			parents.push(makeParent(makeUuid()))
		}

		await runScenario({
			name: "helpers/01-parentCacheKey-100k",
			run: () => {
				let acc = 0

				for (let i = 0; i < 100_000; i++) {
					acc += parentCacheKey(parents[i & 63] as OfflineParent).length
				}

				return acc
			}
		})

		await runScenario({
			name: "helpers/02-makeSyncError-100k",
			run: () => {
				let acc = 0

				for (let i = 0; i < 100_000; i++) {
					acc += makeSyncError({
						itemUuid: "u",
						topLevelUuid: null,
						name: "n",
						itemType: "file",
						kind: "listing",
						message: "m"
					}).id.length
				}

				return acc
			}
		})

		{
			const index = {
				files: {} as Record<string, unknown>,
				directories: {} as Record<string, unknown>
			}
			const cacheEntries: StoredOfflineQueryCacheEntry[] = []

			for (let i = 0; i < 5000; i++) {
				const uuid = makeUuid()

				if (i % 2 === 0) {
					index.files[uuid] = true
				}

				cacheEntries.push({
					queryKey: [
						"driveItemStoredOffline",
						{
							uuid,
							type: "file"
						}
					],
					state: {
						data: true
					}
				})
			}

			await runScenario({
				name: "helpers/03-findStale-5k",
				run: () => findStaleStoredOfflineEntries(cacheEntries, index),
				validate: result => {
					assertBench((result as unknown[]).length === 2500, "stale count mismatch")
				}
			})
		}

		{
			const uuids: string[] = []

			for (let i = 0; i < 1000; i++) {
				uuids.push(makeUuid())
			}

			await runScenario({
				name: "helpers/04-validateUuid-100k",
				run: () => {
					let valid = 0

					for (let i = 0; i < 100_000; i++) {
						if (validateUuid(uuids[i % 1000] as string)) {
							valid++
						}
					}

					return valid
				},
				validate: result => {
					assertBench(result === 100_000, "uuid validation failed")
				}
			})
		}
	})
})

// Module-scope stash to share fixtures between suites (vitest runs its in order).
const stash: {
	standaloneParent: OfflineParent
	standaloneUuids: string[]
	standaloneItems: DriveItem[]
	standaloneMetaTexts: string[]
	trees: TreeFixture[]
	indexText: string
	restoreMixed: () => void
} = {
	standaloneParent: "sharedInRoot",
	standaloneUuids: [],
	standaloneItems: [],
	standaloneMetaTexts: [],
	trees: [],
	indexText: "",
	restoreMixed: () => {}
}

describe.runIf(!BENCH)("offline benchmark (disabled)", () => {
	it("is skipped without OFFLINE_BENCH=1", () => {
		// Intentional no-op: the benchmark only runs with OFFLINE_BENCH=1.
	})
})

/**
 * TEMP performance benchmark for the cameraUpload lib (cameraUpload.ts +
 * cameraUploadHelpers.ts).
 *
 * Gated behind CAMERA_BENCH=1 so the normal test suite ("npm test" / verify)
 * skips it entirely. Run with:
 *
 *   CAMERA_BENCH=1 npx vitest run src/tests/cameraUploadBench.test.ts
 *
 * Knobs (env): CAMERA_BENCH_SAMPLES (default 5), CAMERA_BENCH_WARMUP (default 2),
 * CAMERA_BENCH_SCALES (default "10000,100000"), CAMERA_BENCH_OUT (table file,
 * default /tmp/cameraUploadBench-out.txt — vitest swallows console output of
 * passing non-TTY runs, so the table is WRITTEN TO A FILE).
 *
 * Methodology (mirrors src/tests/offlineBench.test.ts): per scenario — untimed
 * prepare, one untimed VALIDATION run that asserts the intended code path
 * actually executed (and snapshots boundary-call counters: every unwrap /
 * upload / SDK-listing call maps to real work on device), then WARMUP warmups +
 * SAMPLES timed runs with state restored between runs OUTSIDE the timed region.
 * Reported: min / median / mean ms + per-run boundary counters.
 *
 * Mock boundaries: expo-media-library (canonical in-memory mock — plain
 * classes, no vi.fn in hot paths), expo-file-system (canonical mock — same
 * Paths semantics the suites pin), SDK listing/transfers/secureStore/store
 * (plain functions + counters). REAL code measured: cameraUpload.ts,
 * cameraUploadHelpers.ts, @filen/utils (run/Semaphore/fastLocaleCompare),
 * js-xxhash, @/lib/tmp. unwrapFileMeta is a plain stub that mimics the real
 * shape work (tag check + result-object allocation) and counts calls.
 */
import { describe, it, expect, afterAll, vi } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
import { writeFileSync } from "node:fs"

// @ts-expect-error __DEV__ is a React Native global
globalThis.__DEV__ = true

const H = vi.hoisted(() => {
	const counters = {
		unwrapCalls: 0,
		uploads: 0,
		listDirCalls: 0,
		createDirCalls: 0
	}

	const holders: {
		counters: typeof counters
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		remoteFiles: any[]
		captureUploads: boolean
		uploadCapture: { name: string; created: number; modified: number | undefined }[]
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		config: any
		reuploadDeleted: boolean
		uuidCounter: number
	} = {
		counters,
		remoteFiles: [],
		captureUploads: false,
		uploadCapture: [],
		config: null,
		reuploadDeleted: false,
		uuidCounter: 0
	}

	return holders
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-media-library/next", async () => await import("@/tests/mocks/expoMediaLibrary"))

vi.mock("expo-media-library/legacy", async () => {
	const next = await import("@/tests/mocks/expoMediaLibrary")

	return {
		getAlbumsAsync: async () =>
			Array.from(next.ml.albums.values()).map(stored => ({
				id: stored.id,
				title: stored.title,
				type: "album",
				assetCount: stored.assetIds.length
			}))
	}
})

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("expo-crypto", () => ({
	randomUUID: () => `bench-uuid-${H.uuidCounter++}`
}))

vi.mock("@react-native-community/netinfo", () => ({
	default: {
		fetch: async () => ({
			type: "wifi",
			isInternetReachable: true,
			isConnected: true
		})
	}
}))

vi.mock("expo-battery", () => ({
	isLowPowerModeEnabledAsync: async () => false
}))

vi.mock("@/hooks/useMediaPermissions", () => ({
	hasAllNeededMediaPermissions: async () => true
}))

vi.mock("expo-image-manipulator", () => ({
	ImageManipulator: {
		manipulate: () => {
			throw new Error("bench: ImageManipulator must not run (supported-extensions set is empty)")
		}
	},
	SaveFormat: {
		JPEG: "jpeg"
	}
}))

// Empty supported-extension set → compress() early-returns the file untouched, so
// compress-ON scenarios measure the listing/dedup-key costs without ImageManipulator.
vi.mock("@/constants", () => ({
	EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS: new Set<string>()
}))

vi.mock("@filen/sdk-rs", () => ({
	AnyNormalDir: {
		Dir: class {
			tag = "Dir"
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		}
	},
	AnyNormalDir_Tags: {
		Dir: "Dir",
		Root: "Root"
	},
	AnyDirWithContext: {
		Normal: class {
			tag = "Normal"
			inner: unknown[]
			constructor(inner: unknown) {
				this.inner = [inner]
			}
		}
	}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: async () => ({
			authedSdkClient: {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				listDirRecursiveWithPaths: async (_dir: any, _progress: any, _errors: any, _opts: any) => {
					H.counters.listDirCalls++

					return {
						files: H.remoteFiles
					}
				},
				createDir: async () => {
					H.counters.createDirCalls++

					return {
						uuid: `created-dir-${H.counters.createDirCalls}`
					}
				},
				getDirOptional: async () => ({ uuid: "remote-uuid", parent: { tag: "Uuid", inner: ["root-uuid"] } })
			}
		})
	}
}))

vi.mock("@/features/transfers/transfers", () => ({
	default: {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		upload: async (args: any) => {
			H.counters.uploads++

			if (H.captureUploads) {
				H.uploadCapture.push({
					name: args.name,
					created: args.created,
					modified: args.modified
				})
			}

			return {
				files: []
			}
		}
	}
}))

vi.mock("@/features/cameraUpload/store/useCameraUpload.store", () => {
	const state = {
		setSyncing: () => {},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		setErrors: (fn: any) => {
			// Surface unexpected error-path entries loudly — happy-path scenarios must not error.
			const errors = typeof fn === "function" ? fn([]) : fn

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			for (const entry of errors as any[]) {
				console.error("[bench] cameraUpload error surfaced:", entry?.error)
			}
		},
		addSkippedAsset: () => {},
		removeSkippedAsset: () => {},
		clearSkippedAssets: () => {}
	}

	return {
		default: {
			getState: () => state
		}
	}
})

vi.mock("@/lib/secureStore", () => ({
	default: {
		get: async (key: string) => {
			if (key === "cameraUploadReuploadDeleted") {
				return H.reuploadDeleted
			}

			return H.config
		},
		set: async () => {}
	},
	useSecureStore: () => [null, () => {}]
}))

vi.mock("zustand/shallow", () => ({
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	useShallow: (fn: any) => fn
}))

vi.mock("@/lib/events", () => ({
	default: {
		subscribe: () => {}
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

// REAL floor semantics (src/lib/utils.ts) — same as the hardening suite.
vi.mock("@/lib/utils", () => ({
	normalizeModificationTimestampForComparison: (timestamp: number) => Math.floor(timestamp / 1000)
}))

// Plain stub mimicking the real unwrapFileMeta's work for a normal File: a tag/shape
// check plus a fresh result-object allocation per call. Counts calls — the
// listRemote+deltas double-unwrap is an optimization target the table must show.
vi.mock("@/lib/sdkUnwrap", () => ({
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	unwrapFileMeta: (file: any) => {
		H.counters.unwrapCalls++

		const meta = file && typeof file === "object" ? (file.__meta ?? null) : null

		return {
			meta,
			shared: false,
			root: false,
			file,
			undecryptable: meta === null
		}
	},
	isTrashParent: (parent: { tag?: string } | null | undefined) => parent?.tag === "Trash"
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

import cache from "@/lib/cache"
import cameraUpload, { type Config } from "@/features/cameraUpload/cameraUpload"
import { ml, MediaType } from "@/tests/mocks/expoMediaLibrary"
import { fs } from "@/tests/mocks/expoFileSystem"
import {
	collisionNameSuffix,
	modifyAssetPathOnCollision,
	composeLocalTreePath,
	dedupTreeKey,
	stripFilenameExtension,
	effectiveCreationTimestamp,
	rawRemoteTreePath
} from "@/features/cameraUpload/cameraUploadHelpers"

const BENCH = process.env["CAMERA_BENCH"] === "1"
const SAMPLES = Number(process.env["CAMERA_BENCH_SAMPLES"] ?? 5)
const WARMUP = Number(process.env["CAMERA_BENCH_WARMUP"] ?? 2)
// Explicitly typed: CI runs without the gitignored expo-env.d.ts, where process.env
// indexing degrades to `any` and the chain below trips noImplicitAny.
const SCALES_ENV: string = process.env["CAMERA_BENCH_SCALES"] ?? "10000,100000"
const SCALES = SCALES_ENV.split(",")
	.map(value => Number(value.trim()))
	.filter(value => Number.isFinite(value) && value > 0)
const OUT_FILE = process.env["CAMERA_BENCH_OUT"] ?? "/tmp/cameraUploadBench-out.txt"

const BENCH_CONFIG: Config = {
	enabled: true,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	remoteDir: { inner: [{ uuid: "remote-root-uuid" }] } as any,
	albumIds: ["album-main"],
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RemoteFixtureFile = any

type CounterSnapshot = typeof H.counters

type ScenarioRow = {
	name: string
	scale: number
	minMs: number
	medianMs: number
	meanMs: number
	samples: number
	counters: Partial<CounterSnapshot>
}

const rows: ScenarioRow[] = []

function resetCounters(): void {
	H.counters.unwrapCalls = 0
	H.counters.uploads = 0
	H.counters.listDirCalls = 0
	H.counters.createDirCalls = 0
}

function snapshotCounters(): Partial<CounterSnapshot> {
	return {
		unwrapCalls: H.counters.unwrapCalls,
		uploads: H.counters.uploads,
		listDirCalls: H.counters.listDirCalls,
		createDirCalls: H.counters.createDirCalls
	}
}

/**
 * Deterministic fixture mix for n assets (single selected album, camera-roll
 * reality): ~94% unique names, ~2% same-name pairs at DISTINCT floored seconds
 * (iteration-0 collisions), ~1% same-name twins in the SAME floored second with
 * equal mtimes (indistinguishable by design — slot SET stable, quiet on mirror
 * passes), ~1% special-char names. Creation times strictly spaced 1s apart per
 * index so sorts have real work but a stable total order.
 */
function buildFixture(n: number): FixtureAsset[] {
	const assets: FixtureAsset[] = []
	const baseMs = 1_700_000_000_000
	const specialNames = [
		"MusicBrainz - Sinner's Prayer [id3v2.3].V2.jpg",
		"IMG [edited] (1).jpg",
		"literal %20 percent.jpg",
		"umlauts äöü ß.jpg",
		"braces {b} caret ^ pipe ¦.jpg"
	]
	let id = 0

	while (assets.length < n) {
		const i = id
		const creation = baseMs + i * 1000
		const bucket = i % 100

		if (bucket >= 96 && bucket <= 97 && assets.length + 2 <= n) {
			// Same-name pair at distinct seconds → deterministic iteration-0 collision.
			assets.push({
				id: `dup-a-${id}`,
				filename: `dup_${i}.jpg`,
				creationTime: creation,
				modificationTime: creation + 500
			})
			assets.push({
				id: `dup-b-${id}`,
				filename: `dup_${i}.jpg`,
				creationTime: creation + 5000,
				modificationTime: creation + 5500
			})
			id += 2

			continue
		}

		if (bucket === 98 && assets.length + 2 <= n) {
			// Same-second twins, equal mtimes — slot assignment enumeration-dependent
			// BY DESIGN, mirror passes stay quiet either way.
			assets.push({
				id: `twin-a-${id}`,
				filename: `twin_${i}.jpg`,
				creationTime: creation + 100,
				modificationTime: creation
			})
			assets.push({
				id: `twin-b-${id}`,
				filename: `twin_${i}.jpg`,
				creationTime: creation + 900,
				modificationTime: creation
			})
			id += 2

			continue
		}

		if (bucket === 99) {
			const special = specialNames[i % specialNames.length] ?? "fallback.jpg"

			assets.push({
				id: `special-${id}`,
				filename: `v${i} ${special}`,
				creationTime: creation,
				modificationTime: creation + 500
			})
			id++

			continue
		}

		assets.push({
			id: `plain-${id}`,
			filename: `img_${i}.jpg`,
			creationTime: creation,
			modificationTime: creation + 500
		})
		id++
	}

	return assets
}

// 50% same-name pairs at distinct seconds — heavy collision-loop exercise.
function buildCollisionFixture(n: number): FixtureAsset[] {
	const assets: FixtureAsset[] = []
	const baseMs = 1_700_000_000_000
	let id = 0

	while (assets.length + 2 <= n) {
		const creation = baseMs + id * 1000

		assets.push({
			id: `col-a-${id}`,
			filename: `col_${id}.jpg`,
			creationTime: creation,
			modificationTime: creation + 500
		})
		assets.push({
			id: `col-b-${id}`,
			filename: `col_${id}.jpg`,
			creationTime: creation + 5000,
			modificationTime: creation + 5500
		})
		id += 2
	}

	return assets
}

function installAssets(assets: FixtureAsset[]): void {
	ml.clear()
	fs.clear()

	// Two unselected albums keep the all-albums enumeration honest without
	// dominating anything.
	ml.addAlbum({
		id: "album-other-1",
		title: "Screenshots",
		assetIds: []
	})
	ml.addAlbum({
		id: "album-other-2",
		title: "WhatsApp",
		assetIds: []
	})
	ml.addAlbum({
		id: "album-main",
		title: "Camera Roll",
		assetIds: assets.map(asset => asset.id)
	})

	const bytes = new Uint8Array([1, 2, 3])

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

		fs.set(uri, bytes)
	}
}

function buildMirrorFromCapture(): RemoteFixtureFile[] {
	return H.uploadCapture.map((upload, index) => ({
		path: `/Camera Roll/${upload.name}`,
		file: {
			uuid: `remote-${index}`,
			__meta: {
				name: upload.name,
				created: BigInt(Math.trunc(upload.created)),
				modified: upload.modified !== undefined ? BigInt(Math.trunc(upload.modified)) : null
			}
		}
	}))
}

function resetSyncState(): void {
	cameraUpload.cancel()
	cache.cameraUploadHashes.clear()
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	;(cameraUpload as any).ensureParentDirectoryExistsCache.clear()
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	;(cameraUpload as any).ensureParentDirectoryExistsInFlight.clear()
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	;(cameraUpload as any).uploadFailures.clear()
}

function abortSignalForRun(): AbortSignal {
	return new AbortController().signal
}

async function runScenario({
	name,
	scale,
	samples = SAMPLES,
	prepare,
	restore,
	run,
	validate
}: {
	name: string
	scale: number
	samples?: number
	prepare?: () => void | Promise<void>
	restore?: () => void | Promise<void>
	run: () => Promise<unknown>
	validate: (result: unknown) => void
}): Promise<void> {
	if (prepare) {
		await prepare()
	}

	// Validation run (untimed): asserts the scenario actually exercised the
	// intended path and snapshots boundary-call counters for ONE run.
	if (restore) {
		await restore()
	}

	resetCounters()

	const validationResult = await run()

	validate(validationResult)

	const counters = snapshotCounters()

	for (let i = 0; i < WARMUP; i++) {
		if (restore) {
			await restore()
		}

		await run()
	}

	const timings: number[] = []

	for (let i = 0; i < samples; i++) {
		if (restore) {
			await restore()
		}

		const start = performance.now()

		await run()

		timings.push(performance.now() - start)
	}

	timings.sort((a, b) => a - b)

	const min = timings[0] ?? 0
	const median = timings[Math.floor(timings.length / 2)] ?? 0
	const mean = timings.reduce((sum, value) => sum + value, 0) / Math.max(1, timings.length)

	rows.push({
		name,
		scale,
		minMs: min,
		medianMs: median,
		meanMs: mean,
		samples: timings.length,
		counters
	})
}

function formatTable(): string {
	const header = ["scenario", "scale", "min ms", "med ms", "mean ms", "unwrap", "uploads", "listDir", "createDir"]
	const lines: string[][] = [header]

	for (const row of rows) {
		lines.push([
			row.name,
			String(row.scale),
			row.minMs.toFixed(2),
			row.medianMs.toFixed(2),
			row.meanMs.toFixed(2),
			String(row.counters.unwrapCalls ?? 0),
			String(row.counters.uploads ?? 0),
			String(row.counters.listDirCalls ?? 0),
			String(row.counters.createDirCalls ?? 0)
		])
	}

	const widths = header.map((_, col) => Math.max(...lines.map(line => (line[col] ?? "").length)))

	return lines
		.map((line, index) => {
			const text = line.map((cell, col) => (cell ?? "").padEnd(widths[col] ?? 0)).join("  ")

			return index === 0 ? `${text}\n${"-".repeat(text.length)}` : text
		})
		.join("\n")
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internal = cameraUpload as any

describe.skipIf(!BENCH)("cameraUpload benchmark", () => {
	it(
		"benchmarks listing, diff and sync pipelines at configured scales",
		{ timeout: 3_600_000 },
		async () => {
			for (const scale of SCALES) {
				const fixture = buildFixture(scale)

				// ── listLocal (cold) ────────────────────────────────────────────────
				installAssets(fixture)
				resetSyncState()
				H.remoteFiles = []

				await runScenario({
					name: "01 listLocal cold",
					scale,
					run: () =>
						internal.listLocal({
							config: BENCH_CONFIG,
							signal: abortSignalForRun()
						}),
					validate: result => {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const listing = result as any

						expect(listing.degraded).toBe(false)
						expect(Object.keys(listing.tree)).toHaveLength(scale)
					}
				})

				// ── listLocal collision-heavy (50% same-name pairs) ─────────────────
				const collisionFixture = buildCollisionFixture(scale)

				installAssets(collisionFixture)

				await runScenario({
					name: "02 listLocal 50% collisions",
					scale,
					run: () =>
						internal.listLocal({
							config: BENCH_CONFIG,
							signal: abortSignalForRun()
						}),
					validate: result => {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const listing = result as any

						expect(listing.degraded).toBe(false)
						expect(Object.keys(listing.tree)).toHaveLength(collisionFixture.length)
					}
				})

				// ── capture pass: build the mirror remote (also validates convergence) ──
				installAssets(fixture)
				resetSyncState()
				H.remoteFiles = []
				H.config = BENCH_CONFIG
				H.uploadCapture = []
				H.captureUploads = true
				resetCounters()

				await cameraUpload.sync()

				H.captureUploads = false

				expect(H.counters.uploads).toBe(scale)
				expect(H.uploadCapture).toHaveLength(scale)

				const mirrorFiles = buildMirrorFromCapture()

				// ── listRemote (cold, mirror-sized) ─────────────────────────────────
				H.remoteFiles = mirrorFiles

				await runScenario({
					name: "03 listRemote cold",
					scale,
					run: () =>
						internal.listRemote({
							remoteDir: BENCH_CONFIG.remoteDir,
							signal: abortSignalForRun(),
							compress: false
						}),
					validate: result => {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const listing = result as any

						expect(listing.degraded).toBe(false)
						expect(Object.keys(listing.tree)).toHaveLength(scale)
					}
				})

				// ── deltas quiet (steady state: local == remote) ────────────────────
				await runScenario({
					name: "04 deltas quiet",
					scale,
					run: () =>
						internal.deltas({
							config: BENCH_CONFIG,
							signal: abortSignalForRun()
						}),
					validate: result => {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const value = result as any

						expect(value.deltas).toHaveLength(0)
					}
				})

				// ── deltas all-new (remote empty → every asset is a delta) ──────────
				await runScenario({
					name: "05 deltas all-new",
					scale,
					prepare: () => {
						H.remoteFiles = []
					},
					run: () =>
						internal.deltas({
							config: BENCH_CONFIG,
							signal: abortSignalForRun()
						}),
					validate: result => {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const value = result as any

						expect(value.deltas).toHaveLength(scale)
					}
				})

				// ── sync quiet e2e (mirror remote + fully-populated md5 cache) ──────
				await runScenario({
					name: "06 sync quiet e2e",
					scale,
					prepare: () => {
						H.remoteFiles = mirrorFiles
						resetSyncState()

						// Steady-state device: md5 cache holds an entry per tree key, all
						// verified — the #B4 prune loop scans all of them, deletes none.
						for (const asset of fixture) {
							const path = `/camera roll/${asset.filename.toLowerCase()}`

							if (!cache.cameraUploadHashes.has(path)) {
								cache.cameraUploadHashes.set(path, {
									md5: "mock-md5",
									verifiedModificationTime: asset.modificationTime
								})
							}
						}
					},
					run: () => cameraUpload.sync(),
					validate: () => {
						expect(H.counters.uploads).toBe(0)
					}
				})

				// ── sync md5-shielded (remote empty, cache verified at current mtimes) ──
				await runScenario({
					name: "07 sync md5-shielded",
					scale,
					samples: Math.min(SAMPLES, 3),
					prepare: async () => {
						H.remoteFiles = []
						resetSyncState()

						// Build the EXACT tree-keyed cache state by listing locally once.
						const listing = await internal.listLocal({
							config: BENCH_CONFIG,
							signal: abortSignalForRun()
						})

						for (const path in listing.tree) {
							const entry = listing.tree[path]

							cache.cameraUploadHashes.set(path, {
								md5: "mock-md5",
								verifiedModificationTime: entry.info.modificationTime
							})
						}
					},
					run: () => cameraUpload.sync(),
					validate: () => {
						expect(H.counters.uploads).toBe(0)
					}
				})

				// ── sync all-new e2e (empty remote, empty cache → full upload pipeline) ──
				await runScenario({
					name: "08 sync all-new e2e",
					scale,
					samples: Math.min(SAMPLES, 3),
					prepare: () => {
						H.remoteFiles = []
					},
					restore: () => {
						resetSyncState()
					},
					run: () => cameraUpload.sync(),
					validate: () => {
						expect(H.counters.uploads).toBe(scale)
					}
				})

				// ── deltas quiet with compress ON (stem-keyed dedup both sides) ─────
				const compressConfig: Config = {
					...BENCH_CONFIG,
					compress: true
				}

				// Mirror stays valid: compress() never rewrites in the bench (empty
				// supported-extension set), so uploaded names keep their extensions and
				// the stem-keys collapse identically on both sides.
				await runScenario({
					name: "09 deltas quiet compress",
					scale,
					prepare: () => {
						H.remoteFiles = mirrorFiles
						resetSyncState()
					},
					run: () =>
						internal.deltas({
							config: compressConfig,
							signal: abortSignalForRun()
						}),
					validate: result => {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const value = result as any

						expect(value.deltas).toHaveLength(0)
					}
				})
			}

			// ── helper micro-benchmarks (fixed 200k iterations, scale-independent) ──
			const iterations = 200_000
			const microAsset = {
				name: "IMG_4242.jpg",
				contentHash: "1700000000"
			}

			const micro: [string, () => void][] = [
				[
					"collisionNameSuffix it0+it1",
					() => {
						collisionNameSuffix({ iteration: 0, asset: microAsset })
						collisionNameSuffix({ iteration: 1, asset: microAsset })
					}
				],
				[
					"modifyAssetPathOnCollision",
					() => {
						modifyAssetPathOnCollision({
							iteration: 0,
							path: "/camera roll/img_4242.jpg",
							asset: microAsset
						})
					}
				],
				[
					"composeLocalTreePath+lower",
					() => {
						composeLocalTreePath({
							folderTitle: "Camera Roll",
							filename: "IMG_4242.jpg"
						}).toLowerCase()
					}
				],
				[
					"dedupTreeKey compress",
					() => {
						dedupTreeKey({
							path: "/camera roll/img_4242.jpg",
							compress: true
						})
					}
				],
				[
					"stripFilenameExtension",
					() => {
						stripFilenameExtension("IMG_4242.jpg")
					}
				],
				[
					"rawRemoteTreePath+lower",
					() => {
						rawRemoteTreePath("/Camera Roll/IMG_4242.jpg").toLowerCase()
					}
				],
				[
					"effectiveCreationTs+floor",
					() => {
						Math.floor(
							effectiveCreationTimestamp({
								creationTime: 1_700_000_000_123,
								modificationTime: 1_700_000_000_456
							}) / 1000
						)
					}
				]
			]

			for (const [name, fn] of micro) {
				// warmup
				for (let i = 0; i < 10_000; i++) {
					fn()
				}

				const start = performance.now()

				for (let i = 0; i < iterations; i++) {
					fn()
				}

				const elapsed = performance.now() - start

				rows.push({
					name: `90 micro ${name}`,
					scale: iterations,
					minMs: elapsed,
					medianMs: elapsed,
					meanMs: elapsed,
					samples: 1,
					counters: {}
				})
			}
		}
	)

	afterAll(() => {
		if (rows.length === 0) {
			return
		}

		const table = `cameraUpload bench — samples=${SAMPLES} warmup=${WARMUP} scales=${SCALES.join(",")}\n${formatTable()}\n`

		writeFileSync(OUT_FILE, table)

		// Also try console — visible on TTY runs.
		console.log(`\n${table}`)
	})
})

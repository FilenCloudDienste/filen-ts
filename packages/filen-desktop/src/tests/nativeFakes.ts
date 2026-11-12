import { vi } from "vitest"
import type {
	AnyDirWithContext,
	ConflictReason,
	ConflictResolution,
	AnyFile,
	AnyNormalDir,
	Dir,
	DirsAndFilesWithPaths,
	File,
	FilenSdkError,
	JsDirDownloadCallback,
	JsDirUploadCallback,
	JsFileDownloadCallback,
	JsFileUploadCallback,
	JsRcloneDaemon,
	JsSyncPlan,
	ManagedFuture,
	DirContentDownloadErrorCallback,
	FileBuilderParamsOptionalName,
	PlannedAction,
	RcloneExit,
	RcloneRefusal,
	RcloneStats,
	SyncConflictPage,
	SyncConflictResolved,
	SyncPairInfo,
	SyncPassEvent,
	SyncPassReport,
	SyncPlanSummary,
	SyncRefusal
} from "@filen/sdk-rs"
import type { NativeSdk, SyncEngine } from "../native/addon.ts"
import type { TransferClient, TransferSdk } from "../native/transfers.ts"

// The addon's values the host reads, with the napi enums' numbers.
class FakeInner {
	readonly #kind: number
	readonly #message: string
	readonly #refusal: SyncRefusal | undefined
	readonly #rcloneRefusal: RcloneRefusal | undefined

	constructor(kind: number, message: string, refusal: SyncRefusal | undefined, rcloneRefusal?: RcloneRefusal) {
		this.#kind = kind
		this.#message = message
		this.#refusal = refusal
		this.#rcloneRefusal = rcloneRefusal
	}

	kind(): number {
		return this.#kind
	}

	innerMessage(): string {
		return this.#message
	}

	message(): string {
		return `Error of kind ${String(this.#kind)}: ${this.#message}`
	}

	syncRefusal(): SyncRefusal | undefined {
		return this.#refusal
	}

	rcloneRefusal(): RcloneRefusal | undefined {
		return this.#rcloneRefusal
	}
}

class FakeThrown extends Error {
	readonly inner: FakeInner

	constructor(inner: FakeInner) {
		super("FilenSdkError")
		this.inner = inner
	}
}

export const fakeSdk = {
	ErrorKind: {
		Server: 0,
		Unauthenticated: 1,
		Reqwest: 2,
		Io: 6,
		InvalidState: 8,
		Cancelled: 13,
		FolderNotFound: 20,
		MaxStorageReached: 22,
		StaleState: 28,
		TlsVerification: 38
	},
	SyncMode: { LocalToRemote: 0, RemoteToLocal: 1, TwoWay: 2, LocalBackup: 3, RemoteBackup: 4 },
	Backlog: { Propagate: 0, AdoptDestination: 1 },
	ConflictResolution: { KeepLocal: 0, KeepRemote: 1, KeepBoth: 2 },
	LogLevel: { Off: 0, Error: 1, Warn: 2, Info: 3, Debug: 4, Trace: 5 },
	PauseMode: { Suspend: 0, Cancel: 1 },
	PlannedNodeKind: { Dir: 0, File: 1 },
	PlannedTransfer: { Create: 0, Replace: 1 },
	HaltReason: { LocalStorageFull: 0, RemoteStorageFull: 1, RemoteUnavailable: 2, Unauthenticated: 3 },
	RefuseReason: { RemoteCollision: 0, LocalCollision: 1 },
	TransferDirection: { Upload: 0, Download: 1 },
	WatchState: { Running: 0, Paused: 1, Stopped: 2, PairRemoved: 3 },
	ServeProtocol: { Webdav: 0, S3: 1, Ftp: 2, Sftp: 3, Http: 4, Restic: 5, Nfs: 6 },
	FilenSdkError: {
		hasInner: (error: unknown) => error instanceof FakeThrown,
		getInner: (error: FakeThrown) => error.inner
	},
	defaultSyncIgnorePatterns: () => [".DS_Store"],
	init: () => undefined
} as unknown as NativeSdk

// ConflictReason.Diverged: the addon owns the enum's values.
export const DIVERGED: ConflictReason = 0

// What an SDK call throws.
export function sdkError(kind: number, message = "", refusal?: SyncRefusal): Error {
	return new FakeThrown(new FakeInner(kind, message, refusal))
}

// What a transfer callback hands over: the FilenSdkError itself, not thrown.
export function sdkErrorValue(kind: number, message = ""): FilenSdkError {
	return new FakeInner(kind, message, undefined) as unknown as FilenSdkError
}

// What the SDK's rclone module throws when it refuses.
export function rcloneError(refusal: RcloneRefusal, message = "refused"): Error {
	return new FakeThrown(new FakeInner(fakeSdk.ErrorKind.Io, message, undefined, refusal))
}

export function rcloneStats(overrides: Partial<RcloneStats> = {}): RcloneStats {
	return {
		uploadsInProgress: 0,
		uploadsQueued: 0,
		erroredFiles: 0,
		cacheBytesUsed: 0n,
		outOfSpace: false,
		transfers: [],
		mounts: [],
		serves: [],
		...overrides
	}
}

// One rclone the fake client started: its calls are spies, `crash` ends it by itself.
export function fakeDaemon(pid: number) {
	let ended: (exit: RcloneExit) => void = () => undefined
	const exit = new Promise<RcloneExit>(resolve => {
		ended = resolve
	})
	const state = { stats: rcloneStats(), mounts: [] as string[], serves: 0 }
	const daemon = {
		pid: () => pid,
		exited: () => exit,
		stats: vi.fn(() => Promise.resolve({ ...state.stats, mounts: [...state.mounts] })),
		mount: vi.fn((options: { mountPoint: string }) => {
			state.mounts.push(options.mountPoint)

			return Promise.resolve({ mountPoint: options.mountPoint, provider: 0 })
		}),
		unmount: vi.fn((mountPoint: string) => {
			state.mounts = state.mounts.filter(point => point !== mountPoint)

			return Promise.resolve()
		}),
		startServe: vi.fn((options: { protocol: number; host: string; port: number }) =>
			Promise.resolve({
				id: `serve-${String(++state.serves)}`,
				protocol: options.protocol,
				addr: `${options.host}:${String(options.port)}`
			})
		),
		stopServe: vi.fn(() => Promise.resolve()),
		serveTypes: vi.fn(() => Promise.resolve([])),
		stop: vi.fn(() => {
			ended({ tag: "Stopped" })

			return Promise.resolve({ pendingUploads: 0, forced: false })
		})
	}

	return {
		daemon,
		handle: daemon as unknown as JsRcloneDaemon,
		state,
		crash: (code = 2) => {
			ended({ tag: "Crashed", inner: { code, stderrTail: "panic" } })
		}
	}
}

// The addon's rclone functions plus a client whose daemons the test reaches.
export function fakeRclone() {
	const daemons: ReturnType<typeof fakeDaemon>[] = []
	// What a daemon started from now on reads at first.
	const initial = { stats: rcloneStats() }
	const sdk = {
		...fakeSdk,
		rcloneAvailableDriveLetters: vi.fn(() => Promise.resolve(["D", "X", "Z"])),
		rcloneClearCache: vi.fn(() => Promise.resolve()),
		rcloneForceUnmount: vi.fn(() => Promise.resolve(false)),
		rcloneRecoverStale: vi.fn(() => Promise.resolve({ stopped: false, unmounted: [] })),
		rcloneStopUnder: vi.fn(() => Promise.resolve(0))
	}
	const client = {
		startRcloneDaemon: vi.fn(() => {
			const started = fakeDaemon(1000 + daemons.length)

			started.state.stats = initial.stats
			daemons.push(started)

			return Promise.resolve(started.handle)
		})
	}

	return { sdk, nativeSdk: sdk as unknown as NativeSdk, client, daemons, initial }
}

export const REMOTE_ROOT = "6b1f0d2e-3c4a-4b5d-8e9f-0a1b2c3d4e5f"

export function pairInfo(overrides: Partial<SyncPairInfo> = {}): SyncPairInfo {
	return {
		id: 1n,
		localRoot: "/Users/me/Sync",
		remoteRoot: REMOTE_ROOT,
		mode: fakeSdk.SyncMode.TwoWay,
		deleteGuard: { tag: "Unlimited" },
		paused: false,
		firstPassCompleted: true,
		activity: 0,
		...overrides
	} as SyncPairInfo
}

export function passEvent(event: SyncPassEvent["event"], pairId = 1n, at = 1000n): SyncPassEvent {
	return { pairId, passId: 1n, emittedAtMs: at, event }
}

export function report(overrides: Partial<SyncPassReport> = {}): SyncPassReport {
	return {
		downloaded: 0n,
		uploaded: 0n,
		localDirsCreated: 0n,
		remoteDirsCreated: 0n,
		locallyDeleted: 0n,
		remotelyTrashed: 0n,
		movedRemote: 0n,
		movedLocal: 0n,
		conflicts: [],
		conflictsTotal: 0n,
		held: [],
		heldTotal: 0n,
		heldDeletions: 0n,
		unsyncable: [],
		unsyncableTotal: 0n,
		ignored: [],
		ignoredTotal: 0n,
		deferredPaths: 0n,
		errors: [],
		errorsTotal: 0n,
		quarantined: [],
		quarantinedTotal: 0n,
		paused: false,
		interrupted: 0n,
		scanGaps: [],
		scanGapsTotal: 0n,
		...overrides
	}
}

export function action(tag: PlannedAction["kind"]["tag"], relPath: string, to?: string): PlannedAction {
	const kind = (tag === "MoveRemote" || tag === "MoveLocal" ? { tag, inner: { to: to ?? "" } } : { tag }) as PlannedAction["kind"]

	return { kind, relPath, node: fakeSdk.PlannedNodeKind.File, size: 1n }
}

export function fakePlan(actions: PlannedAction[], summary: Partial<SyncPlanSummary> = {}) {
	const plan = {
		summary: (): SyncPlanSummary => ({
			actionsTotal: BigInt(actions.length),
			uploadBytes: 0n,
			downloadBytes: 0n,
			heldTotal: 0n,
			heldDeletions: 0n,
			conflictsTotal: 0n,
			unsyncableTotal: 0n,
			ignoredTotal: 0n,
			...summary
		}),
		actions: vi.fn((offset: bigint, limit: bigint) => actions.slice(Number(offset), Number(offset + limit))),
		held: () => [],
		conflicts: () => [],
		unsyncable: () => [],
		ignored: () => [],
		release: vi.fn()
	}

	return { plan, handle: plan as unknown as JsSyncPlan }
}

// An engine whose pairs live in memory; every call resolves unless a test replaces it.
export function fakeEngine(pairs: SyncPairInfo[] = [pairInfo()]) {
	const state = { pairs }
	const engine = {
		listPairs: vi.fn(() => Promise.resolve(state.pairs.map(pair => ({ ...pair })))),
		addPair: vi.fn(() => Promise.resolve(2n)),
		removePair: vi.fn(() => Promise.resolve()),
		pausePair: vi.fn((id: bigint) => {
			state.pairs = state.pairs.map(pair => (pair.id === id ? { ...pair, paused: true } : pair))

			return Promise.resolve()
		}),
		resumePair: vi.fn((id: bigint) => {
			state.pairs = state.pairs.map(pair => (pair.id === id ? { ...pair, paused: false } : pair))

			return Promise.resolve()
		}),
		watchPair: vi.fn(() => Promise.resolve({})),
		requestPass: vi.fn(() => Promise.resolve()),
		reconfigurePair: vi.fn(() => Promise.resolve()),
		planPair: vi.fn(() => Promise.resolve(fakePlan([]).handle)),
		listConflicts: vi.fn((_pairId: bigint, _offset: bigint, _limit: bigint): Promise<SyncConflictPage> =>
			Promise.resolve({ conflicts: [], total: 0n })
		),
		resolveConflict: vi.fn((): Promise<SyncConflictResolved> => Promise.resolve({})),
		conflictResolutions: vi.fn((_reason: ConflictReason): ConflictResolution[] => [0, 1, 2]),
		lastReport: vi.fn((_pairId: bigint): Promise<SyncPassReport | undefined> => Promise.resolve(undefined)),
		approveDeletions: vi.fn(() => Promise.resolve()),
		restoreDeletions: vi.fn(() => Promise.resolve()),
		retryPath: vi.fn(() => Promise.resolve()),
		retryAll: vi.fn(() => Promise.resolve()),
		setDeleteGuard: vi.fn((id: bigint, floor: bigint, ratio: number) => {
			state.pairs = state.pairs.map(pair =>
				pair.id === id ? { ...pair, deleteGuard: { tag: "Limited", inner: { floor, ratio } } } : pair
			)

			return Promise.resolve()
		}),
		userIgnore: vi.fn(() => Promise.resolve("")),
		setUserIgnore: vi.fn(() => Promise.resolve()),
		close: vi.fn(() => Promise.resolve())
	}

	return { engine, handle: engine as unknown as SyncEngine, state }
}

export class FakePauseSignal {
	#paused = false

	isPaused(): boolean {
		return this.#paused
	}

	pause(): void {
		this.#paused = true
	}

	resume(): void {
		this.#paused = false
	}
}

export class FakeManagedAbortSignal {
	#aborted = false

	aborted(): boolean {
		return this.#aborted
	}

	markAborted(): void {
		this.#aborted = true
	}
}

export class FakeManagedAbortController {
	readonly #signal = new FakeManagedAbortSignal()

	abort(): void {
		this.#signal.markAborted()
	}

	signal(): FakeManagedAbortSignal {
		return this.#signal
	}
}

export const fakeTransferSdk = {
	FilenSdkError: fakeSdk.FilenSdkError,
	ErrorKind: fakeSdk.ErrorKind,
	PauseSignal: FakePauseSignal,
	ManagedAbortController: FakeManagedAbortController
} as unknown as TransferSdk

// One call the fake client received; the test settles it.
export interface FakeTransferCall {
	method: keyof TransferClient
	args: unknown[]
	resolve(value?: unknown): void
	reject(error: unknown): void
}

// The napi transfer calls: each records its arguments (callbacks included) and waits for the test to settle it.
export class FakeTransferClient implements TransferClient {
	readonly calls: FakeTransferCall[] = []
	rootUuid = REMOTE_ROOT
	readonly root = vi.fn(() => ({ uuid: this.rootUuid }))

	#call<T>(method: keyof TransferClient, args: unknown[]): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.calls.push({ method, args, resolve: value => resolve(value as T), reject })
		})
	}

	createDir(parent: AnyNormalDir, name: string): Promise<Dir> {
		return this.#call("createDir", [parent, name])
	}

	uploadFile(
		params: FileBuilderParamsOptionalName,
		filePath: string,
		callback: JsFileUploadCallback | undefined,
		managedFuture: ManagedFuture
	): Promise<File> {
		return this.#call("uploadFile", [params, filePath, callback, managedFuture])
	}

	downloadFileToPath(
		file: AnyFile,
		filePath: string,
		callback: JsFileDownloadCallback | undefined,
		managedFuture: ManagedFuture
	): Promise<void> {
		return this.#call("downloadFileToPath", [file, filePath, callback, managedFuture])
	}

	uploadDirRecursively(dirPath: string, callback: JsDirUploadCallback, target: Dir, managedFuture: ManagedFuture): Promise<void> {
		return this.#call("uploadDirRecursively", [dirPath, callback, target, managedFuture])
	}

	downloadDirRecursively(
		dirPath: string,
		callback: JsDirDownloadCallback,
		target: AnyDirWithContext,
		managedFuture: ManagedFuture
	): Promise<void> {
		return this.#call("downloadDirRecursively", [dirPath, callback, target, managedFuture])
	}

	listDirRecursiveWithPaths(
		dir: AnyDirWithContext,
		progress: undefined,
		errors: DirContentDownloadErrorCallback
	): Promise<DirsAndFilesWithPaths> {
		return this.#call("listDirRecursiveWithPaths", [dir, progress, errors])
	}

	// The calls of one method, oldest first.
	of(method: keyof TransferClient): FakeTransferCall[] {
		return this.calls.filter(call => call.method === method)
	}

	last(method: keyof TransferClient): FakeTransferCall {
		const call = this.of(method).at(-1)

		if (call === undefined) {
			throw new Error(`no ${method} call`)
		}

		return call
	}
}

// Wasm-shaped items as the page holds them (sdk-rs.d.ts).
export function wasmFile(uuid: string, size: bigint, name = "a.txt") {
	return {
		uuid,
		stableUUID: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
		meta: {
			type: "decoded",
			data: { name, mime: "text/plain", created: 1n, modified: 2n, hash: "0".repeat(64), size, key: "dummy-key", version: 2 }
		},
		parent: REMOTE_ROOT,
		size,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 3n,
		chunks: 1n,
		canMakeThumbnail: false
	}
}

export function wasmDir(uuid: string, name = "dir") {
	return {
		uuid,
		parent: REMOTE_ROOT,
		color: "default",
		timestamp: 3n,
		favorited: false,
		meta: { type: "decoded", data: { name, created: 1n } }
	}
}

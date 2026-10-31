import { vi } from "vitest"
import type {
	JsRcloneDaemon,
	JsSyncPlan,
	PlannedAction,
	RcloneExit,
	RcloneRefusal,
	RcloneStats,
	SyncPairInfo,
	SyncPassEvent,
	SyncPassReport,
	SyncPlanSummary,
	SyncRefusal
} from "@filen/sdk-rs"
import type { NativeSdk, SyncEngine } from "../native/addon.ts"

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
	ErrorKind: { Server: 0, Unauthenticated: 1, Io: 6, InvalidState: 8, FolderNotFound: 20 },
	SyncMode: { LocalToRemote: 0, RemoteToLocal: 1, TwoWay: 2, LocalBackup: 3, RemoteBackup: 4 },
	Backlog: { Propagate: 0, AdoptDestination: 1 },
	ConflictResolution: { KeepLocal: 0, KeepRemote: 1, KeepBoth: 2 },
	LogLevel: { Off: 0, Error: 1, Warn: 2, Info: 3, Debug: 4, Trace: 5 },
	PauseMode: { Suspend: 0, Cancel: 1 },
	PlannedNodeKind: { Dir: 0, File: 1 },
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

// What an SDK call throws.
export function sdkError(kind: number, message = "", refusal?: SyncRefusal): Error {
	return new FakeThrown(new FakeInner(kind, message, refusal))
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
		listConflicts: vi.fn(() => Promise.resolve({ conflicts: [], total: 0n })),
		resolveConflict: vi.fn(() => Promise.resolve(undefined)),
		lastReport: vi.fn(() => Promise.resolve(undefined)),
		approveDeletions: vi.fn(() => Promise.resolve()),
		retryPath: vi.fn(() => Promise.resolve()),
		userIgnore: vi.fn(() => Promise.resolve("")),
		setUserIgnore: vi.fn(() => Promise.resolve()),
		close: vi.fn(() => Promise.resolve())
	}

	return { engine, handle: engine as unknown as SyncEngine, state }
}

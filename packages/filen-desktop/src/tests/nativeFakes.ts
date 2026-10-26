import { vi } from "vitest"
import type { JsSyncPlan, PlannedAction, SyncPairInfo, SyncPassEvent, SyncPassReport, SyncPlanSummary, SyncRefusal } from "@filen/sdk-rs"
import type { NativeSdk, SyncEngine } from "../native/addon.ts"

// The addon's values the host reads, with the napi enums' numbers.
class FakeInner {
	readonly #kind: number
	readonly #message: string
	readonly #refusal: SyncRefusal | undefined

	constructor(kind: number, message: string, refusal: SyncRefusal | undefined) {
		this.#kind = kind
		this.#message = message
		this.#refusal = refusal
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

export const REMOTE_ROOT = "6b1f0d2e-3c4a-4b5d-8e9f-0a1b2c3d4e5f"
export const ACCOUNT_ROOT = "3f2b8c1e-6a4d-4e2f-9b7a-1c5d8e9f0a2b"

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

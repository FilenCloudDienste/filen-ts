import { vi } from "vitest"
import type { DesktopSyncErrorCode } from "@filen/shared/desktop"
import type { NativeOp, NativeOpArgs, NativePlanSummary } from "../shared/nativeProtocol.ts"
import type { FirstRunDeps } from "../main/sync/firstRun.ts"
import type { ShellPair, ShellSyncState, SyncStore } from "../main/sync/store.ts"

export function memoryStore(pairs: ShellPair[] = [], legacyApplied = false): SyncStore {
	let state: ShellSyncState = { version: 1, pairs, legacyApplied, importNote: null }

	return {
		get: () => state,
		update: change => {
			state = change(state)

			return Promise.resolve(state)
		},
		hasPairs: () => state.pairs.length > 0
	}
}

export const CLEAN_SUMMARY: NativePlanSummary = {
	actions: 0,
	uploadBytes: 0,
	downloadBytes: 0,
	heldDeletions: 0,
	heldReason: null,
	conflicts: 0,
	unsyncable: 0,
	ignored: 0,
	refused: null,
	passToken: null
}

// Reserved directories no test root is near.
export const ROOT_CONTEXT = {
	platform: process.platform,
	home: "/nonexistent-home",
	appData: [],
	temporary: [],
	mountPoints: [],
	oneDrive: []
}

// The shell's record of a pair, with what a test changes.
export function shellPair(overrides: Partial<ShellPair> = {}): ShellPair {
	return {
		pairId: null,
		name: "Sync",
		localRoot: "/Users/me/Sync",
		remoteRoot: "6b1f0d2e-3c4a-4b5d-8e9f-0a1b2c3d4e5f",
		mode: "twoWay",
		paused: false,
		state: "active",
		review: null,
		legacyUuid: null,
		legacyRules: null,
		notices: [],
		rootProblem: null,
		holds: [],
		wholeDriveConfirmed: false,
		info: [],
		createdAt: 0,
		...overrides
	}
}

// An answer that fails the call with `code`.
export class Refusal {
	readonly code: DesktopSyncErrorCode

	constructor(code: DesktopSyncErrorCode) {
		this.code = code
	}
}

export type Answers = { [K in NativeOp]?: ((args: NativeOpArgs<K>) => unknown) | undefined }

// A native host for first-run work: clean plans, every pair added as "1", "2", …; ops without an answer fail.
export function fakeNative(store: SyncStore, answers: Answers = {}) {
	let nextPairId = 0
	const all: Answers = {
		userIgnore: () => "",
		setUserIgnore: () => null,
		addPair: () => ({ pairId: String(++nextPairId) }),
		pause: () => null,
		resume: () => null,
		removePair: () => null,
		releasePlan: () => null,
		awaitConverged: () => true,
		setMigratedGuard: () => null,
		evaluatePlan: () => ({
			status: "ok",
			planId: "plan",
			summary: CLEAN_SUMMARY,
			check: { uploads: 0, downloads: 0, overwrites: { files: 0, bytes: 0 } }
		}),
		...answers
	}
	const call = vi.fn((op: NativeOp, args: unknown) => {
		const answer = all[op] as ((args: unknown) => unknown) | undefined
		const value = answer === undefined ? new Refusal("unknown") : answer(args)

		return Promise.resolve(value instanceof Refusal ? { ok: false, error: { code: value.code } } : { ok: true, value })
	})
	const deps: FirstRunDeps = {
		call: call as unknown as FirstRunDeps["call"],
		store,
		now: () => 5,
		rootContext: () => Promise.resolve(ROOT_CONTEXT),
		driveRoot: null,
		listingRounds: new Map(),
		starting: vi.fn(),
		log: { info: vi.fn(), warn: vi.fn() }
	}

	return {
		deps,
		call,
		ops: () => call.mock.calls.map(([op]) => op),
		argsOf: (op: NativeOp) => call.mock.calls.filter(([name]) => name === op).map(([, args]) => args)
	}
}

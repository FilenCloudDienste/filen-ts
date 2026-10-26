import type { SyncPairInfo, SyncPassEvent, SyncPassReport, WatchStatus } from "@filen/sdk-rs"
import type { DesktopSyncIssueCounts, DesktopSyncTransfer } from "@filen/shared/desktop"
import type { FromNative, NativeActivity, NativeAggregate, NativePairRuntime } from "../shared/nativeProtocol.ts"
import { modeName, type NativeSdk } from "./addon.ts"
import { clip } from "./errors.ts"

// How often at most the host reports what changed: overview pushes stay at 4 Hz however fast the engine emits.
export const FEED_INTERVAL_MS = 250
// The transfers a pair shows, newest first.
const TRANSFERS_SHOWN = 3
// Activity waiting for the next report; main keeps 200 per pair, so a burst past this drops its oldest entries.
const ACTIVITY_BUFFER = 1000

// What the host knows live about one pair, beyond what the engine stores.
export interface PairRuntime {
	syncing: boolean
	// The running pass's planned actions, and how many of them it has begun.
	planned: number | null
	done: number
	transfers: DesktopSyncTransfer[]
	lastSyncedAt: number | null
	lastError: string | null
	issues: DesktopSyncIssueCounts
	degraded: { local: boolean; remote: boolean }
	// The action in flight: reported once the next one begins or the pass completes, or as failed on its ActionFailed.
	pending: NativeActivity | null
}

export function createPairRuntime(info?: SyncPairInfo): PairRuntime {
	const status = info?.watchStatus

	return {
		syncing: info?.passInFlight !== undefined,
		planned: null,
		done: 0,
		transfers: [],
		lastSyncedAt: info?.lastPassCompletedAtMs === undefined ? null : Number(info.lastPassCompletedAtMs),
		lastError: info?.lastPassError === undefined ? null : clip(info.lastPassError),
		issues: { conflicts: 0, heldDeletions: 0, unsyncable: 0, failed: 0 },
		degraded: { local: status?.localEventsDegraded !== undefined, remote: status?.remoteEventsDegraded !== undefined },
		pending: null
	}
}

export interface Reduced {
	changed: boolean
	activity: NativeActivity[]
	// A pass failed because the server no longer takes the session.
	authFailed: boolean
}

const BEGIN_KINDS = {
	Uploading: "uploaded",
	Downloading: "downloaded",
	CreatingRemoteDir: "createdRemoteDirectory",
	CreatingLocalDir: "createdLocalDirectory",
	TrashingRemote: "trashedRemote",
	DeletingLocal: "deletedLocal"
} as const

function applied(report: SyncPassReport): boolean {
	return (
		report.uploaded +
			report.downloaded +
			report.localDirsCreated +
			report.remoteDirsCreated +
			report.locallyDeleted +
			report.remotelyTrashed +
			report.movedRemote +
			report.movedLocal +
			report.errorsTotal >
		0n
	)
}

// The action in flight is done: the next one began or the pass completed.
function finishPending(runtime: PairRuntime, activity: NativeActivity[]): void {
	if (runtime.pending !== null) {
		activity.push(runtime.pending)
		runtime.pending = null
	}
}

function begin(runtime: PairRuntime, activity: NativeActivity[], entry: NativeActivity): void {
	finishPending(runtime, activity)
	runtime.pending = entry
	runtime.done++
}

function endPass(runtime: PairRuntime): void {
	runtime.syncing = false
	runtime.planned = null
	runtime.done = 0
	runtime.transfers = []
	runtime.pending = null
}

// Folds a chunk of engine events into the pairs' runtime. Progress only updates the transfer it belongs to: it never
// becomes activity, and what reaches main is the coalesced state.
export function reduceEvents(sdk: NativeSdk, state: Map<string, PairRuntime>, events: readonly SyncPassEvent[]): Reduced {
	const activity: NativeActivity[] = []
	let authFailed = false

	for (const { pairId: id, emittedAtMs, event } of events) {
		const pairId = id.toString()
		const at = Number(emittedAtMs)
		let runtime = state.get(pairId)

		if (runtime === undefined) {
			runtime = createPairRuntime()
			state.set(pairId, runtime)
		}

		switch (event.tag) {
			case "PassStarted":
				endPass(runtime)
				runtime.syncing = true
				break
			case "Planned":
				runtime.planned = Number(event.inner.actions)
				break
			case "Uploading":
			case "Downloading": {
				const relPath = clip(event.inner.relPath)

				begin(runtime, activity, { pairId, at, kind: BEGIN_KINDS[event.tag], relPath })
				runtime.transfers = [
					{ relPath, direction: event.tag === "Uploading" ? "upload" : "download", bytes: 0, total: 0 },
					...runtime.transfers.slice(0, TRANSFERS_SHOWN - 1)
				]
				break
			}
			case "Progress": {
				const relPath = clip(event.inner.relPath)
				const direction = event.inner.direction === sdk.TransferDirection.Upload ? "upload" : "download"
				const transfer = runtime.transfers.find(entry => entry.relPath === relPath && entry.direction === direction)
				const bytes = Number(event.inner.bytes)
				const total = Number(event.inner.total)

				if (transfer !== undefined) {
					transfer.bytes = bytes
					transfer.total = total
				} else {
					runtime.transfers = [{ relPath, direction, bytes, total }, ...runtime.transfers.slice(0, TRANSFERS_SHOWN - 1)]
				}

				break
			}
			case "CreatingRemoteDir":
			case "CreatingLocalDir":
			case "TrashingRemote":
			case "DeletingLocal":
				begin(runtime, activity, { pairId, at, kind: BEGIN_KINDS[event.tag], relPath: clip(event.inner.relPath) })
				break
			case "MovingRemote":
			case "MovingLocal":
				begin(runtime, activity, {
					pairId,
					at,
					kind: event.tag === "MovingRemote" ? "movedRemote" : "movedLocal",
					relPath: clip(event.inner.from),
					to: clip(event.inner.to)
				})
				break
			case "AdoptedBaseline":
				// Counted towards progress; an adoption moves nothing, so it is no activity.
				finishPending(runtime, activity)
				runtime.done++
				break
			case "Quarantined":
				activity.push({ pairId, at, kind: "quarantined", relPath: clip(event.inner.relPath), to: clip(event.inner.binPath) })
				break
			case "ActionFailed": {
				const relPath = clip(event.inner.relPath)

				if (runtime.pending?.relPath === relPath) {
					runtime.pending = null
				}

				activity.push({ pairId, at, kind: "failed", relPath, detail: clip(event.inner.error) })
				break
			}
			case "Conflict":
				activity.push({ pairId, at, kind: "conflict", relPath: clip(event.inner.relPath) })
				break
			case "DeletionsHeld":
				activity.push({ pairId, at, kind: "deletionsHeld", detail: event.inner.count.toString() })
				break
			case "Interrupted":
				// The action in flight was given up with the rest.
				runtime.pending = null
				break
			case "Refused":
				break
			case "PassCompleted": {
				const { report } = event.inner

				finishPending(runtime, activity)
				endPass(runtime)
				runtime.lastSyncedAt = at
				runtime.lastError = report.passError === undefined ? null : clip(report.passError)
				runtime.issues = {
					conflicts: Number(report.conflictsTotal),
					heldDeletions: Number(report.heldDeletions),
					unsyncable: Number(report.unsyncableTotal),
					failed: Number(report.errorsTotal)
				}
				authFailed ||= report.passErrorKind === sdk.ErrorKind.Unauthenticated

				// A safety-net pass that found nothing to do is no news.
				if (applied(report) || report.passError !== undefined) {
					activity.push({ pairId, at, kind: "passCompleted" })
				}

				break
			}
			case "PassFailed":
				endPass(runtime)
				runtime.lastError = clip(event.inner.error)
				authFailed ||= event.inner.kind === sdk.ErrorKind.Unauthenticated
				activity.push({ pairId, at, kind: "passFailed", detail: runtime.lastError })
				break
		}
	}

	return { changed: events.length > 0, activity, authFailed }
}

// A watch's status, published after every pass and when it starts or ends.
export function reduceWatchStatus(sdk: NativeSdk, runtime: PairRuntime, status: WatchStatus): { authFailed: boolean } {
	runtime.degraded = { local: status.localEventsDegraded !== undefined, remote: status.remoteEventsDegraded !== undefined }

	if (status.lastError !== undefined) {
		runtime.lastError = clip(status.lastError)
	}

	if (status.state === sdk.WatchState.Stopped || status.state === sdk.WatchState.PairRemoved) {
		endPass(runtime)
	}

	return { authFailed: status.lastErrorKind === sdk.ErrorKind.Unauthenticated }
}

export function runtimeOf(sdk: NativeSdk, info: SyncPairInfo, runtime: PairRuntime): NativePairRuntime {
	return {
		id: info.id.toString(),
		localRoot: info.localRoot,
		remoteRoot: info.remoteRoot,
		mode: modeName(sdk, info.mode),
		paused: info.paused,
		syncing: runtime.syncing,
		progress:
			runtime.syncing && runtime.planned !== null ? { done: Math.min(runtime.done, runtime.planned), total: runtime.planned } : null,
		transfers: runtime.transfers.map(transfer => ({ ...transfer })),
		lastSyncedAt: runtime.lastSyncedAt,
		lastError: runtime.lastError,
		issues: runtime.issues,
		degraded: runtime.degraded
	}
}

function needsAttention(runtime: PairRuntime): boolean {
	return runtime.lastError !== null || runtime.issues.conflicts > 0 || runtime.issues.heldDeletions > 0
}

export interface RuntimeFeed {
	// The engine's pairs as listPairs reads them; a pair's runtime lives while it is listed.
	setPairs(infos: readonly SyncPairInfo[]): void
	pair(pairId: string): SyncPairInfo | undefined
	events(events: readonly SyncPassEvent[]): void
	watchStatus(pairId: bigint, status: WatchStatus): void
	subscribe(on: boolean): void
	stop(): void
}

// Turns the engine's firehose into main's messages: at most one round per interval, carrying the activity since the
// last one (always), the aggregate when it changed, and the overview while main is subscribed.
export function createRuntimeFeed(
	sdk: NativeSdk,
	deps: { post(message: FromNative): void; onAuthFailed(): void },
	intervalMs = FEED_INTERVAL_MS
): RuntimeFeed {
	const infos = new Map<string, SyncPairInfo>()
	const state = new Map<string, PairRuntime>()
	let activity: NativeActivity[] = []
	let aggregate: NativeAggregate = "idle"
	let subscribed = false
	let dirty = false
	let stopped = false
	let timer: NodeJS.Timeout | undefined

	function schedule(): void {
		if (!stopped) {
			timer ??= setTimeout(flush, intervalMs)
		}
	}

	function runtimeFor(pairId: string): PairRuntime {
		let runtime = state.get(pairId)

		if (runtime === undefined) {
			runtime = createPairRuntime(infos.get(pairId))
			state.set(pairId, runtime)
		}

		return runtime
	}

	function flush(): void {
		timer = undefined

		if (activity.length > 0) {
			deps.post({ t: "activity", entries: activity })
			activity = []
		}

		let next: NativeAggregate = "idle"

		for (const pairId of infos.keys()) {
			const runtime = runtimeFor(pairId)

			if (needsAttention(runtime)) {
				next = "attention"

				break
			}

			if (runtime.syncing) {
				next = "syncing"
			}
		}

		if (next !== aggregate) {
			aggregate = next
			deps.post({ t: "aggregate", state: next })
		}

		if (subscribed && dirty) {
			deps.post({ t: "overview", pairs: [...infos.values()].map(info => runtimeOf(sdk, info, runtimeFor(info.id.toString()))) })
		}

		dirty = false
	}

	return {
		setPairs: list => {
			infos.clear()

			for (const info of list) {
				infos.set(info.id.toString(), info)
				runtimeFor(info.id.toString())
			}

			for (const pairId of state.keys()) {
				if (!infos.has(pairId)) {
					state.delete(pairId)
				}
			}

			dirty = true
			schedule()
		},
		pair: pairId => infos.get(pairId),
		events: events => {
			const reduced = reduceEvents(sdk, state, events)

			if (reduced.activity.length > 0) {
				activity.push(...reduced.activity)

				if (activity.length > ACTIVITY_BUFFER) {
					activity = activity.slice(-ACTIVITY_BUFFER)
				}
			}

			if (reduced.authFailed) {
				deps.onAuthFailed()
			}

			if (reduced.changed) {
				dirty = true
				schedule()
			}
		},
		watchStatus: (pairId, status) => {
			if (reduceWatchStatus(sdk, runtimeFor(pairId.toString()), status).authFailed) {
				deps.onAuthFailed()
			}

			dirty = true
			schedule()
		},
		subscribe: on => {
			subscribed = on

			if (on) {
				dirty = true
				schedule()
			}
		},
		stop: () => {
			stopped = true
			clearTimeout(timer)
			timer = undefined
		}
	}
}

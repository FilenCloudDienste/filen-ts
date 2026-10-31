import type { ErrorKind, HaltReason, SyncPairInfo, SyncPassEvent, SyncPassReport, WatchStatus } from "@filen/sdk-rs"
import type {
	DesktopSyncHalt,
	DesktopSyncIssueCounts,
	DesktopSyncRefusal,
	DesktopSyncStage,
	DesktopSyncTransfer
} from "@filen/shared/desktop"
import {
	type FromNative,
	type NativeActivity,
	type NativeAggregate,
	type NativePairRuntime,
	SYNC_TRANSFERS_KEPT
} from "../shared/nativeProtocol.ts"
import { modeName, type NativeSdk } from "./addon.ts"
import { clip } from "./errors.ts"
import { refusal } from "./plans.ts"

// How often at most the host reports what changed: overview pushes stay at 4 Hz however fast the engine emits.
export const FEED_INTERVAL_MS = 250
// Activity waiting for the next report; main keeps 200 per pair, so a burst past this drops its oldest entries.
const ACTIVITY_BUFFER = 1000

// What the host knows live about one pair, beyond what the engine stores.
export interface PairRuntime {
	syncing: boolean
	// The running pass's planned actions, and how many of them it has begun.
	planned: number | null
	done: number
	// In flight, newest first: a transfer leaves once its bytes reach its size, it fails, or the pass ends.
	transfers: DesktopSyncTransfer[]
	lastSyncedAt: number | null
	lastError: string | null
	issues: DesktopSyncIssueCounts
	degraded: { local: boolean; remote: boolean }
	// The action in flight: reported once the next one begins or the pass completes, or as failed on its ActionFailed.
	pending: NativeActivity | null
	// Before a pass starts: waiting for the cloud listing, or reading the local directory.
	stage: DesktopSyncStage | null
	halted: DesktopSyncHalt | null
	refused: DesktopSyncRefusal | null
	// A pass completed in this process, so `issues` are its counts.
	reported: boolean
}

export function createPairRuntime(info?: SyncPairInfo, sdk?: NativeSdk): PairRuntime {
	const status = info?.watchStatus

	return {
		syncing: info?.passInFlight !== undefined,
		planned: null,
		done: 0,
		transfers: [],
		lastSyncedAt: info?.lastPassCompletedAtMs === undefined ? null : Number(info.lastPassCompletedAtMs),
		// A pass that only found the cloud listing unfinished is not ready yet, no error.
		lastError:
			info?.lastPassError === undefined || (sdk !== undefined && info.lastPassErrorKind === sdk.ErrorKind.StaleState)
				? null
				: clip(info.lastPassError),
		issues: { conflicts: 0, heldDeletions: 0, unsyncable: 0, failed: 0 },
		degraded: { local: status?.localEventsDegraded !== undefined, remote: status?.remoteEventsDegraded !== undefined },
		pending: null,
		stage: null,
		halted: sdk !== undefined && info?.lastPassErrorKind === sdk.ErrorKind.Reqwest ? "offline" : null,
		refused: null,
		reported: false
	}
}

export interface Reduced {
	changed: boolean
	activity: NativeActivity[]
	// A pass failed because the server no longer takes the session.
	authFailed: boolean
	// The passes that ended, with the report of each that completed.
	ended: { pairId: bigint; report: SyncPassReport | null }[]
}

// Unauthenticated is the sign-out flow's, not a state the pair shows.
function halt(sdk: NativeSdk, reason: HaltReason | undefined): DesktopSyncHalt | null {
	if (reason === undefined) {
		return null
	}

	switch (reason) {
		case sdk.HaltReason.LocalStorageFull:
			return "localStorageFull"
		case sdk.HaltReason.RemoteStorageFull:
			return "remoteStorageFull"
		case sdk.HaltReason.RemoteUnavailable:
			return "offline"
		case sdk.HaltReason.Unauthenticated:
			return null
		default:
			return reason satisfies never
	}
}

// A pass that failed because the server could not be reached (a lock request among them) is offline, whatever halted.
function offlineKind(sdk: NativeSdk, kind: ErrorKind | undefined): DesktopSyncHalt | null {
	return kind === sdk.ErrorKind.Reqwest ? "offline" : null
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
	runtime.stage = null
}

// Adds a transfer in front, replacing an older entry for the same file.
function started(runtime: PairRuntime, transfer: DesktopSyncTransfer): void {
	runtime.transfers = [
		transfer,
		...runtime.transfers
			.filter(entry => entry.relPath !== transfer.relPath || entry.direction !== transfer.direction)
			.slice(0, SYNC_TRANSFERS_KEPT - 1)
	]
}

// Folds a chunk of engine events into the pairs' runtime. Progress only updates the transfer it belongs to: it never
// becomes activity, and what reaches main is the coalesced state.
export function reduceEvents(sdk: NativeSdk, state: Map<string, PairRuntime>, events: readonly SyncPassEvent[]): Reduced {
	const activity: NativeActivity[] = []
	const ended: Reduced["ended"] = []
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
			case "AwaitingRemote":
				runtime.stage = { kind: "waitingForCloud" }
				break
			case "Scanning": {
				const { progress } = event.inner

				runtime.stage = {
					kind: "indexing",
					entries: Number(progress.entries),
					filesToHash: Number(progress.filesToHash),
					bytesToHash: Number(progress.bytesToHash),
					filesHashed: Number(progress.filesHashed),
					bytesHashed: Number(progress.bytesHashed)
				}
				break
			}
			case "PassStarted":
				endPass(runtime)
				runtime.syncing = true

				// The pass that tries the server again: its own end says how it went.
				if (runtime.halted === "offline") {
					runtime.halted = null
					runtime.lastError = null
				}

				break
			case "Planned":
				runtime.planned = Number(event.inner.actions)
				break
			case "Uploading":
			case "Downloading": {
				const relPath = clip(event.inner.relPath)

				begin(runtime, activity, { pairId, at, kind: BEGIN_KINDS[event.tag], relPath })
				started(runtime, { relPath, direction: event.tag === "Uploading" ? "upload" : "download", bytes: 0, total: 0 })
				break
			}
			case "Progress": {
				const relPath = clip(event.inner.relPath)
				const direction = event.inner.direction === sdk.TransferDirection.Upload ? "upload" : "download"
				const transfer = runtime.transfers.find(entry => entry.relPath === relPath && entry.direction === direction)
				const bytes = Number(event.inner.bytes)
				const total = Number(event.inner.total)

				// The engine reports no end of its own: the last progress, at the full size, is it.
				if (total > 0 && bytes >= total) {
					if (transfer !== undefined) {
						runtime.transfers = runtime.transfers.filter(entry => entry !== transfer)
					}
				} else if (transfer !== undefined) {
					transfer.bytes = bytes
					transfer.total = total
				} else {
					started(runtime, { relPath, direction, bytes, total })
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
				activity.push({ pairId, at, kind: "binned", relPath: clip(event.inner.relPath), to: clip(event.inner.binPath) })
				break
			case "ActionFailed": {
				const relPath = clip(event.inner.relPath)

				if (runtime.pending?.relPath === relPath) {
					runtime.pending = null
				}

				runtime.transfers = runtime.transfers.filter(entry => entry.relPath !== relPath)

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
				// The actions in flight were given up with the rest.
				runtime.pending = null
				runtime.transfers = []
				break
			case "Refused":
				// Its reason is the report's `refused`.
				break
			case "PassCompleted": {
				const { report } = event.inner

				finishPending(runtime, activity)
				endPass(runtime)
				runtime.lastSyncedAt = at
				runtime.lastError = report.passError === undefined ? null : clip(report.passError)
				runtime.halted = halt(sdk, report.halted) ?? offlineKind(sdk, report.passErrorKind)
				runtime.refused = refusal(sdk, report.refused)
				runtime.reported = true
				runtime.issues = {
					conflicts: Number(report.conflictsTotal),
					heldDeletions: Number(report.heldDeletions),
					unsyncable: Number(report.unsyncableTotal),
					failed: Number(report.errorsTotal)
				}
				authFailed ||= report.passErrorKind === sdk.ErrorKind.Unauthenticated || report.halted === sdk.HaltReason.Unauthenticated
				ended.push({ pairId: id, report })

				// A safety-net pass that found nothing to do is no news.
				if (applied(report) || report.passError !== undefined) {
					activity.push({ pairId, at, kind: "passCompleted" })
				}

				break
			}
			case "PassFailed":
				endPass(runtime)
				ended.push({ pairId: id, report: null })

				// The cloud listing did not finish in time: not ready yet. The engine tries again on its own, and the pair
				// keeps waiting for the cloud until a pass starts.
				if (event.inner.kind === sdk.ErrorKind.StaleState) {
					runtime.stage = { kind: "waitingForCloud" }
					break
				}

				runtime.lastError = clip(event.inner.error)
				runtime.halted = offlineKind(sdk, event.inner.kind)
				authFailed ||= event.inner.kind === sdk.ErrorKind.Unauthenticated
				activity.push({ pairId, at, kind: "passFailed", detail: runtime.lastError })
				break
		}
	}

	return { changed: events.length > 0, activity, authFailed, ended }
}

// A watch's status, published after every pass and when it starts or ends.
export function reduceWatchStatus(sdk: NativeSdk, runtime: PairRuntime, status: WatchStatus): { authFailed: boolean } {
	runtime.degraded = { local: status.localEventsDegraded !== undefined, remote: status.remoteEventsDegraded !== undefined }

	// A cloud listing that did not finish in time is not ready yet, no error.
	if (status.lastError !== undefined && status.lastErrorKind !== sdk.ErrorKind.StaleState) {
		runtime.lastError = clip(status.lastError)

		if (status.lastErrorKind === sdk.ErrorKind.Reqwest) {
			runtime.halted = "offline"
		}
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
		degraded: runtime.degraded,
		stage: runtime.stage,
		halted: runtime.halted,
		refused: runtime.refused
	}
}

// Being offline is no attention: the engine backs off and syncs once the server is back. The failures such a pass
// reports are the outage's (the error and the work it held back), so they are none either.
function needsAttention(runtime: PairRuntime): boolean {
	const { issues } = runtime
	const offline = runtime.halted === "offline"

	return (
		(runtime.lastError !== null && !offline) ||
		runtime.refused !== null ||
		issues.conflicts + issues.heldDeletions + issues.unsyncable + (offline ? 0 : issues.failed) > 0
	)
}

export interface RuntimeFeed {
	// The engine's pairs as listPairs reads them; a pair's runtime lives while it is listed.
	setPairs(infos: readonly SyncPairInfo[]): void
	pair(pairId: string): SyncPairInfo | undefined
	// The pair's held conflicts, counted before this process saw a pass of it.
	seedConflicts(pairId: string, conflicts: number): void
	events(events: readonly SyncPassEvent[]): void
	watchStatus(pairId: bigint, status: WatchStatus): void
	subscribe(on: boolean): void
	stop(): void
}

// Turns the engine's firehose into main's messages: at most one round per interval, carrying the activity since the
// last one (always), the aggregate when it changed, and the overview while main is subscribed.
export function createRuntimeFeed(
	sdk: NativeSdk,
	deps: {
		post(message: FromNative): void
		onAuthFailed(): void
		onPassEnded(pairId: bigint, report: SyncPassReport | null): void
	},
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
			runtime = createPairRuntime(infos.get(pairId), sdk)
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
		seedConflicts: (pairId, conflicts) => {
			const runtime = state.get(pairId)

			if (runtime !== undefined && !runtime.reported && runtime.issues.conflicts !== conflicts) {
				runtime.issues = { ...runtime.issues, conflicts }
				dirty = true
				schedule()
			}
		},
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

			for (const { pairId, report } of reduced.ended) {
				deps.post({ t: "passEnded", pairId: pairId.toString() })
				deps.onPassEnded(pairId, report)
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

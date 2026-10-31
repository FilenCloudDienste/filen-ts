import type {
	IgnoredPath,
	JsSyncPlan,
	PlannedAction,
	PlannedConflict,
	PlannedNodeKind,
	SyncGuardReason,
	SyncPlanSummary,
	SyncScanGap,
	UnsyncablePath
} from "@filen/sdk-rs"
import type {
	DesktopSyncActionKind,
	DesktopSyncConflict,
	DesktopSyncHeldReason,
	DesktopSyncIgnored,
	DesktopSyncNodeKind,
	DesktopSyncPlanAction,
	DesktopSyncPlanList,
	DesktopSyncPlanPage,
	DesktopSyncRefusal,
	DesktopSyncScanGap,
	DesktopSyncUnsyncable,
	DesktopSyncUnsyncableReason
} from "@filen/shared/desktop"
import type { NativePlanSummary } from "../shared/nativeProtocol.ts"
import type { NativeSdk } from "./addon.ts"
import { clip } from "./errors.ts"

export const PLAN_TTL_MS = 300_000

export interface PlanRegistry {
	put(plan: JsSyncPlan): string
	// Keeps the plan alive another TTL; null once it expired or was released.
	get(planId: string): JsSyncPlan | null
	release(planId: string): void
	releaseAll(): void
}

// The dry runs main holds by id. A plan's lists live in native memory until it is released, so one nothing asked for
// within the TTL is released; ids main still holds are then answered `planExpired`.
export function createPlanRegistry(ttlMs = PLAN_TTL_MS): PlanRegistry {
	const plans = new Map<string, { plan: JsSyncPlan; timer: NodeJS.Timeout }>()
	let nextId = 0

	function expire(planId: string): NodeJS.Timeout {
		const timer = setTimeout(() => {
			release(planId)
		}, ttlMs)

		timer.unref()

		return timer
	}

	function release(planId: string): void {
		const entry = plans.get(planId)

		if (entry !== undefined) {
			plans.delete(planId)
			clearTimeout(entry.timer)
			entry.plan.release()
		}
	}

	return {
		put: plan => {
			const planId = String(++nextId)

			plans.set(planId, { plan, timer: expire(planId) })

			return planId
		},
		get: planId => {
			const entry = plans.get(planId)

			if (entry === undefined) {
				return null
			}

			clearTimeout(entry.timer)
			entry.timer = expire(planId)

			return entry.plan
		},
		release,
		releaseAll: () => {
			for (const planId of [...plans.keys()]) {
				release(planId)
			}
		}
	}
}

const count = (value: bigint): number => Number(value)

const ACTION_KINDS: Record<PlannedAction["kind"]["tag"], DesktopSyncActionKind> = {
	UploadFile: "upload",
	DownloadFile: "download",
	CreateRemoteDir: "createRemoteDirectory",
	CreateLocalDir: "createLocalDirectory",
	MoveRemote: "moveRemote",
	MoveLocal: "moveLocal",
	TrashRemote: "trashRemote",
	DeleteLocal: "deleteLocal",
	AdoptBaseline: "adoptBaseline"
}

const HELD_REASONS: Record<SyncGuardReason["tag"], DesktopSyncHeldReason> = {
	ScanIncomplete: "scanIncomplete",
	FirstSyncWithDeletions: "firstSyncWithDeletions",
	RemoteUnconverged: "remoteUnconverged",
	RemoteEmptied: "remoteEmptied",
	ExceededThreshold: "exceededThreshold"
}

const UNSYNCABLE_REASONS: Record<UnsyncablePath["reason"]["tag"], DesktopSyncUnsyncableReason> = {
	InvalidName: "invalidName",
	RepeatedFailure: "repeatedFailure",
	RemoteUndecodable: "remoteUndecodable",
	RemoteInvalidName: "remoteInvalidName",
	RemoteBrokenParent: "remoteBrokenParent",
	LocalAlias: "localAlias",
	LocalNameCollision: "localNameCollision",
	RemoteNameCollision: "remoteNameCollision"
}

function nodeKind(sdk: NativeSdk, node: PlannedNodeKind): DesktopSyncNodeKind {
	return node === sdk.PlannedNodeKind.Dir ? "directory" : "file"
}

export function toAction(sdk: NativeSdk, action: PlannedAction): DesktopSyncPlanAction {
	const { kind } = action

	return {
		relPath: clip(action.relPath),
		kind: ACTION_KINDS[kind.tag],
		to: kind.tag === "MoveRemote" || kind.tag === "MoveLocal" ? clip(kind.inner.to) : null,
		node: nodeKind(sdk, action.node),
		size: action.size === undefined ? null : count(action.size)
	}
}

export function toConflict(sdk: NativeSdk, conflict: PlannedConflict): DesktopSyncConflict {
	return {
		relPath: clip(conflict.relPath),
		local: conflict.local === undefined ? null : nodeKind(sdk, conflict.local),
		remote: conflict.remote === undefined ? null : nodeKind(sdk, conflict.remote)
	}
}

function unsyncableDetail(reason: UnsyncablePath["reason"]): string | null {
	switch (reason.tag) {
		case "InvalidName":
			return reason.inner.detail
		case "RepeatedFailure":
			return reason.inner.lastError
		case "RemoteInvalidName":
			return reason.inner.name
		case "LocalAlias":
			return reason.inner.target
		default:
			return null
	}
}

export function toUnsyncable(path: UnsyncablePath): DesktopSyncUnsyncable {
	const detail = unsyncableDetail(path.reason)

	return { relPath: clip(path.relPath), reason: UNSYNCABLE_REASONS[path.reason.tag], detail: detail === null ? null : clip(detail) }
}

const GAP_CAUSES: Record<SyncScanGap["cause"]["tag"], DesktopSyncScanGap["cause"]> = {
	Unreadable: "unreadable",
	ChangedDuringScan: "changedDuringScan",
	NonUtf8Name: "nonUtf8Name"
}

export function toScanGap(gap: SyncScanGap): DesktopSyncScanGap {
	const { cause } = gap

	return { relPath: clip(gap.relPath), cause: GAP_CAUSES[cause.tag], kind: cause.tag === "Unreadable" ? clip(cause.inner.kind) : null }
}

export function toIgnored(path: IgnoredPath): DesktopSyncIgnored {
	const { level } = path

	return {
		relPath: clip(path.relPath),
		level: level.tag === "Default" ? "default" : level.tag === "User" ? "user" : "file",
		dir: level.tag === "File" ? clip(level.inner.dir) : null,
		pattern: clip(path.pattern),
		tracked: path.tracked
	}
}

export function heldReason(guard: SyncGuardReason | undefined): DesktopSyncHeldReason | null {
	return guard === undefined ? null : HELD_REASONS[guard.tag]
}

export function refusal(sdk: NativeSdk, reason: SyncPlanSummary["refused"]): DesktopSyncRefusal | null {
	if (reason === undefined) {
		return null
	}

	return reason === sdk.RefuseReason.RemoteCollision ? "remoteCollision" : "localCollision"
}

export function toSummary(sdk: NativeSdk, summary: SyncPlanSummary): NativePlanSummary {
	return {
		actions: count(summary.actionsTotal),
		uploadBytes: count(summary.uploadBytes),
		downloadBytes: count(summary.downloadBytes),
		heldDeletions: count(summary.heldDeletions),
		heldReason: heldReason(summary.heldReason),
		conflicts: count(summary.conflictsTotal),
		unsyncable: count(summary.unsyncableTotal),
		ignored: count(summary.ignoredTotal),
		refused: refusal(sdk, summary.refused),
		passToken: summary.passToken ?? null
	}
}

// One page of one of a plan's lists.
export function planPage(sdk: NativeSdk, plan: JsSyncPlan, list: DesktopSyncPlanList, offset: number, limit: number): DesktopSyncPlanPage {
	const summary = plan.summary()
	const from = BigInt(offset)
	const size = BigInt(limit)

	switch (list) {
		case "actions":
			return { list, total: count(summary.actionsTotal), entries: plan.actions(from, size).map(action => toAction(sdk, action)) }
		case "held":
			return { list, total: count(summary.heldTotal), entries: plan.held(from, size).map(action => toAction(sdk, action)) }
		case "conflicts":
			return { list, total: count(summary.conflictsTotal), entries: plan.conflicts(from, size).map(entry => toConflict(sdk, entry)) }
		case "unsyncable":
			return { list, total: count(summary.unsyncableTotal), entries: plan.unsyncable(from, size).map(toUnsyncable) }
		case "ignored":
			return { list, total: count(summary.ignoredTotal), entries: plan.ignored(from, size).map(toIgnored) }
	}
}

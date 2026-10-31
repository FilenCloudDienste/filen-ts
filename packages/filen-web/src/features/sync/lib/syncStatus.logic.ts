import {
	type DesktopSyncConflict,
	type DesktopSyncHalt,
	type DesktopSyncHold,
	type DesktopSyncHeldReason,
	type DesktopSyncInfoNotice,
	type DesktopSyncScanGap,
	SYNC_ATTENTION_HOLDS,
	type DesktopSyncIssueCounts,
	type DesktopSyncMode,
	type DesktopSyncNotice,
	type DesktopSyncOverview,
	type DesktopSyncPair,
	type DesktopSyncPhase,
	type DesktopSyncPlanList,
	type DesktopSyncPlanSummary,
	type DesktopSyncRefusal,
	type DesktopSyncReviewFinding,
	type DesktopSyncActionKind
} from "@filen/shared/desktop"
import type { SyncKey } from "@/lib/i18n"

// The rail's one-glance state: anything the user has to act on wins over a running pass.
export type SyncAggregate = "idle" | "syncing" | "attention"

const ATTENTION_PHASES: ReadonlySet<DesktopSyncPhase> = new Set(["error", "review", "waitingForRoot"])

export function issueTotal(issues: DesktopSyncIssueCounts): number {
	return issues.conflicts + issues.heldDeletions + issues.unsyncable + issues.failed
}

// Being offline never is: the pair syncs again once the server is back, and what failed in that pass is the outage's.
export function pairNeedsAttention(pair: Pick<DesktopSyncPair, "phase" | "issues" | "refused" | "holds" | "halted">): boolean {
	const issues = pair.halted === "offline" ? { ...pair.issues, failed: 0 } : pair.issues

	return (
		ATTENTION_PHASES.has(pair.phase) ||
		issueTotal(issues) > 0 ||
		pair.refused !== null ||
		pair.holds.some(hold => SYNC_ATTENTION_HOLDS.has(hold))
	)
}

// null before the first overview (and always in a browser).
export function aggregateSyncState(overview: DesktopSyncOverview | null): SyncAggregate | null {
	if (overview === null) {
		return null
	}

	if (overview.host.state === "failed") {
		return "attention"
	}

	let syncing = false

	for (const pair of overview.pairs) {
		if (pairNeedsAttention(pair)) {
			return "attention"
		}

		if (pair.phase === "syncing") {
			syncing = true
		}
	}

	return syncing ? "syncing" : "idle"
}

export const PHASE_KEY: Record<DesktopSyncPhase, SyncKey> = {
	idle: "phaseIdle",
	syncing: "phaseSyncing",
	paused: "phasePaused",
	preparing: "phasePreparing",
	review: "phaseReview",
	waitingForRoot: "phaseWaitingForRoot",
	unsupported: "phaseUnsupported",
	error: "phaseError",
	waitingForCloud: "phaseWaitingForCloud",
	indexing: "phaseIndexing",
	offline: "phaseOffline"
}

export const MODES: readonly DesktopSyncMode[] = ["twoWay", "localToRemote", "remoteToLocal", "localBackup", "remoteBackup"]

export const MODE_KEY: Record<DesktopSyncMode, SyncKey> = {
	twoWay: "modeTwoWay",
	localToRemote: "modeLocalToRemote",
	remoteToLocal: "modeRemoteToLocal",
	localBackup: "modeLocalBackup",
	remoteBackup: "modeRemoteBackup"
}

// The pair page's mode chip between its two directories.
export const MODE_SHORT_KEY: Record<DesktopSyncMode, SyncKey> = {
	twoWay: "modeShortTwoWay",
	localToRemote: "modeShortLocalToRemote",
	remoteToLocal: "modeShortRemoteToLocal",
	localBackup: "modeShortLocalBackup",
	remoteBackup: "modeShortRemoteBackup"
}

// Which way changes flow between the local directory (drawn first) and the cloud one.
export type SyncDirection = "both" | "toRemote" | "toLocal"

export const MODE_DIRECTION: Record<DesktopSyncMode, SyncDirection> = {
	twoWay: "both",
	localToRemote: "toRemote",
	remoteToLocal: "toLocal",
	localBackup: "toRemote",
	remoteBackup: "toLocal"
}

export const MODE_DESCRIPTION_KEY: Record<DesktopSyncMode, SyncKey> = {
	twoWay: "modeTwoWayDescription",
	localToRemote: "modeLocalToRemoteDescription",
	remoteToLocal: "modeRemoteToLocalDescription",
	localBackup: "modeLocalBackupDescription",
	remoteBackup: "modeRemoteBackupDescription"
}

export function isBackupMode(mode: DesktopSyncMode): boolean {
	return mode === "localBackup" || mode === "remoteBackup"
}

// Leaving a backup mode must say what happens to what it held back from the destination (setMode's `backlog`).
export function modeChangeNeedsBacklog(from: DesktopSyncMode, to: DesktopSyncMode): boolean {
	return from !== to && isBackupMode(from)
}

export const NOTICE_KEY: Record<DesktopSyncNotice, SyncKey> = {
	refusedLocalRoot: "noticeRefusedLocalRoot",
	refusedRemoteMissing: "noticeRefusedRemoteMissing",
	refusedLocalOverlap: "noticeRefusedLocalOverlap",
	refusedRemoteOverlap: "noticeRefusedRemoteOverlap",
	refusedModeConflict: "noticeRefusedModeConflict"
}

export const HOLD_KEY: Record<DesktopSyncHold, SyncKey> = {
	ruleFileUnwritable: "holdRuleFileUnwritable",
	ruleFileUndecodable: "holdRuleFileUndecodable",
	driveRoot: "holdDriveRoot",
	cloudListingSlow: "holdCloudListingSlow"
}

export const INFO_NOTICE_KEY: Record<DesktopSyncInfoNotice, SyncKey> = {
	localTrashNowOn: "infoLocalTrashNowOn"
}

export const HALT_KEY: Record<DesktopSyncHalt, SyncKey> = {
	localStorageFull: "haltLocalStorageFull",
	remoteStorageFull: "haltRemoteStorageFull",
	offline: "haltOffline"
}

export const SCAN_GAP_KEY: Record<DesktopSyncScanGap["cause"], SyncKey> = {
	unreadable: "scanGapUnreadable",
	changedDuringScan: "scanGapChangedDuringScan",
	nonUtf8Name: "scanGapNonUtf8Name"
}

export const FINDING_KEY: Record<DesktopSyncReviewFinding, SyncKey> = {
	uploads: "findingUploads",
	downloads: "findingDownloads",
	conflicts: "findingConflicts",
	heldDeletions: "findingHeldDeletions",
	refused: "findingRefused",
	unconverged: "findingUnconverged",
	overwrites: "findingOverwrites"
}

export const HELD_REASON_KEY: Record<DesktopSyncHeldReason, SyncKey> = {
	scanIncomplete: "heldScanIncomplete",
	firstSyncWithDeletions: "heldFirstSyncWithDeletions",
	remoteUnconverged: "heldRemoteUnconverged",
	remoteEmptied: "heldRemoteEmptied",
	exceededThreshold: "heldExceededThreshold"
}

export const REFUSAL_KEY: Record<DesktopSyncRefusal, SyncKey> = {
	remoteCollision: "refusedRemoteCollision",
	localCollision: "refusedLocalCollision"
}

export const PLAN_LIST_KEY: Record<DesktopSyncPlanList, SyncKey> = {
	actions: "planListActions",
	held: "planListHeld",
	conflicts: "planListConflicts",
	unsyncable: "planListUnsyncable",
	ignored: "planListIgnored"
}

export const ACTION_KIND_KEY: Record<DesktopSyncActionKind, SyncKey> = {
	upload: "actionUpload",
	download: "actionDownload",
	createRemoteDirectory: "actionCreateRemoteDirectory",
	createLocalDirectory: "actionCreateLocalDirectory",
	moveRemote: "actionMoveRemote",
	moveLocal: "actionMoveLocal",
	trashRemote: "actionTrashRemote",
	deleteLocal: "actionDeleteLocal",
	adoptBaseline: "actionAdoptBaseline"
}

const PLAN_LISTS: readonly DesktopSyncPlanList[] = ["actions", "held", "conflicts", "unsyncable", "ignored"]

export function planListTotal(summary: DesktopSyncPlanSummary, list: DesktopSyncPlanList): number {
	switch (list) {
		case "actions":
			return summary.actions
		case "held":
			return summary.heldDeletions
		case "conflicts":
			return summary.conflicts
		case "unsyncable":
			return summary.unsyncable
		case "ignored":
			return summary.ignored
	}
}

// The review card's list tabs: only lists that hold something.
export function planListsWithEntries(summary: DesktopSyncPlanSummary): DesktopSyncPlanList[] {
	return PLAN_LISTS.filter(list => planListTotal(summary, list) > 0)
}

// Above this a first sync gets an extra warning: it can run for hours.
export const LARGE_PLAN_ACTIONS = 100_000

export function isLargePlan(summary: DesktopSyncPlanSummary | null): boolean {
	return summary !== null && summary.actions > LARGE_PLAN_ACTIONS
}

// The last segment of a local path, either separator; the path itself when it has none (a drive root).
export function pathBasename(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "")
	const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))

	return index === -1 ? (trimmed.length > 0 ? trimmed : path) : trimmed.slice(index + 1)
}

// Everything before the last segment of a path, either separator, keeping a root's own separator ("/", "C:\");
// "" for a path with no parent segment.
export function pathParent(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "")
	const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))

	if (index === -1) {
		return ""
	}

	return index === 0 || trimmed[index - 1] === ":" ? trimmed.slice(0, index + 1) : trimmed.slice(0, index)
}

// The pair's own rule file, which a pair that only downloaded kept to this device: switched to a mode that uploads,
// it meets the cloud's copy.
export function isRootRuleFile(conflict: Pick<DesktopSyncConflict, "relPath">): boolean {
	return conflict.relPath === ".filenignore"
}

// How a conflict came about: a side is null where that side deleted the path.
export function conflictDetailKey(conflict: DesktopSyncConflict): SyncKey {
	if (conflict.local === null) {
		return "conflictLocalDeleted"
	}

	return conflict.remote === null ? "conflictRemoteDeleted" : "conflictBoth"
}

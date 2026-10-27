import type { DesktopSyncActivity, DesktopSyncActivityKind } from "@filen/shared/desktop"
import type { SyncKey } from "@/lib/i18n"

// The shell keeps the latest 200 per pair; the page never holds more.
export const ACTIVITY_LIMIT = 200

export const ACTIVITY_KIND_KEY: Record<DesktopSyncActivityKind, SyncKey> = {
	uploaded: "activityUploaded",
	downloaded: "activityDownloaded",
	createdRemoteDirectory: "activityCreatedRemoteDirectory",
	createdLocalDirectory: "activityCreatedLocalDirectory",
	trashedRemote: "activityTrashedRemote",
	deletedLocal: "activityDeletedLocal",
	movedRemote: "activityMovedRemote",
	movedLocal: "activityMovedLocal",
	binned: "activityBinned",
	failed: "activityFailed",
	conflict: "activityConflict",
	deletionsHeld: "activityDeletionsHeld",
	passFailed: "activityPassFailed",
	passCompleted: "activityPassCompleted"
}

export type ActivityTone = "normal" | "warning" | "error"

export const ACTIVITY_KIND_TONE: Record<DesktopSyncActivityKind, ActivityTone> = {
	uploaded: "normal",
	downloaded: "normal",
	createdRemoteDirectory: "normal",
	createdLocalDirectory: "normal",
	trashedRemote: "normal",
	deletedLocal: "normal",
	movedRemote: "normal",
	movedLocal: "normal",
	binned: "normal",
	failed: "error",
	conflict: "warning",
	deletionsHeld: "warning",
	passFailed: "error",
	passCompleted: "normal"
}

// Folds a batch into one pair's list: only that pair's entries, each seq once, newest first, capped. Returns
// `current` itself when the batch adds nothing, so a push for another pair re-renders nothing.
export function mergeActivity(
	current: readonly DesktopSyncActivity[],
	incoming: readonly DesktopSyncActivity[],
	pairId: string
): readonly DesktopSyncActivity[] {
	const seen = new Set(current.map(entry => entry.seq))
	const added = incoming.filter(entry => {
		if (entry.pairId !== pairId || seen.has(entry.seq)) {
			return false
		}

		seen.add(entry.seq)

		return true
	})

	if (added.length === 0) {
		return current
	}

	return [...added, ...current].sort((a, b) => b.seq - a.seq).slice(0, ACTIVITY_LIMIT)
}

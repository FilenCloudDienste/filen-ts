import { isRevisionOf as isRevisionOfIdentity, settleHeldRevisions as settleHeld, type RevisionIdentity } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"

// The preview's side of @filen/shared's remote-change rules (remoteChange.ts): how an open preview answers
// a newer version of one of its files saved elsewhere. The drive socket announces every new version as a
// fileNew carrying the lineage's stableUUID (a version restore as fileArchiveRestored, naming the uuid it
// replaced), so a slot follows its file by that id and never by its uuid, which rotates with every save.

export interface PreviewRevision {
	item: DriveItem
	// The uuid the revision replaced, when the event names it (a version restore).
	previousUuid?: string
}

function identityOf(item: DriveItem): RevisionIdentity {
	return { uuid: item.data.uuid, stableUuid: item.type === "file" ? item.data.stableUUID : undefined }
}

// Whether `revision` is a newer version of the file `displayed` shows.
export function isRevisionOf(displayed: DriveItem, revision: PreviewRevision): boolean {
	return (
		displayed.type === "file" &&
		isRevisionOfIdentity(identityOf(displayed), { ...identityOf(revision.item), previousUuid: revision.previousUuid })
	)
}

export function settleHeldRevisions(
	held: readonly PreviewRevision[],
	savedUuid: string | null
): { replaced: boolean; newer: PreviewRevision[] } {
	return settleHeld(held, savedUuid, revision => revision.item.data.uuid)
}

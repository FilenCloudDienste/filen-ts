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

function lineageOf(item: DriveItem): string {
	return item.type === "file" ? (item.data.stableUUID ?? item.data.uuid) : item.data.uuid
}

// settleHeldRevisions once every save that overlapped has settled (an export carrying on in the background while
// another file is saved, say): each file's held revisions are sorted by that file's own saves, its last echo
// splitting them, the other saves' echoes dropped as the user's own. A file no save landed for keeps them all, as
// newer. `afterSave` per revision: a save of its file landed.
export function settleHeldAcrossSaves(
	held: readonly PreviewRevision[],
	saved: readonly DriveItem[]
): { replaced: boolean; newer: { revision: PreviewRevision; afterSave: boolean }[] } {
	const savedByLineage = new Map<string, Set<string>>()

	for (const item of saved) {
		const lineage = lineageOf(item)
		const uuids = savedByLineage.get(lineage) ?? new Set<string>()

		uuids.add(item.data.uuid)
		savedByLineage.set(lineage, uuids)
	}

	let replaced = false
	const newer: { revision: PreviewRevision; afterSave: boolean }[] = []
	const lastEcho = new Map<string, number>()

	held.forEach((revision, index) => {
		const lineage = lineageOf(revision.item)

		if (savedByLineage.get(lineage)?.has(revision.item.data.uuid) === true) {
			lastEcho.set(lineage, index)
		}
	})

	held.forEach((revision, index) => {
		const lineage = lineageOf(revision.item)
		const own = savedByLineage.get(lineage)

		if (own === undefined) {
			newer.push({ revision, afterSave: false })

			return
		}

		if (own.has(revision.item.data.uuid)) {
			return
		}

		const echo = lastEcho.get(lineage)

		// Before its file's last own echo (or with none yet arrived): the save went over it.
		if (echo === undefined || index < echo) {
			replaced = true

			return
		}

		newer.push({ revision, afterSave: true })
	})

	return { replaced, newer }
}

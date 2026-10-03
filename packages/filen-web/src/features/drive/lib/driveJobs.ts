import type { QuotaCheckDeps, StorageCounters } from "@filen/shared"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { BulkOutcome } from "@/lib/actions/bulk"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { findCachedListingItem, normalizeParentUuid, queueListingCreate } from "@/features/drive/queries/drive"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { flushDeferredRecents } from "@/features/drive/lib/socketHandlers"
import { addAccountStorageUsed } from "@/features/drive/lib/quota"
import { invalidateUploadedDirectorySizes } from "@/features/drive/lib/upload"
import { isDriveJobRunning } from "@/features/drive/lib/driveJobs.logic"
import { forgetJobPassword } from "@/features/drive/lib/jobSecrets"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"

// What every drive job (copy, compress, extract) shares, whatever its kind.

// A cached figure can predate a delete made elsewhere, so a job the SDK refused up front for storage reads
// it once fresh.
export async function readFreshAccount(account: QuotaCheckDeps): Promise<StorageCounters | undefined> {
	try {
		return await account.fetchFresh()
	} catch {
		return undefined
	}
}

// Settles a job the user stopped as cancelled; never shown.
export const STOPPED: ErrorDTO = { species: "sdk", kind: "Cancelled", message: "", label: "" }

export interface TrashResult {
	moved: number
	failed: number
}

export function addTrashOutcome(result: TrashResult | null, outcome: BulkOutcome<DriveItem>): TrashResult {
	return { moved: (result?.moved ?? 0) + outcome.succeeded.length, failed: (result?.failed ?? 0) + outcome.failed.length }
}

// The destination listing is usually the one on screen; one nobody has read is left to its first read.
// Batched with the socket echoes, which carry the same items again.
export function patchJobCreatedItem(item: DriveItem): void {
	queueListingCreate(normalizeParentUuid(item.data.parent, currentRootUuid()), item)
}

// A settled job stays while its card shows or its transfers row can reopen the card.
export function pruneSettledDriveJobs(): void {
	const rows = new Set(useTransfersStore.getState().transfers.map(transfer => transfer.id))
	const gone = new Set<string>()

	for (const job of Object.values(useDriveJobsStore.getState().jobs)) {
		if (!isDriveJobRunning(job) && !job.cardVisible && !rows.has(job.id)) {
			gone.add(job.id)
		}
	}

	if (gone.size === 0) {
		return
	}

	useDriveJobsStore.getState().removeMany(gone)

	for (const id of gone) {
		forgetJobPassword(id)
	}
}

// A directory to walk up from: an SDK dir carries its parent, so the first step needs no lookup.
export interface DirectoryHop {
	uuid: string
	parent?: string
}

function cachedParentOf(uuid: string): string | undefined {
	const cached = findCachedListingItem(uuid)

	return cached === undefined ? undefined : asDirectoryOrFile(cached).data.parent
}

// Every directory from each hop up to `stopUuid` (left out), the rest of the way read through the listing
// cache (no request). A walk ends early at a directory `seed` holds or an earlier walk passed.
export function directoriesBetween(from: Iterable<DirectoryHop>, stopUuid: string | null, seed: Iterable<string> = []): string[] {
	const found = new Set<string>(seed)
	const rootUuid = currentRootUuid()

	for (const hop of from) {
		let uuid = normalizeParentUuid(hop.uuid, rootUuid)
		let parent = hop.parent

		while (uuid !== null && uuid !== stopUuid && !found.has(uuid)) {
			found.add(uuid)

			const next = parent ?? cachedParentOf(uuid)

			parent = undefined
			uuid = next === undefined ? null : normalizeParentUuid(next, rootUuid)
		}
	}

	return [...found]
}

// Whether a walk up from `hop`, the rest of the way through the listing cache (no request), meets one of
// `uuids` before the root or an uncached directory.
export function liesWithin(hop: DirectoryHop, uuids: ReadonlySet<string>): boolean {
	const rootUuid = currentRootUuid()
	const seen = new Set<string>()
	let uuid = normalizeParentUuid(hop.uuid, rootUuid)
	let parent = hop.parent

	while (uuid !== null && !seen.has(uuid)) {
		if (uuids.has(uuid)) {
			return true
		}

		seen.add(uuid)

		const next = parent ?? cachedParentOf(uuid)

		parent = undefined
		uuid = next === undefined ? null : normalizeParentUuid(next, rootUuid)
	}

	return false
}

export interface JobSettledEffects {
	destinationUuid: string | null
	// The directories below the destination the job wrote into or created.
	writtenDirs: readonly string[]
	bytesWritten: number
	// What a "delete permanently" of the sources freed; a trash frees nothing until the trash is emptied.
	bytesFreed: number
	// Where the sources the job removed were (null for the root), once each.
	sourceParents: readonly (string | null)[]
}

// No toast: the card, or the transfers row, shows how the job ended.
export function afterDriveJobSettled(effects: JobSettledEffects): void {
	flushDeferredRecents()

	const delta = effects.bytesWritten - effects.bytesFreed

	if (delta !== 0) {
		addAccountStorageUsed(BigInt(delta), { readNow: true })
	}

	// The source parents' chains go in as already known, so the destination's walk stops where they meet
	// and no directory is invalidated twice.
	const sourceDirs = directoriesBetween(
		effects.sourceParents.flatMap(parent => (parent === null ? [] : [{ uuid: parent }])),
		null
	)

	if (effects.bytesWritten > 0 || effects.writtenDirs.length > 0) {
		invalidateUploadedDirectorySizes(effects.destinationUuid, [...effects.writtenDirs, ...sourceDirs])
	} else if (sourceDirs.length > 0) {
		invalidateUploadedDirectorySizes(null, sourceDirs)
	}

	pruneSettledDriveJobs()
}

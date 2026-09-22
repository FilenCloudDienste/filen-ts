import { type InflightContent } from "./notesOutbox"

// Post-push maintenance: keep only the entries typed strictly AFTER the pushed entry's LOCAL
// author-timestamp (they were typed during the round trip and must survive), and rebase every
// survivor's baseContentHash onto the hash of the content just pushed — otherwise the next pass
// would compare those entries against their stale session base and flag the app's OWN push as a
// conflict. Never compares local and server clocks. `undefined` (both for absent input and an
// emptied result) tells the caller to delete the outbox key entirely rather than store `[]`.
export function pruneAndRebaseNoteOutboxAfterPush<T extends { timestamp: number; baseContentHash?: string }>(
	entries: T[] | undefined,
	syncedUpTo: number,
	pushedContentHash: string
): T[] | undefined {
	if (!entries) {
		return undefined
	}

	const remaining = entries.filter(c => c.timestamp > syncedUpTo).map(c => ({
		...c,
		baseContentHash: pushedContentHash
	}))

	return remaining.length > 0 ? remaining : undefined
}

// Restore-from-disk maintenance, run once per reconcile pass against a freshly-fetched cloud
// snapshot: drop a disk-seeded entry whose note no longer exists in the cloud, drop entries whose
// content now equals the fetched cloud content (already synced), and leave everything else
// untouched — including when the cloud fetch for that note failed or is unavailable, since pruning
// against content we don't have would discard an unsynced draft. Compares content only, never local
// and server clocks.
export function reconcileNoteOutboxAgainstCloud<TNote>(
	current: InflightContent<TNote>,
	fromDiskKeys: string[],
	cloudNoteUuids: ReadonlySet<string>,
	cloudContentByUuid: ReadonlyMap<string, string>
): InflightContent<TNote> {
	const updated: InflightContent<TNote> = {
		...current
	}

	for (const noteUuid of fromDiskKeys) {
		const entries = updated[noteUuid]

		if (!entries) {
			continue
		}

		if (!cloudNoteUuids.has(noteUuid)) {
			delete updated[noteUuid]

			continue
		}

		if (!cloudContentByUuid.has(noteUuid)) {
			continue
		}

		const cloudContent = cloudContentByUuid.get(noteUuid) ?? ""
		const remaining = entries.filter(c => c.content !== cloudContent)

		if (remaining.length === 0) {
			delete updated[noteUuid]

			continue
		}

		updated[noteUuid] = remaining
	}

	return updated
}

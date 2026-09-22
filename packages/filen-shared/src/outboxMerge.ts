// D1 fix (ported from chat/notes outbox restore): a functional, per-key MERGE used to hydrate a
// disk-restored send-outbox queue into the (possibly already-populated) live queue without
// clobbering an entry added during the restore window. Disk seeds keys the live queue doesn't
// have yet; for keys present on both sides the message lists are UNIONED by inflightId with LIVE
// entries winning (anything already live is newer than any disk snapshot of the same id). Pure —
// no store/IO access.
//
// Deliberately generic and NOT domain-prefixed: every outbox that unions by inflightId (chat, and
// any future one) shares this one implementation. The "ByUnion" in the name is load-bearing — it
// distinguishes this from a last-write-wins merge (e.g. notes' outbox, which keeps newest-per-uuid).
export function mergeInflightQueuesByUnion<TMessage extends { inflightId: string }, TEntry extends { messages: TMessage[] }>(
	current: Record<string, TEntry>,
	fromDisk: Record<string, TEntry>
): Record<string, TEntry> {
	const merged: Record<string, TEntry> = {
		...current
	}

	for (const key of Object.keys(fromDisk)) {
		const diskEntry = fromDisk[key]

		if (!diskEntry) {
			continue
		}

		const currentEntry = merged[key]

		if (!currentEntry || currentEntry.messages.length === 0) {
			merged[key] = diskEntry

			continue
		}

		const liveInflightIds = new Set(currentEntry.messages.map(message => message.inflightId))
		const missingFromLive = diskEntry.messages.filter(message => !liveInflightIds.has(message.inflightId))

		if (missingFromLive.length === 0) {
			continue
		}

		merged[key] = {
			...currentEntry,
			messages: [...currentEntry.messages, ...missingFromLive]
		}
	}

	return merged
}

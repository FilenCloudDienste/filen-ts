import { xxHash32 } from "js-xxhash"

// The notes outbox's in-memory entry shape, generic over each app's own generated Note type: per
// note, a time-ordered list of the content the user has typed but not yet confirmed synced. Kept as a
// list (not a single latest value) so the push loop can prune by LOCAL author-time — only entries
// typed DURING a round trip survive a successful push, the ones it actually sent die.
export type InflightEntry<TNote> = {
	// LOCAL author-time (Date.now()), made per-note MONOTONIC by buildInflightEntries so an NTP
	// backstep can never leave a stale entry outranking freshly typed text. Never compared against
	// the server's editedTimestamp — different clocks in the same unit.
	timestamp: number
	content: string
	// A full Note SNAPSHOT captured at edit time. The push loop prefers the LIVE note from the list
	// cache and only falls back to this snapshot when the note has left the cache (concurrently
	// deleted).
	note: TNote
	// Hash (hashNoteContent) of the synced/loaded content this editing session was BASED on — NOT
	// the typed text. Compared against the note's current cloud content to DETECT (never prevent —
	// local edits always win) that a push buried newer remote work. OPTIONAL because the queue is
	// persisted: entries written by an older app version carry no hash and push WITHOUT the conflict
	// check (a one-time grace, not migration machinery).
	baseContentHash?: string
}

export type InflightContent<TNote> = Record<string, InflightEntry<TNote>[]>

// Cheap stable content hash used for overwrite-conflict DETECTION. Persisted inside inflight entries
// as `baseContentHash`, so the algorithm must stay stable across app versions: changing it only costs
// a one-pass grace (entries fall back to the legacy no-hash path), never data. Local-only bookkeeping;
// never sent to the server.
export function hashNoteContent(content: string): string {
	return xxHash32(content).toString(16)
}

// Pure builder for a note's inflight entry list after a keystroke.
//
// The author timestamp is PER-NOTE MONOTONIC — `max(now, newest existing + 1)` — so a backward
// clock step (e.g. an NTP correction mid-editing) can never leave an OLDER entry outranking the text
// just typed: the sync push's max-timestamp pick would push the stale entry and its `> syncedUpTo`
// prune would then discard the newest text. All comparisons stay local-vs-local; server clocks are
// never consulted.
//
// An ongoing session CARRIES its existing base hash forward unchanged (including the legacy no-hash
// grace for entries persisted by an older app version — stamping a fresh base mid-session would claim
// a sync point the session never had). Only a FRESH session (no existing entries) stamps
// `sessionBaseHash` — the hash of the synced/loaded content the editor was seeded from, or none when
// nothing synced is known. The caller supplies `sessionBaseHash` when a session starts; omitting it is
// the legacy grace.
export function buildInflightEntries<TNote>({
	previous,
	note,
	content,
	now,
	sessionBaseHash
}: {
	previous: InflightEntry<TNote>[] | undefined
	note: TNote
	content: string
	now: number
	sessionBaseHash: string | null
}): InflightEntry<TNote>[] {
	const entries = previous ?? []
	const newestExisting = entries.reduce((acc, c) => (c.timestamp > acc ? c.timestamp : acc), Number.NEGATIVE_INFINITY)
	const timestamp = entries.length > 0 ? Math.max(now, newestExisting + 1) : now
	const newestEntry = entries.find(c => c.timestamp === newestExisting)
	const baseContentHash = entries.length > 0 ? newestEntry?.baseContentHash : (sessionBaseHash ?? undefined)

	// exactOptionalPropertyTypes: an absent base hash must OMIT the key, never set it to `undefined`.
	const newEntry: InflightEntry<TNote> =
		baseContentHash !== undefined
			? {
					timestamp,
					note,
					content,
					baseContentHash
				}
			: {
					timestamp,
					note,
					content
				}

	return [
		newEntry,
		// The new keystroke strictly supersedes every existing entry (its timestamp is the monotonic
		// maximum), so this keeps nothing in practice — retained purely as a guard against an exotic
		// concurrent writer racing this functional update.
		...entries.filter(c => c.timestamp > timestamp)
	]
}

// Functional, per-uuid MERGE used to hydrate a disk-restored outbox into the (possibly already-
// populated) live queue without clobbering an edit made during the seconds-long cloud-fetch
// reconciliation window. For each uuid, keeps whichever side carries the newest LOCAL author-
// timestamp: a fresh live edit beats stale disk content, and disk content seeds uuids the live queue
// doesn't have yet. Pure — no store/IO access, so it stays trivially testable. Generic over any entry
// carrying a numeric `timestamp`; this is a newest-per-key rule, NOT an inflightId union — see
// mergeInflightQueuesByUnion for that different (chat outbox) rule.
export function mergeInflight<T extends { timestamp: number }>(
	current: Record<string, T[]>,
	fromDisk: Record<string, T[]>
): Record<string, T[]> {
	const merged: Record<string, T[]> = {
		...current
	}

	for (const uuid of Object.keys(fromDisk)) {
		const diskEntries = fromDisk[uuid] ?? []
		const currentEntries = merged[uuid]

		if (!currentEntries || currentEntries.length === 0) {
			merged[uuid] = diskEntries

			continue
		}

		const newestCurrent = currentEntries.reduce((acc, c) => (c.timestamp > acc ? c.timestamp : acc), Number.NEGATIVE_INFINITY)
		const newestDisk = diskEntries.reduce((acc, c) => (c.timestamp > acc ? c.timestamp : acc), Number.NEGATIVE_INFINITY)

		// Current live edits win when they're at least as fresh as disk; otherwise the disk copy is
		// the newer record (e.g. the live queue was empty for this uuid at fetch start) and replaces it.
		if (newestCurrent >= newestDisk) {
			continue
		}

		merged[uuid] = diskEntries
	}

	return merged
}

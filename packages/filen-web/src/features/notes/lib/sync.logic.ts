import { type } from "arktype"
import { xxHash32 } from "js-xxhash"
import type { Note, NoteType } from "@filen/sdk-rs"
import { asErrorDTO } from "@/lib/sdk/errors"
import type { InflightContent, InflightEntry } from "@/features/notes/store/useNotesInflight"

// D3: cheap stable content hash used for overwrite-conflict DETECTION — the same xxHash32 lib +
// hex format filen-mobile uses. Persisted inside inflight entries as `baseContentHash`, so the
// algorithm must stay stable across app versions: changing it only costs a one-pass grace (entries
// fall back to the legacy no-hash path), never data. Local-only bookkeeping; never sent to the server.
export function hashNoteContent(content: string): string {
	return xxHash32(content).toString(16)
}

// A genuine read-only/permission rejection (a non-network, non-auth SDK error) must eventually DROP
// so the wedged content query re-enables — but a TRANSIENT non-network error (e.g. a one-off
// `Server`, the catch-all for non-`Internal` API failures) must NOT lose the first edit. We bound
// the drop: only after this many CONSECUTIVE non-network, non-auth SDK rejections for the same note
// do we discard its inflight content.
export const MAX_NON_RETRYABLE_REJECTIONS = 3

// The SDK error kinds whose root cause is a wire/transport failure the SDK already retried
// internally. A push that fails with one of these KEEPS its entry and retries forever (offline-safe)
// — this classification layer decides KEEP-vs-DROP for a POST-SDK-retry failure, it is not the wire
// retry itself (the SDK owns that). Mobile's isNetworkClassError over the uniffi ErrorKind enum;
// mapped here to the web worker's structured-clone-safe ErrorDTO `kind` string.
const NETWORK_CLASS_KINDS: ReadonlySet<string> = new Set(["Reqwest", "RetryFailed", "Response"])

export function isNetworkClassError(error: unknown): boolean {
	const dto = asErrorDTO(error)

	return dto.species === "sdk" && dto.kind !== undefined && NETWORK_CLASS_KINDS.has(dto.kind)
}

// An SDK error whose root cause is a recoverable authentication state (`Unauthenticated`, e.g. right
// after a password change, before the client re-authenticates) rather than a permanent rejection.
// Keep-for-retry: the edit is valid and succeeds once the session refreshes. Never counts toward the
// drop bound. `kind` is the strongest structured signal the DTO exposes (no permission code).
export function isRetryableAuthError(error: unknown): boolean {
	const dto = asErrorDTO(error)

	return dto.species === "sdk" && dto.kind === "Unauthenticated"
}

// Mobile drops the inflight entry only for a genuine SDK error (`unwrapSdkError` returns non-null);
// a non-SDK throw (`!unwrapped`) is kept-for-retry unconditionally. The web equivalent: a rejection
// that did not cross the SDK worker as an SDK error is species "plain" — treat it as keep-forever,
// never counting it toward the bounded drop.
export function isNonSdkError(error: unknown): boolean {
	return asErrorDTO(error).species !== "sdk"
}

// createNotePreviewFromContentText's `type` argument, derived from the wasm STRING-union noteType —
// mirrors mobile's `Checklist ? "checklist" : Rich ? "rich" : "other"` mapping exactly.
export function noteKindForPreview(noteType: NoteType): "rich" | "checklist" | "other" {
	return noteType === "checklist" ? "checklist" : noteType === "rich" ? "rich" : "other"
}

// M1 + D3: pure builder for a note's inflight entry list after a keystroke.
//
// M1: the author timestamp is PER-NOTE MONOTONIC — `max(now, newest existing + 1)` — so a backward
// clock step (NTP correction mid-editing) can never leave an OLDER entry outranking the text just
// typed: sync's max-timestamp pick would push the stale entry and its `> syncedUpTo` prune would
// then discard the newest text. All comparisons stay local-vs-local; server clocks are never consulted.
//
// D3: an ongoing session CARRIES its existing base hash forward unchanged (including the legacy
// no-hash grace for entries persisted by older app versions — stamping a fresh base mid-session
// would claim a sync point the session never had). Only a FRESH session (no existing entries) stamps
// `sessionBaseHash` — the hash of the synced/loaded content the editor was seeded from, or none when
// nothing synced is known. The editor wave supplies `sessionBaseHash`; omitting it is the legacy grace.
export function buildInflightEntries({
	previous,
	note,
	content,
	now,
	sessionBaseHash
}: {
	previous: InflightEntry[] | undefined
	note: Note
	content: string
	now: number
	sessionBaseHash: string | null
}): InflightEntry[] {
	const entries = previous ?? []
	const newestExisting = entries.reduce((acc, c) => (c.timestamp > acc ? c.timestamp : acc), Number.NEGATIVE_INFINITY)
	const timestamp = entries.length > 0 ? Math.max(now, newestExisting + 1) : now
	const newestEntry = entries.find(c => c.timestamp === newestExisting)
	const baseContentHash = entries.length > 0 ? newestEntry?.baseContentHash : (sessionBaseHash ?? undefined)

	// exactOptionalPropertyTypes: an absent base hash must OMIT the key, never set it to `undefined`.
	const newEntry: InflightEntry =
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

// Functional, per-uuid MERGE used to hydrate the disk-restored outbox into the (possibly already-
// populated) store without clobbering edits the user typed during the seconds-long cloud-fetch
// reconciliation window. For each uuid we keep whichever side carries the newest LOCAL author-
// timestamp: a fresh store edit beats stale disk content, and disk content seeds uuids the store
// doesn't have yet. Pure — no store/IO access — so it stays trivially testable.
export function mergeInflight(current: InflightContent, fromDisk: InflightContent): InflightContent {
	const merged: InflightContent = {
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

		// Current store edits win when they're at least as fresh as disk; otherwise the disk copy is
		// the newer record (e.g. store was empty for this uuid at fetch start) and replaces it.
		if (newestCurrent >= newestDisk) {
			continue
		}

		merged[uuid] = diskEntries
	}

	return merged
}

// Adaptation A: arktype schema for the DURABLE outbox's read path (invalid → dropped, the kv
// adapter's convention). Validates the record-of-arrays envelope and each entry's own scalar fields;
// `note` is validated only as a non-null object, not field-by-field — over-constraining the wasm
// Note snapshot would drop otherwise-valid entries the moment the SDK adds a field, and the push
// loop already prefers the LIVE note from the list cache over this snapshot. `.as<InflightContent>()`
// carries the trusted-boundary cast (the persisted note round-trips through the $bigint envelope, so
// at runtime it is a genuine Note) without loosening the runtime structural check.
const inflightEntrySchema = type({
	timestamp: "number",
	content: "string",
	note: "object",
	"baseContentHash?": "string"
})

export const inflightContentSchema = type({
	"[string]": inflightEntrySchema.array()
}).as<InflightContent>()

// ── Multi-tab outbox (leader-owned) ─────────────────────────────────────────
//
// One tab (the db-lock leader) owns the push loop + all disk persistence. Follower tabs forward each
// edit to the leader over a dedicated BroadcastChannel and apply it OPTIMISTICALLY to their own store
// so UI gating (spinner / content-query enable / menu suppression) never waits a round trip. The
// leader is authoritative: its periodic state broadcast reconciles followers. Same-note-two-tabs is
// last-enqueue-wins per note by the LOCAL author timestamp (mergeInflight) — never content merging;
// live cross-tab content sync is explicitly out of scope.

// A single edit a follower forwards to the leader. Carries the follower's own monotonic author
// timestamp so cross-tab ordering stays last-write-wins by wall clock; the leader ingests it AS-IS
// (never re-stamps) and merges it by that timestamp.
export interface RemoteEnqueue {
	note: Note
	content: string
	timestamp: number
	baseContentHash?: string
}

// Newest local author timestamp across a note's entry list (NEGATIVE_INFINITY for an empty list).
function newestTimestamp(entries: InflightEntry[]): number {
	return entries.reduce((acc, c) => (c.timestamp > acc ? c.timestamp : acc), Number.NEGATIVE_INFINITY)
}

// Rebuild a follower's displayed store + its still-outstanding unacked set from the leader's
// authoritative broadcast. An unacked note is CONFIRMED (dropped from unacked) once the leader's state
// carries an entry for it at a timestamp >= ours — proof the leader received our forwarded edit; the
// store then simply mirrors the leader for that note, so a later drain (leader omits it) makes it
// disappear. A note the leader has NOT caught up to (its newest < ours, or absent entirely — an
// in-flight or lost forward) keeps its unacked entries, which win the merge so the optimistic edit is
// never dropped before the leader has it. Pure: the caller owns the unacked ref and the store write.
export function reconcileFollower(
	leaderState: InflightContent,
	unacked: InflightContent
): { store: InflightContent; unacked: InflightContent } {
	const remaining: InflightContent = {}

	for (const uuid of Object.keys(unacked)) {
		const localEntries = unacked[uuid] ?? []
		const leaderEntries = leaderState[uuid]
		const leaderNewest = leaderEntries ? newestTimestamp(leaderEntries) : Number.NEGATIVE_INFINITY

		// Leader has caught up to (or past) our latest forward → confirmed; let the store mirror it.
		if (leaderNewest >= newestTimestamp(localEntries)) {
			continue
		}

		remaining[uuid] = localEntries
	}

	return { store: mergeInflight(leaderState, remaining), unacked: remaining }
}

// Build the leader-side one-note patch for an ingested follower edit: `{ [uuid]: [entry] }`, ready to
// mergeInflight into the leader store. exactOptionalPropertyTypes: the base hash key is OMITTED, never
// set to undefined, when the forward carried none (legacy no-hash grace).
export function remoteEnqueueToPatch(msg: RemoteEnqueue): InflightContent {
	const entry: InflightEntry =
		msg.baseContentHash !== undefined
			? { timestamp: msg.timestamp, note: msg.note, content: msg.content, baseContentHash: msg.baseContentHash }
			: { timestamp: msg.timestamp, note: msg.note, content: msg.content }

	return { [msg.note.uuid]: [entry] }
}

// The newest entry a follower holds for a note, used both to seed the optimistic store write and to
// pick the single entry it forwards to the leader (older entries are strictly superseded).
export function newestEntry(entries: InflightEntry[]): InflightEntry | undefined {
	return entries.reduce<InflightEntry | undefined>((acc, c) => (acc === undefined || c.timestamp > acc.timestamp ? c : acc), undefined)
}

import { type } from "arktype"
import { hashNoteContent, mergeInflight, buildInflightEntries } from "@filen/shared"
import type { Note, NoteType } from "@filen/sdk-rs"
import type { InflightContent, InflightEntry } from "@/features/notes/store/useNotesInflight"

// The outbox retry classifiers now live in a shared module (chats' send outbox reuses the identical
// semantics — a byte-identical mechanical move, not a fork). Re-exported here so every existing
// importer of this module's classifier surface (sync.ts, the notes tests) resolves unchanged.
export { isNetworkClassError, MAX_NON_RETRYABLE_REJECTIONS } from "@/lib/sdk/retry"

// The outbox's content hash, disk-restore merge and monotonic-timestamp entry builder now live in a
// shared module (mobile's outbox uses the identical algorithms). Re-exported here so every existing
// importer of this module's outbox surface (sync.ts, the notes tests, useNoteEditor.logic) resolves
// unchanged.
export { hashNoteContent, mergeInflight, buildInflightEntries }

// createNotePreviewFromContentText's `type` argument, derived from the wasm STRING-union noteType —
// mirrors mobile's `Checklist ? "checklist" : Rich ? "rich" : "other"` mapping exactly.
export function noteKindForPreview(noteType: NoteType): "rich" | "checklist" | "other" {
	return noteType === "checklist" ? "checklist" : noteType === "rich" ? "rich" : "other"
}

// arktype schema for the DURABLE outbox's read path (invalid → dropped, the kv
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

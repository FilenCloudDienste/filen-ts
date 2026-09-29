import { type } from "arktype"
import { createNotePreviewFromContentText, mergeInflight, newestEntryTimestamp } from "@filen/shared"
import type { NoteType } from "@filen/sdk-rs"
import { entryIsShowable, type InflightContent, type InflightEntry } from "@/features/notes/store/useNotesInflight"

// createNotePreviewFromContentText's `type` argument, derived from the wasm STRING-union noteType —
// mirrors mobile's `Checklist ? "checklist" : Rich ? "rich" : "other"` mapping exactly.
export function noteKindForPreview(noteType: NoteType): "rich" | "checklist" | "other" {
	return noteType === "checklist" ? "checklist" : noteType === "rich" ? "rich" : "other"
}

export function notePreviewFor(noteType: NoteType, content: string): string {
	return createNotePreviewFromContentText(noteKindForPreview(noteType), content)
}

// arktype schema for the DURABLE outbox's read path (invalid → dropped, the kv
// adapter's convention). Validates the record-of-arrays envelope and each entry's own scalar fields;
// `note` is validated only as a non-null object, not field-by-field — over-constraining the wasm
// Note snapshot would drop otherwise-valid entries the moment the SDK adds a field, and the push
// loop already prefers the LIVE note from the list cache over this snapshot. `.as<InflightContent>()`
// carries the trusted-boundary cast (the persisted note round-trips through the $bigint envelope, so
// at runtime it is a genuine Note) without loosening the runtime structural check.
export const inflightEntrySchema = type({
	timestamp: "number",
	content: "string",
	note: "object",
	"baseContentHash?": "string",
	"origin?": "string",
	"orphan?": "true",
	"carriedFrom?": "string"
})

export const INFLIGHT_NOTE_CONTENT_KV_KEY = "inflightNoteContent"

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
// (never re-stamps) and merges it by that timestamp. `answer`: an answer to the remote-edit dialog
// (Sync.enqueueAnswer).
export type RemoteEnqueue = Omit<InflightEntry, "orphan"> & { answer?: true }

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
		const leaderNewest = newestEntryTimestamp(leaderState[uuid] ?? [])

		// Leader has caught up to (or past) our latest forward → confirmed; let the store mirror it.
		if (leaderNewest >= newestEntryTimestamp(localEntries)) {
			continue
		}

		remaining[uuid] = localEntries
	}

	return { store: mergeInflight(leaderState, remaining), unacked: remaining }
}

// Build the leader-side one-note patch for an ingested follower edit: `{ [uuid]: [entry] }`, ready to
// mergeInflight into the leader store. exactOptionalPropertyTypes: the base hash and origin keys are
// OMITTED, never set to undefined, when the forward carried none (legacy no-hash grace).
export function remoteEnqueueToPatch(msg: RemoteEnqueue): InflightContent {
	const entry: InflightEntry = { timestamp: msg.timestamp, note: msg.note, content: msg.content }

	if (msg.baseContentHash !== undefined) {
		entry.baseContentHash = msg.baseContentHash
	}

	if (msg.origin !== undefined) {
		entry.origin = msg.origin
	}

	if (msg.carriedFrom !== undefined) {
		entry.carriedFrom = msg.carriedFrom
	}

	return { [msg.note.uuid]: [entry] }
}

// The newest entry a follower holds for a note, used both to seed the optimistic store write and to
// pick the single entry it forwards to the leader (older entries are strictly superseded).
export function newestEntry(entries: readonly InflightEntry[] | undefined): InflightEntry | undefined {
	return entries?.reduce<InflightEntry | undefined>((acc, c) => (acc === undefined || c.timestamp > acc.timestamp ? c : acc), undefined)
}

// The same, over the entries this tab's editor may show (entryIsShowable): never another live tab's.
export function newestShowableEntry(entries: readonly InflightEntry[] | undefined): InflightEntry | undefined {
	return newestEntry(entries?.filter(entryIsShowable))
}

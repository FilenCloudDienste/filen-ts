import type { Note } from "@filen/sdk-rs"
import type { InflightEntry } from "@/features/notes/store/useNotesInflight"
import { hashNoteContent, newestEntry } from "@/features/notes/lib/sync.logic"
import { hasNoteWriteAccess } from "@/features/notes/lib/sort"

// old-web parity: the client-side note-content cap. A push past this would be rejected server-side and
// wedge the note, so the editor blocks the ENQUEUE past the cap (never the keystroke — CodeMirror keeps
// the text on screen) and surfaces a size-reached indicator instead. 1 MiB minus a 64-byte headroom
// for the encryption envelope the SDK wraps the content in.
export const MAX_NOTE_SIZE = 1024 * 1024 - 64

// One shared encoder — measuring by UTF-8 byte length (not JS string length) so a note full of
// multibyte characters is capped by what actually crosses the wire, matching the server's own budget.
const encoder = new TextEncoder()

export function noteContentByteSize(value: string): number {
	return encoder.encode(value).length
}

export function exceedsNoteSizeCap(value: string): boolean {
	return noteContentByteSize(value) > MAX_NOTE_SIZE
}

// The freshest inflight entry's content for a note, or null when the outbox holds nothing for it. The
// outbox is a time-ordered list per uuid (it collapses to one entry in steady state); the seed wants
// the newest by LOCAL author-time, the same entry the push loop sends.
export function latestInflightContent(entries: InflightEntry[] | undefined): string | null {
	return newestEntry(entries ?? [])?.content ?? null
}

// THE seed-priority rule (mobile content/index.tsx editorSeed): an unsynced inflight edit wins over the
// content query's data — a cold open with a disk-restored queue must paint the user's own typed text,
// never stale pre-edit content. Read once at mount; the editor freezes it there and only a remount-key
// change may reseed (the EDITOR INVARIANT). `queryContent` is `undefined` only while the query is
// pending or failed, and both render before the editor mounts, so the `?? ""` tail is the type-level
// fallback for a state the editor never paints from: the only `""` it really seeds from is a note whose
// query resolved `""` (a freshly-created note).
export function deriveEditorSeed({
	inflightLatest,
	queryContent
}: {
	inflightLatest: string | null
	queryContent: string | undefined
}): string {
	if (inflightLatest !== null) {
		return inflightLatest
	}

	return queryContent ?? ""
}

// The editor's remount key. `dataUpdatedAt` cannot advance while the note has an inflight entry (its
// content query is disabled-while-inflight, noteContent.ts), so this key is FROZEN across an editing
// session and the editor never remounts mid-edit and wipes the cursor. It only changes on a real
// reseed event: a different note (uuid) or a completed fetch for a note with no pending edits.
export function deriveEditorRemountKey({ uuid, dataUpdatedAt }: { uuid: string; dataUpdatedAt: number }): string {
	return `${uuid}:${String(dataUpdatedAt)}`
}

// Read-only when the note is trashed, or when this user has no write access to it (a shared note
// without permissionsWrite). Mobile's hasWriteAccess, one helper shared with the bulk bar.
export function deriveEditorReadOnly(note: Note, currentUserId: bigint | undefined): boolean {
	return note.trash || !hasNoteWriteAccess(note, currentUserId)
}

// The session-base hash the overwrite-conflict check compares the note's cloud content against: the
// hash of the content THIS editing session was seeded from. It renews to the seed's hash whenever no
// session is ongoing (the note has no inflight entries) and holds steady mid-session, so a keystroke
// never claims a sync point the session never had. Renewing on the has-inflight EDGE (drain) is
// load-bearing: after a full drain the push writes the just-synced content back into the content cache,
// so the seed string is byte-identical to what it was mid-session — a seed-only trigger would observe
// no change and leave the base frozen at the mount seed, mis-flagging the next edit as an overwrite of
// the content this session itself just wrote. INVARIANT: after a successful drain the base equals the
// pushed content's hash. This never weakens genuine detection — a real divergent remote edit is caught
// at push time against whatever base the session actually holds.
export function deriveSessionBaseHash({
	seed,
	hasInflight,
	current
}: {
	seed: string
	hasInflight: boolean
	current: string | null
}): string | null {
	if (hasInflight) {
		return current
	}

	return hashNoteContent(seed)
}

// Coalesce the per-keystroke durable-persist results into at most one "not saved to this device"
// warning per failure streak: warn on the FIRST failure, stay silent through a sustained streak (so a
// persistent disk/quota fault never spams a toast per keystroke), and re-arm once a persist SUCCEEDS
// again so a later failure is surfaced anew. Pure so the "N failures → one warning" invariant is
// directly testable without rendering the hook.
export function reducePersistFailureNotice({ persisted, alreadyNotified }: { persisted: boolean; alreadyNotified: boolean }): {
	notified: boolean
	warn: boolean
} {
	if (persisted) {
		return { notified: false, warn: false }
	}

	if (alreadyNotified) {
		return { notified: true, warn: false }
	}

	return { notified: true, warn: true }
}

// What the content query itself can report, versus what the editor renders — "undecryptable" is a
// narrowing of the query's ERROR state, never an input the query can produce on its own.
export type QueryLoadState = "pending" | "error" | "ready"
export type EditorLoadState = QueryLoadState | "undecryptable"

// Decouple the editor's load state from the deliberately-disabled content query (mobile
// computeNoteLoading): when the note has an inflight entry the query is disabled and stays `pending`
// FOREVER, but we already have a seed to render — so inflight is always immediately "ready". Only with
// NO inflight does the query's own pending/error surface as the editor's load state, and an error whose
// cause is a failed content decryption gets its own explainer instead of a raw fetch-error message.
//
// `outboxHydrated` gates all of it: the outbox loads asynchronously (disk for the leader tab, a
// broadcast for a follower), and until it has, an empty inflight view is "not known yet", not "clean".
// The editor freezes its seed at its first ready render, so seeding before that point paints the
// server's pre-edit content over a queued local edit — and since the seed only ever re-derives on a
// remount-key change, nothing would ever correct it. Holding the existing pending state costs a
// disk read's latency and makes the seed's inflight-first rule truthful.
export function deriveEditorLoadState({
	hasInflight,
	outboxHydrated,
	queryStatus,
	isUndecryptable
}: {
	hasInflight: boolean
	outboxHydrated: boolean
	queryStatus: QueryLoadState
	isUndecryptable: boolean
}): EditorLoadState {
	if (!outboxHydrated) {
		return "pending"
	}

	if (hasInflight) {
		return "ready"
	}

	if (queryStatus === "pending") {
		return "pending"
	}

	if (queryStatus === "error") {
		return isUndecryptable ? "undecryptable" : "error"
	}

	return "ready"
}

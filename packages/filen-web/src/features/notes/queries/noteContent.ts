import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { useNoteInflight } from "@/features/notes/store/useNotesInflight"
import type { Note } from "@filen/sdk-rs"

// Per-note content, keyed on uuid so switching between two notes' editors never shows a stale read
// while the new one is still in flight — same rationale as drive's itemInfoQueryKey.
export function noteContentQueryKey(uuid: string) {
	return ["notes", "content", { uuid }] as const
}

// Exported bare (no hook wrapper of its own consumes it directly here) so this project's
// node-environment unit tests can exercise it against a mocked sdkApi, same as fetchNotes.
// getNoteContent needs the full Note (not just its uuid) to resolve the note's own encryption key.
export async function fetchNoteContent(note: Note): Promise<string | undefined> {
	return sdkApi.getNoteContent(note)
}

// getNoteContent resolves `undefined` for exactly one reason: the note's content ciphertext failed to
// decrypt. An EMPTY note round-trips as "" and a note whose key never unwrapped ERRORS instead, so
// coalescing it to "" reads unreadable-but-present content as "empty" — an export then writes an empty
// file the user believes is a backup, and the sync reconcile prunes a real draft against a phantom "".
export type NoteContentResult = { status: "ok"; content: string } | { status: "undecryptable" }

export async function readNoteContent(note: Note): Promise<NoteContentResult> {
	const content = await fetchNoteContent(note)

	return content === undefined ? { status: "undecryptable" } : { status: "ok", content }
}

// TanStack Query REJECTS a queryFn that resolves undefined and retry is off, so an undecryptable note
// already fails its content query — with the library's raw "<queryHash> data is undefined" as the
// user-visible message. Throw an identity-checked sentinel instead (same convention as drive's
// IMPORT_CANCELLED) so the editor can tell "could not decrypt" from a genuine fetch failure. A thrown
// queryFn writes NO data, so the value cached under noteContentQueryKey stays a bare string for every
// other reader and for the disk persister.
export const NOTE_CONTENT_UNDECRYPTABLE = Symbol("note-content-undecryptable")

export function isUndecryptableContentError(error: unknown): boolean {
	return error === NOTE_CONTENT_UNDECRYPTABLE
}

export async function fetchNoteContentOrThrow(note: Note): Promise<string> {
	const result = await readNoteContent(note)

	if (result.status === "undecryptable") {
		// eslint-disable-next-line @typescript-eslint/only-throw-error -- identity-checked sentinel, see above
		throw NOTE_CONTENT_UNDECRYPTABLE
	}

	return result.content
}

// staleTime: Infinity + refetchOnMount:"always" — mobile's exact per-note content config. staleTime
// Infinity stops focus/reconnect refetches from clobbering an open editor mid-session; but this query
// is PERSISTED per-query (queries/client.ts persister), and the sync loop's post-push cache write does
// NOT re-persist to disk, so a plain "never stale" query would rehydrate a STALE disk value on the next
// load and — being never-stale — never refetch it (a reload right after editing would then paint the
// pre-edit content). refetchOnMount:"always" bypasses the stale check ON MOUNT ONLY, so a fresh editor
// mount always pulls authoritative server content, while a note that is currently inflight has the
// query DISABLED (so no mount refetch fires) and its in-flight edit stays protected. Explicit
// invalidation still owns freshness after a confirmed write. `note` is optional so a caller can mount
// the hook before its Note is resolved (the editor route's first render) without a conditional hook.
//
// USAGE NOTE for the editor: `dataUpdatedAt` on this hook's result is the editor remount key —
// because the query is disabled while the note has an inflight outbox entry, `dataUpdatedAt`
// cannot advance mid-edit, so a component keyed on it never remounts (and blows away in-progress
// keystrokes) while a local edit is still pending.
export function useNoteContentQuery(note: Note | undefined, options?: { enabled?: boolean }): UseQueryResult<string | undefined> {
	// UI gating seam: disable the read while the note has a pending sync-outbox entry.
	// `dataUpdatedAt` (the editor's remount key) therefore cannot advance mid-edit, so the editor never
	// remounts and blows away in-progress keystrokes while a local edit is still queued. Re-enables the
	// instant the outbox drains this note. Reactive — subscribes to the store's has/has-not edge.
	const inflight = useNoteInflight(note?.uuid ?? "")

	return useQuery({
		queryKey: noteContentQueryKey(note?.uuid ?? ""),
		// `enabled` below guarantees `note` is defined whenever this actually runs — guard-and-throw
		// instead of a `note as Note` cast (this codebase avoids bare null-strip assertions).
		queryFn: () => {
			if (note === undefined) {
				throw new Error("noteContent queryFn: called while disabled (note is undefined)")
			}

			return fetchNoteContentOrThrow(note)
		},
		enabled: (options?.enabled ?? true) && note !== undefined && !inflight,
		staleTime: Infinity,
		refetchOnMount: "always"
	})
}

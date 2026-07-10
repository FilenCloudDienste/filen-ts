import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
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

// staleTime: Infinity — content never goes stale on its own; the editor wave gates `enabled` on
// "not currently inflight in the sync outbox" (synthesis §3.3's disabled-while-inflight rule) so a
// pending local edit is never clobbered by a refetch, and invalidates explicitly after a confirmed
// write instead. `note` is optional so a caller can mount the hook before its Note is resolved
// (e.g. the editor route's first render, before the notes list query has settled) without a
// conditional hook call.
//
// USAGE NOTE for the editor wave: `dataUpdatedAt` on this hook's result is the intended editor
// remount key (synthesis §3.3) — because the query is disabled while the note has an inflight
// outbox entry, `dataUpdatedAt` cannot advance mid-edit, so a component keyed on it never remounts
// (and blows away in-progress keystrokes) while a local edit is still pending.
export function useNoteContentQuery(note: Note | undefined, options?: { enabled?: boolean }): UseQueryResult<string | undefined> {
	return useQuery({
		queryKey: noteContentQueryKey(note?.uuid ?? ""),
		// `enabled` below guarantees `note` is defined whenever this actually runs — guard-and-throw
		// instead of a `note as Note` cast (this codebase avoids bare null-strip assertions).
		queryFn: () => {
			if (note === undefined) {
				throw new Error("noteContent queryFn: called while disabled (note is undefined)")
			}

			return fetchNoteContent(note)
		},
		enabled: (options?.enabled ?? true) && note !== undefined,
		staleTime: Infinity
	})
}

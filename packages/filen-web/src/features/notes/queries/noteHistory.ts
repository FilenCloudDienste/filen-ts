import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import type { Note, NoteHistory } from "@filen/sdk-rs"

// History panel primitive: an on-demand read of a single note's version history, keyed on its uuid
// — same rationale as drive's fileVersionsQueryKey.
export function noteHistoryQueryKey(uuid: string) {
	return ["notes", "history", { uuid }] as const
}

export async function fetchNoteHistory(note: Note): Promise<NoteHistory[]> {
	return sdkApi.getNoteHistory(note)
}

// `note` optional for the same reason as useNoteContentQuery — a caller can mount the history
// dialog before the live Note row has resolved without a conditional hook call.
export function useNoteHistoryQuery(note: Note | undefined, options?: { enabled?: boolean }): UseQueryResult<NoteHistory[]> {
	return useQuery({
		queryKey: noteHistoryQueryKey(note?.uuid ?? ""),
		queryFn: () => {
			if (note === undefined) {
				throw new Error("noteHistory queryFn: called while disabled (note is undefined)")
			}

			return fetchNoteHistory(note)
		},
		enabled: (options?.enabled ?? true) && note !== undefined
	})
}

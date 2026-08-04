import { queryClient } from "@/queries/client"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import useNotesInflightStore from "@/features/notes/store/useNotesInflight"
import { newestEntry } from "@/features/notes/lib/sync.logic"

// A note's content AS THIS CLIENT KNOWS IT — the same precedence the editor's seed applies
// (deriveEditorSeed): an unsynced outbox edit first, then the content query cache, `undefined` when
// neither holds it. The cache only advances AFTER a successful push (sync.ts), so any surface that
// hands the user their content — export, copy — must go through here or it reports text the user can
// see is stale, which is exactly the case those affordances stay enabled offline for.
export function localNoteContent(uuid: string): string | undefined {
	return (
		newestEntry(useNotesInflightStore.getState().inflightContent[uuid] ?? [])?.content ??
		queryClient.getQueryData<string | undefined>(noteContentQueryKey(uuid))
	)
}

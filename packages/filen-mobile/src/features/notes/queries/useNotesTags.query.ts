import { type UseQueryOptions } from "@tanstack/react-query"
import { createFixedKeyQuery } from "@/queries/createFixedKeyQuery"
import auth from "@/lib/auth"
import { NOTES_REUSE_WINDOW_MS } from "@/features/notes/queries/useNotesQuery"
import { toSignalOpts } from "@/lib/signals"

export const BASE_QUERY_KEY = "useNotesTagsQuery"

// Stamped by server reads only (see NOTES_REUSE_WINDOW_MS); tag changes have no socket event at all.
let lastServerReadAt = 0

export const reuseRecentNotesTagsRead = {
	refetchOnMount: () => (Date.now() - lastServerReadAt < NOTES_REUSE_WINDOW_MS ? false : "always")
} satisfies Omit<UseQueryOptions, "queryKey" | "queryFn">

export async function fetchData(params?: { signal?: AbortSignal }) {
	const { authedSdkClient } = await auth.getSdkClients()

	const tags = await authedSdkClient.listNoteTags(
		toSignalOpts(params?.signal)
	)

	lastServerReadAt = Date.now()

	return tags.map(tag => ({
		...tag,
		undecryptable: tag.name === undefined
	}))
}

const notesTagsQuery = createFixedKeyQuery({
	baseKey: BASE_QUERY_KEY,
	fetchData,
	empty: () => []
})

export const useNotesTagsQuery = notesTagsQuery.useQuery
export const notesTagsQueryUpdate = notesTagsQuery.update

export default useNotesTagsQuery

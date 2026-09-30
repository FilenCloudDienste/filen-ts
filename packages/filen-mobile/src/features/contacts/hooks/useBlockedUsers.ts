import { useSyncExternalStore } from "react"
import { BASE_QUERY_KEY, contactsQueryGet } from "@/features/contacts/queries/useContacts.query"
import { queryClient } from "@/queries/client"
import { deriveBlockedUsers, EMPTY_BLOCKED_USERS, type BlockedUsers } from "@filen/shared"

// Reads the cached contacts data through one shared query-cache subscription instead of a
// disabled useQuery observer per row.
const listeners = new Set<() => void>()
let detachCache: (() => void) | null = null

function subscribe(listener: () => void): () => void {
	listeners.add(listener)

	if (!detachCache) {
		detachCache = queryClient.getQueryCache().subscribe(event => {
			if (event.query.queryKey[0] !== BASE_QUERY_KEY) {
				return
			}

			for (const l of listeners) {
				l()
			}
		})
	}

	return () => {
		listeners.delete(listener)

		if (listeners.size === 0) {
			detachCache?.()
			detachCache = null
		}
	}
}

let lastBlocked: unknown = undefined
let lastDerived: BlockedUsers = EMPTY_BLOCKED_USERS

function getSnapshot(): BlockedUsers {
	const data = contactsQueryGet()

	// Read the DATA, not the last fetch's verdict: an offline refetch fails and flips `status` to
	// "error" while keeping the blocked list (#103). Gating on status answered "nobody is blocked"
	// for the whole time the device was offline, silently un-hiding blocked users' notes and chats.
	if (!data) {
		return EMPTY_BLOCKED_USERS
	}

	if (data.blocked !== lastBlocked) {
		lastBlocked = data.blocked
		lastDerived = deriveBlockedUsers(data.blocked)
	}

	return lastDerived
}

export function useBlockedUsers(): BlockedUsers {
	return useSyncExternalStore(subscribe, getSnapshot)
}

export default useBlockedUsers
